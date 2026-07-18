import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STARTING_TIMEOUT_MS = 60_000;

function nowStr() { return new Date().toISOString(); }

function terminateChildTree(child, platform) {
  if (!child || child.exitCode != null || !child.pid) return;
  if (platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    } catch { /* already gone */ }
  } else {
    try { child.kill(); } catch { /* already gone */ }
  }
}

function normalizedUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    input_tokens: Number(usage.input_tokens) || 0,
    output_tokens: Number(usage.output_tokens) || 0,
    cache_read_input_tokens: Number(usage.cache_read_input_tokens) || 0,
    cache_creation_input_tokens: Number(usage.cache_creation_input_tokens) || 0,
  };
}

function stampContent(content) {
  const stamp = nowStr();
  return (Array.isArray(content) ? content : []).map((block) => {
    if (!block || typeof block !== 'object' || block._ts != null) return block;
    return { ...block, _ts: stamp };
  });
}

export class ClaudeAdapter {
  constructor(options = {}) {
    this.provider = 'claude';
    this.command = options.command || 'claude';
    this.cwd = options.cwd || process.cwd();
    this.model = options.model || null;
    this.effort = options.effort || null;
    this.resume = options.resume || null;
    this.bypass = !!options.bypass;
    this.taskKey = options.taskKey || null;
    this.dynamicWorkflow = options.dynamicWorkflow;
    this.emit = typeof options.emit === 'function' ? options.emit : () => {};
    this.spawnImpl = options.spawnImpl || spawn;
    this.platform = options.platform || process.platform;
    this.child = null;
    this.sessionId = this.resume;
    this.backgroundTasks = [];
    this._buf = '';
    this._startWatchdog = null;
    this._initialized = false;
  }

  start() {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (this.bypass) args.push('--dangerously-skip-permissions', '--disallowedTools', 'AskUserQuestion');
    else args.push('--permission-prompt-tool', 'stdio');
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.resume) args.push('--resume', this.resume);

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (this.dynamicWorkflow === true) {
      env.CLAUDE_CODE_WORKFLOWS = '1';
      delete env.CLAUDE_CODE_DISABLE_WORKFLOWS;
    } else if (this.dynamicWorkflow === false) {
      env.CLAUDE_CODE_DISABLE_WORKFLOWS = '1';
      delete env.CLAUDE_CODE_WORKFLOWS;
    }
    if (this.taskKey) {
      env.SCRUMWS_TASK_KEY = this.taskKey;
      env.SCRUMWS_API_BASE = `http://127.0.0.1:${Number(process.env.SCRUMWS_PORT) || 8799}`;
    }

    this.child = this.spawnImpl(this.command, args, {
      cwd: this.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: this.platform === 'win32',
    });
    this._wireChild();
    return this.child;
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
    child.stderr.on('data', (chunk) => this.emit({ type: 'diagnostic', stream: 'stderr', text: String(chunk), at: nowStr() }));
    child.on('error', (error) => this.emit({ type: 'error', error: error.message, at: nowStr() }));
    child.on('exit', (code, signal) => {
      this._clearWatchdog();
      this.emit({ type: 'closed', code, signal, at: nowStr() });
    });
  }

  _handleLine(line) {
    const text = line.trim();
    if (!text.startsWith('{')) return;
    let raw;
    try { raw = JSON.parse(text); } catch { return; }

    if (raw.type === 'system' && raw.subtype === 'init') {
      this._initialized = true;
      this.sessionId = raw.session_id || this.sessionId;
      this.model = raw.model || this.model;
      this._clearWatchdog();
      this.emit({ type: 'session_initialized', provider: this.provider, sessionId: this.sessionId, model: this.model, at: nowStr() });
      return;
    }
    if (raw.type === 'assistant' || raw.type === 'user') {
      const message = raw.message || {};
      this.emit({
        type: 'message',
        message: {
          id: message.id || raw.uuid || null,
          role: raw.type === 'assistant' ? 'assistant' : 'user',
          model: message.model || null,
          content: stampContent(typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content),
          usage: normalizedUsage(message.usage),
        },
        isMeta: !!raw.isMeta,
        uuid: raw.uuid || null,
        at: raw.timestamp || nowStr(),
      });
      return;
    }
    if (raw.type === 'stream_event') {
      this._handleStreamEvent(raw.event || {});
      return;
    }
    if (raw.type === 'control_request') {
      const requestId = raw.request?.request_id || raw.request_id;
      const request = raw.request?.request || raw.request || {};
      if (requestId && request.subtype === 'can_use_tool') {
        const input = request.input || {};
        this.emit({
          type: 'approval_requested',
          requestId,
          kind: request.tool_name === 'AskUserQuestion' ? 'request_user_input' : 'tool',
          toolName: request.tool_name || 'Tool',
          input,
          questions: Array.isArray(input.questions) ? input.questions : null,
          decisions: ['allow', 'deny'],
          _providerRequest: raw,
          at: nowStr(),
        });
      }
      return;
    }
    if (raw.type === 'system' && raw.subtype === 'background_tasks_changed') {
      this.backgroundTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
      this.emit({ type: 'background_tasks', tasks: this.backgroundTasks, at: nowStr() });
      return;
    }
    if (raw.type === 'result') {
      const status = raw.is_error ? 'failed' : (raw.subtype === 'interrupted' ? 'interrupted' : 'completed');
      this.emit({
        type: 'turn_completed',
        provider: this.provider,
        sessionId: raw.session_id || this.sessionId,
        status,
        usage: normalizedUsage(raw.usage),
        costUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : null,
        numTurns: Number(raw.num_turns) || 0,
        error: raw.is_error ? String(raw.result || raw.error || 'Claude turn failed') : null,
        at: nowStr(),
      });
    }
  }

  _handleStreamEvent(event) {
    if (event.type === 'content_block_delta' && event.delta) {
      const delta = event.delta;
      if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
        this.emit({
          type: 'message_delta',
          messageId: event.message_id || null,
          blockType: delta.type === 'thinking_delta' ? 'thinking' : 'text',
          delta: delta.text || delta.thinking || '',
          at: nowStr(),
        });
      }
    } else if (event.type === 'message_start' && event.message?.usage) {
      this.emit({ type: 'turn_usage', usage: normalizedUsage(event.message.usage), at: nowStr() });
    } else if (event.type === 'message_delta' && event.usage) {
      this.emit({ type: 'turn_usage', usage: normalizedUsage(event.usage), at: nowStr() });
    }
  }

  _write(object) {
    if (!this.child || this.child.killed || !this.child.stdin?.writable) return false;
    try { this.child.stdin.write(`${JSON.stringify(object)}\n`); return true; } catch { return false; }
  }

  send(text) {
    const ok = this._write({ type: 'user', message: { role: 'user', content: text } });
    if (ok && !this._initialized) this._armWatchdog();
    return ok;
  }

  respond(requestId, allow, extraInput, approval) {
    const raw = approval?._providerRequest || {};
    const request = raw.request?.request || raw.request || {};
    const originalInput = request.input || {};
    const response = allow
      ? { behavior: 'allow', updatedInput: extraInput ? { ...originalInput, ...extraInput } : originalInput }
      : { behavior: 'deny', message: 'denied by user' };
    const ok = this._write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    if (ok) this.emit({ type: 'approval_resolved', requestId, at: nowStr() });
    return ok;
  }

  interrupt() {
    return this._write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  }

  stopTask(taskId) {
    return this._write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'stop_task', task_id: taskId } });
  }

  taskOutputPath(taskId) {
    if (!this.cwd || !this.sessionId) return null;
    const folded = this.cwd.replace(/[:\\/]/g, '-');
    return path.join(os.tmpdir(), 'claude', folded, this.sessionId, 'tasks', `${taskId}.output`);
  }

  readTaskOutput(taskId, tailBytes = 64 * 1024) {
    const outputPath = this.taskOutputPath(taskId);
    if (!outputPath) return { ok: false, error: '会话尚未 init（无 sessionId），暂无法定位输出文件' };
    let fd;
    try {
      fd = fs.openSync(outputPath, 'r');
      const { size } = fs.fstatSync(fd);
      const start = Math.max(0, size - tailBytes);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return { ok: true, path: outputPath, size, truncated: start > 0, text: buffer.toString('utf8') };
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: false, error: '输出文件不存在（任务可能已结束，CC 会清理输出）', gone: true };
      return { ok: false, error: error.message };
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  close() {
    this._clearWatchdog();
    try { this.child?.stdin?.end(); } catch { /* already gone */ }
    const child = this.child;
    setTimeout(() => terminateChildTree(child, this.platform), 1500).unref?.();
    return true;
  }

  info() {
    return { provider: this.provider, sessionId: this.sessionId, model: this.model, effort: this.effort, backgroundTasks: this.backgroundTasks };
  }

  _armWatchdog() {
    if (this._startWatchdog) return;
    this._startWatchdog = setTimeout(() => {
      if (this._initialized) return;
      const error = 'init 超时（发出消息后 60s 未收到 system/init；该 session 可能已被其他进程占用）';
      this.emit({ type: 'error', error, at: nowStr() });
      terminateChildTree(this.child, this.platform);
    }, STARTING_TIMEOUT_MS);
    this._startWatchdog.unref?.();
  }

  _clearWatchdog() {
    if (this._startWatchdog) clearTimeout(this._startWatchdog);
    this._startWatchdog = null;
  }
}
