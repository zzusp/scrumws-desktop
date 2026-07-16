import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';
import { parse } from './timeutil.js';
import { readConfig } from './runner-config.js';
import { replyCliSession, rewindCliSession, truncateSessionJsonlByUuid } from './cli-actions.js';
import { tryStartOrQueue, replyTask, cancelTaskSession, parkTaskSession } from './task-runner.js';
import { readCcSessionForAdopt, completeCliSession, uncompleteCliTask } from './logs.js';
import { readAttachedSessions, locateJsonlBySid } from './collect-cli.js';
import { readWatchlist, removeWatchlist } from './cli-watchlist.js';
import { detectWorktreeBase } from './git.js';

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

// 规范化「附加本地文件」路径数组：字符串、trim、去空、去重、限量；不校验文件系统存在性
//（选时由 Electron dialog 保证存在，执行时若已删由 claude Read 自行报错——比 plan 保存时强校验更鲁棒）
const MAX_ATTACHMENTS = 20;
function normalizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const p = String(raw || '').trim();
    if (!p || p.length > 1000 || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

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

// 移除 plan 态任务（从未 spawn 的计划草稿）：直接删除任务包目录。
// 仅限 plan——已排队/运行/收敛的任务有真实执行记录，不走删除（用中断/归档）。
export function deleteTask({ taskKey }) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  // 不按 source 特判：物化后的 CLI 任务有 meta.sessionId，会被下面「已执行过→改归档」guard 挡下；未物化 CLI 无包→
  // 落到「task not found」。删除只对「plan 且无 sessionId」的纯草稿放行（见下）。
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  if (!fs.existsSync(taskDir)) return { ok: false, error: 'task not found' };
  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8')); } catch { }
  if (state.state !== 'plan') {
    return { ok: false, error: `state=${state.state || '?'} 非 plan，不能移除（用中断/归档）` };
  }
  // 跑过的任务（有会话记录，如从 待人工/完成 退回 plan 的）不走删除——会毁掉可 --resume 的执行记录；改用归档。
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf8')); } catch { }
  if (meta?.sessionId) return { ok: false, error: '该任务已执行过（有会话记录），不能移除；如要清走请用归档' };
  try { fs.rmSync(taskDir, { recursive: true, force: true }); }
  catch (e) { return { ok: false, error: `删除任务目录失败: ${e.message}` }; }
  return { ok: true, taskKey, safeKey, removed: taskDir };
}

// 人工确认完成（awaiting-human → done）：人工复查后判定任务其实已完成，落成成功终态。
// 与 worker 自动 done 区分：outcomeDetail.resolvedBy='user'（卡片「人工完成」标据此显示）。
// 仅对 awaiting-human 分身任务；CLI 无可写 state.json / 无 done 态、processing/queued/plan/done 语义不符，一律拒绝。
export function completeTask({ taskKey }) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  // 无任务包：未物化的 CLI 会话 → 走 watchlist doneAt（与 collect-cli 判态一致）；物化后有包，走下面统一路径
  if (!fs.existsSync(taskDir)) {
    if (String(taskKey).startsWith('cli:')) return completeCliSession(taskKey);
    return { ok: false, error: 'task not found' };
  }
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
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  // 无任务包：未物化的 CLI 会话 → 清 watchlist.doneAt；物化后有包，走下面统一路径
  if (!fs.existsSync(taskDir)) {
    if (String(taskKey).startsWith('cli:')) return uncompleteCliTask(taskKey);
    return { ok: false, error: 'task not found' };
  }
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

// 把被旁观的 CLI 会话「物化」成一等托管任务包（runner-state/<key>/），使其后续走与其它来源完全一致的状态机
// （退回计划 / 完成 / 回复 / 编辑…）。source 仍标 'cli'（仅展示元数据，不改行为——见 README「任务来源不变量」）；
// sessionId 落 meta 供确认执行时 --resume 续上之前的对话；task.cwd 取会话原目录，保 --resume 定位到同一 CC 项目目录。
// 从 watchlist 摘除该 sid（去重：collect-cli 不再出这张卡，改由 runner-state 包出卡）。终端仍占用该会话时拒绝
// （对齐 /api/session/adopt 的 guard：两个 claude 抢同一 session 会撞车）。
export function materializeCliTask(taskKey, { state = 'plan' } = {}) {
  const shortSid = String(taskKey).slice(4);   // 'cli:xxxxxxxx' → 'xxxxxxxx'
  const w = readWatchlist();
  const found = Object.entries(w.sessions).find(([sid]) => sid.startsWith(shortSid));
  if (!found) return { ok: false, error: 'cli session not in watchlist' };
  const [fullSid, entry] = found;
  const att = readAttachedSessions().get(fullSid);
  if (att) return { ok: false, error: `session 正被终端进程占用（pid=${att.pid}），请先关闭该终端窗口再操作` };
  const hist = readCcSessionForAdopt(fullSid);
  if (!hist.ok) return hist;
  const textOf = (m) => {
    if (!m) return '';
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.text || '')).join(' ').trim();
    return '';
  };
  const firstUser = (hist.messages || []).find((m) => m.role === 'user' && !m.isMeta);
  const lastUser = [...(hist.messages || [])].reverse().find((m) => m.role === 'user' && !m.isMeta);
  const title = (entry.customTitle || textOf(firstUser) || shortSid).slice(0, 200);
  const prompt = (textOf(lastUser) || title).slice(0, 100000);   // 续跑起点，用户可在编辑里改写

  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');   // cli:xxxx → cli__xxxx
  const taskDir = path.join(P.runnerRoot, safeKey);
  const p2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const nowStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    const taskJson = { taskKey, source: 'cli', title, prompt, mode: 'single', metaMode: 'overwrite', createdAt: nowStr };
    if (hist.model) taskJson.model = hist.model;
    const meta = { sessionId: fullSid };
    // 工作目录不变量：task.cwd 只存 base 仓库根。会话跑在 worktree 里时，worktree 路径进 meta.worktreeDir，
    // 并置 task.worktree=true —— 确认执行时 resolveRunCwd 据 meta.worktreeDir --resume 回到同一 worktree（否则会跑错目录）。
    if (hist.cwd) {
      const wt = detectWorktreeBase(hist.cwd);
      taskJson.cwd = wt.baseCwd;
      if (wt.isWorktree) {
        taskJson.worktree = true;
        meta.worktreeDir = hist.cwd;
      }
      meta.cwd = hist.cwd;   // 保留会话实际运行 cwd（历史字段）
    }
    fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(taskJson, null, 2), 'utf8');
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      state, enteredAt: nowStr, outcome: null, resolvedAt: null,
      outcomeDetail: { quotaResetAt: null, failureReason: null, checkerExhausted: false },
      history: [{ state, at: nowStr, by: 'user:materialize-cli' }],
    }, null, 2), 'utf8');
    if (hist.gitBranch) meta.gitBranch = hist.gitBranch;
    fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: `物化 CLI 任务包失败: ${e.message}` };
  }
  removeWatchlist(fullSid);   // 去重：改由 runner-state 包出卡
  return { ok: true, taskKey, state, materialized: true, sessionId: fullSid };
}

// 退回计划（awaiting-human/done → plan）：把终态任务退回 plan 桶，供编辑配置 / 改期后重新执行。
// 关掉可能仍空转的 Mode B 会话（释放 claude 进程）但**保留 meta.sessionId**——之后确认执行时 startTask 据它
// --resume 续上之前的对话。CLI 会话（尚无任务包）→ 先物化成一等托管任务、直接落 plan 桶（不再按来源特判拒绝）。
export function moveTaskToPlan({ taskKey }) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  // CLI 会话未物化（无任务包）→ 物化成托管任务并直接落 plan（source 仍 'cli'，仅元数据）
  if (String(taskKey).startsWith('cli:') && !fs.existsSync(taskDir)) {
    return materializeCliTask(taskKey, { state: 'plan' });
  }
  if (!fs.existsSync(taskDir)) return { ok: false, error: 'task not found（归档任务请先取消归档再退回计划）' };
  const stateFile = path.join(taskDir, 'state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { }
  if (!['awaiting-human', 'done'].includes(state.state)) {
    return { ok: false, error: `只有 待人工/完成 任务可退回计划（当前 ${state.state || '未知'}）` };
  }
  // 先关空转会话 + 删 lease（parkTaskSession 精准解绑，'closed' 事件不会翻回 awaiting-human）
  parkTaskSession(taskKey);

  const p2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const nowStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  const history = Array.isArray(state.history) ? state.history : [];
  history.push({ state: 'plan', at: nowStr, by: 'user' });
  const newState = {
    ...state,
    state: 'plan',
    outcome: null,
    resolvedAt: null,
    enteredAt: nowStr,
    outcomeDetail: { quotaResetAt: null, failureReason: null, checkerExhausted: false },
    history,
  };
  try { fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2), 'utf8'); }
  catch (e) { return { ok: false, error: `写 state.json 失败: ${e.message}` }; }
  return { ok: true, taskKey, state: 'plan' };
}

// 回复任务：package-first——有任务包（含物化 CLI）走 Mode B（复用 live 会话 / --resume 重挂）；未物化的 CLI 会话
// （无包）才走观察侧 cli-reply-runner。effort：per-reply reasoning 档位覆盖（仅 --resume 重挂新会话时生效）。
export function replyToTask({ taskKey, message, model, effort, attachments }) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  // 未物化的 CLI 会话（无任务包）→ 观察侧 replyCliSession；有包一律走下面统一的 Mode B 路径
  if (String(taskKey).startsWith('cli:') && !fs.existsSync(taskDir)) return replyCliSession({ taskKey, message, model });
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'message required' };
  if (!fs.existsSync(taskDir)) return { ok: false, error: 'task not found（归档任务请先取消归档再回复）' };
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8')); } catch { }
  if (state?.state === 'processing') return { ok: false, error: '任务正在处理中（state=processing），等它跑完再回复' };
  if (model && !ALLOWED_MODELS.has(model)) {
    return { ok: false, error: `model 不在白名单：${Array.from(ALLOWED_MODELS).join(', ')}` };
  }
  const eff = String(effort || '').trim();
  if (eff && !ALLOWED_EFFORTS.has(eff)) {
    return { ok: false, error: `effort 不在白名单：${Array.from(ALLOWED_EFFORTS).join(', ')}` };
  }
  // 走 Mode B：live 会话在则复用续轮 / 会话已死则 --resume 重挂（task-runner 内写 state=processing + lease）
  return replyTask(taskKey, msg, model, eff || undefined, normalizeAttachments(attachments));
}

// 改写重跑（原地 rewind）：改写某条历史 user 消息、从那里替换重跑（该消息及之后的时间线丢弃，对齐 CC 交互 double-Esc）。
// 统一入口——不按 source 特判，只按「有无任务包」这一真实能力差异分支：
//   · 观察态 CLI 会话（cli: 无包）→ rewindCliSession 截断，前端收养成 live 会话重跑（hosted:false）。
//   · 托管任务（有包，含物化 cli / manual / api）→ park 空转会话 + 截断 + replyTask 从截断处 --resume 重跑（hosted:true）。
export function rewindTaskMessage({ taskKey, uuid, message } = {}) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'message required' };
  if (!uuid || !/^[a-f0-9-]{36}$/i.test(String(uuid))) return { ok: false, error: 'invalid uuid（目标消息）' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  const hasPackage = fs.existsSync(taskDir);

  // 观察态 CLI 会话（cli: 且无任务包）→ 观察侧截断，前端收养成 live 会话重跑
  if (String(taskKey).startsWith('cli:') && !hasPackage) {
    const r = rewindCliSession({ taskKey, uuid, message: msg });
    return r.ok ? { ...r, hosted: false } : r;
  }

  // 托管任务（有包）
  if (!hasPackage) return { ok: false, error: 'task not found（归档任务请先取消归档再改写重跑）' };
  let state = null, meta = null;
  try { state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8')); } catch { }
  try { meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf8')); } catch { }
  if (state?.state === 'processing') return { ok: false, error: '任务正在处理中（state=processing），等它跑完 / 停下再改写重跑' };
  const sid = meta?.sessionId || null;
  if (!sid) return { ok: false, error: '该任务无 sessionId，无法改写重跑（会话从未成功起过，请重新发起）' };

  const located = locateJsonlBySid(sid);
  if (!located || !located.jsonlPath || !fs.existsSync(located.jsonlPath)) {
    return { ok: false, error: 'session jsonl 未找到（历史久远或已被清）' };
  }
  // guard：sid 被活终端进程占用 → 拒绝（双进程写同一 session 会撞）
  const att = readAttachedSessions().get(sid);
  if (att) return { ok: false, error: `session 正被终端进程占用（pid=${att.pid}），不能改写历史` };

  // 关掉可能仍存活的 idle Mode B 会话——否则 replyTask 会复用旧进程，其内存里是截断前的全量上下文、rewind 不生效
  parkTaskSession(taskKey);
  // 截断 jsonl 到目标消息之前（原时间线丢弃、不备份）
  const tr = truncateSessionJsonlByUuid(located.jsonlPath, uuid);
  if (!tr.ok) return tr;
  // 从截断处 --resume 重跑改写后的消息（无 live 会话 → --resume + 截断后的历史 seed；task-runner 写 state=processing + lease）
  const rr = replyTask(taskKey, msg);
  return rr.ok ? { ...rr, hosted: true } : rr;
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
  // 受并发上限约束：满则落 queued 等排空（名额释放自动放行）
  const r = tryStartOrQueue(taskKey);
  if (!r.ok) return r;
  if (r.queued) return { ok: true, taskKey, spawned: false, queued: true };
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
// scheduledAt（可选）：定时执行时刻（本地串），到点由调度器把 plan 提升为执行；给了则强制 plan。
// worktree/baseBranch（可选）：git 项目下隔离 worktree 运行 + 签出基分支。dynamicWorkflow（可选）：动态工作流开关。
export function createTask({ source, title, prompt, model, description, plan, cwd, effort, scheduledAt, worktree, baseBranch, dynamicWorkflow, attachments }) {
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
  // scheduledAt 可选：给了必须能解析成时刻；有定时 = 必然 plan（到点才执行）
  const schedRaw = String(scheduledAt || '').trim();
  if (schedRaw && !parse(schedRaw)) return { ok: false, error: `定时时间无法解析：${schedRaw}` };
  const wantWorktree = !!worktree;
  const baseBr = String(baseBranch || '').trim();
  const dynFlow = dynamicWorkflow == null ? null : !!dynamicWorkflow;
  const attachList = normalizeAttachments(attachments);

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
  // 有定时 = 必然先存 plan（到点由调度器提升执行）；其余按 plan 标志 / planSources 决定
  const planFirst = !!plan || !!schedRaw || (Array.isArray(cfg.planSources) && cfg.planSources.includes(src));
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
    if (schedRaw) taskJson.scheduledAt = schedRaw;
    // worktree 与签出基分支相互独立：不勾 worktree 也可单独设签出基分支（起会话前直接在工作目录本身签出+拉取最新，见 task-runner.resolveRunCwd）
    if (wantWorktree) taskJson.worktree = true;
    if (baseBr) taskJson.baseBranch = baseBr;
    if (dynFlow != null) taskJson.dynamicWorkflow = dynFlow;
    if (attachList.length) taskJson.attachments = attachList;   // 附加本地文件：绝对路径数组，startTask 拼进首轮 prompt
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
    const started = tryStartOrQueue(taskKey);   // 受并发上限约束：满则留 queued 等排空
    if (started.ok && started.spawned) return { ok: true, taskKey, state: 'processing', spawned: true, sessionUiId: started.sessionUiId };
    if (started.ok && started.queued) return { ok: true, taskKey, state: 'queued', spawned: false, capped: true };
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
  let state = null; let task = {}; let meta = null;
  try { state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8')); } catch { }
  try { task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')); } catch { }
  try { meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf8')); } catch { }
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
    effort: task.effort || '',
    scheduledAt: task.scheduledAt || '',
    worktree: !!task.worktree,
    baseBranch: task.baseBranch || '',
    dynamicWorkflow: task.dynamicWorkflow == null ? null : !!task.dynamicWorkflow,
    attachments: Array.isArray(task.attachments) ? task.attachments : [],
    // 有会话记录（从 待人工/完成 退回来的）→ 工作目录 / worktree 锁定：改了会让确认执行的 --resume 找不到原会话
    resumeLocked: !!meta?.sessionId,
  };
}

// 编辑 plan 态任务：改写 task.json 的 title/prompt/model/cwd/description + effort/scheduledAt/worktree/baseBranch/dynamicWorkflow。
// 仅 plan 且非归档可编辑（已 queued/processing/收敛的任务不给改）。复用 createTask 同套校验（model/effort 白名单、cwd 必须存在目录）。
// 编辑后 title 落 task.title 且清 customTitle（编辑即权威标题）。
export function editTask({ taskKey, title, prompt, model, description, cwd, effort, scheduledAt, worktree, baseBranch, dynamicWorkflow, attachments }) {
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
  const eff = String(effort || '').trim();
  const schedRaw = String(scheduledAt || '').trim();
  const baseBr = String(baseBranch || '').trim();
  const dynFlow = dynamicWorkflow == null ? null : !!dynamicWorkflow;
  if (!t) return { ok: false, error: 'title required' };
  if (!p) return { ok: false, error: 'prompt required' };
  if (!ALLOWED_MODELS.has(m)) return { ok: false, error: `model 不在白名单：${Array.from(ALLOWED_MODELS).join(', ')}` };
  if (eff && !ALLOWED_EFFORTS.has(eff)) return { ok: false, error: `effort 不在白名单：${Array.from(ALLOWED_EFFORTS).join(', ')}` };
  if (schedRaw && !parse(schedRaw)) return { ok: false, error: `定时时间无法解析：${schedRaw}` };
  // 有会话记录（从 待人工/完成 退回来的）→ 锁定 cwd/worktree/baseBranch：这些决定 --resume 去哪个项目目录找原
  // 会话 jsonl，改了续接就失效。锁定时沿用 task.json 原值、不校验也不改（前端也已禁用这些字段兜底）。
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf8')); } catch { }
  const locked = !!meta?.sessionId;
  // cwd 可选：给了就必须存在且是目录（对齐 createTask，避免改出跑不起来的任务）；锁定时跳过校验（沿用原值）
  let cwdFinal = null;
  if (!locked) {
    const cwdRaw = String(cwd || '').trim();
    if (cwdRaw) {
      let st = null;
      try { st = fs.statSync(cwdRaw); } catch { return { ok: false, error: `工作目录不存在：${cwdRaw}` }; }
      if (!st.isDirectory()) return { ok: false, error: `工作目录不是文件夹：${cwdRaw}` };
      cwdFinal = path.resolve(cwdRaw);
    }
  }

  const taskFile = path.join(taskDir, 'task.json');
  let task = {};
  try { task = JSON.parse(fs.readFileSync(taskFile, 'utf8')); } catch { }
  task.title = t;
  delete task.customTitle;   // 编辑弹窗的标题即权威值，避免 rename 写的 customTitle 遮盖
  task.prompt = p;
  task.model = m;
  if (desc) task.description = desc; else delete task.description;
  if (eff) task.effort = eff; else delete task.effort;
  if (schedRaw) task.scheduledAt = schedRaw; else delete task.scheduledAt;
  // 锁定时不动 task.cwd/worktree/baseBranch（保原值）；否则按提交值改写
  if (!locked) {
    if (cwdFinal) task.cwd = cwdFinal; else delete task.cwd;
    // worktree 与签出基分支相互独立：不勾 worktree 也可单独设签出基分支
    if (cwdFinal && worktree) task.worktree = true; else delete task.worktree;
    if (cwdFinal && baseBr) task.baseBranch = baseBr; else delete task.baseBranch;
  }
  if (dynFlow != null) task.dynamicWorkflow = dynFlow; else delete task.dynamicWorkflow;
  const attachList = normalizeAttachments(attachments);
  if (attachList.length) task.attachments = attachList; else delete task.attachments;
  task.taskKey = task.taskKey || taskKey;
  try { fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8'); }
  catch (e) { return { ok: false, error: `写 task.json 失败: ${e.message}` }; }
  return { ok: true, taskKey, state: 'plan' };
}
