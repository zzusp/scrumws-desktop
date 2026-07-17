import fs from 'node:fs';
import path from 'node:path';
import { P } from '../paths.js';
import { getState, invalidateState } from '../collect.js';
import { readConfig } from '../runner-config.js';
import { createTask, replyToTask, cancelTask, completeTask, uncompleteTask, moveTaskToPlan, restartTask } from '../task-actions.js';
import { getTaskSessionId } from '../task-runner.js';
import { sendUserMessage } from '../session-manager.js';
import { readWorkerLog } from '../logs.js';

// 手机中继 rpc verb 执行器（契约 §4.4，**穷举白名单**）：云端只透传 verb/args，一切校验在这里。
// 白名单写死在本文件——云端被攻破也只能调这张表里的动作；动作函数与 platform/server.js 对应路由
// **完全同一个**（复用 task-actions / task-runner / session-manager，本地状态机行为与本地操作一致）。
// source:'mobile' 仅是来源元数据（README 任务来源不变量），不据此做任何行为分支。

/** workerLog 尾窗默认块数（契约 §4.4：tail 默认 30 块；watch 基线帧同口径） */
export const WORKER_LOG_TAIL = 30;

const str = (v) => String(v ?? '').trim();

// 与 server.js 各任务路由同款的 taskKey 形状校验（task-actions 内部还会再验一次，这里先挡明显垃圾）
const validTaskKey = (k) => /^[A-Za-z0-9:_#/-]+$/.test(k);
const safeKeyOf = (k) => String(k).replace(/:/g, '__').replace(/#/g, '_');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// 动作函数返回值 → 上行结果（契约 §4.2：{ok:true,data} / {ok:false,error}）。
// 成功即作废状态缓存：server.js 靠 POST 'finish' 钩子做 read-your-writes，中继动作不走本地 HTTP，
// 这里补同一动作，否则手机紧随其后的 state rpc 会命中 3s 旧缓存拿到 mutation 之前的快照。
function wrapAction(r) {
  if (r?.ok) { invalidateState(); return { ok: true, data: r }; }
  return { ok: false, error: r?.error || '操作失败' };
}

// ---- state：六桶卡片裁剪（契约 §4.4：每卡只留 10 个核心字段，不含 prompt 全文）----
const CARD_FIELDS = ['taskKey', 'title', 'state', 'outcome', 'source', 'cwd', 'enteredAt', 'lastActivityMs', 'backgroundTaskCount', 'worktreeBranch'];
function pruneCard(card) {
  const out = {};
  for (const k of CARD_FIELDS) out[k] = card?.[k] ?? null;
  return out;
}
async function verbState() {
  const snap = await getState({ maxAgeMs: 3000 });
  const lc = snap?.lifecycle || {};
  const lifecycle = {};
  for (const bucket of ['plan', 'processing', 'queued', 'done', 'awaitingHuman', 'archived']) {
    lifecycle[bucket] = (lc[bucket] || []).map(pruneCard);
  }
  return { ok: true, data: { now: snap?.now || null, lifecycle } };
}

// ---- cwds：白名单本身（新建表单的目录选择器）----
function verbCwds() {
  const raw = readConfig().cloudAllowedCwds;
  const cwds = Array.isArray(raw) ? raw.map((x) => str(x)).filter(Boolean) : [];
  return { ok: true, data: { cwds } };
}

// ---- CLI 观察态任务（无任务包）→ 从 lifecycle 卡兜底合成详情 ----
// CLI 会话不落任务包（collect-cli.js 每次现场合成卡片），verbTaskDetail 读包必然 not found。
// 但 readWorkerLog 认 cli:（→ readCliWorkerLog），输出流本可展示——所以 detail 也要能出，
// 否则手机点进 CLI 卡整页报错（输出明明拉得到）。CLI 卡没有 prompt（观察态，非本端发起）。
async function cliDetailFromCard(taskKey) {
  let snap;
  try { snap = await getState({ maxAgeMs: 3000 }); } catch { return null; }
  const lc = snap?.lifecycle || {};
  let card = null;
  for (const bucket of ['plan', 'processing', 'queued', 'done', 'awaitingHuman', 'archived']) {
    const hit = (lc[bucket] || []).find((c) => c?.taskKey === taskKey);
    if (hit) { card = hit; break; }
  }
  if (!card) return null;
  return {
    ok: true,
    data: {
      taskKey,
      isArchive: card.state === 'archived' || !!card.isArchive,
      title: card.title || taskKey,
      prompt: null,                                  // CLI 观察态无 prompt（非本端发起）
      model: card.meta?.model ?? null,
      effort: null,
      cwd: card.cwd ?? card.cli?.cwd ?? null,
      worktree: !!card.worktreeDir,
      baseBranch: null,
      description: card.description ?? null,
      scheduledAt: null,
      source: card.source ?? 'cli',
      createdAt: card.createdAt ?? null,
      state: card.state ?? null,
      outcome: card.outcome ?? null,
      enteredAt: card.enteredAt ?? null,
      resolvedAt: card.resolvedAt ?? null,
      outcomeDetail: card.outcomeDetail ?? null,
      history: Array.isArray(card.history) ? card.history : [],
      meta: {
        sessionId: card.meta?.sessionId ?? null,
        rounds: card.meta?.rounds ?? 0,
        numTurns: card.meta?.numTurns ?? 0,
        totalCostUsd: card.meta?.totalCostUsd ?? 0,
        usage: card.meta?.usage ?? null,
        lastRoundAt: card.meta?.lastRoundAt ?? null,
        worktreeBranch: card.cli?.gitBranch ?? null,
        worktreeDir: card.worktreeDir ?? null,
      },
    },
  };
}

// ---- taskDetail：task.json + state.json + meta 概要（含 prompt 全文 / history / usage）----
// 无任务包时（CLI 观察态）回落 lifecycle 卡合成（见 cliDetailFromCard）。
async function verbTaskDetail(args) {
  const taskKey = str(args?.taskKey);
  if (!validTaskKey(taskKey)) return { ok: false, error: 'invalid taskKey' };
  const safeKey = safeKeyOf(taskKey);
  let dir = path.join(P.runnerRoot, safeKey);
  let isArchive = false;
  if (!fs.existsSync(dir)) { dir = path.join(P.archiveRoot, safeKey); isArchive = true; }
  if (!fs.existsSync(dir)) {
    const cli = await cliDetailFromCard(taskKey);
    return cli || { ok: false, error: 'task not found' };
  }
  const task = readJson(path.join(dir, 'task.json')) || {};
  const state = readJson(path.join(dir, 'state.json')) || {};
  const meta = readJson(path.join(dir, 'meta.json')) || {};
  return {
    ok: true,
    data: {
      taskKey,
      isArchive,
      title: task.customTitle || task.title || taskKey,
      prompt: task.prompt ?? null,
      model: task.model ?? null,
      effort: task.effort ?? null,
      cwd: task.cwd ?? null,
      worktree: !!task.worktree,
      baseBranch: task.baseBranch ?? null,
      description: task.description ?? null,
      scheduledAt: task.scheduledAt ?? null,
      source: task.source ?? null,
      createdAt: task.createdAt ?? null,
      state: state.state ?? null,
      outcome: state.outcome ?? null,
      enteredAt: state.enteredAt ?? null,
      resolvedAt: state.resolvedAt ?? null,
      outcomeDetail: state.outcomeDetail ?? null,
      history: Array.isArray(state.history) ? state.history : [],
      meta: {
        sessionId: meta.sessionId ?? null,
        rounds: meta.rounds ?? 0,
        numTurns: meta.numTurns ?? 0,
        totalCostUsd: meta.totalCostUsd ?? 0,
        usage: meta.usage ?? null,
        lastRoundAt: meta.lastRoundAt ?? null,
        worktreeBranch: meta.worktreeBranch ?? null,
        worktreeDir: meta.worktreeDir ?? null,
      },
    },
  };
}

// ---- workerLog：readWorkerLog 摊平成块序列（供尾窗翻页 / watch 增量共用）----
// 「块」= rounds[].messages[] 逐条摊平（带轮次标注）；total = 全量块数，手机端「加载更早」传更大 tail。
export function workerLogBlocks(taskKey) {
  let r;
  try { r = readWorkerLog(taskKey); } catch (e) { return { ok: false, error: e.message }; }
  if (!r || !r.ok) return { ok: false, error: r?.error || 'task not found' };
  const blocks = [];
  for (const round of r.rounds || []) {
    for (const m of round.messages || []) {
      blocks.push({ round: round.round ?? null, sessionId: round.sessionId || null, inflight: !!round.inflight, ...m });
    }
  }
  return { ok: true, taskKey: r.taskKey, state: r.state ?? null, hasInflight: !!r.hasInflight, blocks };
}
function verbWorkerLog(args) {
  const taskKey = str(args?.taskKey);
  if (!taskKey) return { ok: false, error: 'taskKey required' };
  const r = workerLogBlocks(taskKey);
  if (!r.ok) return r;
  let tail = Math.trunc(Number(args?.tail));
  if (!Number.isFinite(tail) || tail <= 0) tail = WORKER_LOG_TAIL;
  tail = Math.min(tail, 500);   // 上限兜底：blocks 含 tool_result 原文，别让一发 rpc 拖全量历史
  return { ok: true, data: { taskKey, state: r.state, hasInflight: r.hasInflight, total: r.blocks.length, blocks: r.blocks.slice(-tail) } };
}

// ---- createTask：闸门（总开关 + cwd 白名单前缀）→ createTask({source:'mobile', …}) ----
// 白名单前缀匹配按目录边界（'D:\a' 不放行 'D:\ab'）；Windows 大小写不敏感。
function cwdAllowed(cwd, allowed) {
  let target;
  try { target = path.resolve(cwd).replace(/[\\/]+$/, ''); } catch { return false; }
  const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const t = fold(target);
  for (const a of allowed) {
    const raw = str(a);
    if (!raw) continue;
    let base;
    try { base = path.resolve(raw).replace(/[\\/]+$/, ''); } catch { continue; }
    const b = fold(base);
    if (t === b || t.startsWith(b + path.sep)) return true;
  }
  return false;
}
function verbCreateTask(args) {
  const cfg = readConfig();
  const allowed = Array.isArray(cfg.cloudAllowedCwds) ? cfg.cloudAllowedCwds : [];
  const cwd = str(args?.cwd);
  if (!cwd) return { ok: false, error: '缺少 cwd（远程新建必须显式指定工作目录）' };
  if (!cwdAllowed(cwd, allowed)) return { ok: false, error: `白名单外的 cwd：${cwd}` };
  return wrapAction(createTask({
    source: 'mobile',                       // 仅元数据：与本地手建任务走同一状态机，不特判
    title: args?.title,
    prompt: args?.prompt,
    model: args?.model,
    effort: args?.effort,
    cwd,
    worktree: args?.worktree,
    baseBranch: args?.baseBranch,
    scheduledAt: args?.scheduledAt,         // 本地串 'yyyy-MM-dd HH:mm:ss'；给了 createTask 强制落 plan、到点由调度器提升执行
    plan: args?.plan,                       // true = 落 plan 待确认；false = 直接排队执行
  }));
}

// ---- message：与本地详情页同一分支逻辑 ----
// 活会话在且无任务包（被旁观 / 收养的 CLI 会话）→ 直接注入 stdin（对齐本地 /api/session/send 分支：
// 未物化 cli:* 不能走 replyToTask，那会进已废弃的观察侧 replyCliSession）。
// 其余一律 replyToTask（本地 /api/task/reply 同一函数）：它自己做状态校验（processing 等不可发原样
// 报错、plan/queued 无 sessionId 报「无 sessionId 可 --resume」），live 会话在则内部同样注入 + 置 processing。
function verbMessage(args) {
  const taskKey = str(args?.taskKey);
  const text = str(args?.text);
  if (!validTaskKey(taskKey)) return { ok: false, error: 'invalid taskKey' };
  if (!text) return { ok: false, error: 'text required' };
  const liveId = getTaskSessionId(taskKey);
  const hasPackage = fs.existsSync(path.join(P.runnerRoot, safeKeyOf(taskKey)));
  if (liveId && !hasPackage) {
    const r = sendUserMessage(liveId, text);
    if (!r?.ok) return { ok: false, error: r?.error || '注入失败' };
    return wrapAction({ ok: true, taskKey, injected: true, sessionUiId: liveId });
  }
  return wrapAction(replyToTask({ taskKey, message: text }));
}

/**
 * 执行一个中继 verb（downlink 收到 event:rpc 后调）。
 * @param {string} verb  白名单之一：state/cwds/taskDetail/workerLog/createTask/message/approve/cancel/complete/uncomplete/toPlan
 * @param {object} [args]
 * @returns {Promise<{ok:true,data:any}|{ok:false,error:string}>} 契约 §4.2 的上行结果体
 */
export async function runVerb(verb, args = {}) {
  // 总开关管一切 relay 能力（含只读，契约 §3）：关到断连之间最长 15s 窗口，这里兜底拒绝
  if (!readConfig().cloudRemoteControl) return { ok: false, error: '远程控制未开启（cloudRemoteControl=false）' };
  try {
    switch (verb) {
      case 'state': return await verbState();
      case 'cwds': return verbCwds();
      case 'taskDetail': return await verbTaskDetail(args);
      case 'workerLog': return verbWorkerLog(args);
      case 'createTask': return verbCreateTask(args);
      case 'message': return verbMessage(args);
      // 以下五个与 platform/server.js 对应路由完全相同的函数调用（状态机自校验，非法迁移原样返回错误）
      case 'approve': return wrapAction(restartTask({ taskKey: str(args?.taskKey), approve: true }));
      case 'cancel': return wrapAction(cancelTask({ taskKey: str(args?.taskKey) }));
      case 'complete': return wrapAction(completeTask({ taskKey: str(args?.taskKey) }));
      case 'uncomplete': return wrapAction(uncompleteTask({ taskKey: str(args?.taskKey) }));
      case 'toPlan': return wrapAction(moveTaskToPlan({ taskKey: str(args?.taskKey) }));
      default: return { ok: false, error: `未知 verb：${String(verb)}` };
    }
  } catch (e) {
    return { ok: false, error: `verb 执行异常：${e.message}` };
  }
}
