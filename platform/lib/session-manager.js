import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

// ---- Mode B：看板持有的交互式 claude 会话引擎（L2 地基 / S4）----
// 基于已验证命令（docs/acceptance/board-interactive-session/round-1.md）：
//   claude -p --input-format stream-json --output-format stream-json --verbose
//          --include-partial-messages --permission-prompt-tool stdio [--resume <sid>] [--model <m>]
// 双向：stdin 喂 stream-json user 消息（保持打开 = 持久多轮）；stdout 解析 NDJSON 事件。
// 本模块只做引擎骨架：spawn / 解析 / 转发 / 送消息 / 生命周期。
// 权限应答（can_use_tool）、打断（interrupt）、前端渲染留给 S5/S6/S7 —— 但相关 stdin 原语已就绪。

const CLAUDE_BIN = process.platform === 'win32' ? 'claude.cmd' : 'claude';
const ALLOWED_MODELS = new Set([
  'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5',
]);
const TRANSCRIPT_CAP = 2000;   // 完整消息上限（逐字 partial 不入 transcript，只实时转发）

const sessions = new Map();    // id → Session

function nowStr() { return new Date().toISOString(); }

class Session {
  constructor({ id, cwd, model }) {
    this.id = id;                    // 看板内部句柄
    this.claudeSessionId = null;     // CC 侧 session_id（system/init 里拿，用于 --resume / 关联磁盘 jsonl）
    this.cwd = cwd || null;
    this.model = model || null;
    this.state = 'starting';         // starting | running | idle | closed | error
    this.createdAt = nowStr();
    this.transcript = [];            // 完整消息（user/assistant/result/system），有界
    this.truncated = 0;              // transcript 被截断丢弃的条数（不静默）
    this.pendingPermissions = new Map();   // request_id → 原始 can_use_tool 请求（S5 用）
    this.lastError = null;
    this.child = null;
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
      id: this.id, claudeSessionId: this.claudeSessionId, cwd: this.cwd, model: this.model,
      state: this.state, createdAt: this.createdAt, transcriptLen: this.transcript.length,
      truncated: this.truncated, pendingPermissions: this.pendingPermissions.size, lastError: this.lastError,
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
  } else if (ev.type === 'result') {
    s.state = 'idle';               // 一轮收敛，等下一条用户消息
  } else if (ev.type === 'control_request') {
    const rid = ev.request?.request_id || ev.request_id;
    const sub = ev.request?.subtype || ev.request?.request?.subtype;
    if (rid && sub === 'can_use_tool') s.pendingPermissions.set(rid, ev);   // S5 应答
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

// ---- 对外 API ----

export function createSession({ cwd, model, resume, prompt, seedTranscript } = {}) {
  if (cwd) {
    try { if (!fs.statSync(cwd).isDirectory()) return { ok: false, error: `cwd 不是目录：${cwd}` }; }
    catch { return { ok: false, error: `cwd 不存在：${cwd}` }; }
  }
  if (model && !ALLOWED_MODELS.has(model)) return { ok: false, error: `model 不在白名单：${[...ALLOWED_MODELS].join(', ')}` };

  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // 防经宿主扩散到 claude 后代（README 宿主适配点 1）

  const id = randomUUID();
  const s = new Session({ id, cwd, model });
  // S10 收养：预置历史 transcript（终端会话的既往对话）→ SSE 连上即回放，续接体验连续
  if (Array.isArray(seedTranscript) && seedTranscript.length) {
    s.transcript = seedTranscript.slice(-TRANSCRIPT_CAP);
    s.claudeSessionId = resume || null;
    s.adopted = true;
  }
  try {
    s.child = spawn(CLAUDE_BIN, args, { cwd: cwd || process.cwd(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, error: `spawn 失败：${e.message}` };
  }
  sessions.set(id, s);
  wireChild(s);
  if (prompt) sendUserMessage(id, prompt);
  return { ok: true, id, info: s.info() };
}

export function sendUserMessage(id, message) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'session not found' };
  if (s.state === 'closed' || s.state === 'error') return { ok: false, error: `session 已${s.state}` };
  const text = String(message || '');
  if (!text.trim()) return { ok: false, error: 'message required' };
  const ok = writeStdin(s, { type: 'user', message: { role: 'user', content: text } });
  if (ok && s.state === 'idle') s.state = 'running';
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
