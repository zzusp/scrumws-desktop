import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../../../../platform/lib/providers/codex.js';

const command = process.env.CODEX_COMMAND || 'codex';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scrumws-real-codex-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(events, predicate, label, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const hit = events.find(predicate);
    if (hit) return resolve(hit);
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const event = events.find(predicate);
      if (event) { clearInterval(timer); resolve(event); }
      else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error(`timeout: ${label}`)); }
    }, 20);
  });
}

async function waitClosed(adapter) {
  const child = adapter.child;
  adapter.close();
  const deadline = Date.now() + 5000;
  while (child?.exitCode == null && Date.now() < deadline) await sleep(25);
  assert.notEqual(child?.exitCode, null, 'codex app-server child should exit after close');
}

let first;
let resumed;
try {
  const firstEvents = [];
  first = new CodexAdapter({ command, cwd, bypass: true, emit: (event) => firstEvents.push(event) });
  await first.start();
  assert.ok(first.threadId, 'thread/start should return a thread id');
  assert.equal(first.send('只回复 CODEX_DESKTOP_FIRST_OK，不调用工具，不修改文件。'), true);
  const completed = await waitFor(firstEvents, (event) => event.type === 'turn_completed', 'first turn');
  assert.equal(completed.status, 'completed');
  assert.ok(firstEvents.filter((event) => event.type === 'message_delta').map((event) => event.delta).join('').includes('CODEX_DESKTOP_FIRST_OK'));
  assert.ok(firstEvents.some((event) => event.type === 'message' && JSON.stringify(event.message?.content).includes('CODEX_DESKTOP_FIRST_OK')));
  const threadId = first.threadId;
  await waitClosed(first);
  first = null;

  const resumedEvents = [];
  resumed = new CodexAdapter({ command, cwd, resume: threadId, bypass: true, emit: (event) => resumedEvents.push(event) });
  await resumed.start();
  const initialized = resumedEvents.find((event) => event.type === 'session_initialized');
  assert.equal(initialized?.sessionId, threadId);
  assert.equal(initialized?.resumed, true);
  assert.equal(resumed.send('只回复 CODEX_DESKTOP_RESUME_OK，不调用工具，不修改文件。'), true);
  const second = await waitFor(resumedEvents, (event) => event.type === 'turn_completed', 'resumed turn');
  assert.equal(second.status, 'completed');
  assert.ok(resumedEvents.some((event) => event.type === 'message' && JSON.stringify(event.message?.content).includes('CODEX_DESKTOP_RESUME_OK')));

  const completedBeforeInterrupt = resumedEvents.filter((event) => event.type === 'turn_completed').length;
  assert.equal(resumed.send('请使用 shell 工具运行 PowerShell 命令 Start-Sleep -Seconds 60；命令结束后再回复完成。不要做其它操作。'), true);
  await waitFor(
    resumedEvents,
    (event) => event.type === 'message'
      && event.message?.content?.some((block) => block.type === 'tool_use'),
    'interruptible command tool use',
    30000,
  );
  assert.equal(resumed.interrupt(), true, 'active turn should accept interrupt');
  let interrupted;
  try {
    interrupted = await waitFor(
      resumedEvents,
      (event) => event.type === 'turn_completed' && event.status === 'interrupted'
        && resumedEvents.filter((candidate) => candidate.type === 'turn_completed').length > completedBeforeInterrupt,
      'interrupted turn',
      30000,
    );
  } catch (error) {
    console.error('interrupt diagnostics:', JSON.stringify(resumedEvents.filter((event) => ['turn_completed', 'error', 'diagnostic'].includes(event.type))));
    throw error;
  }
  assert.equal(interrupted.status, 'interrupted');

  console.log(JSON.stringify({
    ok: true,
    command,
    threadId,
    firstTypes: [...new Set(firstEvents.map((event) => event.type))],
    resumed: initialized?.resumed,
    usage: second.usage,
    interruptStatus: interrupted.status,
  }));
} finally {
  if (first) await waitClosed(first).catch(() => {});
  if (resumed) await waitClosed(resumed).catch(() => {});
  fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
