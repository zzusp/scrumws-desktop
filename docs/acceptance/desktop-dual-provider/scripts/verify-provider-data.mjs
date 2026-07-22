import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'scrumws-provider-data-'));
process.env.SCRUMWS_DATA_ROOT = sandbox;
process.env.SCRUMWS_CODEX_SESSIONS = path.join(sandbox, 'codex-sessions');

const here = path.dirname(fileURLToPath(import.meta.url));
const platformLib = path.join(here, '../../../../platform/lib');
const importLib = (name) => import(pathToFileURL(path.join(platformLib, name)).href);
const { writeConfig } = await importLib('runner-config.js');
const { createTask, editTask, readTaskEdit } = await importLib('task-actions.js');
const { createApiKey, listApiKeys } = await importLib('api-keys.js');
const { createExternalTask, externalTaskStatus } = await importLib('external-ingest.js');
const { collectState } = await importLib('collect.js');

const readTask = (taskKey) => {
  const safeKey = taskKey.replace(/:/g, '__').replace(/#/g, '_');
  return JSON.parse(fs.readFileSync(path.join(sandbox, 'runtime', 'runner-state', safeKey, 'task.json'), 'utf8'));
};

try {
  fs.mkdirSync(path.join(sandbox, 'runtime', 'runner-state'), { recursive: true });
  writeConfig({
    defaultProvider: 'codex',
    defaultModel: 'claude-opus-4-7',
    providerDefaults: {
      claude: { model: 'claude-sonnet-5', effort: 'medium' },
      codex: { model: 'gpt-config-default', effort: 'high' },
    },
    workDirectories: [sandbox],
  });

  // provider 缺失仍按 Claude，不能被本机 defaultProvider=codex 改义；新包必须显式落 provider。
  const legacyCreate = createTask({ title: 'legacy caller', prompt: 'keep claude', cwd: sandbox, plan: true });
  assert.equal(legacyCreate.ok, true, legacyCreate.error);
  const legacyCreatedTask = readTask(legacyCreate.taskKey);
  assert.equal(legacyCreatedTask.provider, 'claude');
  assert.equal(legacyCreatedTask.model, 'claude-sonnet-5');
  assert.equal(legacyCreatedTask.effort, 'medium');

  const codexCreate = createTask({
    provider: 'codex', title: 'codex task', prompt: 'use cli default model', cwd: sandbox,
    model: '', effort: 'ultra', plan: true, dynamicWorkflow: false,
  });
  assert.equal(codexCreate.ok, true, codexCreate.error);
  const codexTask = readTask(codexCreate.taskKey);
  assert.equal(codexTask.provider, 'codex');
  assert.equal(codexTask.model, '');
  assert.equal(codexTask.effort, 'ultra');

  const unsupportedWorkflow = createTask({
    provider: 'codex', title: 'invalid workflow', prompt: 'reject', cwd: sandbox,
    plan: true, dynamicWorkflow: true,
  });
  assert.equal(unsupportedWorkflow.ok, false);
  assert.match(unsupportedWorkflow.error, /不支持 dynamicWorkflow/);

  // 旧 task.json 无 provider 读取为 Claude；一旦有 sessionId，编辑 provider 必须锁定。
  const oldKey = 'manual:old-providerless';
  const oldDir = path.join(sandbox, 'runtime', 'runner-state', 'manual__old-providerless');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'task.json'), JSON.stringify({
    taskKey: oldKey, source: 'manual', title: 'old', prompt: 'old', model: 'claude-opus-4-8', cwd: sandbox,
  }, null, 2));
  fs.writeFileSync(path.join(oldDir, 'state.json'), JSON.stringify({ state: 'plan' }, null, 2));
  fs.writeFileSync(path.join(oldDir, 'meta.json'), JSON.stringify({ sessionId: 'claude-session-1' }, null, 2));
  assert.equal(readTaskEdit(oldKey).provider, 'claude');
  const lockedEdit = editTask({
    taskKey: oldKey, provider: 'codex', title: 'old', prompt: 'old', model: '', effort: 'high', cwd: sandbox,
  });
  assert.equal(lockedEdit.ok, false);
  assert.match(lockedEdit.error, /provider 已锁定/);

  const switchable = createTask({ title: 'switchable', prompt: 'switch', cwd: sandbox, plan: true });
  const switched = editTask({
    taskKey: switchable.taskKey, provider: 'codex', title: 'switchable', prompt: 'switch', cwd: sandbox,
  });
  assert.equal(switched.ok, true, switched.error);
  const switchedTask = readTask(switchable.taskKey);
  assert.equal(switchedTask.provider, 'codex');
  assert.equal(switchedTask.model, 'gpt-config-default');
  assert.equal(switchedTask.effort, 'high');

  // API key provider 作用域：Codex 的空字符串 model 是“CLI 默认”，不是缺失策略。
  const createdKey = createApiKey({
    label: 'codex ingest', source: 'fixture', provider: 'codex',
    allowedModels: [''], allowedEfforts: [''], allowedCwds: [sandbox], allowQueued: false,
  });
  assert.equal(createdKey.ok, true, createdKey.error);
  assert.equal(createdKey.key.provider, 'codex');
  assert.deepEqual(createdKey.key.allowedModels, ['']);
  assert.equal(listApiKeys()[0].provider, 'codex');
  const keysFile = path.join(sandbox, 'runtime', 'api-keys.json');
  const keyStore = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
  keyStore.keys.push({
    id: 'legacy-key', label: 'legacy', source: 'legacy', prefix: 'swak_legacy', createdAt: '2026-07-18 00:00:00',
    allowedModels: ['claude-opus-4-8'], allowedEfforts: ['xhigh'], allowedCwds: [sandbox], allowQueued: false,
  });
  fs.writeFileSync(keysFile, JSON.stringify(keyStore, null, 2));
  assert.equal(listApiKeys().find((item) => item.id === 'legacy-key')?.provider, 'claude');

  const crossProvider = createExternalTask(createdKey.key, {
    provider: 'claude', title: 'cross', prompt: 'reject', cwd: sandbox,
  });
  assert.equal(crossProvider.ok, false);
  assert.match(crossProvider.error, /不能在请求中跨 provider/);

  const external = createExternalTask(createdKey.key, {
    title: 'external codex', prompt: 'default model', cwd: sandbox, externalKey: 'fixture-1',
  });
  assert.equal(external.ok, true, external.error);
  const externalTask = readTask(external.taskKey);
  assert.equal(externalTask.provider, 'codex');
  assert.equal(externalTask.model, '');
  assert.equal(Object.hasOwn(externalTask, 'effort'), false);
  const status = externalTaskStatus(createdKey.key, { externalKey: 'fixture-1' });
  assert.equal(status.ok, true, status.error);
  assert.equal(status.provider, 'codex');

  // HTTP 契约：provider registry + 独立 runtime，state card/config 都带 provider。
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  process.env.SCRUMWS_PORT = String(port);
  process.env.DASHBOARD_NO_SCHEDULER = '1';
  const originalPath = process.env.PATH;
  const fakeBin = path.join(sandbox, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@echo 9.9.9 Claude Code\r\n');
  } else {
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\necho 9.9.9 Claude Code\n');
    fs.chmodSync(fakeClaude, 0o755);
  }
  process.env.PATH = fakeBin;

  // 外部平台 resume 不会通过 ScrumWS runner 回写 state.json；卡片必须从 Codex rollout 的真实 turn 状态派生。
  const resumedSid = '11111111-1111-4111-8111-111111111111';
  const resumedKey = 'external:codex-resume';
  const resumedDir = path.join(sandbox, 'runtime', 'runner-state', 'external__codex-resume');
  const rolloutDir = path.join(process.env.SCRUMWS_CODEX_SESSIONS, '2026', '07', '22');
  const rolloutPath = path.join(rolloutDir, `rollout-2026-07-22-${resumedSid}.jsonl`);
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.mkdirSync(resumedDir, { recursive: true });
  fs.writeFileSync(path.join(resumedDir, 'task.json'), JSON.stringify({
    taskKey: resumedKey, source: 'external', kind: 'interactive', provider: 'codex', title: 'external resume', prompt: 'resume', cwd: sandbox,
  }, null, 2));
  fs.writeFileSync(path.join(resumedDir, 'state.json'), JSON.stringify({ state: 'awaiting-human', enteredAt: '2026-07-22 10:00:00' }, null, 2));
  fs.writeFileSync(path.join(resumedDir, 'meta.json'), JSON.stringify({ sessionId: resumedSid, jsonlPath: rolloutPath }, null, 2));
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ type: 'session_meta', payload: { session_id: resumedSid, cwd: sandbox } }),
    JSON.stringify({ timestamp: '2026-07-22T10:01:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'resume-turn' } }),
  ].join('\n') + '\n');
  const runningState = await collectState();
  assert.equal(runningState.lifecycle.processing.some((item) => item.taskKey === resumedKey), true);
  assert.equal(runningState.lifecycle.awaitingHuman.some((item) => item.taskKey === resumedKey), false);
  fs.appendFileSync(rolloutPath, JSON.stringify({ timestamp: '2026-07-22T10:02:00.000Z', type: 'event_msg', payload: { type: 'task_complete', duration_ms: 1_000 } }) + '\n');
  const settledState = await collectState();
  assert.equal(settledState.lifecycle.processing.some((item) => item.taskKey === resumedKey), false);
  assert.equal(settledState.lifecycle.awaitingHuman.some((item) => item.taskKey === resumedKey), true);

  const { start } = await import(pathToFileURL(path.join(platformLib, '../server.js')).href);
  const running = await start();
  try {
    const providers = await fetch(`http://127.0.0.1:${port}/api/providers`).then((res) => res.json());
    assert.equal(providers.ok, true);
    assert.deepEqual(providers.providers.map((item) => item.id), ['claude', 'codex']);
    assert.equal(providers.defaultProvider, 'codex');
    assert.equal(providers.providers.find((item) => item.id === 'claude').runtime.available, true);
    assert.equal(providers.providers.find((item) => item.id === 'codex').runtime.available, false);

    const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((res) => res.json());
    assert.deepEqual(state.runtime.providers.map((item) => item.id), ['claude', 'codex']);
    assert.equal(state.runnerConfig.defaultProvider, 'codex');
    assert.equal(state.runnerConfig.providerDefaults.codex.model, 'gpt-config-default');
    const cards = [...state.lifecycle.plan, ...state.lifecycle.processing, ...state.lifecycle.queued];
    assert.equal(cards.find((item) => item.taskKey === external.taskKey)?.provider, 'codex');
    assert.equal(cards.find((item) => item.taskKey === legacyCreate.taskKey)?.provider, 'claude');
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
    process.env.PATH = originalPath;
  }

  console.log('PASS provider data: legacy defaults/lock, API key scope, external ingest/resume state, independent runtime HTTP');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
