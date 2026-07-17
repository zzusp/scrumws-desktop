import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---- Mode B：看板持有的交互式 claude 会话引擎（L2 地基 / S4）----
// 基于已验证命令（docs/acceptance/board-interactive-session/round-1.md）：
//   claude -p --input-format stream-json --output-format stream-json --verbose
//          --include-partial-messages [--permission-prompt-tool stdio | --dangerously-skip-permissions] [--resume <sid>] [--model <m>] [--effort <lvl>]
// bypass=true（任务发起/唤醒、CLI 会话续接 adopt）→ --dangerously-skip-permissions 免逐工具授权；否则走 stdio 权限卡（S5）。
// 双向：stdin 喂 stream-json user 消息（保持打开 = 持久多轮）；stdout 解析 NDJSON 事件。
// 本模块只做引擎骨架：spawn / 解析 / 转发 / 送消息 / 生命周期。
// 权限应答（can_use_tool）、打断（interrupt）、前端渲染留给 S5/S6/S7 —— 但相关 stdin 原语已就绪。

// 不硬编码 .cmd：Windows 走 shell 由 PATHEXT 解析（原生装 claude.exe / npm 全局装 claude.cmd 皆命中，与 collect.js 探测同款）
const CLAUDE_BIN = 'claude';
const ALLOWED_MODELS = new Set([
  'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5',
]);
const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);   // claude --effort 合法档位（CLI v2.1.207 实测校验集）
const TRANSCRIPT_CAP = 2000;   // 完整消息上限（逐字 partial 不入 transcript，只实时转发）
// init 看门狗超时：resume/新建正常都秒级收到 system/init 进 running；超过此阈值仍卡 starting = init 失败，判死。
const STARTING_TIMEOUT_MS = 60 * 1000;

const sessions = new Map();    // id → Session

function nowStr() { return new Date().toISOString(); }

// 「附加本地文件」→ 把绝对路径拼进消息文本尾部：claude 本地全权限、Read 工具支持任意类型（含图片），
// 让它按需读，无需 Node 侧读文件/base64/判类型（对齐 CC 对大文件的 compact_file_reference 策略）。
// 前端乐观回显用同款格式（public/app.js attachSuffix），改格式需两处同步。
export function appendAttachments(text, attachments) {
  const files = (Array.isArray(attachments) ? attachments : [])
    .map((p) => String(p || '').trim()).filter(Boolean);
  const base = String(text || '');
  if (!files.length) return base;
  return `${base}\n\n[附加本地文件 · 请用 Read 工具读取]\n${files.map((p) => `- ${p}`).join('\n')}`;
}

class Session {
  constructor({ id, cwd, model, effort, taskKey, gitBranch }) {
    this.id = id;                    // 看板内部句柄
    this.taskKey = taskKey || null;  // 绑定的文件任务 key（task-runner 起的会话有值；CLI 收养会话为 null）
    this.claudeSessionId = null;     // CC 侧 session_id（system/init 里拿，用于 --resume / 关联磁盘 jsonl）
    this.cwd = cwd || null;
    this.gitBranch = gitBranch || null;  // resume/收养源 jsonl 的分支（live 流不带 gitBranch → 详情侧栏据此显示）
    this.model = model || null;
    this.effort = effort || null;    // reasoning effort（spawn 时 --effort 传入）；供前端实时状态行显示 "thinking with X effort"
    this.state = 'starting';         // starting | running | idle | closed | error
    this.createdAt = nowStr();
    this.transcript = [];            // 完整消息（user/assistant/result/system），有界
    this.truncated = 0;              // transcript 被截断丢弃的条数（不静默）
    this.pendingPermissions = new Map();   // request_id → 原始 can_use_tool 请求（S5 用）
    // 当前在跑的后台任务全表 [{task_id, task_type, description}]——CC 经 system/background_tasks_changed
    // 全量推送（实测增删都推：起任务推 [x]、任务结束推 []），直接覆盖即可，无需自行增删/兜底。
    this.backgroundTasks = [];
    this.lastError = null;
    this.child = null;
    this._startWatchdog = null;      // init 看门狗计时器（收到 system/init 即清；超时未清则判死）
    this._buf = '';
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  _record(ev) {
    // 完整消息进 transcript；partial（stream_event）只转发不存
    if (ev.type !== 'stream_event') {
      this.transcript.push(ev);
      if (this.transcript.length > TRANSCRIPT_CAP) { this.transcript.shift(); this.truncated++; }
    }
    this.emitter.emit('event', ev);
  }

  info() {
    return {
      id: this.id, taskKey: this.taskKey, claudeSessionId: this.claudeSessionId, cwd: this.cwd, gitBranch: this.gitBranch, model: this.model, effort: this.effort,
      state: this.state, createdAt: this.createdAt, transcriptLen: this.transcript.length,
      truncated: this.truncated, pendingPermissions: this.pendingPermissions.size, lastError: this.lastError,
      backgroundTasks: this.backgroundTasks,
    };
  }
}

function handleLine(s, line) {
  const t = line.trim();
  if (!t.startsWith('{')) return;   // 非 JSON（installStreamJsonStdoutGuard 会把杂音导去 stderr，这里再兜一层）
  let ev;
  try { ev = JSON.parse(t); } catch { return; }
  // 关键事件旁路：抓 session_id / 维护状态 / 暂存权限请求
  if (ev.type === 'system' && ev.subtype === 'init') {
    if (ev.session_id) s.claudeSessionId = ev.session_id;
    if (ev.model && !s.model) s.model = ev.model;
    s.state = 'running';
    if (s._startWatchdog) { clearTimeout(s._startWatchdog); s._startWatchdog = null; }   // 正常起会话，撤看门狗
  } else if (ev.type === 'result') {
    s.state = 'idle';               // 一轮收敛，等下一条用户消息
  } else if (ev.type === 'control_request') {
    const rid = ev.request?.request_id || ev.request_id;
    const sub = ev.request?.subtype || ev.request?.request?.subtype;
    if (rid && sub === 'can_use_tool') s.pendingPermissions.set(rid, ev);   // S5 应答
  } else if (ev.type === 'system' && ev.subtype === 'background_tasks_changed') {
    // 后台任务全表（后台命令 / Monitor / subagent 等，见 Task 的 task_type）。CC 全量推、增删都推
    // → 直接覆盖。这是权威实时表，比反读 jsonl 准（jsonl 那套是给非 Mode B 会话兜底的，见 collect-cli）。
    s.backgroundTasks = Array.isArray(ev.tasks) ? ev.tasks : [];
  }
  // S7：给 assistant/user 的 content block 补收到时刻 _ts（stream-json 事件不带 timestamp）。
  // assistant 的 tool_use 与 user 的 tool_result 各在自己事件到达时打戳 → 前端可算每步耗时 / 进行中跳秒。
  if ((ev.type === 'assistant' || ev.type === 'user') && ev.message && Array.isArray(ev.message.content)) {
    const ts = nowStr();
    for (const c of ev.message.content) if (c && typeof c === 'object' && c._ts == null) c._ts = ts;
  }
  s._record(ev);
}

function wireChild(s) {
  const child = s.child;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    s._buf += chunk;
    let nl;
    while ((nl = s._buf.indexOf('\n')) >= 0) {
      const line = s._buf.slice(0, nl); s._buf = s._buf.slice(nl + 1);
      handleLine(s, line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    // stderr 是 claude 的诊断/告警（非 JSON 流）；作为事件透出供排障，不进 transcript
    s.emitter.emit('event', { type: 'stderr', text: String(chunk), _local: true, at: nowStr() });
  });
  child.on('error', (e) => {
    s.state = 'error'; s.lastError = e.message;
    s.emitter.emit('event', { type: 'error', error: e.message, _local: true, at: nowStr() });
  });
  child.on('exit', (code, signal) => {
    if (s.state !== 'error') s.state = 'closed';
    s.emitter.emit('event', { type: 'closed', code, signal, _local: true, at: nowStr() });
  });
}

// 往 stdin 写一行 stream-json（NDJSON）
function writeStdin(s, obj) {
  if (!s.child || s.child.killed || !s.child.stdin.writable) return false;
  try { s.child.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
}

// init 看门狗：会话被喂了首条消息却迟迟 init 不了（仍 starting）→ 判死 + 杀子进程。
// 只在「已发出首条消息」后武装：claude -p --input-format stream-json 在收到消息前根本不 emit system/init，
// 空等输入的会话属正常 idle，不能误杀；发了消息还长时间不 init 才是卡死（典型：resume 撞上被终端进程
// 持有的同一 session，两个 claude 抢锁 init 拿不到）。否则僵尸会话把看板 CLI 卡片永久钉在 processing
// （collect-cli 把 board 的 starting→processing）。收到 system/init 即在 handleLine 里清掉。
function armInitWatchdog(s) {
  if (s._startWatchdog) return;
  s._startWatchdog = setTimeout(() => {
    if (s.state !== 'starting') return;
    s.state = 'error';
    s.lastError = 'init 超时（发出消息后 60s 未收到 system/init；该 session 可能已被其他进程占用）';
    s.emitter.emit('event', { type: 'error', error: s.lastError, _local: true, at: nowStr() });
    try { s.child?.kill(); } catch { /* already gone */ }
  }, STARTING_TIMEOUT_MS);
  if (s._startWatchdog.unref) s._startWatchdog.unref();   // 不因看门狗阻塞进程退出
}

// ---- 对外 API ----

export function createSession({ cwd, model, effort, resume, prompt, attachments, seedTranscript, taskKey, bypass, gitBranch, dynamicWorkflow } = {}) {
  if (cwd) {
    try { if (!fs.statSync(cwd).isDirectory()) return { ok: false, error: `cwd 不是目录：${cwd}` }; }
    catch { return { ok: false, error: `cwd 不存在：${cwd}` }; }
  }
  if (model && !ALLOWED_MODELS.has(model)) return { ok: false, error: `model 不在白名单：${[...ALLOWED_MODELS].join(', ')}` };
  if (effort && !ALLOWED_EFFORTS.has(effort)) return { ok: false, error: `effort 不在白名单：${[...ALLOWED_EFFORTS].join(', ')}` };

  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages'];
  // 任务发起/唤醒（startTask/replyTask）、CLI 会话续接（adopt）传 bypass:true → 跳过权限确认，避免逐工具反复授权
  //（CLI 续接：终端里本就是 bypass permissions 态）；仅手动新建交互会话（session/create）走 stdio 权限卡（S5）。
  // ⚠ --disallowedTools AskUserQuestion 只挂 bypass，不能无条件加一行（决策 15，契约 §8.1）：非 bypass 会话的
  // AskUserQuestion 由**权限组件**收集，走 can_use_tool 通道 → 看板渲染成交互选项卡（实测可用，round-9）。
  // 而 bypass=--dangerously-skip-permissions **没有权限卡** → 问题永远到不了人眼前 → agent 默默自己猜
  //（multica GitHub #2588）。所以：禁的正好是坏掉的那一半，留的正好是能用的那一半。
  if (bypass) {
    args.push('--dangerously-skip-permissions');
    args.push('--disallowedTools', 'AskUserQuestion');
  } else args.push('--permission-prompt-tool', 'stdio');
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (resume) args.push('--resume', resume);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // 防经宿主扩散到 claude 后代（README 宿主适配点 1）
  // 动态工作流（Claude Code Workflows 能力）任务级开关：走环境变量而非 --settings，避开 Windows shell:true
  // spawn 下 JSON 参数的引号/大括号被 cmd 解析坏的坑。二进制实测：CLAUDE_CODE_WORKFLOWS truthy=可用、
  // CLAUDE_CODE_DISABLE_WORKFLOWS truthy=禁用。undefined=不干预、继承 claude 默认。
  if (dynamicWorkflow === true) { env.CLAUDE_CODE_WORKFLOWS = '1'; delete env.CLAUDE_CODE_DISABLE_WORKFLOWS; }
  else if (dynamicWorkflow === false) { env.CLAUDE_CODE_DISABLE_WORKFLOWS = '1'; delete env.CLAUDE_CODE_WORKFLOWS; }
  // 决策 15（契约 §8.1/§8.3）：让 agent 知道「自己是谁 / 去哪儿声明完成」。taskKey 由 createTask 生成，
  // 云端下发时还不存在，所以只能在 spawn 这一刻注入。用法由 prompt 尾的完成协议告诉它（completion-protocol.js）。
  // 来源无关：所有绑任务的会话都注入（不按 source 分支，不变式 2）；没带完成协议的任务不会去调，行为零变化。
  // ⚠ 这里只给本机 127.0.0.1 的看板端点，**绝不给任何云端凭据**——agent 带 bypass 跑，swmt_ 碰都不能碰。
  if (taskKey) {
    env.SCRUMWS_TASK_KEY = taskKey;
    // 端口与 server.js:22 同源（同一个 SCRUMWS_PORT env）；改默认值要两处一起改。本机、不出网。
    env.SCRUMWS_API_BASE = `http://127.0.0.1:${Number(process.env.SCRUMWS_PORT) || 8799}`;
  }

  const id = randomUUID();
  const s = new Session({ id, cwd, model, effort, taskKey, gitBranch });
  // S10 收养：预置历史 transcript（终端会话的既往对话）→ SSE 连上即回放，续接体验连续。
  // 首条 prompt 不在这里补 transcript——由下方 sendUserMessage(id, prompt) 统一自记（同续轮 reply 一条路径），
  // 避免两处各 push 一次导致首条消息重复。seedTranscript 只含历史（不含本轮消息），调用方不再往 seed 尾追消息。
  if (Array.isArray(seedTranscript) && seedTranscript.length) {
    s.transcript = seedTranscript.slice(-TRANSCRIPT_CAP);
    s.claudeSessionId = resume || null;
    s.adopted = true;
  }
  try {
    // Windows 须走 shell：CVE-2024-27980 后 Node 拒绝无 shell spawn .cmd（同步抛 spawn EINVAL）；shell 由 PATHEXT 解析 claude.exe/.cmd
    s.child = spawn(CLAUDE_BIN, args, { cwd: cwd || process.cwd(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  } catch (e) {
    return { ok: false, error: `spawn 失败：${e.message}` };
  }
  sessions.set(id, s);
  wireChild(s);
  if (prompt) sendUserMessage(id, prompt, attachments);
  return { ok: true, id, info: s.info() };
}

export function sendUserMessage(id, message, attachments) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'session not found' };
  if (s.state === 'closed' || s.state === 'error') return { ok: false, error: `session 已${s.state}` };
  if (!String(message || '').trim()) return { ok: false, error: 'message required' };
  // 附加本地文件 → 拼进文本尾部（claude 用 Read 读）；transcript 也存拼接版（claude 所见 = 历史所存）
  const text = appendAttachments(message, attachments);
  const ok = writeStdin(s, { type: 'user', message: { role: 'user', content: text } });
  // 记入 transcript（不 emit）：claude stdout stream-json 不回显用户输入，用户消息只有这里自记才进得了历史。
  // 否则续轮 reply / leak-retry 等经本函数发出的用户消息从不入 transcript → 详情重开(SSE 回放)时全丢。
  // 不 emit 以免与前端乐观回显重复；对齐 createSession 首条 prompt 的自记做法。
  if (ok) {
    s.transcript.push({ type: 'user', message: { role: 'user', content: text } });
    if (s.transcript.length > TRANSCRIPT_CAP) { s.transcript.shift(); s.truncated++; }
  }
  if (ok && s.state === 'idle') s.state = 'running';
  // 首条消息喂进去但会话仍未 init（starting）→ 武装 init 看门狗（发了消息才该期待 system/init）
  if (ok && s.state === 'starting') armInitWatchdog(s);
  return ok ? { ok: true } : { ok: false, error: 'stdin 不可写' };
}

// 权限应答（S5 / S8）：allow=true 放行 / false 拒绝。behavior 对齐 can_use_tool 协议。
// extraInput：合并进 updatedInput —— S8 交互式工具（AskUserQuestion）用它回传 {answers:{问题:选项}}。
export function respondPermission(id, requestId, allow, extraInput = null) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'session not found' };
  const req = s.pendingPermissions.get(requestId);
  if (!req) return { ok: false, error: 'no pending permission for request_id' };
  // can_use_tool 请求里 input 的路径按实测可能是 request.input 或 request.request.input，两处兜底
  const inner = req.request?.request || req.request || {};
  const origInput = inner.input ?? req.request?.input ?? {};
  const response = allow
    ? { behavior: 'allow', updatedInput: extraInput ? { ...origInput, ...extraInput } : origInput }
    : { behavior: 'deny', message: 'denied by user' };
  const ok = writeStdin(s, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  if (ok) s.pendingPermissions.delete(requestId);
  return ok ? { ok: true } : { ok: false, error: 'stdin 不可写' };
}

// 打断当前轮（S6 用）
export function interruptSession(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'session not found' };
  const ok = writeStdin(s, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  return ok ? { ok: true } : { ok: false, error: 'stdin 不可写' };
}

// 停单个后台任务：走 CC 的 SDK 控制通道，与 TaskStopTool（LLM 调的那个）共用同一个 stopTask()——
// 按 task_id 查 CC 自己的任务表，不猜进程，且 subagent 这类没有独立进程的任务同样能停。
// 停掉后 CC 会推 background_tasks_changed（移除）+ 终态 task_notification，前端不必自行摘除。
export function stopTaskInSession(id, taskId) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'session not found' };
  if (!taskId) return { ok: false, error: 'taskId required' };
  const ok = writeStdin(s, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'stop_task', task_id: taskId } });
  return ok ? { ok: true } : { ok: false, error: 'stdin 不可写' };
}

// 后台任务的输出文件：CC 落在 <临时目录>/claude/<cwd 折叠>/<CC sessionId>/tasks/<taskId>.output
// （盘符冒号与路径分隔符折成 '-'，同 paths.js 对 CC 项目目录的编码）。任务终态后 CC 会 evict 掉该文件，
// 所以能读到的天然只有在跑的任务。
export function taskOutputPath(s, taskId) {
  if (!s?.cwd || !s.claudeSessionId) return null;
  const folded = s.cwd.replace(/[:\\/]/g, '-');
  return path.join(os.tmpdir(), 'claude', folded, s.claudeSessionId, 'tasks', `${taskId}.output`);
}

// 读后台任务输出（详情栏「查看」用）：只回尾部，避免长跑任务的巨大日志灌爆响应
export function readTaskOutput(id, taskId, tailBytes = 64 * 1024) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'session not found' };
  const p = taskOutputPath(s, taskId);
  if (!p) return { ok: false, error: '会话尚未 init（无 sessionId），暂无法定位输出文件' };
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return { ok: true, path: p, size, truncated: start > 0, text: buf.toString('utf8') };
  } catch (e) {
    // 任务已结束 → CC evict 输出文件；对调用方是正常态，不是错误
    if (e.code === 'ENOENT') return { ok: false, error: '输出文件不存在（任务可能已结束，CC 会清理输出）', gone: true };
    return { ok: false, error: e.message };
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

export function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'session not found' };
  try { s.child?.stdin?.end(); } catch { /* already gone */ }
  // 宽限后仍活则强杀
  const child = s.child;
  setTimeout(() => { try { if (child && !child.killed) child.kill(); } catch { /* gone */ } }, 1500);
  return { ok: true };
}

export function getSession(id) { return sessions.get(id) || null; }
export function listSessions() { return [...sessions.values()].map((s) => s.info()); }

// 按 taskKey 反查活着的会话 id（收养会话未经 task-runner.bind 注册 registry，靠会话自记的 taskKey 找回）
export function getSessionIdByTaskKey(taskKey) {
  if (!taskKey) return null;
  for (const s of sessions.values()) {
    if (s.taskKey === taskKey && s.state !== 'closed' && s.state !== 'error') return s.id;
  }
  return null;
}
