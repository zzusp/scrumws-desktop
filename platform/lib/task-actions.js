import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';
import { readConfig } from './runner-config.js';
import { replyCliSession } from './cli-actions.js';
import { startTask, replyTask, cancelTaskSession } from './task-runner.js';

// 生成任务 slug：yyyyMMddHHmmss + 3 位随机（同秒并发也不撞）；来源类型由 taskKey 前缀承载，slug 不带类型标记
function genSlug() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 900 + 100);
  return `${ts}-${rand}`;
}

// 允许的 model 白名单（Q4：用户可选）
const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5',
]);
// claude --effort 合法档位（与 session-manager 同集）
const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// 手动中断任务（标 awaiting-human + outcome=cancelled + kill worker pid；独立 cancelled 态 2026-07-10 废除，
// "谁按的停止键"由 outcome 记录，state 统一走 awaiting-human → 归档即人工处理完毕的出口）
// 顺序：**先写 state.json 后 kill pid** —— 否则 runner 被强杀后 state 停 processing、runner-checker 会当孤儿收纳
export function cancelTask({ taskKey }) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  if (!fs.existsSync(taskDir)) return { ok: false, error: 'task not found' };
  const stateFile = path.join(taskDir, 'state.json');
  const leaseFile = path.join(taskDir, 'lease.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { }
  if (['done', 'awaiting-human'].includes(state.state)) {
    return { ok: false, error: `任务已是终态 ${state.state}、不能中断` };
  }

  // 有活跃 Mode B 会话 → 关会话进程 + 落 awaiting-human/cancelled（跨平台，task-runner 内写盘）
  const viaSession = cancelTaskSession(taskKey);
  if (viaSession.ok) return { ok: true, taskKey, killedPid: viaSession.killed, resolvedAt: viaSession.resolvedAt || null };

  // 无 live 会话（孤儿 / 服务重启后）：直接落 awaiting-human/cancelled + best-effort 杀残留 pid（跨平台 SIGTERM）
  const p2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const nowStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  const history = Array.isArray(state.history) ? state.history : [];
  history.push({ state: 'awaiting-human', at: nowStr, by: 'user' });
  const newState = {
    ...state, state: 'awaiting-human', outcome: 'cancelled', resolvedAt: nowStr, enteredAt: nowStr,
    outcomeDetail: { ...(state.outcomeDetail || {}), failureReason: 'user cancelled', checkerExhausted: false },
    history,
  };
  try { fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2), 'utf8'); }
  catch (e) { return { ok: false, error: `写 state.json 失败: ${e.message}` }; }

  let killedPid = null;
  try {
    if (fs.existsSync(leaseFile)) {
      const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
      const pid = Number(lease.pid || 0);
      if (pid > 0) { try { process.kill(pid, 'SIGTERM'); killedPid = pid; } catch { /* pid 已死 */ } }
      try { fs.unlinkSync(leaseFile); } catch { }
    }
  } catch { /* lease 读失败、忽略 */ }
  return { ok: true, taskKey, killedPid, resolvedAt: nowStr };
}

// 人工确认完成（awaiting-human → done）：人工复查后判定任务其实已完成，落成成功终态。
// 与 worker 自动 done 区分：outcomeDetail.resolvedBy='user'（卡片「人工完成」标据此显示）。
// 仅对 awaiting-human 分身任务；CLI 无可写 state.json / 无 done 态、processing/queued/plan/done 语义不符，一律拒绝。
export function completeTask({ taskKey }) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  if (String(taskKey).startsWith('cli:')) return { ok: false, error: 'CLI 会话无 done 态，不能人工确认完成' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  if (!fs.existsSync(taskDir)) return { ok: false, error: 'task not found' };
  const stateFile = path.join(taskDir, 'state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { }
  if (state.state !== 'awaiting-human') {
    return { ok: false, error: `只有 awaiting-human 任务可人工确认完成（当前 ${state.state || '未知'}）` };
  }

  const p2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const nowStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  const history = Array.isArray(state.history) ? state.history : [];
  history.push({ state: 'done', at: nowStr, by: 'user' });
  const newState = {
    ...state,
    state: 'done',
    outcome: 'success',
    resolvedAt: nowStr,
    enteredAt: nowStr,
    outcomeDetail: {
      ...(state.outcomeDetail || {}),
      resolvedBy: 'user',
      failureReason: null,
    },
    history,
  };
  try { fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2), 'utf8'); }
  catch (e) { return { ok: false, error: `写 state.json 失败: ${e.message}` }; }

  return { ok: true, taskKey, resolvedAt: nowStr };
}

// 取消完成（done → awaiting-human）：completeTask 的逆操作，清 outcome/resolvedBy 退回待人工处理。
// CLI 会话走 watchlist.doneAt（server 按来源分派到 uncompleteCliTask），此处只处理分身任务包。
export function uncompleteTask({ taskKey }) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  if (String(taskKey).startsWith('cli:')) return { ok: false, error: 'CLI 会话取消完成走 watchlist' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  if (!fs.existsSync(taskDir)) return { ok: false, error: 'task not found' };
  const stateFile = path.join(taskDir, 'state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { }
  if (state.state !== 'done') {
    return { ok: false, error: `只有 done 任务可取消完成（当前 ${state.state || '未知'}）` };
  }
  const p2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const nowStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  const history = Array.isArray(state.history) ? state.history : [];
  history.push({ state: 'awaiting-human', at: nowStr, by: 'user' });
  const newState = {
    ...state,
    state: 'awaiting-human',
    outcome: null,
    resolvedAt: nowStr,
    enteredAt: nowStr,
    outcomeDetail: { ...(state.outcomeDetail || {}), resolvedBy: null, failureReason: null },
    history,
  };
  try { fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2), 'utf8'); }
  catch (e) { return { ok: false, error: `写 state.json 失败: ${e.message}` }; }
  return { ok: true, taskKey, state: 'awaiting-human' };
}

// 回复任务：CLI 会话走 cli-reply-runner（观察侧，另一功能）；其余走 Mode B（复用 live 会话 / --resume 重挂）
export function replyToTask({ taskKey, message, model }) {
  if (String(taskKey || '').startsWith('cli:')) return replyCliSession({ taskKey, message, model });
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'message required' };
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  if (!fs.existsSync(taskDir)) return { ok: false, error: 'task not found（归档任务请先取消归档再回复）' };
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8')); } catch { }
  if (state?.state === 'processing') return { ok: false, error: '任务正在处理中（state=processing），等它跑完再回复' };
  if (model && !ALLOWED_MODELS.has(model)) {
    return { ok: false, error: `model 不在白名单：${Array.from(ALLOWED_MODELS).join(', ')}` };
  }
  // 走 Mode B：live 会话在则复用续轮 / 会话已死则 --resume 重挂（task-runner 内写 state=processing + lease）
  return replyTask(taskKey, msg, model);
}

// 重新发起 / 确认执行：起绑定该任务的 Mode B 会话执行（→processing）。
// restart 对 awaiting-human/queued（中断后 / 新建入队未起）；approve=true 对 plan（用户确认后执行）。
// task-runner.startTask 内含「已有活跃会话则拒绝」防双跑；无 .ps1、无 source 分支——一律 Mode B 引擎。
export function restartTask({ taskKey, approve = false }) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  if (!fs.existsSync(taskDir)) {
    const archDir = path.join(P.archiveRoot, safeKey);
    if (fs.existsSync(archDir)) return { ok: false, error: '任务已归档、不能重新发起（如需重试请先取消归档）' };
    return { ok: false, error: 'task not found' };
  }
  if (!fs.existsSync(path.join(taskDir, 'task.json'))) return { ok: false, error: '任务无 task.json、无法重新发起' };
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8')); } catch { }
  // approve 只对 plan（待确认 → 执行）；restart 只对 awaiting-human/queued。其他态语义混乱、拒绝
  const allowed = approve ? ['plan'] : ['awaiting-human', 'queued'];
  if (!allowed.includes(state?.state)) {
    return { ok: false, error: `当前 state=${state?.state || '?'}、不能${approve ? '确认执行' : '重新发起'}（仅允许 ${allowed.join('/')}）` };
  }
  const r = startTask(taskKey);
  if (!r.ok) return r;
  return { ok: true, taskKey, spawned: true, sessionUiId: r.sessionUiId };
}

// 现有任务（runner-state + archive）的 task.json.cwd 去重列表 —— 新建任务「选已有工作目录」下拉用
export function taskCwds() {
  const seen = new Set();
  for (const root of [P.runnerRoot, P.archiveRoot]) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const name of dirs) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(root, name, 'task.json'), 'utf8'));
        const c = String(t?.cwd || '').trim();
        if (c) seen.add(c);
      } catch { /* 跳过坏包 */ }
    }
  }
  return [...seen];
}

// 新增任务（推送式）：任意来源调 API / CLI / 看板「新建任务」把任务推进来。
// state 由任务信息决定：plan(需用户确认) / queued(可跑)。**queued 即自动起绑定该任务的 Mode B 会话执行**
// （→processing，见 task-runner.startTask）；plan 待用户 approve 再起。跨平台，一个入口一套处理逻辑。
// source（缺省 manual）：任意 [A-Za-z0-9_-] 标签，承载在 taskKey 前缀（<source>:<slug>），仅作展示/回复路由。
// cwd（可选）：claude 工作目录，校验存在且是目录后写进 task.json.cwd。effort（可选）：reasoning 档位。
export function createTask({ source, title, prompt, model, description, plan, cwd, effort }) {
  const src = String(source || 'manual').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(src)) return { ok: false, error: `非法 source：${src}（仅 [A-Za-z0-9_-]、首字符字母数字）` };
  const t = String(title || '').trim();
  const p = String(prompt || '').trim();
  const m = String(model || readConfig().defaultModel || 'claude-opus-4-7').trim();
  const desc = String(description || '').trim().slice(0, 2000);
  const eff = String(effort || '').trim();
  if (!t) return { ok: false, error: 'title required' };
  if (!p) return { ok: false, error: 'prompt required' };
  if (!ALLOWED_MODELS.has(m)) return { ok: false, error: `model 不在白名单：${Array.from(ALLOWED_MODELS).join(', ')}` };
  if (eff && !ALLOWED_EFFORTS.has(eff)) return { ok: false, error: `effort 不在白名单：${Array.from(ALLOWED_EFFORTS).join(', ')}` };
  // cwd 可选：给了就必须存在且是目录（避免建出跑不起来的任务）
  let cwdFinal = null;
  const cwdRaw = String(cwd || '').trim();
  if (cwdRaw) {
    let st = null;
    try { st = fs.statSync(cwdRaw); } catch { return { ok: false, error: `工作目录不存在：${cwdRaw}` }; }
    if (!st.isDirectory()) return { ok: false, error: `工作目录不是文件夹：${cwdRaw}` };
    cwdFinal = path.resolve(cwdRaw);
  }

  const slug = genSlug();
  const taskKey = `${src}:${slug}`;
  const safeTaskKey = `${src}__${slug}`;   // 对齐 safeKey 约定：taskKey 的 ':' 折成 '__'
  const taskDir = path.join(P.runnerRoot, safeTaskKey);
  // 用本地时间（与 PowerShell 侧的 yyyy-MM-dd HH:mm:ss 对齐；避免 UTC 偏差）
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const nowStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;

  // state = plan(需确认) / queued(可跑)：由 plan 标志或 runner-config.planSources 含该 source 决定
  const cfg = readConfig();
  const planFirst = !!plan || (Array.isArray(cfg.planSources) && cfg.planSources.includes(src));
  const initState = planFirst ? 'plan' : 'queued';

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    // task.json（description = 纯用户备注，不进 prompt）
    const taskJson = {
      taskKey, source: src, title: t, prompt: p, model: m,
      mode: 'single', metaMode: 'overwrite', createdAt: nowStr,
    };
    if (cwdFinal) taskJson.cwd = cwdFinal;
    if (eff) taskJson.effort = eff;
    if (desc) taskJson.description = desc;
    fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(taskJson, null, 2), 'utf8');
    // state.json = plan（先计划，用户确认后执行）或 queued（即将自动起会话）
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      state: initState, enteredAt: nowStr, outcome: null, resolvedAt: null,
      outcomeDetail: { quotaResetAt: null, failureReason: null, checkerExhausted: false },
      history: [{ state: initState, at: nowStr, by: `create:${src}` }],
    }, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: `建任务包失败: ${e.message}` };
  }

  // queued → 立即起绑定该任务的 Mode B 会话执行（→processing）；plan 待 approve。
  // 起会话失败（如 claude 不可用）不回滚任务，留在 queued 供用户「重新发起」重试。
  if (initState === 'queued') {
    const started = startTask(taskKey);
    if (started.ok) return { ok: true, taskKey, state: 'processing', spawned: true, sessionUiId: started.sessionUiId };
    return { ok: true, taskKey, state: initState, spawned: false, startError: started.error };
  }
  return { ok: true, taskKey, state: initState, spawned: false };
}

// 读 plan 态任务的可编辑字段（看板「编辑」弹窗回填用）：仅 plan 且非归档可编辑。
// title 取生效标题（customTitle 优先，与卡片展示一致）；prompt/model/cwd/description 原样回填。
export function readTaskEdit(taskKey) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  if (!fs.existsSync(taskDir)) return { ok: false, error: 'task not found' };
  let state = null; let task = {};
  try { state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8')); } catch { }
  try { task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')); } catch { }
  if (state?.state !== 'plan') return { ok: false, error: `只有 plan 态任务可编辑（当前 ${state?.state || '未知'}）` };
  return {
    ok: true,
    taskKey,
    source: task.source || String(taskKey).split(':')[0] || 'manual',
    state: state.state,
    title: task.customTitle || task.title || '',
    prompt: task.prompt || '',
    model: task.model || '',
    cwd: task.cwd || '',
    description: task.description || '',
  };
}

// 编辑 plan 态任务：改写 task.json 的 title/prompt/model/cwd/description（prompt 是确认排队后真正发给 claude 的指令）。
// 仅 plan 且非归档可编辑（已 queued/processing/收敛的任务不给改）。复用 createTask 同套校验（model 白名单、cwd 必须存在目录）。
// 编辑后 title 落 task.title 且清 customTitle（编辑即权威标题）；effort 表单不涉及、保留原值不动。
export function editTask({ taskKey, title, prompt, model, description, cwd }) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  if (!fs.existsSync(taskDir)) return { ok: false, error: 'task not found' };
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8')); } catch { }
  if (state?.state !== 'plan') return { ok: false, error: `只有 plan 态任务可编辑（当前 ${state?.state || '未知'}）` };

  const t = String(title || '').trim();
  const p = String(prompt || '').trim();
  const m = String(model || '').trim();
  const desc = String(description || '').trim().slice(0, 2000);
  if (!t) return { ok: false, error: 'title required' };
  if (!p) return { ok: false, error: 'prompt required' };
  if (!ALLOWED_MODELS.has(m)) return { ok: false, error: `model 不在白名单：${Array.from(ALLOWED_MODELS).join(', ')}` };
  // cwd 可选：给了就必须存在且是目录（对齐 createTask，避免改出跑不起来的任务）
  let cwdFinal = null;
  const cwdRaw = String(cwd || '').trim();
  if (cwdRaw) {
    let st = null;
    try { st = fs.statSync(cwdRaw); } catch { return { ok: false, error: `工作目录不存在：${cwdRaw}` }; }
    if (!st.isDirectory()) return { ok: false, error: `工作目录不是文件夹：${cwdRaw}` };
    cwdFinal = path.resolve(cwdRaw);
  }

  const taskFile = path.join(taskDir, 'task.json');
  let task = {};
  try { task = JSON.parse(fs.readFileSync(taskFile, 'utf8')); } catch { }
  task.title = t;
  delete task.customTitle;   // 编辑弹窗的标题即权威值，避免 rename 写的 customTitle 遮盖
  task.prompt = p;
  task.model = m;
  if (desc) task.description = desc; else delete task.description;
  if (cwdFinal) task.cwd = cwdFinal; else delete task.cwd;
  task.taskKey = task.taskKey || taskKey;
  try { fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8'); }
  catch (e) { return { ok: false, error: `写 task.json 失败: ${e.message}` }; }
  return { ok: true, taskKey, state: 'plan' };
}
