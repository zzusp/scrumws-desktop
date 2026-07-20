import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'scrumws-dual-runner-'));
const binDir = path.join(sandbox, 'bin');
const rpcLog = path.join(sandbox, 'codex-rpc.log');
fs.mkdirSync(binDir, { recursive: true });
process.env.SCRUMWS_DATA_ROOT = sandbox;
process.env.FAKE_CODEX_RPC_LOG = rpcLog;
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ''}`;

const fakeServer = path.join(binDir, 'fake-codex-app-server.mjs');
fs.writeFileSync(fakeServer, `
import fs from 'node:fs';
import readline from 'node:readline';
const log = process.env.FAKE_CODEX_RPC_LOG;
let turn = 0;
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method) fs.appendFileSync(log, request.method + '\\n');
  if (request.method === 'initialize') out({ id: request.id, result: {} });
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    out({ id: request.id, result: { thread: { id: 'thread-fixture-codex' } } });
  } else if (request.method === 'turn/start') {
    turn += 1;
    const turnId = 'turn-' + turn;
    out({ id: request.id, result: { turn: { id: turnId } } });
    setTimeout(() => {
      out({ method: 'turn/started', params: { threadId: 'thread-fixture-codex', turn: { id: turnId } } });
      out({ method: 'item/agentMessage/delta', params: { threadId: 'thread-fixture-codex', item: { id: 'msg-' + turn, type: 'agentMessage' }, delta: 'partial-' + turn } });
      out({ method: 'item/completed', params: { threadId: 'thread-fixture-codex', item: { id: 'msg-' + turn, type: 'agentMessage', text: 'answer-' + turn } } });
      out({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-fixture-codex', tokenUsage: { last: { inputTokens: 10 * turn, outputTokens: turn }, modelContextWindow: 200000 } } });
      out({ method: 'turn/completed', params: { threadId: 'thread-fixture-codex', turn: { id: turnId, status: 'completed' } } });
    }, 10);
  }
});
rl.on('close', () => process.exit(0));
`, 'utf8');

const command = path.join(binDir, 'codex.cmd');
fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${fakeServer}" %*\r\n`, 'utf8');

const here = path.dirname(fileURLToPath(import.meta.url));
const platformLib = path.join(here, '../../../../platform/lib');
const runner = await import(pathToFileURL(path.join(platformLib, 'task-runner.js')).href);
const sessions = await import(pathToFileURL(path.join(platformLib, 'session-manager.js')).href);
const { readWorkerLog } = await import(pathToFileURL(path.join(platformLib, 'logs.js')).href);

const taskKey = 'manual:codex-runner';
const taskDir = path.join(sandbox, 'runtime', 'runner-state', 'manual__codex-runner');
fs.mkdirSync(taskDir, { recursive: true });
fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({
  taskKey,
  provider: 'codex',
  prompt: 'first turn',
  cwd: sandbox,
  model: '',
  effort: 'high',
}, null, 2));
fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({ state: 'queued', history: [] }, null, 2));

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(taskDir, name), 'utf8'));
const waitFor = async (predicate, label, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${label}`);
};

try {
  const first = runner.startTask(taskKey);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(sessions.getSession(first.sessionUiId)?.provider, 'codex');
  await waitFor(() => readJson('state.json').state === 'awaiting-human' && readJson('meta.json').rounds === 1, 'first turn completed');

  let meta = readJson('meta.json');
  assert.equal(meta.sessionId, 'thread-fixture-codex');
  assert.equal(meta.sessionHistory.length, 1);
  assert.deepEqual(meta.sessionHistory[0].provider, 'codex');
  assert.equal(runner.getTaskSessionId(taskKey), null, 'one-shot Codex process is released after the turn');

  const second = runner.replyTask(taskKey, 'second turn', '', 'high');
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.resumed, 'thread-fixture-codex');
  await waitFor(() => readJson('state.json').state === 'awaiting-human' && readJson('meta.json').rounds === 2, 'second turn completed');

  const parked = runner.parkTaskSession(taskKey);
  assert.equal(parked.ok, true);
  assert.equal(parked.killed, null);
  const task = readJson('task.json');
  task.prompt = 'third turn after restart';
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(task, null, 2));

  const third = runner.startTask(taskKey);
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(third.resumed, 'thread-fixture-codex');
  const seeded = sessions.getSession(third.sessionUiId)?.transcript || [];
  assert.ok(seeded.filter((event) => event.type === 'message').length >= 5, 'journal messages seed the resumed Codex session');
  await waitFor(() => readJson('state.json').state === 'awaiting-human' && readJson('meta.json').rounds === 3, 'resumed turn completed');

  meta = readJson('meta.json');
  assert.equal(meta.sessionHistory.length, 1, 'same provider/session is not duplicated in sessionHistory');
  const methods = fs.readFileSync(rpcLog, 'utf8').trim().split(/\r?\n/);
  assert.ok(methods.includes('thread/start'));
  assert.ok(methods.includes('thread/resume'), 'task.provider routes resume through Codex adapter');

  const detail = readWorkerLog(taskKey);
  assert.equal(detail.provider, 'codex');
  assert.equal(detail.rounds.length, 3);
  assert.deepEqual(detail.rounds.map((round) => round.messages.at(-1)?.content?.[0]?.text), ['answer-1', 'answer-1', 'answer-1']);
  const journalText = fs.readFileSync(path.join(taskDir, 'session-events.jsonl'), 'utf8');
  assert.equal(journalText.includes('message_delta'), false, 'high-frequency deltas stay out of the task package');

  console.log('PASS task runner: provider route, resume seed, lifecycle/meta, settled journal');
} finally {
  try { runner.parkTaskSession(taskKey); } catch { /* already closed */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
