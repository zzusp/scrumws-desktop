import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeAdapter } from '../../../../platform/lib/providers/claude.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; child.exitCode = 0; return true; };
  return child;
}

const events = [];
const writes = [];
const child = fakeChild();
let spawned = null;
const adapter = new ClaudeAdapter({
  command: 'claude',
  cwd: process.cwd(),
  model: 'claude-opus-4-8',
  effort: 'xhigh',
  dynamicWorkflow: true,
  taskKey: 'fixture-task',
  platform: 'win32',
  emit: (event) => events.push(event),
  spawnImpl: (command, args, options) => {
    spawned = { command, args, options };
    child.stdin.on('data', (chunk) => writes.push(JSON.parse(String(chunk).trim())));
    return child;
  },
});

assert.equal(adapter.start(), child);
assert.equal(spawned.command, 'claude');
assert.equal(spawned.options.shell, true);
assert.equal(spawned.options.env.CLAUDE_CODE_WORKFLOWS, '1');
assert.equal(spawned.options.env.SCRUMWS_TASK_KEY, 'fixture-task');
assert.equal(spawned.args.includes('--permission-prompt-tool'), true);
assert.equal(spawned.args.includes('--model'), true);
assert.equal(spawned.args.includes('--effort'), true);

function emitRaw(value) { child.stdout.write(`${JSON.stringify(value)}\n`); }

emitRaw({ type: 'system', subtype: 'init', session_id: 'claude-fixture', model: 'claude-opus-4-8' });
emitRaw({ type: 'stream_event', event: { type: 'content_block_delta', message_id: 'message-1', delta: { type: 'text_delta', text: 'hello ' } } });
emitRaw({ type: 'stream_event', event: { type: 'content_block_delta', message_id: 'message-1', delta: { type: 'thinking_delta', thinking: 'inspect ' } } });
emitRaw({
  type: 'assistant',
  uuid: 'assistant-event',
  message: {
    id: 'message-1',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text: 'hello world' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } }],
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  },
});
const rawApproval = {
  type: 'control_request',
  request_id: 'approval-1',
  request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: 'README.md' } },
};
emitRaw(rawApproval);
emitRaw({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-1', task_type: 'shell', description: 'fixture' }] });
emitRaw({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'fixture output' }] },
});
emitRaw({
  type: 'result',
  session_id: 'claude-fixture',
  subtype: 'success',
  usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 },
  total_cost_usd: 0.01,
  num_turns: 1,
});

const initialized = events.find((event) => event.type === 'session_initialized');
assert.equal(initialized?.sessionId, 'claude-fixture');
assert.equal(events.some((event) => event.type === 'message_delta' && event.blockType === 'text' && event.delta === 'hello '), true);
assert.equal(events.some((event) => event.type === 'message_delta' && event.blockType === 'thinking' && event.delta === 'inspect '), true);
const assistant = events.find((event) => event.type === 'message' && event.message?.role === 'assistant');
assert.equal(assistant.message.content[1].type, 'tool_use');
assert.equal(assistant.message.content.every((block) => Boolean(block._ts)), true);
assert.deepEqual(assistant.message.usage, {
  input_tokens: 10,
  output_tokens: 4,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
});
const approval = events.find((event) => event.type === 'approval_requested');
assert.deepEqual({ requestId: approval?.requestId, kind: approval?.kind, toolName: approval?.toolName }, {
  requestId: 'approval-1', kind: 'tool', toolName: 'Read',
});
assert.equal(adapter.respond(approval.requestId, true, { file_path: 'docs/README.md' }, approval), true);
assert.equal(events.some((event) => event.type === 'approval_resolved' && event.requestId === 'approval-1'), true);
assert.equal(events.find((event) => event.type === 'background_tasks')?.tasks?.[0]?.task_id, 'task-1');
assert.equal(events.find((event) => event.type === 'turn_completed')?.status, 'completed');

assert.equal(adapter.send('follow up'), true);
assert.equal(adapter.interrupt(), true);
assert.equal(adapter.stopTask('task-1'), true);
assert.equal(writes.some((message) => message.type === 'user' && message.message?.content === 'follow up'), true);
assert.equal(writes.some((message) => message.type === 'control_response' && message.response?.request_id === 'approval-1'), true);
assert.equal(writes.some((message) => message.type === 'control_request' && message.request?.subtype === 'interrupt'), true);
assert.equal(writes.some((message) => message.type === 'control_request' && message.request?.subtype === 'stop_task'), true);

child.exitCode = 0;
assert.equal(adapter.close(), true);

const bypassChild = fakeChild();
let bypassArgs = null;
new ClaudeAdapter({
  bypass: true,
  platform: 'win32',
  spawnImpl: (_command, args) => { bypassArgs = args; return bypassChild; },
}).start();
assert.equal(bypassArgs.includes('--dangerously-skip-permissions'), true);
assert.equal(bypassArgs.includes('AskUserQuestion'), true);
bypassChild.exitCode = 0;
bypassChild.stdin.end();

console.log(JSON.stringify({
  ok: true,
  sessionId: initialized.sessionId,
  canonicalTypes: [...new Set(events.map((event) => event.type))],
  stdinActions: writes.map((message) => message.type === 'control_request' ? message.request.subtype : message.type),
  windowsShell: spawned.options.shell,
}));
