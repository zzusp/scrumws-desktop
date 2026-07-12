import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { P, ROOT } from './paths.js';
import { readConfig } from './runner-config.js';
import { leaseAlive } from './lease.js';
import { replyCliSession } from './cli-actions.js';

// Node child_process 在 Windows 不搜 PATH；hardcode pwsh 完整路径（fallback 到 shell:true 找）
const PWSH_CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
];
const PWSH_EXE = PWSH_CANDIDATES.find((p) => fs.existsSync(p)) || 'pwsh';

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

  // ① 先写 state.json（awaiting-human + outcome=cancelled + resolvedAt + failureReason='user cancelled'）
  const p2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const nowStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  const history = Array.isArray(state.history) ? state.history : [];
  history.push({ state: 'awaiting-human', at: nowStr, by: 'user' });
  const newState = {
    ...state,
    state: 'awaiting-human',
    outcome: 'cancelled',
    resolvedAt: nowStr,
    enteredAt: nowStr,
    outcomeDetail: {
      ...(state.outcomeDetail || {}),
      failureReason: 'user cancelled',
      checkerExhausted: false,
    },
    history,
  };
  try { fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2), 'utf8'); }
  catch (e) { return { ok: false, error: `写 state.json 失败: ${e.message}` }; }

  // ② 若有活 pid 强杀 worker
  let killedPid = null;
  try {
    if (fs.existsSync(leaseFile)) {
      const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
      const pid = Number(lease.pid || 0);
      if (pid > 0) {
        try {
          process.kill(pid, 0);   // 存活检测
          // taskkill /F /PID 强杀（PowerShell 侧 finally 跑不到、但 state 已落定）
          const kill = spawn('taskkill.exe', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
          kill.unref();
          killedPid = pid;
        } catch (e) { /* pid 已死、跳过 */ }
      }
      // 删 lease 避免存活判据混乱
      try { fs.unlinkSync(leaseFile); } catch { }
    }
  } catch (e) { /* lease 读失败、忽略 */ }

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

// 回复任务（跨 chat/issue/manual/cli）：分身走 reply-runner --resume；CLI 会话走 cli-reply-runner
export function replyToTask({ taskKey, message, model }) {
  if (String(taskKey || '').startsWith('cli:')) return replyCliSession({ taskKey, message, model });
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'message required' };
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  let taskDir = path.join(P.runnerRoot, safeKey);
  if (!fs.existsSync(taskDir)) {
    const archDir = path.join(P.archiveRoot, safeKey);
    if (fs.existsSync(archDir)) taskDir = archDir;
    else return { ok: false, error: 'task not found' };
  }
  const stateFile = path.join(taskDir, 'state.json');
  const metaFile = path.join(taskDir, 'meta.json');
  const leaseFile = path.join(taskDir, 'lease.json');
  if (!fs.existsSync(metaFile)) return { ok: false, error: '任务无 meta.json（未真跑过 claude、无 sessionId 可 resume）' };
  let state = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { }
  if (state?.state === 'processing') return { ok: false, error: '任务正在处理中（state=processing），等它跑完再回复' };
  // model 若指定则校验白名单
  if (model && !ALLOWED_MODELS.has(model)) {
    return { ok: false, error: `model 不在白名单：${Array.from(ALLOWED_MODELS).join(', ')}` };
  }
  // ---- 唤醒过渡：先写 state=queued + 占位 lease，让看板立即看到过渡态 ----
  const p2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const nowStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  try {
    const base = state || {};
    const history = Array.isArray(base.history) ? base.history : [];
    history.push({ state: 'queued', at: nowStr, by: 'user-reply' });
    fs.writeFileSync(stateFile, JSON.stringify({
      ...base,
      state: 'queued',
      outcome: null,
      resolvedAt: null,
      enteredAt: nowStr,
      history,
    }, null, 2), 'utf8');
    // 占位 lease（pid=0；reply-runner 起来后 Beat 会覆盖为真 pid）；claimedAt 决定 <2min 宽限期
    fs.writeFileSync(leaseFile, JSON.stringify({
      taskKey, claimedAt: nowStr, pid: 0, heartbeatAt: nowStr,
    }), 'utf8');
  } catch (e) {
    return { ok: false, error: `唤醒过渡写盘失败: ${e.message}` };
  }
  const spawnLog = path.join(P.tmpDir, 'manual-spawn.log');
  try {
    const errFd = fs.openSync(spawnLog, 'a');
    fs.writeSync(errFd, `\n[${new Date().toISOString()}] reply ${taskKey} via ${PWSH_EXE}\n`);
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(ROOT, 'scripts', 'reply-runner.ps1'),
      '-TaskKey', taskKey,
      '-Message', msg,
    ];
    if (model) { args.push('-Model'); args.push(model); }
    const psi = spawn(PWSH_EXE, args, {
      cwd: ROOT,
      detached: false,
      stdio: ['ignore', errFd, errFd],
      windowsHide: true,
      shell: PWSH_EXE === 'pwsh',
    });
    psi.unref();
    fs.closeSync(errFd);
  } catch (e) {
    return { ok: false, error: `spawn 失败: ${e.message}` };
  }
  return { ok: true, taskKey, spawned: true };
}

// 重新发起任务：把 awaiting-human/queued 归零回 queued，直接 spawn 对应 source 的 worker 脚本一次
// 与 replyToTask 的区别：不走 meta.sessionId --resume（无 sessionId 场景专用）；
// queued 场景 = 新建入队 / 中断后回排队（推送式无自动执行，全靠用户从看板拉起）；
// state.pendingResumeSessionId 经 ...base spread 保留，worker 起来会自动 --resume 续）
// approve=true：plan → queued 的用户确认动作（同样立即 spawn），history 记 user-approve
export function restartTask({ taskKey, approve = false }) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(String(taskKey || ''))) return { ok: false, error: 'invalid taskKey' };
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const taskDir = path.join(P.runnerRoot, safeKey);
  if (!fs.existsSync(taskDir)) {
    // 归档过的不允许 restart（归档=最终态）
    const archDir = path.join(P.archiveRoot, safeKey);
    if (fs.existsSync(archDir)) return { ok: false, error: '任务已归档、不能重新发起（如需重试请从归档手动恢复目录）' };
    return { ok: false, error: 'task not found' };
  }
  const stateFile = path.join(taskDir, 'state.json');
  const taskFile = path.join(taskDir, 'task.json');
  const leaseFile = path.join(taskDir, 'lease.json');
  if (!fs.existsSync(taskFile)) return { ok: false, error: '任务无 task.json、无法重新发起' };
  let state = null;
  let task = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { }
  try { task = JSON.parse(fs.readFileSync(taskFile, 'utf8')); } catch { return { ok: false, error: 'task.json 解析失败' }; }
  // approve 只对 plan（待确认 → 排队）；restart 只对 awaiting-human/queued。其他态语义混乱、拒绝
  const allowed = approve ? ['plan'] : ['awaiting-human', 'queued'];
  if (!allowed.includes(state?.state)) {
    return { ok: false, error: `当前 state=${state?.state || '?'}、不能${approve ? '确认排队' : '重新发起'}（仅允许 ${allowed.join('/')}）` };
  }
  // queued 且 lease 存活 = worker 正在起/在跑，重发会双 worker 撞车
  if (state?.state === 'queued' && fs.existsSync(leaseFile)) {
    try {
      const l = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
      if (leaseAlive(l)) return { ok: false, error: 'queued 且 lease 存活（worker 正在起/在跑）、不能重新发起' };
    } catch { /* lease 读失败视为死 */ }
  }
  // 挑 worker 脚本（source: chat/issue/manual）
  const source = task.source || (taskKey.startsWith('chat:') ? 'chat' : taskKey.startsWith('issue:') ? 'issue' : taskKey.startsWith('manual:') ? 'manual' : null);
  let workerScript = null;
  if (source === 'chat') workerScript = path.join(ROOT, 'scripts', 'watch-worker.ps1');
  else if (source === 'issue') workerScript = path.join(ROOT, 'scripts', 'issue-worker.ps1');
  else if (source === 'manual') workerScript = path.join(ROOT, 'scripts', 'manual-worker.ps1');
  else return { ok: false, error: `未知 source=${source}、不知道该 spawn 哪个 worker` };

  const p2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const nowStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;

  // ① 归零 state.json：state=queued，清 outcome/resolvedAt；outcomeDetail 保留但清 failureReason；追加 history
  try {
    const base = state || {};
    const history = Array.isArray(base.history) ? base.history : [];
    history.push({ state: 'queued', at: nowStr, by: approve ? 'user-approve' : 'user-restart' });
    const newOutcomeDetail = { ...(base.outcomeDetail || {}), failureReason: null, checkerExhausted: false };
    fs.writeFileSync(stateFile, JSON.stringify({
      ...base,
      state: 'queued',
      outcome: null,
      resolvedAt: null,
      enteredAt: nowStr,
      outcomeDetail: newOutcomeDetail,
      history,
    }, null, 2), 'utf8');
    // ② 占位 lease（worker 起来自补 pid）
    fs.writeFileSync(leaseFile, JSON.stringify({
      taskKey, claimedAt: nowStr, pid: 0, heartbeatAt: nowStr,
    }), 'utf8');
  } catch (e) {
    return { ok: false, error: `重置 state 失败: ${e.message}` };
  }

  // ③ spawn 对应 worker（用户从看板触发，直接立即起）
  const spawnLog = path.join(P.tmpDir, 'manual-spawn.log');
  try {
    const errFd = fs.openSync(spawnLog, 'a');
    fs.writeSync(errFd, `\n[${new Date().toISOString()}] restart ${taskKey} via ${PWSH_EXE} (${path.basename(workerScript)})\n`);
    const psi = spawn(PWSH_EXE, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', workerScript,
      '-TaskKey', taskKey,
    ], {
      cwd: ROOT,
      detached: false,
      stdio: ['ignore', errFd, errFd],
      windowsHide: true,
      shell: PWSH_EXE === 'pwsh',
    });
    psi.unref();
    fs.closeSync(errFd);
  } catch (e) {
    return { ok: false, error: `spawn 失败: ${e.message}` };
  }
  return { ok: true, taskKey, spawned: true, worker: path.basename(workerScript) };
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

// 新增任务（推送式）：任意来源调 API / CLI 把任务推进来 —— 只入队，不 spawn、不占 lease。
// state 由任务信息决定：plan(需用户确认) / queued(可跑)；真正跑起来靠 run 侧（用户从看板触发 restart/approve）。
// source（缺省 manual）：任意 [A-Za-z0-9_-] 标签，承载在 taskKey 前缀（<source>:<slug>），仅作展示/回复路由。
// cwd（可选）：claude 工作目录，校验存在且是目录后写进 task.json.cwd。
export function createTask({ source, title, prompt, model, description, plan, cwd }) {
  const src = String(source || 'manual').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(src)) return { ok: false, error: `非法 source：${src}（仅 [A-Za-z0-9_-]、首字符字母数字）` };
  const t = String(title || '').trim();
  const p = String(prompt || '').trim();
  const m = String(model || readConfig().defaultModel || 'claude-opus-4-7').trim();
  const desc = String(description || '').trim().slice(0, 2000);
  if (!t) return { ok: false, error: 'title required' };
  if (!p) return { ok: false, error: 'prompt required' };
  if (!ALLOWED_MODELS.has(m)) return { ok: false, error: `model 不在白名单：${Array.from(ALLOWED_MODELS).join(', ')}` };
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
    if (desc) taskJson.description = desc;
    fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(taskJson, null, 2), 'utf8');
    // state.json = plan（先计划，用户确认后排队）或 queued —— 入队即止，不占 lease、不 spawn
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      state: initState, enteredAt: nowStr, outcome: null, resolvedAt: null,
      outcomeDetail: { quotaResetAt: null, failureReason: null, checkerExhausted: false },
      history: [{ state: initState, at: nowStr, by: `create:${src}` }],
    }, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: `建任务包失败: ${e.message}` };
  }
  return { ok: true, taskKey, state: initState, spawned: false };
}
