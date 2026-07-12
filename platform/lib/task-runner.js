// 桥接层：Mode B 交互会话（session-manager）↔ 文件式任务生命周期（runner-state/）。
// 任务进 queued 即起一个「绑定该任务」的 Mode B 会话当执行器；会话生命周期写回该任务 state.json/lease/meta：
//   起会话/发消息 → processing；一轮 result(idle) → awaiting-human；closed/error → awaiting-human。
// 关键：桶完全由 state.json.state 决定（不靠 lease 活死）——idle-but-alive 也稳在 awaiting-human。
// reply：live 会话在则复用（进程常驻多轮）；会话已死（服务重启）则 claude --resume <sessionId> 重挂。
import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';
import { fmt } from './timeutil.js';
import { createSession, sendUserMessage, getSession, closeSession, getSessionIdByTaskKey } from './session-manager.js';
import { readCcSessionForAdopt, ccMessagesToModeBSeed } from './logs.js';

// taskKey → 内存会话 id（reply 复用 / 详情接 live SSE / 判活）
const registry = new Map();
const lastBeat = new Map();   // taskKey → 上次 heartbeat 落盘的 ms（节流，避免逐 token 写盘）

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

// 更新 meta（sessionId 供 --resume + rounds/usage/lastRoundAt 供详情/看板显示）
function updateMeta(taskKey, sessionId, resultEv) {
  const f = path.join(taskDirOf(taskKey), 'meta.json');
  const m = readJson(f) || {};
  if (sessionId) {
    m.sessionId = sessionId;
    const hist = Array.isArray(m.sessionHistory) ? m.sessionHistory : [];
    if (!hist.find((h) => h.sessionId === sessionId)) hist.push({ sessionId, round: hist.length + 1, at: fmt(new Date()) });
    m.sessionHistory = hist;
  }
  if (resultEv) {
    m.rounds = (m.rounds || 0) + 1;
    m.numTurns = Number(resultEv.num_turns) || m.numTurns || 0;
    if (typeof resultEv.total_cost_usd === 'number') m.totalCostUsd = resultEv.total_cost_usd;
    if (resultEv.usage) m.usage = resultEv.usage;
    m.lastRoundAt = fmt(new Date());
  }
  writeJson(f, m);
}

// 订阅会话 emitter → 写任务盘（settled 事件驱动，逐 token partial 不写盘只节流保活）
function bind(taskKey, id) {
  registry.set(taskKey, id);
  const s = getSession(id);
  if (!s) return;
  const onEvent = (ev) => {
    try {
      if (ev.type === 'system' && ev.subtype === 'init') {
        if (ev.session_id) updateMeta(taskKey, ev.session_id, null);
        writeLease(taskKey, s.child?.pid || 0);   // 拿到真 pid 后补写 lease
      } else if (ev.type === 'assistant' || ev.type === 'user' || ev.type === 'stream_event') {
        beatLease(taskKey);
      } else if (ev.type === 'result') {
        updateMeta(taskKey, s.claudeSessionId, ev);
        setTaskState(taskKey, { state: 'awaiting-human', outcome: null, resolvedAt: fmt(new Date()) }, 'session');
        removeLease(taskKey);            // 一轮收敛：进程常驻但不算 processing
      } else if (ev.type === 'closed') {
        setTaskState(taskKey, { state: 'awaiting-human', outcome: null, resolvedAt: fmt(new Date()) }, 'session');
        removeLease(taskKey);
        registry.delete(taskKey);
        s.emitter.off('event', onEvent);
      } else if (ev.type === 'error') {
        const sd = readJson(path.join(taskDirOf(taskKey), 'state.json')) || {};
        setTaskState(taskKey, {
          state: 'awaiting-human', outcome: 'failed', resolvedAt: fmt(new Date()),
          outcomeDetail: { ...(sd.outcomeDetail || {}), failureReason: ev.error || 'session error' },
        }, 'session');
        removeLease(taskKey);
      }
    } catch { /* 写盘失败不拖垮会话事件流 */ }
  };
  s.emitter.on('event', onEvent);
}

// 立即置 processing + 写占位 lease（同步落盘，/api/state 秒级可见；system.init 到达后补真 pid）
function markProcessing(taskKey, id) {
  const s = getSession(id);
  // 清 outcomeDetail：起会话/唤醒即进 processing，上一轮收敛/checker 收孤儿写的 failureReason(resumeSessionId 等)
  // 必须一并清掉，否则详情右上「任务信息」卡片会残留旧的"会话中断…可 --resume"红条（reply/restart 两路共用本函数）。
  setTaskState(taskKey, {
    state: 'processing', outcome: null, resolvedAt: null,
    outcomeDetail: { quotaResetAt: null, failureReason: null, checkerExhausted: false },
  }, 'session');
  writeLease(taskKey, s?.child?.pid || 0);
}

// 起任务执行会话（queued/approve/restart → 起绑定会话，task.prompt 作首条消息）
export function startTask(taskKey) {
  const task = readJson(path.join(taskDirOf(taskKey), 'task.json'));
  if (!task) return { ok: false, error: 'task.json 不存在，无法起会话' };
  if (getTaskSessionId(taskKey)) return { ok: false, error: '该任务已有活跃会话在跑' };
  const r = createSession({ taskKey, cwd: task.cwd || undefined, model: task.model || undefined, effort: task.effort || undefined, prompt: task.prompt, bypass: true });
  if (!r.ok) return r;
  bind(taskKey, r.id);
  markProcessing(taskKey, r.id);
  return { ok: true, taskKey, sessionUiId: r.id };
}

// 回复任务：live 会话在则复用（多轮）；已死则 --resume 重挂
export function replyTask(taskKey, message, model) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'message required' };
  const liveId = getTaskSessionId(taskKey);
  if (liveId) {
    const r = sendUserMessage(liveId, msg);
    if (!r.ok) return r;
    markProcessing(taskKey, liveId);
    return { ok: true, taskKey, sessionUiId: liveId, reused: true };
  }
  const dir = taskDirOf(taskKey);
  const task = readJson(path.join(dir, 'task.json'));
  const meta = readJson(path.join(dir, 'meta.json'));
  const state = readJson(path.join(dir, 'state.json'));
  const sid = meta?.sessionId || state?.outcomeDetail?.resumeSessionId || null;
  if (!sid) return { ok: false, error: '无 sessionId 可 --resume（会话从未成功起过，请重新发起）' };
  // 会话进程已死（用户取消 / 服务重启）→ --resume 重挂。喂回历史 transcript + 这条 reply 回显作 seed，
  // 否则详情连上 live 会话时 transcript 只有新一轮、历史全丢（与 adopt 同款 seed 机制）。
  const hist = readCcSessionForAdopt(sid);
  const seed = hist.ok ? ccMessagesToModeBSeed(hist.messages) : [];
  seed.push({ type: 'user', message: { content: msg } });
  const r = createSession({ taskKey, cwd: task?.cwd || undefined, model: model || task?.model || undefined, effort: task?.effort || undefined, resume: sid, prompt: msg, seedTranscript: seed, bypass: true });
  if (!r.ok) return r;
  bind(taskKey, r.id);
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
