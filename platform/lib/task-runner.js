// 桥接层：Mode B 交互会话（session-manager）↔ 文件式任务生命周期（runner-state/）。
// 任务进 queued 即起一个「绑定该任务」的 Mode B 会话当执行器；会话生命周期写回该任务 state.json/lease/meta：
//   起会话/发消息 → processing；一轮 result(idle) → awaiting-human；closed/error → awaiting-human。
// 关键：桶完全由 state.json.state 决定（不靠 lease 活死）——idle-but-alive 也稳在 awaiting-human。
// reply：live 会话在则复用（进程常驻多轮）；会话已死（服务重启）则按 task.provider 恢复原会话。
import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';
import { fmt, parse } from './timeutil.js';
import { createSession, sendUserMessage, getSession, closeSession, getSessionIdByTaskKey } from './session-manager.js';
import { appendSessionJournalEvent, readTaskSessionSeed } from './logs.js';
import { ensureWorktree, checkoutBranchLatest } from './git.js';
import { readConfig } from './runner-config.js';

// taskKey → 内存会话 id（reply 复用 / 详情接 live SSE / 判活）
const registry = new Map();
const boundHandlers = new Map();   // taskKey → bind() 装的 onEvent 引用（parkTaskSession 精准解绑用，不误伤详情 SSE 订阅）
const lastBeat = new Map();   // taskKey → 上次 heartbeat 落盘的 ms（节流，避免逐 token 写盘）
const leakRetry = new Map();  // taskKey → 本轮"泄漏空转"已自动重试次数（真人新一轮 markProcessing 时清零）
const LEAK_RETRY_MAX = 2;     // 上限：仍泄漏则落回 awaiting-human（不比现状差），防死循环

// 泄漏空转判据：模型把工具调用输出成了文本（court 哨兵 + 原样 <invoke name=…>）而非结构化 tool_use，
// 于是这一轮没有真工具、以 end_turn 收场 → CC 发 result。runner 据此自动补一条重试而非翻 awaiting-human，
// 既不让用户把它误读成"异常中断"，也让被漏执行的 commit/验证得以补跑。判 content：无 tool_use 且某 text 命中泄漏特征。
export function isLeakedToolTurn(content) {
  const arr = Array.isArray(content) ? content : [];
  if (arr.some((c) => c && c.type === 'tool_use')) return false;
  return arr.some((c) => c && c.type === 'text'
    && (/<invoke\s+name=/.test(c.text || '') || /(^|\n)\s*court\s*(\n|$)/.test(c.text || '')));
}

// 该任务当前是否有活着的 Mode B 会话（供 /api/state 暴露 mbSessionId + reply 判复用）
export function getTaskSessionId(taskKey) {
  // file 任务经 bind() 注册 registry；收养会话未 bind，靠 session 自记 taskKey 反查
  const id = registry.get(taskKey) || getSessionIdByTaskKey(taskKey);
  if (!id) return null;
  const s = getSession(id);
  if (!s || s.state === 'closed' || s.state === 'error') return null;
  return id;
}

function safeKeyOf(taskKey) { return String(taskKey).replace(/:/g, '__').replace(/#/g, '_'); }
function taskDirOf(taskKey) { return path.join(P.runnerRoot, safeKeyOf(taskKey)); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, o) { fs.writeFileSync(f, JSON.stringify(o, null, 2), 'utf8'); }

// 写任务 state（读现盘 merge，state 变才追 history + 刷 enteredAt）
function setTaskState(taskKey, patch, by) {
  const stateFile = path.join(taskDirOf(taskKey), 'state.json');
  const base = readJson(stateFile) || {};
  const now = fmt(new Date());
  const history = Array.isArray(base.history) ? base.history : [];
  const next = { ...base, ...patch };
  if (patch.state && patch.state !== base.state) {
    history.push({ state: patch.state, at: now, by: by || 'session' });
    next.enteredAt = now;
  }
  next.history = history;
  writeJson(stateFile, next);
}

// 本轮收敛落桶（决策 15 延迟落地）：
//   · agent 本轮已声明完成（processing 时调过 complete?resolvedBy=agent，落了 outcomeDetail.agentRequestedDone）
//     → 落 done(by=agent)，消费掉标记；
//   · 否则 → awaiting-human（原行为不变）。
// result 落完 done 后，紧随的 closed 会再调一次 —— 已是 done 就直接返回，绝不把 done 覆盖回 awaiting-human。
// 会话 error 不走这里（error 优先，不认预声明）。
function convergeAwaitingOrDone(taskKey) {
  const sd = readJson(path.join(taskDirOf(taskKey), 'state.json')) || {};
  if (sd.state === 'done') return;
  const od = sd.outcomeDetail || {};
  if (od.agentRequestedDone) {
    const { agentRequestedDone, ...restOd } = od;   // 标记用过即消费
    setTaskState(taskKey, {
      state: 'done', outcome: 'success', resolvedAt: fmt(new Date()),
      outcomeDetail: { ...restOd, resolvedBy: 'agent', failureReason: null },
    }, 'agent');
  } else {
    setTaskState(taskKey, { state: 'awaiting-human', outcome: null, resolvedAt: fmt(new Date()) }, 'session');
  }
}

function writeLease(taskKey, pid) {
  const now = fmt(new Date());
  writeJson(path.join(taskDirOf(taskKey), 'lease.json'), { taskKey, pid: pid || 0, claimedAt: now, heartbeatAt: now });
  lastBeat.set(taskKey, Date.now());
}
function beatLease(taskKey) {
  if (Date.now() - (lastBeat.get(taskKey) || 0) < 10000) return;   // 节流 10s
  const f = path.join(taskDirOf(taskKey), 'lease.json');
  const l = readJson(f);
  if (l) { l.heartbeatAt = fmt(new Date()); writeJson(f, l); lastBeat.set(taskKey, Date.now()); }
}
function removeLease(taskKey) {
  try { fs.unlinkSync(path.join(taskDirOf(taskKey), 'lease.json')); } catch { /* 已无 */ }
  lastBeat.delete(taskKey);
}

// 更新 meta（sessionId 供 provider resume + rounds/usage/lastRoundAt 供详情/看板显示）。
// task.provider 是恢复路由唯一事实源；旧 history 缺 provider 只解释为 claude。
function updateMeta(taskKey, provider, sessionId, resultEv) {
  const f = path.join(taskDirOf(taskKey), 'meta.json');
  const m = readJson(f) || {};
  if (sessionId) {
    m.sessionId = sessionId;
    const hist = Array.isArray(m.sessionHistory) ? m.sessionHistory : [];
    if (!hist.find((h) => h.sessionId === sessionId && (h.provider || 'claude') === provider)) {
      hist.push({ provider, sessionId, round: hist.length + 1, at: fmt(new Date()) });
    }
    m.sessionHistory = hist;
  }
  if (resultEv) {
    m.rounds = (m.rounds || 0) + 1;
    m.numTurns = Number(resultEv.numTurns) || m.numTurns || 0;
    if (typeof resultEv.costUsd === 'number') m.totalCostUsd = resultEv.costUsd;
    if (resultEv.usage) m.usage = resultEv.usage;
    m.lastRoundAt = fmt(new Date());
  }
  writeJson(f, m);
}

function updateTurnUsage(taskKey, usage) {
  if (!usage) return;
  const f = path.join(taskDirOf(taskKey), 'meta.json');
  const meta = readJson(f) || {};
  meta.usage = usage;
  writeJson(f, meta);
}

// sendUserMessage 会把统一 user message 写入 Session.transcript，但为避免 UI 乐观回显重复不会 emit。
// task-runner 在成功发送后取该 settled event 补 journal，不自行拼第二套 message 形状。
function journalLatestUserMessage(taskKey, id) {
  const session = getSession(id);
  const event = [...(session?.transcript || [])].reverse()
    .find((candidate) => candidate?.type === 'message' && candidate.message?.role === 'user');
  if (event) appendSessionJournalEvent(taskKey, event);
}

// 订阅会话 emitter → 写任务盘（settled 事件驱动，逐 token partial 不写盘只节流保活）
function bind(taskKey, id, provider) {
  registry.set(taskKey, id);
  const s = getSession(id);
  if (!s) return;
  const onEvent = (ev) => {
    try {
      if (ev.type === 'session_initialized') {
        appendSessionJournalEvent(taskKey, ev);
        if (ev.sessionId) updateMeta(taskKey, provider, ev.sessionId, null);
        writeLease(taskKey, s.child?.pid || 0);   // 拿到真 pid 后补写 lease
      } else if (ev.type === 'message') {
        appendSessionJournalEvent(taskKey, ev);
        beatLease(taskKey);
      } else if (ev.type === 'message_delta') {
        // 高频 delta 只保活并实时透传，不写 session-events.jsonl。
        beatLease(taskKey);
      } else if (ev.type === 'turn_usage') {
        appendSessionJournalEvent(taskKey, ev);
        updateTurnUsage(taskKey, ev.usage);
        beatLease(taskKey);
      } else if (ev.type === 'turn_completed') {
        appendSessionJournalEvent(taskKey, ev);
        updateMeta(taskKey, provider, ev.sessionId || s.sessionId || null, ev);
        if (ev.status === 'failed') {
          const sd = readJson(path.join(taskDirOf(taskKey), 'state.json')) || {};
          setTaskState(taskKey, {
            state: 'awaiting-human', outcome: 'failed', resolvedAt: fmt(new Date()),
            outcomeDetail: { ...(sd.outcomeDetail || {}), failureReason: ev.error || 'session turn failed' },
          }, 'session');
          removeLease(taskKey);
          leakRetry.delete(taskKey);
          scheduleDrain();
          return;
        }
        if (ev.status === 'interrupted') {
          const sd = readJson(path.join(taskDirOf(taskKey), 'state.json')) || {};
          if (sd.outcome !== 'cancelled') {
            setTaskState(taskKey, {
              state: 'awaiting-human', outcome: 'cancelled', resolvedAt: fmt(new Date()),
              outcomeDetail: { ...(sd.outcomeDetail || {}), failureReason: ev.error || 'turn interrupted' },
            }, 'session');
          }
          removeLease(taskKey);
          leakRetry.delete(taskKey);
          scheduleDrain();
          return;
        }
        // 泄漏空转拦截：本轮把工具调用输出成了文本、无真 tool_use → 自动补重试、保持 processing，不翻牌
        const lastAsst = [...s.transcript].reverse()
          .find((event) => event.type === 'message' && event.message?.role === 'assistant');
        const n = leakRetry.get(taskKey) || 0;
        if (provider === 'claude' && isLeakedToolTurn(lastAsst?.message?.content) && n < LEAK_RETRY_MAX) {
          leakRetry.set(taskKey, n + 1);
          const retry = sendUserMessage(id, '上一条把工具调用输出成了文本（court<invoke…>），并未真正执行。请用结构化工具重新发起这次调用。');
          if (retry.ok) journalLatestUserMessage(taskKey, id);
          beatLease(taskKey);
          return;                        // 不落 awaiting-human、不 removeLease：本轮继续
        }
        leakRetry.delete(taskKey);
        convergeAwaitingOrDone(taskKey); // 决策 15：agent 本轮已声明完成 → 落 done(agent)，否则 awaiting-human
        removeLease(taskKey);            // 一轮收敛：进程常驻但不算 processing
        scheduleDrain();                 // 名额释放 → 放行等待中的 queued 任务
      } else if (ev.type === 'closed') {
        appendSessionJournalEvent(taskKey, ev);
        const state = readJson(path.join(taskDirOf(taskKey), 'state.json'));
        if (state?.state === 'processing') convergeAwaitingOrDone(taskKey);
        removeLease(taskKey);
        leakRetry.delete(taskKey);
        registry.delete(taskKey);
        boundHandlers.delete(taskKey);
        s.emitter.off('event', onEvent);
        scheduleDrain();
      } else if (ev.type === 'error') {
        appendSessionJournalEvent(taskKey, ev);
        const sd = readJson(path.join(taskDirOf(taskKey), 'state.json')) || {};
        setTaskState(taskKey, {
          state: 'awaiting-human', outcome: 'failed', resolvedAt: fmt(new Date()),
          outcomeDetail: { ...(sd.outcomeDetail || {}), failureReason: ev.error || 'session error' },
        }, 'session');
        removeLease(taskKey);
        scheduleDrain();
      }
    } catch { /* 写盘失败不拖垮会话事件流 */ }
  };
  s.emitter.on('event', onEvent);
  boundHandlers.set(taskKey, onEvent);   // 记引用供 parkTaskSession 精准解绑
  // createSession 先启动 adapter 再返回；极快的本地 CLI 可能在 bind 前已完成 init。
  // JS 回调不会在本同步段中间插入：订阅后检查一次 state，即可无竞态补回错过的统一 init。
  if ((s.state === 'running' || s.state === 'idle') && s.sessionId) {
    const init = { type: 'session_initialized', provider, sessionId: s.sessionId, model: s.model || null, at: new Date().toISOString() };
    appendSessionJournalEvent(taskKey, init);
    updateMeta(taskKey, provider, s.sessionId, null);
    writeLease(taskKey, s.child?.pid || 0);
  }
}

// 立即置 processing + 写占位 lease（同步落盘，/api/state 秒级可见；system.init 到达后补真 pid）
function markProcessing(taskKey, id) {
  const s = getSession(id);
  leakRetry.delete(taskKey);   // 真人新一轮：重置泄漏空转重试预算
  // 清 outcomeDetail：起会话/唤醒即进 processing，上一轮收敛/checker 收孤儿写的 failureReason(resumeSessionId 等)
  // 必须一并清掉，否则详情右上「任务信息」卡片会残留旧的"会话中断…可 --resume"红条（reply/restart 两路共用本函数）。
  setTaskState(taskKey, {
    state: 'processing', outcome: null, resolvedAt: null,
    outcomeDetail: { quotaResetAt: null, failureReason: null, checkerExhausted: false },
  }, 'session');
  writeLease(taskKey, s?.child?.pid || 0);
}

// ---- processing 并发上限（复用 runner-config.maxConcurrentRunners；0 = 不限）----
// 语义：同时处于 processing 的看板任务上限。达上限时新执行请求落 queued 等待，名额释放即自动排空。
// 仅约束「新起任务」（create/approve/restart/定时提升）；不拦回复续轮（人工交互不该被并发闸卡住）。
function maxConcurrent() { const n = Number(readConfig().maxConcurrentRunners ?? 5); return Number.isFinite(n) && n > 0 ? n : 0; }
function processingCount() {
  let names = [];
  try { names = fs.readdirSync(P.runnerRoot); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const s = readJson(path.join(P.runnerRoot, name, 'state.json'));
    if (s && s.state === 'processing') n++;
  }
  return n;
}
function capReached() { const max = maxConcurrent(); return max > 0 && processingCount() >= max; }

// 起任务但受并发上限约束：满则落 queued 等待（不 spawn），未满则真起。
// 起成功统一带 spawned:true（startTask 原生返回不含该字段，调用方靠它区分「起了/排队了」）。
export function tryStartOrQueue(taskKey) {
  if (getTaskSessionId(taskKey)) return { ok: false, error: '该任务已有活跃会话在跑' };
  if (capReached()) {
    setTaskState(taskKey, { state: 'queued', outcome: null, resolvedAt: null }, 'cap');
    return { ok: true, taskKey, queued: true, spawned: false };
  }
  const r = startTask(taskKey);
  return r.ok ? { ...r, spawned: true } : r;
}

// 排空 queued：名额释放 / 定时兜底时，按入队先后（enteredAt）把 queued 任务起到并发上限。
let draining = false;
export function drainQueued() {
  if (draining) return { started: [] };
  draining = true;
  const started = [];
  try {
    while (!capReached()) {
      let names = [];
      try { names = fs.readdirSync(P.runnerRoot); } catch { break; }
      const waiting = [];
      for (const name of names) {
        const s = readJson(path.join(P.runnerRoot, name, 'state.json'));
        if (!s || s.state !== 'queued') continue;
        const t = readJson(path.join(P.runnerRoot, name, 'task.json'));
        const taskKey = t?.taskKey || (name.includes('__') ? name.replace('__', ':') : name);
        if (getTaskSessionId(taskKey)) continue;   // 已在跑（罕见）跳过
        waiting.push({ taskKey, at: s.enteredAt || '' });
      }
      if (!waiting.length) break;
      waiting.sort((a, b) => String(a.at).localeCompare(String(b.at)));   // 先入队先起
      const next = waiting[0];
      const r = startTask(next.taskKey);
      if (!r.ok) break;   // 起不动（如 claude 不可用）→ 停，留 queued 下轮再试
      started.push(next.taskKey);
    }
  } finally { draining = false; }
  return { started };
}
function scheduleDrain() { setImmediate(() => { try { drainQueued(); } catch { /* 排空失败不拖垮事件流 */ } }); }

// 解析任务真正运行的 cwd：worktree 开启且 cwd 是 git → 建/复用 worktree，运行在 worktree 目录；
// 否则（不勾 worktree）若单独设了签出基分支 → 首次运行时直接在工作目录本身签出该分支 + 拉取最新代码后工作，
// 之后（reply/resume）复用、不重复签出（避免打断进行中的改动）；均落 meta.json 幂等标记。
// worktreeDir/branch 落 meta.json：reply/resume 复用同目录续跑，且供 collect 侧栏展示。首次建失败即回错、不降级到主库。
function resolveRunCwd(taskKey, task) {
  const cwd = task?.cwd || null;
  if (!cwd) return { cwd };
  const metaFile = path.join(taskDirOf(taskKey), 'meta.json');
  const meta = readJson(metaFile) || {};
  if (task?.worktree) {
    if (meta.worktreeDir && fs.existsSync(meta.worktreeDir)) return { cwd: meta.worktreeDir };   // 已建，复用
    const name = String(taskKey).split(':').slice(1).join('-').replace(/[^A-Za-z0-9._-]/g, '-') || safeKeyOf(taskKey);
    const r = ensureWorktree({ repoDir: cwd, name, baseBranch: task.baseBranch || null });
    if (!r.ok) return { error: r.error };
    meta.worktreeDir = r.worktreeDir;
    meta.worktreeBranch = r.branch;
    try { writeJson(metaFile, meta); } catch { /* 落盘失败不阻断，用返回值 */ }
    return { cwd: r.worktreeDir };
  }
  if (task?.baseBranch && !meta.baseBranchApplied) {
    const r = checkoutBranchLatest({ repoDir: cwd, baseBranch: task.baseBranch });
    if (!r.ok) return { error: r.error };
    meta.baseBranchApplied = task.baseBranch;
    try { writeJson(metaFile, meta); } catch { /* 落盘失败不阻断 */ }
  }
  return { cwd };
}

// 起任务执行会话（queued/approve/restart → 起绑定会话，task.prompt 作本轮消息）。
// resume-aware：该任务此前跑过并落了会话（meta.sessionId）→ 由对应 provider 续上之前的对话（喂回历史 seed +
// task.prompt 作续轮消息，与 replyTask resume 分支同构，用于「退回 plan 再执行」续对话）；从未跑过 →
// 全新起会话。二者仅差 resume/seed，落盘（bind/markProcessing）一致。现有 caller 都无 sessionId、行为不变。
export function startTask(taskKey) {
  const dir = taskDirOf(taskKey);
  const task = readJson(path.join(dir, 'task.json'));
  if (!task) return { ok: false, error: 'task.json 不存在，无法起会话' };
  if (getTaskSessionId(taskKey)) return { ok: false, error: '该任务已有活跃会话在跑' };
  const rc = resolveRunCwd(taskKey, task);
  if (rc.error) return { ok: false, error: rc.error };
  const provider = task.provider || 'claude';
  const sid = readJson(path.join(dir, 'meta.json'))?.sessionId || null;
  const sessionOptions = {
    provider,
    taskKey,
    cwd: rc.cwd || undefined,
    model: task.model || undefined,
    effort: task.effort || undefined,
    resume: sid || undefined,
    prompt: task.prompt,
    attachments: task.attachments,
    bypass: true,
  };
  if (provider === 'claude') sessionOptions.dynamicWorkflow = task.dynamicWorkflow;
  let r;
  if (sid) {
    const history = readTaskSessionSeed(taskKey, provider, sid);
    // seed 只含历史；本轮 prompt 由 createSession→sendUserMessage 自记进 transcript（不再往 seed 尾追，避免重复）
    sessionOptions.seedTranscript = history.ok ? history.seedTranscript : [];
    if (provider === 'claude' && history.ok) sessionOptions.gitBranch = history.gitBranch || undefined;
    r = createSession(sessionOptions);
  } else {
    r = createSession(sessionOptions);
  }
  if (!r.ok) return r;
  bind(taskKey, r.id, provider);
  journalLatestUserMessage(taskKey, r.id);
  markProcessing(taskKey, r.id);
  return { ok: true, taskKey, sessionUiId: r.id, resumed: sid || undefined };
}

// 回复任务：live 会话在则复用（多轮）；已死则按 provider 恢复。model/effort 覆盖仅在恢复重挂时生效
// （live 会话的 model/effort 在 spawn 时已定、无法中途改）。
export function replyTask(taskKey, message, model, effort, attachments) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'message required' };
  const liveId = getTaskSessionId(taskKey);
  if (liveId) {
    const r = sendUserMessage(liveId, msg, attachments);
    if (!r.ok) return r;
    journalLatestUserMessage(taskKey, liveId);
    markProcessing(taskKey, liveId);
    return { ok: true, taskKey, sessionUiId: liveId, reused: true };
  }
  const dir = taskDirOf(taskKey);
  const task = readJson(path.join(dir, 'task.json'));
  const meta = readJson(path.join(dir, 'meta.json'));
  const state = readJson(path.join(dir, 'state.json'));
  const sid = meta?.sessionId || state?.outcomeDetail?.resumeSessionId || null;
  if (!sid) return { ok: false, error: '无 sessionId 可恢复（会话从未成功起过，请重新发起）' };
  const provider = task?.provider || 'claude';
  // 会话进程已死（用户取消 / 服务重启）→ 按 provider 重挂。喂回历史 transcript 作 seed，
  // 否则详情连上 live 会话时 transcript 只有新一轮、历史全丢（与 adopt 同款 seed 机制）。
  // 本轮 reply 由 createSession→sendUserMessage 自记进 transcript（不再往 seed 尾追，避免重复）。
  const history = readTaskSessionSeed(taskKey, provider, sid);
  const seed = history.ok ? history.seedTranscript : [];
  const rc = resolveRunCwd(taskKey, task || {});
  if (rc.error) return { ok: false, error: rc.error };
  const options = {
    provider,
    taskKey,
    cwd: rc.cwd || undefined,
    model: model || task?.model || undefined,
    effort: effort || task?.effort || undefined,
    resume: sid,
    prompt: msg,
    attachments,
    seedTranscript: seed,
    bypass: true,
  };
  if (provider === 'claude') {
    options.gitBranch = history.ok ? history.gitBranch || undefined : undefined;
    options.dynamicWorkflow = task?.dynamicWorkflow;
  }
  const r = createSession(options);
  if (!r.ok) return r;
  bind(taskKey, r.id, provider);
  journalLatestUserMessage(taskKey, r.id);
  markProcessing(taskKey, r.id);
  return { ok: true, taskKey, sessionUiId: r.id, resumed: sid };
}

// 中断任务：关会话进程 + 落 awaiting-human/cancelled（跨平台，替代 .ps1 时代 taskkill）
export function cancelTaskSession(taskKey) {
  const id = registry.get(taskKey);
  if (!id) return { ok: false, reason: 'no-live-session' };
  try { closeSession(id); } catch { /* 已退 */ }
  registry.delete(taskKey);
  const sd = readJson(path.join(taskDirOf(taskKey), 'state.json')) || {};
  const resolvedAt = fmt(new Date());
  setTaskState(taskKey, {
    state: 'awaiting-human', outcome: 'cancelled', resolvedAt,
    outcomeDetail: { ...(sd.outcomeDetail || {}), failureReason: 'user cancelled' },
  }, 'user');
  removeLease(taskKey);
  return { ok: true, taskKey, killed: id, resolvedAt };
}

// 停手会话（退回 plan 用）：关掉可能仍活着的 idle Mode B 会话进程 + 删 lease，但**不改 state**（交调用方落 plan）。
// 关键：先精准解绑本任务的 onEvent（用 boundHandlers 记的引用），否则 closeSession 触发的 'closed' 事件
// 会把 state 翻回 awaiting-human、盖掉调用方随后落的 plan；不 removeAllListeners 以免误伤详情页 SSE 订阅。
// 保留 meta.sessionId 不动 → 之后 startTask 据它让对应 provider 续上之前的对话。
export function parkTaskSession(taskKey) {
  const id = registry.get(taskKey);
  const onEvent = boundHandlers.get(taskKey);
  registry.delete(taskKey);
  boundHandlers.delete(taskKey);
  removeLease(taskKey);
  leakRetry.delete(taskKey);
  if (!id) return { ok: true, taskKey, killed: null };   // 无 live 会话（服务重启后 / 从未起）：只清 lease
  const s = getSession(id);
  if (s && onEvent) s.emitter.off('event', onEvent);
  // 解绑 taskKey：closeSession 是异步宽限关（1.5s 才强杀），期间会话仍在 sessions Map、state 可能还是 idle，
  // 若不解绑，紧随其后的 startTask/replyTask 经 getSessionIdByTaskKey 仍会找到这个正在关闭的会话并误复用（rewind 竞态）。
  if (s) s.taskKey = null;
  try { closeSession(id); } catch { /* 已退 */ }
  return { ok: true, taskKey, killed: id };
}

// 定时提升：扫 plan 态任务，scheduledAt 到点（<=now）即 startTask 起会话执行（本看板 queued 即刻转 processing，
// 无独立消费 queued 的 loop，故「定时转 queued」= 到点执行）。清 scheduledAt 防重复触发。
// 由主进程调度器持锁实例定时调用（in-process，与 session-manager 同进程才能 spawn）；重启后下一轮扫描自动补偿过期项。
export function promoteDueScheduledTasks() {
  let names = [];
  try { names = fs.readdirSync(P.runnerRoot); } catch { return { promoted: [], errors: [] }; }
  const nowMs = Date.now();
  const promoted = [];
  const errors = [];
  for (const name of names) {
    const dir = path.join(P.runnerRoot, name);
    const state = readJson(path.join(dir, 'state.json'));
    if (!state || state.state !== 'plan') continue;
    const task = readJson(path.join(dir, 'task.json'));
    const sched = task?.scheduledAt;
    if (!sched) continue;
    const at = parse(sched);
    if (!at || at.getTime() > nowMs) continue;
    const taskKey = task?.taskKey || (name.includes('__') ? name.replace('__', ':') : name);
    const r = tryStartOrQueue(taskKey);   // 到点提升，受并发上限约束：满则落 queued 等排空
    if (r.ok) {
      try { const tj = readJson(path.join(dir, 'task.json')) || {}; delete tj.scheduledAt; writeJson(path.join(dir, 'task.json'), tj); } catch { /* 清失败无妨：state 已非 plan、下轮不再命中 */ }
      promoted.push(taskKey);
    } else {
      errors.push({ taskKey, error: r.error });
    }
  }
  return { promoted, errors };
}
