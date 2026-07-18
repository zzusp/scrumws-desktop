import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../../../platform/lib/providers/codex.js';
import { resolveProviderSelection, validateProviderSelection } from '../../../../platform/lib/providers/registry.js';

const fixture = fileURLToPath(new URL('./fake-codex-app-server.mjs', import.meta.url));

function waitFor(predicate, message, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      let value;
      try { value = predicate(); } catch (error) { clearInterval(timer); reject(error); return; }
      if (value) { clearInterval(timer); resolve(value); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`timeout: ${message}`)); }
    }, 10);
  });
}

function createAdapter(options = {}) {
  const events = [];
  const adapter = new CodexAdapter({
    command: process.execPath,
    argsPrefix: [fixture],
    cwd: process.cwd(),
    model: 'gpt-fixture',
    effort: 'high',
    shell: false,
    handshakeTimeoutMs: 2000,
    emit: (event) => events.push(event),
    ...options,
  });
  return { adapter, events };
}

const validation = validateProviderSelection({ provider: 'codex', model: 'gpt-fixture', effort: 'ultra' });
assert.equal(validation.ok, true);
assert.equal(resolveProviderSelection({ provider: 'codex' }).provider, 'codex');
assert.equal(validateProviderSelection({ provider: 'codex', dynamicWorkflow: true }).ok, false);
assert.equal(validateProviderSelection({ provider: 'codex', model: 'gpt-fixture & calc' }).ok, false);
assert.equal(new CodexAdapter({ platform: 'win32' }).shell, true, 'Windows 必须通过 shell 解析 codex.cmd');

const blocked = createAdapter({ resume: 'forbidden-thread' });
await assert.rejects(blocked.adapter.start(), /permission denied/);
assert.equal(blocked.events.some((event) => event.type === 'session_initialized'), false, '非 schema/unknown 的 resume 错误不得静默开新 thread');
blocked.adapter.close();
await waitFor(() => blocked.adapter.child?.exitCode != null, 'blocked fixture process exit');

const { adapter, events } = createAdapter({ resume: 'missing-thread' });
await adapter.start();
const initialized = events.find((event) => event.type === 'session_initialized');
assert.deepEqual({ sessionId: initialized?.sessionId, resumed: initialized?.resumed }, { sessionId: 'fake-thread', resumed: false });

assert.equal(adapter.send('MAIN'), true);
const approvalKinds = [];
for (const expected of ['command', 'file', 'permissions', 'request_user_input', 'mcp_elicitation']) {
  const approval = await waitFor(
    () => events.find((event) => event.type === 'approval_requested' && !approvalKinds.includes(event.requestId)),
    `approval ${expected}`,
  );
  assert.equal(approval.kind, expected);
  approvalKinds.push(approval.requestId);
  const input = expected === 'request_user_input' ? { answers: { choice: { answers: ['Yes'] } } }
    : expected === 'mcp_elicitation' ? { confirmed: true } : null;
  assert.equal(adapter.respond(approval.requestId, true, input, approval._providerRequest), true);
}
await waitFor(() => events.filter((event) => event.type === 'turn_completed').length === 1, 'main turn completed');

assert.equal(events.some((event) => event.delta === 'MUST_NOT_LEAK'), false, 'foreign thread delta leaked');
assert.equal(events.some((event) => event.type === 'message_delta' && event.blockType === 'text' && event.delta === 'hello '), true);
assert.equal(events.some((event) => event.type === 'message_delta' && event.blockType === 'thinking' && event.delta === 'inspect '), true);
assert.equal(events.some((event) => event.type === 'message' && event.message?.content?.some((block) => block.type === 'tool_use')), true);
assert.equal(events.some((event) => event.type === 'message' && event.message?.content?.some((block) => block.type === 'tool_result' && block.content === 'fixture-output')), true);
const usage = events.find((event) => event.type === 'turn_usage');
assert.deepEqual(usage?.usage, {
  input_tokens: 75,
  output_tokens: 20,
  cache_read_input_tokens: 25,
  cache_creation_input_tokens: 0,
  reasoning_output_tokens: 5,
});
assert.equal(usage?.contextWindow, 200000);

assert.equal(adapter.send('INTERRUPT'), true);
await waitFor(() => adapter.turnId === 'turn-2' && adapter._turnActive, 'interrupt turn started');
assert.equal(adapter.interrupt(), true);
await waitFor(() => events.filter((event) => event.type === 'turn_completed').length === 2, 'interrupt turn completed');
assert.equal(events.filter((event) => event.type === 'turn_completed')[1].status, 'interrupted');

assert.equal(adapter.send('UNKNOWN'), true);
await waitFor(() => events.some((event) => event.type === 'error' && /unsupported codex app-server request/.test(event.error)), 'unknown request rejected');
await waitFor(() => events.filter((event) => event.type === 'turn_completed').length === 3, 'unknown request error response observed by fixture');

assert.equal(adapter.close(), true);
await waitFor(() => adapter.child?.exitCode != null, 'fixture process exit');
console.log(JSON.stringify({
  ok: true,
  initialized,
  approvalKinds: events.filter((event) => event.type === 'approval_requested').map((event) => event.kind),
  usage: usage.usage,
  completedStatuses: events.filter((event) => event.type === 'turn_completed').map((event) => event.status),
  unknownRequestFailClosed: true,
}));
