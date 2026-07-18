import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from '../../../../platform/lib/providers/claude.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scrumws-real-claude-'));
const target = path.join(cwd, 'approval-proof.txt');
const events = [];
const adapter = new ClaudeAdapter({
  cwd,
  model: process.env.CLAUDE_TEST_MODEL || 'claude-haiku-4-5-20251001',
  bypass: false,
  emit: (event) => events.push(event),
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(predicate, label, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const hit = events.find(predicate);
    if (hit) return resolve(hit);
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const event = events.find(predicate);
      if (event) { clearInterval(timer); resolve(event); }
      else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error(`timeout: ${label}; events=${JSON.stringify(events.slice(-12))}`)); }
    }, 20);
  });
}

try {
  adapter.start();
  const request = `Use the Write tool to create ${target} with exact content CLAUDE_APPROVAL_OK. Do not use shell commands.`;
  assert.equal(adapter.send(request), true);
  const deniedApproval = await waitFor((event) => event.type === 'approval_requested', 'deny approval');
  assert.equal(adapter.respond(deniedApproval.requestId, false, null, deniedApproval), true);
  const deniedTurn = await waitFor((event) => event.type === 'turn_completed', 'denied turn');
  assert.equal(fs.existsSync(target), false, 'denied tool must not create the file');

  const approvalsBefore = events.filter((event) => event.type === 'approval_requested').length;
  const turnsBefore = events.filter((event) => event.type === 'turn_completed').length;
  assert.equal(adapter.send(request), true);
  const allowedApproval = await waitFor(
    (event) => event.type === 'approval_requested'
      && events.filter((candidate) => candidate.type === 'approval_requested').length > approvalsBefore
      && event !== deniedApproval,
    'allow approval',
  );
  assert.equal(adapter.respond(allowedApproval.requestId, true, null, allowedApproval), true);
  await waitFor(
    (event) => event.type === 'turn_completed'
      && events.filter((candidate) => candidate.type === 'turn_completed').length > turnsBefore
      && event !== deniedTurn,
    'allowed turn',
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'CLAUDE_APPROVAL_OK');

  const interruptedBefore = events.filter((event) => event.type === 'turn_completed').length;
  const deltasBefore = events.filter((event) => event.type === 'message_delta').length;
  assert.equal(adapter.send('Write a five-thousand-word technical essay as text only. Do not call tools.'), true);
  await waitFor((event) => event.type === 'message_delta' && event.blockType === 'text'
    && events.filter((candidate) => candidate.type === 'message_delta').length > deltasBefore, 'interruptible text');
  assert.equal(adapter.interrupt(), true);
  const interrupted = await waitFor(
    (event) => event.type === 'turn_completed'
      && events.filter((candidate) => candidate.type === 'turn_completed').length > interruptedBefore
      && event.status === 'interrupted',
    'interrupted turn',
  );

  console.log(JSON.stringify({
    ok: true,
    sessionId: adapter.sessionId,
    canonicalTypes: [...new Set(events.map((event) => event.type))],
    deniedStatus: deniedTurn.status,
    allowedFile: fs.readFileSync(target, 'utf8'),
    interruptStatus: interrupted.status,
  }));
} finally {
  adapter.close();
  await sleep(1800);
  fs.rmSync(cwd, { recursive: true, force: true });
}
