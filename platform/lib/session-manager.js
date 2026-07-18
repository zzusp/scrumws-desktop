import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  createProviderAdapter,
  normalizeProvider,
  resolveProviderSelection,
  validateProviderSelection,
} from './providers/registry.js';

const TRANSCRIPT_CAP = 2000;
const sessions = new Map();

function nowStr() { return new Date().toISOString(); }

// 附件继续作为本地绝对路径随消息传给 CLI，由 provider 的文件工具按需读取。
// 前端乐观回显使用同一格式；若修改格式，需同步 public/app.js 的 attachSuffix。
export function appendAttachments(text, attachments) {
  const files = (Array.isArray(attachments) ? attachments : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const base = String(text || '');
  if (!files.length) return base;
  return `${base}\n\n[附加本地文件 · 请用 Read 工具读取]\n${files.map((file) => `- ${file}`).join('\n')}`;
}

function stampContent(content) {
  if (!Array.isArray(content)) return content;
  const timestamp = nowStr();
  return content.map((block) => {
    if (!block || typeof block !== 'object' || block._ts != null) return block;
    return { ...block, _ts: timestamp };
  });
}

function normalizeSeedEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'message' && event.message) {
    return {
      ...event,
      message: {
        ...event.message,
        content: stampContent(event.message.content),
      },
    };
  }
  // 迁移边界：历史 Claude JSONL 的 assistant/user 事件只在导入时归一化，向上不再泄露旧事件形状。
  if ((event.type === 'assistant' || event.type === 'user') && event.message) {
    return {
      type: 'message',
      provider: 'claude',
      message: {
        ...event.message,
        role: event.message.role || event.type,
        content: stampContent(event.message.content),
        usage: event.message.usage || null,
      },
      at: event.at || event.timestamp || nowStr(),
    };
  }
  if (event.type === 'result') {
    return {
      type: 'turn_completed',
      provider: 'claude',
      status: event.is_error ? 'failed' : 'completed',
      result: event.result ?? null,
      usage: event.usage || null,
      at: event.at || event.timestamp || nowStr(),
    };
  }
  return event;
}

class Session {
  constructor({ id, provider, cwd, model, effort, taskKey, gitBranch, capabilities, resume }) {
    this.id = id;
    this.taskKey = taskKey || null;
    this.provider = provider;
    this.sessionId = resume || null;
    this.cwd = cwd || null;
    this.gitBranch = gitBranch || null;
    this.model = model || null;
    this.effort = effort || null;
    this.capabilities = { ...capabilities };
    this.state = 'starting';
    this.createdAt = nowStr();
    this.transcript = [];
    this.truncated = 0;
    this.pendingApprovals = new Map();
    // 兼容尚未迁移的调用方字段名；值与统一 approval map 是同一个对象。
    this.pendingPermissions = this.pendingApprovals;
    this.backgroundTasks = [];
    this.lastUsage = null;
    this.lastError = null;
    this.adapter = null;
    this.adopted = Boolean(resume);
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  get child() { return this.adapter?.child || null; }

  // 旧调用方迁移期间只为 Claude 暴露别名；统一代码应读取 sessionId。
  get claudeSessionId() { return this.provider === 'claude' ? this.sessionId : null; }
  set claudeSessionId(value) { if (this.provider === 'claude') this.sessionId = value || null; }

  _appendTranscript(event) {
    this.transcript.push(event);
    if (this.transcript.length > TRANSCRIPT_CAP) {
      this.transcript.shift();
      this.truncated += 1;
    }
  }

  _record(event) {
    // 高频增量与诊断只实时广播；可重放 transcript 只保留已落定的统一事件。
    if (!['message_delta', 'turn_usage', 'diagnostic'].includes(event.type)) this._appendTranscript(event);
    this.emitter.emit('event', event);
  }

  handleProviderEvent(rawEvent) {
    if (!rawEvent || typeof rawEvent !== 'object' || !rawEvent.type) return;
    const event = {
      ...rawEvent,
      provider: rawEvent.provider || this.provider,
      at: rawEvent.at || nowStr(),
    };
    if (event.type === 'message' && event.message) {
      event.message = {
        ...event.message,
        content: stampContent(event.message.content),
      };
    }

    switch (event.type) {
      case 'session_initialized':
        if (event.sessionId) this.sessionId = event.sessionId;
        if (event.model) this.model = event.model;
        this.state = 'running';
        break;
      case 'message':
      case 'message_delta':
        if (this.state === 'idle') this.state = 'running';
        break;
      case 'turn_usage':
        this.lastUsage = event.usage || null;
        break;
      case 'approval_requested':
        if (event.requestId != null) this.pendingApprovals.set(String(event.requestId), event);
        break;
      case 'approval_resolved':
        if (event.requestId != null) this.pendingApprovals.delete(String(event.requestId));
        break;
      case 'background_tasks':
        this.backgroundTasks = Array.isArray(event.tasks) ? event.tasks : [];
        break;
      case 'turn_completed':
        if (event.usage) this.lastUsage = event.usage;
        // 单轮失败不等于常驻 provider transport 已坏；保留会话以便用户修正后续聊。
        this.state = 'idle';
        if (event.status === 'failed' && event.error) this.lastError = String(event.error);
        break;
      case 'error':
        this.state = 'error';
        this.lastError = String(event.error || 'provider error');
        break;
      case 'closed':
        if (this.state !== 'error') this.state = 'closed';
        break;
      default:
        break;
    }
    this._record(event);
  }

  info() {
    return {
      id: this.id,
      taskKey: this.taskKey,
      provider: this.provider,
      sessionId: this.sessionId,
      claudeSessionId: this.claudeSessionId,
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      model: this.model,
      effort: this.effort,
      capabilities: { ...this.capabilities },
      state: this.state,
      createdAt: this.createdAt,
      transcriptLen: this.transcript.length,
      truncated: this.truncated,
      pendingApprovals: this.pendingApprovals.size,
      pendingPermissions: this.pendingApprovals.size,
      lastUsage: this.lastUsage,
      lastError: this.lastError,
      backgroundTasks: this.backgroundTasks,
    };
  }
}

function validateCwd(cwd) {
  if (!cwd) return null;
  try {
    if (!fs.statSync(cwd).isDirectory()) return `cwd 不是目录：${cwd}`;
  } catch {
    return `cwd 不存在：${cwd}`;
  }
  return null;
}

function requireSession(id) {
  const session = sessions.get(id);
  return session ? { session } : { error: { ok: false, error: 'session not found' } };
}

function actionResult(result, error) {
  if (result && typeof result === 'object' && Object.hasOwn(result, 'ok')) return result;
  return result === true ? { ok: true } : { ok: false, error };
}

export function createSession({
  provider,
  cwd,
  model,
  effort,
  resume,
  prompt,
  attachments,
  seedTranscript,
  taskKey,
  bypass,
  gitBranch,
  dynamicWorkflow,
} = {}) {
  const cwdError = validateCwd(cwd);
  if (cwdError) return { ok: false, error: cwdError };

  let selection;
  try {
    selection = resolveProviderSelection({ provider, model, effort, dynamicWorkflow });
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (!selection.ok) return selection;
  const validated = validateProviderSelection(selection);
  if (!validated.ok) return validated;

  const id = randomUUID();
  const session = new Session({
    id,
    provider: selection.provider,
    cwd,
    model: selection.model,
    effort: selection.effort,
    taskKey,
    gitBranch,
    capabilities: selection.definition.capabilities,
    resume,
  });
  if (Array.isArray(seedTranscript) && seedTranscript.length) {
    session.transcript = seedTranscript
      .map(normalizeSeedEvent)
      .filter(Boolean)
      .slice(-TRANSCRIPT_CAP);
    session.truncated = Math.max(0, seedTranscript.length - session.transcript.length);
    session.adopted = true;
  }

  try {
    session.adapter = createProviderAdapter(selection.provider, {
      cwd: cwd || process.cwd(),
      model: selection.model,
      effort: selection.effort,
      resume,
      bypass: Boolean(bypass),
      taskKey,
      dynamicWorkflow,
      emit: (event) => session.handleProviderEvent(event),
    });
    sessions.set(id, session);
    const started = session.adapter.start();
    // adapter 对异步协议失败负责发统一 error；这里只消费 rejection，避免未处理 Promise 与重复 error。
    Promise.resolve(started).catch(() => {});
  } catch (error) {
    sessions.delete(id);
    return { ok: false, error: `provider 启动失败：${error.message}` };
  }

  if (prompt) {
    const sent = sendUserMessage(id, prompt, attachments);
    if (!sent.ok) {
      closeSession(id);
      return sent;
    }
  }
  return { ok: true, id, info: session.info() };
}

export function sendUserMessage(id, message, attachments) {
  const found = requireSession(id);
  if (found.error) return found.error;
  const session = found.session;
  if (session.state === 'closed' || session.state === 'error') return { ok: false, error: `session 已${session.state}` };
  if (!String(message || '').trim()) return { ok: false, error: 'message required' };

  const text = appendAttachments(message, attachments);
  const result = session.adapter.send(text);
  const sent = actionResult(result, 'provider 拒绝消息');
  if (!sent.ok) return sent;

  // CLI 通常不回显用户输入，因此在唯一入口落一条统一 settled event；不广播以避免前端乐观回显重复。
  session._appendTranscript({
    type: 'message',
    provider: session.provider,
    message: { role: 'user', content: [{ type: 'text', text, _ts: nowStr() }] },
    at: nowStr(),
  });
  if (session.state === 'idle') session.state = 'running';
  return { ok: true };
}

export function respondPermission(id, requestId, allow, extraInput = null) {
  const found = requireSession(id);
  if (found.error) return found.error;
  const session = found.session;
  const key = String(requestId);
  const pending = session.pendingApprovals.get(key);
  if (!pending) return { ok: false, error: 'no pending approval for request_id' };
  if (!session.capabilities.approvals) return { ok: false, error: `${session.provider} 不支持审批` };
  return actionResult(session.adapter.respond(key, Boolean(allow), extraInput, pending), 'provider 审批应答失败');
}

export function interruptSession(id) {
  const found = requireSession(id);
  if (found.error) return found.error;
  const session = found.session;
  if (!session.capabilities.interrupt) return { ok: false, error: `${session.provider} 不支持打断` };
  return actionResult(session.adapter.interrupt(), 'provider 打断失败');
}

export function stopTaskInSession(id, taskId) {
  const found = requireSession(id);
  if (found.error) return found.error;
  const session = found.session;
  if (!taskId) return { ok: false, error: 'taskId required' };
  if (!session.capabilities.backgroundTasks || typeof session.adapter.stopTask !== 'function') {
    return { ok: false, error: `${session.provider} 不支持后台任务控制` };
  }
  return actionResult(session.adapter.stopTask(taskId), 'provider 后台任务停止失败');
}

export function taskOutputPath(session, taskId) {
  if (!session?.capabilities?.backgroundTasks || typeof session.adapter?.taskOutputPath !== 'function') return null;
  return session.adapter.taskOutputPath(taskId);
}

export function readTaskOutput(id, taskId, tailBytes = 64 * 1024) {
  const found = requireSession(id);
  if (found.error) return found.error;
  const session = found.session;
  if (!session.capabilities.backgroundTasks || typeof session.adapter.readTaskOutput !== 'function') {
    return { ok: false, error: `${session.provider} 不支持后台任务输出` };
  }
  return session.adapter.readTaskOutput(taskId, tailBytes);
}

export function closeSession(id) {
  const found = requireSession(id);
  if (found.error) return found.error;
  const result = found.session.adapter.close();
  return actionResult(result, 'provider 关闭失败');
}

export function getSession(id) { return sessions.get(id) || null; }
export function listSessions() { return [...sessions.values()].map((session) => session.info()); }

export function getSessionIdByTaskKey(taskKey) {
  if (!taskKey) return null;
  for (const session of sessions.values()) {
    if (session.taskKey === taskKey && session.state !== 'closed' && session.state !== 'error') return session.id;
  }
  return null;
}

export { normalizeProvider };
