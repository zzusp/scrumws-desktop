import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

function nowStr() { return new Date().toISOString(); }
function requestKey(id) { return `${typeof id}:${String(id)}`; }

function nested(object, ...path) {
  let value = object;
  for (const key of path) value = value && typeof value === 'object' ? value[key] : undefined;
  return value;
}

function itemText(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string') return item.text;
  if (typeof item.summary === 'string') return item.summary;
  if (Array.isArray(item.summary)) return item.summary.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n');
  if (Array.isArray(item.content)) return item.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n');
  return '';
}

function codexUsage(source) {
  if (!source || typeof source !== 'object') return null;
  const input = Number(source.inputTokens ?? source.input_tokens ?? source.input ?? source.prompt_tokens) || 0;
  const cached = Number(source.cachedInputTokens ?? source.cached_input_tokens ?? source.cache_read_tokens ?? source.cache_read_input_tokens) || 0;
  return {
    input_tokens: Math.max(0, input - cached),
    output_tokens: Number(source.outputTokens ?? source.output_tokens ?? source.output ?? source.completion_tokens) || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: Number(source.cacheWriteTokens ?? source.cache_write_tokens ?? source.cache_creation_input_tokens) || 0,
    reasoning_output_tokens: Number(source.reasoningOutputTokens ?? source.reasoning_output_tokens) || 0,
  };
}

function rpcError(message, code, data) {
  const error = new Error(`${message}${code != null ? ` (code=${code})` : ''}`);
  error.code = code;
  error.data = data;
  error.transport = false;
  return error;
}

function transportError(message) {
  const error = new Error(message);
  error.transport = true;
  return error;
}

function canFallbackFromResume(error) {
  if (!error || error.transport) return false;
  if (error.code === -32601 || error.code === -32602) return true;
  return /(?:thread|conversation).*(?:not found|unknown|missing)|(?:unknown|missing).*(?:thread|conversation)|schema|deserialize/i.test(error.message || '');
}

function terminateChildTree(child, platform) {
  if (!child || child.exitCode != null || !child.pid) return;
  if (platform === 'win32') {
    try {
      // 必须等待 taskkill 完成；异步发起后宿主若先退出，app-server/工具孙进程仍可能存活。
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    } catch { /* already gone */ }
  } else {
    try { child.kill(); } catch { /* already gone */ }
  }
}

function toolName(type) {
  return {
    commandExecution: 'exec_command',
    fileChange: 'patch_apply',
    mcpToolCall: 'mcp_tool',
    dynamicToolCall: 'dynamic_tool',
    webSearch: 'web_search',
  }[type] || type || 'tool';
}

function toolInput(item) {
  if (!item || typeof item !== 'object') return {};
  switch (item.type) {
    case 'commandExecution': return { command: item.command || '', cwd: item.cwd || null };
    case 'fileChange': return { changes: item.changes || item.patch || item.diff || null };
    case 'mcpToolCall': return { server: item.server || item.serverName || null, tool: item.tool || item.toolName || null, arguments: item.arguments || item.input || null };
    case 'dynamicToolCall': return { tool: item.tool || item.toolName || null, arguments: item.arguments || item.input || null };
    case 'webSearch': return { query: item.query || null };
    default: return item.input && typeof item.input === 'object' ? item.input : {};
  }
}

function toolOutput(item) {
  if (!item || typeof item !== 'object') return '';
  const value = item.aggregatedOutput ?? item.output ?? item.result ?? item.error ?? item.status ?? '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export class CodexAdapter {
  constructor(options = {}) {
    this.provider = 'codex';
    this.command = options.command || 'codex';
    this.argsPrefix = Array.isArray(options.argsPrefix) ? [...options.argsPrefix] : [];
    this.cwd = options.cwd || process.cwd();
    this.model = options.model || null;
    this.effort = options.effort || null;
    this.resume = options.resume || null;
    this.bypass = !!options.bypass;
    this.taskKey = options.taskKey || null;
    this.emit = typeof options.emit === 'function' ? options.emit : () => {};
    this.spawnImpl = options.spawnImpl || spawn;
    this.platform = options.platform || process.platform;
    this.shell = options.shell ?? (this.platform === 'win32');
    this.handshakeTimeoutMs = Number(options.handshakeTimeoutMs) || DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.child = null;
    this.sessionId = this.resume;
    this.threadId = this.resume;
    this.turnId = null;
    this._buf = '';
    this._stderrTail = '';
    this._nextId = 0;
    this._pending = new Map();
    this._approvals = new Map();
    this._turnQueue = [];
    this._turnActive = false;
    this._ready = null;
    this._closed = false;
    this._lastUsage = null;
    this._contextWindow = null;
    this._items = new Map();
  }

  start() {
    const args = [...this.argsPrefix, 'app-server', '--listen', 'stdio://'];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (this.taskKey) {
      env.SCRUMWS_TASK_KEY = this.taskKey;
      env.SCRUMWS_API_BASE = `http://127.0.0.1:${Number(process.env.SCRUMWS_PORT) || 8799}`;
    }
    this.child = this.spawnImpl(this.command, args, {
      cwd: this.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: this.shell,
    });
    this._wireChild();
    this._ready = this._initialize().catch((error) => {
      this.emit({ type: 'error', error: this._withStderr(error.message), at: nowStr() });
      this.close();
      throw error;
    });
    return this._ready;
  }

  async _initialize() {
    await this._request('initialize', {
      clientInfo: { name: 'scrumws-desktop', title: 'ScrumWS', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }, this.handshakeTimeoutMs);
    this._notify('initialized', {});

    let resumed = false;
    if (this.resume) {
      try {
        const result = await this._request('thread/resume', this._threadResumeParams(), this.handshakeTimeoutMs);
        this.threadId = nested(result, 'thread', 'id') || result?.threadId || result?.id || null;
        if (!this.threadId) throw rpcError('thread/resume 返回缺少 thread id');
        resumed = true;
      } catch (error) {
        if (!canFallbackFromResume(error)) throw error;
        this.threadId = null;
      }
    }
    if (!this.threadId) {
      const result = await this._request('thread/start', this._threadStartParams(), this.handshakeTimeoutMs);
      this.threadId = nested(result, 'thread', 'id') || result?.threadId || result?.id || null;
      if (!this.threadId) throw rpcError('thread/start 返回缺少 thread id');
    }
    this.sessionId = this.threadId;
    this.emit({ type: 'session_initialized', provider: this.provider, sessionId: this.threadId, model: this.model, resumed, at: nowStr() });
    this._drainTurns();
  }

  _threadStartParams() {
    const params = {
      model: this.model || null,
      modelProvider: null,
      profile: null,
      cwd: this.cwd,
      approvalPolicy: null,
      sandbox: null,
      config: null,
      baseInstructions: null,
      developerInstructions: null,
      compactPrompt: null,
      includeApplyPatchTool: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    };
    if (this.effort) params.config = { model_reasoning_effort: this.effort };
    return params;
  }

  _threadResumeParams() {
    const params = { threadId: this.resume, cwd: this.cwd, model: this.model || null, developerInstructions: null, config: null };
    if (this.effort) params.config = { model_reasoning_effort: this.effort };
    return params;
  }

  _wireChild() {
    const child = this.child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this._buf += chunk;
      let newline;
      while ((newline = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, newline);
        this._buf = this._buf.slice(newline + 1);
        this._handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this._stderrTail = (this._stderrTail + String(chunk)).slice(-16 * 1024);
      this.emit({ type: 'diagnostic', stream: 'stderr', text: String(chunk), at: nowStr() });
    });
    child.on('error', (error) => this._failTransport(`codex spawn 失败：${error.message}`));
    child.on('exit', (code, signal) => {
      const unexpected = !this._closed && code !== 0;
      if (unexpected) this._failTransport(`codex app-server 退出（code=${code}, signal=${signal || 'none'}）`);
      else this._rejectPending(transportError('codex app-server 已关闭'));
      this.emit({ type: 'closed', code, signal, at: nowStr() });
    });
  }

  _handleLine(line) {
    const text = line.trim();
    if (!text.startsWith('{')) return;
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) && !message.method) {
      this._handleResponse(message);
    } else if (Object.hasOwn(message, 'id') && message.method) {
      this._handleServerRequest(message);
    } else if (message.method) {
      this._handleNotification(message.method, message.params || {});
    }
  }

  _handleResponse(message) {
    const key = requestKey(message.id);
    const pending = this._pending.get(key);
    if (!pending) return;
    this._pending.delete(key);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(rpcError(`${pending.method}: ${message.error.message || 'RPC error'}`, message.error.code, message.error.data));
    else pending.resolve(message.result || {});
  }

  _request(method, params, timeoutMs = 0) {
    if (!this.child?.stdin?.writable || this._closed) return Promise.reject(transportError(`${method}: transport unavailable`));
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this._pending.delete(requestKey(id));
        reject(transportError(`${method}: handshake timeout after ${timeoutMs}ms`));
      }, timeoutMs) : null;
      timer?.unref?.();
      this._pending.set(requestKey(id), { method, resolve, reject, timer });
      if (!this._write({ id, method, params })) {
        if (timer) clearTimeout(timer);
        this._pending.delete(requestKey(id));
        reject(transportError(`${method}: stdin 不可写`));
      }
    });
  }

  _notify(method, params) { return this._write({ method, params }); }
  _respond(id, result) { return this._write({ id, result }); }
  _respondError(id, code, message) { return this._write({ id, error: { code, message } }); }

  _write(message) {
    if (!this.child?.stdin?.writable || this._closed) return false;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); return true; } catch { return false; }
  }

  send(text) {
    if (this._closed) return false;
    this._turnQueue.push(text);
    if (this._ready) this._ready.then(() => this._drainTurns()).catch(() => {});
    return true;
  }

  async _drainTurns() {
    if (!this.threadId || this._turnActive || !this._turnQueue.length || this._closed) return;
    const text = this._turnQueue.shift();
    this._turnActive = true;
    this.turnId = null;
    const params = { threadId: this.threadId, input: [{ type: 'text', text }] };
    if (this.effort) params.effort = this.effort;
    try {
      const result = await this._request('turn/start', params, this.handshakeTimeoutMs);
      this.turnId = nested(result, 'turn', 'id') || result?.turnId || this.turnId;
    } catch (error) {
      this._turnActive = false;
      this.emit({ type: 'error', error: this._withStderr(`turn/start 失败：${error.message}`), at: nowStr() });
      if (error.transport) this.close();
    }
  }

  _handleServerRequest(message) {
    const method = String(message.method || '');
    const params = message.params || {};
    if (!this._isOwnThread(params)) {
      this._respondError(message.id, -32602, `request threadId 不匹配：${method}`);
      return;
    }
    const known = new Set([
      'item/commandExecution/requestApproval', 'execCommandApproval',
      'item/fileChange/requestApproval', 'applyPatchApproval',
      'item/permissions/requestApproval', 'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
    ]);
    if (!known.has(method)) {
      const error = `unsupported codex app-server request: ${method}`;
      this._respondError(message.id, -32601, error);
      this.emit({ type: 'error', error, method, requestId: message.id, at: nowStr() });
      return;
    }

    const requestId = requestKey(message.id);
    const approval = { id: message.id, method, params };
    this._approvals.set(requestId, approval);
    if (this.bypass && method !== 'item/tool/requestUserInput' && method !== 'mcpServer/elicitation/request') {
      this.respond(requestId, true, null, approval);
      return;
    }
    const input = params.permissions || params;
    const kind = method.includes('commandExecution') || method === 'execCommandApproval' ? 'command'
      : method.includes('fileChange') || method === 'applyPatchApproval' ? 'file'
        : method.includes('permissions') ? 'permissions'
          : method === 'item/tool/requestUserInput' ? 'request_user_input' : 'mcp_elicitation';
    this.emit({
      type: 'approval_requested',
      requestId,
      kind,
      toolName: kind === 'command' ? 'exec_command' : kind === 'file' ? 'patch_apply' : kind,
      input,
      questions: params.questions || null,
      decisions: ['allow', 'deny'],
      _providerRequest: approval,
      at: nowStr(),
    });
  }

  respond(requestId, allow, extraInput, suppliedApproval) {
    const approval = suppliedApproval?._providerRequest || suppliedApproval || this._approvals.get(requestId);
    if (!approval) return false;
    const { id, method, params } = approval;
    let result;
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval'
      || method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      result = { decision: allow ? 'accept' : 'decline' };
    } else if (method === 'item/permissions/requestApproval') {
      result = allow ? this._permissionsResponse(params) : { permissions: {}, scope: 'turn' };
    } else if (method === 'item/tool/requestUserInput') {
      result = { answers: allow ? (extraInput?.answers || extraInput || {}) : {} };
    } else if (method === 'mcpServer/elicitation/request') {
      result = { action: allow ? 'accept' : 'decline', content: allow ? (extraInput || {}) : null, _meta: null };
    } else {
      this._respondError(id, -32601, `unsupported codex app-server request: ${method}`);
      return false;
    }
    const ok = this._respond(id, result);
    if (ok) {
      this._approvals.delete(requestId);
      this.emit({ type: 'approval_resolved', requestId, at: nowStr() });
    }
    return ok;
  }

  _permissionsResponse(params) {
    const source = params?.permissions && typeof params.permissions === 'object' ? params.permissions : {};
    const permissions = {};
    for (const key of ['network', 'fileSystem']) if (source[key] != null) permissions[key] = source[key];
    return { permissions, scope: 'turn' };
  }

  _handleNotification(method, params) {
    if (method === 'serverRequest/resolved') {
      if (!this._isOwnThread(params)) return;
      const id = params.requestId;
      for (const [key, approval] of this._approvals) {
        if (String(approval.id) === String(id)) {
          this._approvals.delete(key);
          this.emit({ type: 'approval_resolved', requestId: key, at: nowStr() });
        }
      }
      return;
    }
    if (!this._isOwnThread(params)) return;

    if (method === 'turn/started') {
      this.turnId = nested(params, 'turn', 'id') || this.turnId;
      this._turnActive = true;
      return;
    }
    if (method === 'turn/completed') {
      const turn = params.turn || {};
      const status = turn.status || 'completed';
      const usage = codexUsage(turn.usage) || this._lastUsage;
      this._turnActive = false;
      this.turnId = null;
      this.emit({
        type: 'turn_completed',
        provider: this.provider,
        sessionId: this.threadId,
        status: ['cancelled', 'canceled', 'aborted', 'interrupted'].includes(status) ? 'interrupted' : status,
        usage,
        contextWindow: this._contextWindow,
        costUsd: null,
        numTurns: 1,
        error: status === 'failed' ? nested(turn, 'error', 'message') || 'Codex turn failed' : null,
        at: nowStr(),
      });
      queueMicrotask(() => this._drainTurns());
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = params.tokenUsage || params.usage || {};
      const last = tokenUsage.last || tokenUsage.lastTokenUsage || tokenUsage.last_token_usage || tokenUsage.total || tokenUsage.totalTokenUsage || tokenUsage.total_token_usage;
      this._lastUsage = codexUsage(last);
      this._contextWindow = Number(tokenUsage.modelContextWindow ?? tokenUsage.contextWindow ?? params.modelContextWindow) || null;
      this.emit({ type: 'turn_usage', usage: this._lastUsage, contextWindow: this._contextWindow, at: nowStr() });
      return;
    }
    if (method === 'error') {
      const error = nested(params, 'error', 'message') || params.message || 'Codex app-server error';
      if (!params.willRetry) this.emit({ type: 'error', error, at: nowStr() });
      else this.emit({ type: 'diagnostic', stream: 'protocol', text: error, retrying: true, at: nowStr() });
      return;
    }
    if (method.startsWith('item/')) this._handleItem(method, params.item || {}, params);
  }

  _isOwnThread(params) {
    if (!this.threadId) return false;
    return typeof params?.threadId === 'string' && params.threadId === this.threadId;
  }

  _handleItem(method, item, params) {
    const id = item.id || params.itemId || null;
    const type = item.type || '';
    if (id) this._items.set(id, { ...(this._items.get(id) || {}), ...item });
    if (method === 'item/agentMessage/delta') {
      this.emit({ type: 'message_delta', messageId: id, blockType: 'text', delta: params.delta || '', at: nowStr() });
      return;
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      this.emit({ type: 'message_delta', messageId: id, blockType: 'thinking', delta: params.delta || '', at: nowStr() });
      return;
    }
    if (method === 'item/completed' && type === 'agentMessage') {
      const text = itemText(item);
      if (text) this.emit({ type: 'message', message: { id, role: 'assistant', model: this.model, content: [{ type: 'text', text, _ts: nowStr() }], usage: this._lastUsage }, at: nowStr() });
      return;
    }
    if (method === 'item/completed' && type === 'reasoning') {
      const text = itemText(item);
      if (text) this.emit({ type: 'message', message: { id, role: 'assistant', model: this.model, content: [{ type: 'thinking', thinking: text, _ts: nowStr() }], usage: null }, at: nowStr() });
      return;
    }
    const supportedTools = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch']);
    if (!supportedTools.has(type)) return;
    if (method === 'item/started') {
      this.emit({ type: 'message', message: { id: `tool-use:${id}`, role: 'assistant', model: this.model, content: [{ type: 'tool_use', id, name: toolName(type), input: toolInput(item), _ts: nowStr() }], usage: null }, at: nowStr() });
    } else if (method === 'item/completed') {
      this.emit({ type: 'message', message: { id: `tool-result:${id}`, role: 'user', model: null, content: [{ type: 'tool_result', tool_use_id: id, content: toolOutput(item), is_error: item.status === 'failed', _ts: nowStr() }], usage: null }, at: nowStr() });
    }
  }

  interrupt() {
    if (!this.threadId || !this.turnId || !this._turnActive) return false;
    this._request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, this.handshakeTimeoutMs)
      .catch((error) => {
        this.emit({ type: 'error', error: `turn/interrupt 失败：${error.message}`, at: nowStr() });
        if (error.transport) this.close();
      });
    return true;
  }

  close() {
    this._closed = true;
    this._rejectPending(transportError('session closed'));
    const child = this.child;
    if (this.platform === 'win32') {
      // Windows 上先杀完整进程树：若先关闭 stdin，app-server 会率先退出，正在运行的
      // PowerShell/cmd 工具进程随即变成孤儿，后续 taskkill 已无法沿父子关系清理。
      terminateChildTree(child, this.platform);
    } else {
      try { child?.stdin?.end(); } catch { /* already gone */ }
      setTimeout(() => terminateChildTree(child, this.platform), 1500).unref?.();
    }
    return true;
  }

  info() {
    return { provider: this.provider, sessionId: this.threadId, model: this.model, effort: this.effort, turnId: this.turnId };
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }

  _failTransport(message) {
    const error = transportError(this._withStderr(message));
    this._rejectPending(error);
    this.emit({ type: 'error', error: error.message, at: nowStr() });
  }

  _withStderr(message) {
    const tail = this._stderrTail.trim();
    return tail ? `${message}; stderr: ${tail}` : message;
  }
}
