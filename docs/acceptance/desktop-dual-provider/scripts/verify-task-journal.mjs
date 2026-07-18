import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'scrumws-dual-journal-'));
process.env.SCRUMWS_DATA_ROOT = sandbox;
const claudeProjects = path.join(sandbox, 'claude-projects');
process.env.SCRUMWS_CC_PROJECTS = claudeProjects;

const here = path.dirname(fileURLToPath(import.meta.url));
const logsPath = path.join(here, '../../../../platform/lib/logs.js');
const {
  appendSessionJournalEvent,
  readSessionJournal,
  readTaskSessionSeed,
  readWorkerLog,
} = await import(pathToFileURL(logsPath).href);

const taskKey = 'manual:codex-journal';
const taskDir = path.join(sandbox, 'runtime', 'runner-state', 'manual__codex-journal');
fs.mkdirSync(taskDir, { recursive: true });
fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({
  taskKey,
  provider: 'codex',
  model: 'gpt-5.6-sol',
  cwd: 'D:/work/repo',
}, null, 2));
fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify({
  sessionId: 'thread-codex-1',
  sessionHistory: [{ provider: 'codex', sessionId: 'thread-codex-1', round: 1, at: '2026-07-18 10:00:00' }],
}, null, 2));
fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({ state: 'awaiting-human' }, null, 2));

const claudeSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const claudeProjectDir = path.join(claudeProjects, 'fixture-project');
fs.mkdirSync(claudeProjectDir, { recursive: true });
fs.writeFileSync(path.join(claudeProjectDir, `${claudeSessionId}.jsonl`), [
  JSON.stringify({
    type: 'user', uuid: 'legacy-user-1', parentUuid: null, timestamp: '2026-07-18T09:00:00.000Z',
    message: { content: 'legacy claude question' },
  }),
  JSON.stringify({
    type: 'assistant', uuid: 'legacy-assistant-1', parentUuid: 'legacy-user-1', timestamp: '2026-07-18T09:00:01.000Z',
    message: { id: 'legacy-message-1', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'legacy claude answer' }], usage: { input_tokens: 8, output_tokens: 4 } },
  }),
].join('\n'), 'utf8');

const append = (event) => assert.equal(appendSessionJournalEvent(taskKey, event), true, `append ${event.type}`);
append({ type: 'session_initialized', provider: 'codex', sessionId: 'thread-codex-1', model: 'gpt-5.6-sol', at: '2026-07-18T10:00:00.000Z' });
append({ type: 'message', message: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'round one' }] }, at: '2026-07-18T10:00:01.000Z' });
assert.equal(appendSessionJournalEvent(taskKey, { type: 'message_delta', messageId: 'a1', blockType: 'text', delta: 'partial' }), false, 'message_delta must not be journaled');
append({ type: 'message', message: { id: 'a1', role: 'assistant', model: 'gpt-5.6-sol', content: [{ type: 'text', text: 'first answer' }] }, at: '2026-07-18T10:00:02.000Z' });
append({ type: 'turn_usage', usage: { input_tokens: 10, output_tokens: 3 }, contextWindow: 200000, at: '2026-07-18T10:00:02.500Z' });
append({ type: 'turn_completed', provider: 'codex', sessionId: 'thread-codex-1', status: 'completed', usage: { input_tokens: 10, output_tokens: 3 }, at: '2026-07-18T10:00:03.000Z' });
append({ type: 'message', message: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'round two' }] }, at: '2026-07-18T10:01:00.000Z' });
append({ type: 'message', message: { id: 'a2', role: 'assistant', model: 'gpt-5.6-sol', content: [{ type: 'thinking', text: 'checked' }, { type: 'text', text: 'second answer' }] }, at: '2026-07-18T10:01:01.000Z' });
append({ type: 'turn_completed', provider: 'codex', sessionId: 'thread-codex-1', status: 'completed', usage: { input_tokens: 20, output_tokens: 5 }, at: '2026-07-18T10:01:02.000Z' });

try {
  const journal = readSessionJournal(taskKey);
  assert.equal(journal.ok, true);
  assert.equal(journal.provider, 'codex');
  assert.equal(journal.events.length, 8);
  assert.equal(journal.events.some((event) => event.type === 'message_delta'), false);

  const diskLines = fs.readFileSync(path.join(taskDir, 'session-events.jsonl'), 'utf8').trim().split(/\r?\n/);
  assert.equal(diskLines.length, 8, 'disk journal contains settled events only');

  const seed = readTaskSessionSeed(taskKey, 'codex', 'thread-codex-1');
  assert.equal(seed.ok, true);
  assert.equal(seed.seedTranscript.length, 4);
  assert.deepEqual(seed.seedTranscript.map((event) => event.message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(seed.seedTranscript.some((event) => event.type === 'turn_completed'), false);

  const legacyClaudeSeed = readTaskSessionSeed('manual:legacy-claude', 'claude', claudeSessionId);
  assert.equal(legacyClaudeSeed.ok, true);
  assert.deepEqual(legacyClaudeSeed.seedTranscript.map((event) => event.type), ['user', 'assistant']);
  assert.equal(legacyClaudeSeed.seedTranscript[0].message.content[0].text, 'legacy claude question');
  assert.equal(legacyClaudeSeed.seedTranscript[1].message.content[0].text, 'legacy claude answer');

  const detail = readWorkerLog(taskKey);
  assert.equal(detail.ok, true);
  assert.equal(detail.provider, 'codex');
  assert.equal(detail.hasInflight, false);
  assert.equal(detail.rounds.length, 2);
  assert.deepEqual(detail.rounds.map((round) => round.provider), ['codex', 'codex']);
  assert.deepEqual(detail.rounds.map((round) => round.messages.length), [2, 2]);
  assert.equal(detail.rounds[0].ccSummary.contextSize, 200000);
  assert.deepEqual(detail.rounds[1].metaUsage, { input_tokens: 20, output_tokens: 5 });
  const latestOnly = readWorkerLog(taskKey, 1);
  assert.equal(latestOnly.rounds.length, 1);
  assert.equal(latestOnly.rounds[0].messages[0].content[0].text, 'round two');

  console.log('PASS task journal: settled-only disk, legacy Claude seed, Codex seed, latest idle detail rounds');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
