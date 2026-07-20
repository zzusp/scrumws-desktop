import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'scrumws-observed-session-'));
const dataRoot = path.join(sandbox, 'data');
const cwd = path.join(sandbox, 'repo');
const rollout = path.join(sandbox, 'rollout.jsonl');
const sessionIndex = path.join(sandbox, 'session_index.jsonl');
const sid = '12345678-1234-4234-8234-123456789abc';
process.env.SCRUMWS_DATA_ROOT = dataRoot;
process.env.SCRUMWS_CODEX_SESSIONS = sandbox;
process.env.SCRUMWS_CODEX_SESSION_INDEX = sessionIndex;
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(path.join(dataRoot, 'runtime', 'runner-state'), { recursive: true });
fs.writeFileSync(rollout, [
  { timestamp: '2026-07-20T00:00:00.000Z', type: 'session_meta', payload: { id: sid, cwd, model: 'gpt-5.6-terra' } },
  { timestamp: '2026-07-20T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-terra', effort: 'high' } },
  { timestamp: '2026-07-20T00:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'inspect the task' } },
  { timestamp: '2026-07-20T00:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'inspection complete' } },
].map(JSON.stringify).join('\n') + '\n');
fs.writeFileSync(sessionIndex, JSON.stringify({ id: sid, thread_name: '观察态 Codex 会话名称' }) + '\n');

try {
  const { upsertWatchlist, readWatchlist } = await import('../../../../platform/lib/cli-watchlist.js');
  const { materializeCliTask } = await import('../../../../platform/lib/task-actions.js');
  const { collectCodexCliSessions, searchCodexCliSessions } = await import('../../../../platform/lib/collect-codex-cli.js');
  const { readWorkerLog, readWorkerLogRevision, renameTask } = await import('../../../../platform/lib/logs.js');
  assert.equal(upsertWatchlist(sid, { provider: 'codex', jsonlPath: rollout }).ok, true);

  const taskKey = `cli:${sid.slice(0, 8)}`;
  assert.equal(collectCodexCliSessions(Date.now())[0].title, '观察态 Codex 会话名称');

  // Codex Desktop may keep multiple rollout recordings for a single thread.
  // Discovery is per thread id, selecting the newest recording rather than
  // showing duplicate add candidates with different sizes/mtimes.
  const olderDuplicate = path.join(sandbox, 'rollout-older.jsonl');
  const newerDuplicate = path.join(sandbox, 'rollout-newer.jsonl');
  fs.writeFileSync(olderDuplicate, fs.readFileSync(rollout));
  fs.writeFileSync(newerDuplicate, fs.readFileSync(rollout) + JSON.stringify({ timestamp: '2026-07-20T00:00:05.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'newest copy' } }) + '\n');
  const duplicateNow = Date.now();
  fs.utimesSync(olderDuplicate, new Date(duplicateNow - 2000), new Date(duplicateNow - 2000));
  fs.utimesSync(newerDuplicate, new Date(duplicateNow + 2000), new Date(duplicateNow + 2000));
  const discovered = searchCodexCliSessions({ q: sid.slice(0, 8) });
  assert.equal(discovered.candidates.length, 1, 'duplicate rollout files collapse to one thread candidate');
  assert.equal(discovered.candidates[0].jsonlPath, newerDuplicate, 'newest rollout is selected for the candidate');
  // 重命名只更新显示元数据，不能把 Codex provider 降级为 Claude（否则详情会选错 JSONL 解析器）。
  assert.equal(renameTask(taskKey, '重命名后的 Codex 任务').ok, true);
  assert.equal(readWatchlist().sessions[sid].provider, 'codex');
  const result = materializeCliTask(taskKey, { state: 'awaiting-human' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const taskDir = path.join(dataRoot, 'runtime', 'runner-state', 'cli__12345678');
  const task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf8'));
  assert.equal(task.provider, 'codex');
  assert.equal(task.title, '重命名后的 Codex 任务');
  assert.equal(task.model, 'gpt-5.6-terra');
  assert.equal(task.effort, 'high');
  assert.equal(task.cwd, cwd);
  assert.equal(meta.sessionId, sid);
  assert.equal(meta.sessionHistory[0].provider, 'codex');
  assert.equal(meta.sessionHistory[0].jsonlPath, rollout);
  assert.equal(readWatchlist().sessions[sid], undefined, 'materialized session leaves the watchlist');

  const detail = readWorkerLog(taskKey);
  assert.equal(detail.ok, true);
  assert.equal(detail.provider, 'codex');
  assert.deepEqual(detail.rounds[0].messages.map((message) => message.role), ['user', 'assistant']);
  const before = readWorkerLogRevision(taskKey);
  fs.appendFileSync(rollout, JSON.stringify({ timestamp: '2026-07-20T00:00:04.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'new polled record' } }) + '\n');
  const after = readWorkerLogRevision(taskKey);
  assert.notEqual(after.revision, before.revision, 'JSONL append changes the lightweight revision');
  assert.equal(readWorkerLog(taskKey).rounds[0].messages.at(-1).content[0].text, 'new polled record');
  console.log('PASS observed Codex session: JSONL parse/revision, provider-aware materialization, resumable metadata');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
