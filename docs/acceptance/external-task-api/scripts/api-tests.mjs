// 外部任务 API + API 密钥管理端点验收（跨轮复用）。
// 前置：对一个「隔离数据根」的实例跑（SCRUMWS_DATA_ROOT=临时目录 SCRUMWS_PORT=18799 node platform/standalone.js），
//       不要指向真实 8799/~/.scrumws。用例只建 plan 任务，不触发 claude 会话。
// 用法：node api-tests.mjs [baseUrl] [dataRoot]
//   baseUrl  缺省 http://127.0.0.1:18799
//   dataRoot 该实例的数据根（做磁盘断言）；缺省跳过磁盘断言并标 FAIL（要求传）
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:18799';
const DATA_ROOT = process.argv[3] || '';
const results = [];

function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

async function req(method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { }
  return { status: r.status, json };
}

function taskDirOf(taskKey) {
  const safe = taskKey.replace(/:/g, '__').replace(/#/g, '_');
  return path.join(DATA_ROOT, 'runtime', 'runner-state', safe);
}

const main = async () => {
  // ---- A. 密钥管理端点 ----
  let r = await req('GET', '/api/apikeys');
  record('A1-list-empty', r.status === 200 && r.json?.ok === true && Array.isArray(r.json.keys) && r.json.keys.length === 0,
    `初始列表为空 → ${r.status} keys=${r.json?.keys?.length}`);

  r = await req('POST', '/api/apikeys/create', { body: { label: '钉钉派发器', source: 'chat' } });
  const chatKey = r.json;
  record('A2-create-key', r.status === 200 && chatKey?.ok && /^swak_[A-Za-z0-9_-]{40,}$/.test(chatKey.plaintext || '')
    && chatKey.key?.source === 'chat' && chatKey.key?.prefix === chatKey.plaintext.slice(0, 12),
    `建 chat 密钥（明文 swak_、prefix 对齐）→ ${r.status} prefix=${chatKey?.key?.prefix}`);

  r = await req('POST', '/api/apikeys/create', { body: { label: 'issue 检查器', source: 'issue' } });
  const issueKey = r.json;
  record('A3-create-key-2', r.status === 200 && issueKey?.ok && issueKey.key?.source === 'issue',
    `建 issue 密钥 → ${r.status}`);

  r = await req('POST', '/api/apikeys/create', { body: { label: 'x', source: 'bad source!' } });
  record('A4-bad-source', r.status === 400 && r.json?.ok === false, `非法 source 拒绝 → ${r.status} ${r.json?.error}`);

  r = await req('POST', '/api/apikeys/create', { body: { label: '', source: 'ok' } });
  record('A5-empty-label', r.status === 400 && r.json?.ok === false, `空 label 拒绝 → ${r.status} ${r.json?.error}`);

  r = await req('GET', '/api/apikeys');
  // prefix（明文前 12 位）是有意展示的；泄漏 = 出现完整明文（swak_ 后 ≥40 字符）或 hash 字段
  const listStr = JSON.stringify(r.json);
  const leaked = /"hash"/.test(listStr) || /swak_[A-Za-z0-9_-]{40,}/.test(listStr);
  record('A6-list-no-secret', r.status === 200 && r.json.keys.length === 2 && !leaked,
    `列表 2 条且不含 hash/完整明文 → ${r.status} keys=${r.json?.keys?.length} leaked=${leaked}`);

  // ---- B. 外部建任务 ----
  r = await req('POST', '/api/external/task/create', { body: { title: 't', prompt: 'p' } });
  record('B1-no-auth', r.status === 401, `无 Authorization → ${r.status}`);

  r = await req('POST', '/api/external/task/create', { body: { title: 't', prompt: 'p' }, token: 'swak_' + 'x'.repeat(43) });
  record('B2-bad-key', r.status === 401, `伪造密钥 → ${r.status}`);

  r = await req('POST', '/api/external/task/create', {
    body: { title: '群里的活', prompt: '处理一下', externalKey: 'e2e-1', source: 'hacker' }, token: chatKey.plaintext,
  });
  const created = r.json;
  record('B3-create-plan', r.status === 200 && created?.ok && created.existed === false
    && created.state === 'plan' && String(created.taskKey).startsWith('chat:'),
    `有效密钥建任务：默认 plan、source 取密钥绑定值（请求体 source=hacker 被忽略）→ ${r.status} ${created?.taskKey} state=${created?.state}`);

  if (DATA_ROOT) {
    const dir = taskDirOf(created.taskKey);
    let task = {}, state = {};
    try { task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8')); } catch { }
    try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { }
    record('B4-disk', task.source === 'chat' && task.externalKey === 'e2e-1' && state.state === 'plan',
      `磁盘任务包：source=${task.source} externalKey=${task.externalKey} state=${state.state}（${dir}）`);
  } else {
    record('B4-disk', false, '未传 dataRoot，磁盘断言未执行');
  }

  r = await req('POST', '/api/external/task/create', {
    body: { title: '群里的活', prompt: '处理一下', externalKey: 'e2e-1' }, token: chatKey.plaintext,
  });
  record('B5-idempotent', r.status === 200 && r.json?.existed === true && r.json.taskKey === created.taskKey,
    `同 externalKey 幂等：existed=true 且 taskKey 不变 → ${r.json?.taskKey}`);

  r = await req('POST', '/api/external/task/create', {
    body: { title: 'issue 活', prompt: 'p', externalKey: 'e2e-1' }, token: issueKey.plaintext,
  });
  const issueTask = r.json;
  record('B6-per-source-ns', r.status === 200 && issueTask?.existed === false && String(issueTask.taskKey).startsWith('issue:'),
    `幂等键按 source 分命名空间：issue 密钥同键新建 → ${issueTask?.taskKey}`);

  r = await req('POST', '/api/external/task/create', { body: { prompt: 'p' }, token: chatKey.plaintext });
  record('B7-validation', r.status === 400 && /title/.test(r.json?.error || ''), `缺 title 走 createTask 校验 → ${r.status} ${r.json?.error}`);

  r = await req('POST', '/api/external/task/create', {
    body: { title: 't', prompt: 'p', externalKey: 'x'.repeat(201) }, token: chatKey.plaintext,
  });
  record('B8-longkey', r.status === 400 && /externalKey/.test(r.json?.error || ''), `externalKey 超长拒绝 → ${r.status}`);

  // ---- C. 外部查状态 ----
  r = await req('GET', `/api/external/task/status?taskKey=${encodeURIComponent(created.taskKey)}`, { token: chatKey.plaintext });
  record('C1-status-by-taskkey', r.status === 200 && r.json?.state === 'plan' && r.json.externalKey === 'e2e-1',
    `按 taskKey 查 → ${r.status} state=${r.json?.state}`);

  r = await req('GET', '/api/external/task/status?externalKey=e2e-1', { token: chatKey.plaintext });
  record('C2-status-by-extkey', r.status === 200 && r.json?.taskKey === created.taskKey,
    `按 externalKey 查（台账解析）→ ${r.json?.taskKey}`);

  r = await req('GET', `/api/external/task/status?taskKey=${encodeURIComponent(created.taskKey)}`, { token: issueKey.plaintext });
  record('C3-cross-source-404', r.status === 404, `跨 source 查 chat 任务 → ${r.status}`);

  r = await req('GET', '/api/external/task/status?externalKey=nope', { token: chatKey.plaintext });
  record('C4-unknown-404', r.status === 404, `未登记 externalKey → ${r.status}`);

  r = await req('GET', '/api/external/task/status?taskKey=x', {});
  record('C5-status-no-auth', r.status === 401, `查状态无鉴权 → ${r.status}`);

  // ---- D. 禁用 / 删除 / 台账重建 ----
  r = await req('POST', '/api/apikeys/toggle', { body: { id: chatKey.key.id, disabled: true } });
  const afterDisable = await req('POST', '/api/external/task/create', { body: { title: 't', prompt: 'p' }, token: chatKey.plaintext });
  record('D1-disabled-401', r.status === 200 && afterDisable.status === 401, `禁用后建任务 → ${afterDisable.status}`);

  await req('POST', '/api/apikeys/toggle', { body: { id: chatKey.key.id, disabled: false } });
  r = await req('GET', '/api/external/task/status?externalKey=e2e-1', { token: chatKey.plaintext });
  record('D2-reenable', r.status === 200, `重新启用后可用 → ${r.status}`);

  r = await req('POST', `/api/task/delete?taskKey=${encodeURIComponent(created.taskKey)}`);
  const recreate = await req('POST', '/api/external/task/create', {
    body: { title: '群里的活', prompt: '处理一下', externalKey: 'e2e-1' }, token: chatKey.plaintext,
  });
  record('D3-recreate-after-delete', r.status === 200 && recreate.status === 200
    && recreate.json?.existed === false && recreate.json.taskKey !== created.taskKey,
    `任务删除后同 externalKey 重建（台账掉旧建新）→ ${recreate.json?.taskKey}`);

  r = await req('POST', '/api/apikeys/delete', { body: { id: issueKey.key.id } });
  const afterDelete = await req('POST', '/api/external/task/create', { body: { title: 't', prompt: 'p' }, token: issueKey.plaintext });
  record('D4-deleted-401', r.status === 200 && afterDelete.status === 401, `删除密钥后 → ${afterDelete.status}`);

  r = await req('GET', '/api/apikeys');
  const ck = (r.json?.keys || []).find((k) => k.id === chatKey.key.id);
  record('E1-lastused', !!ck && !!ck.lastUsedAt, `lastUsedAt 已刷新 → ${ck?.lastUsedAt}`);

  const fails = results.filter((x) => !x.pass);
  console.log(`\n== ${results.length - fails.length}/${results.length} PASS ==`);
  process.exit(fails.length ? 1 : 0);
};

main().catch((e) => { console.error('driver error:', e); process.exit(2); });
