// 外部任务 API + API 密钥管理端点验收（跨轮复用）。
// 前置：对一个「隔离数据根」的实例跑（SCRUMWS_DATA_ROOT=临时目录 SCRUMWS_PORT=18799 node platform/standalone.js），
//       不要指向真实 8799/~/.scrumws。且实例须以 **PATH 无 claude** 的环境起（Q2 会建 plan:false 任务
//       触发 spawn——claude 不存在时子进程秒死零副作用；其余用例只建 plan 任务）。
// 用法：node api-tests.mjs [baseUrl] [dataRoot]
//   baseUrl  缺省 http://127.0.0.1:18799
//   dataRoot 该实例的数据根（做磁盘断言）；缺省跳过磁盘断言并标 FAIL（要求传）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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

  // 策略三项必选（2026-07-17 语义：全不选 = 没有权限）——所有建钥都带全策略
  const FULL_POLICY = { allowedModels: ['claude-opus-4-8', 'claude-haiku-4-5-20251001'], allowedEfforts: ['xhigh', 'low'], allowedCwds: [DATA_ROOT] };
  r = await req('POST', '/api/apikeys/create', { body: { label: '钉钉派发器', source: 'chat', ...FULL_POLICY, allowQueued: true } });
  const chatKey = r.json;
  record('A2-create-key', r.status === 200 && chatKey?.ok && /^swak_[A-Za-z0-9_-]{40,}$/.test(chatKey.plaintext || '')
    && chatKey.key?.source === 'chat' && chatKey.key?.prefix === chatKey.plaintext.slice(0, 12)
    && chatKey.key?.allowedModels?.length === 2 && chatKey.key?.allowedEfforts?.length === 2 && chatKey.key?.allowedCwds?.length === 1
    && chatKey.key?.allowQueued === true,
    `建 chat 密钥（明文 swak_、prefix 对齐、策略外显、allowQueued 回显）→ ${r.status} prefix=${chatKey?.key?.prefix}`);

  r = await req('POST', '/api/apikeys/create', { body: { label: 'issue 检查器', source: 'issue', ...FULL_POLICY } });
  const issueKey = r.json;
  record('A3-create-key-2', r.status === 200 && issueKey?.ok && issueKey.key?.source === 'issue',
    `建 issue 密钥 → ${r.status}`);

  r = await req('POST', '/api/apikeys/create', { body: { label: 'x', source: 'bad source!', ...FULL_POLICY } });
  record('A4-bad-source', r.status === 400 && r.json?.ok === false, `非法 source 拒绝 → ${r.status} ${r.json?.error}`);

  r = await req('POST', '/api/apikeys/create', { body: { label: '', source: 'ok', ...FULL_POLICY } });
  record('A5-empty-label', r.status === 400 && r.json?.ok === false, `空 label 拒绝 → ${r.status} ${r.json?.error}`);

  // 策略缺任一项 → 拒绝创建（全不选 = 没有权限）
  const noModels = await req('POST', '/api/apikeys/create', { body: { label: 'x', source: 'a7', allowedEfforts: ['xhigh'], allowedCwds: [DATA_ROOT] } });
  const noEfforts = await req('POST', '/api/apikeys/create', { body: { label: 'x', source: 'a7', allowedModels: ['claude-opus-4-8'], allowedCwds: [DATA_ROOT] } });
  const noCwds = await req('POST', '/api/apikeys/create', { body: { label: 'x', source: 'a7', allowedModels: ['claude-opus-4-8'], allowedEfforts: ['xhigh'] } });
  record('A7-policy-required', noModels.status === 400 && /allowedModels 必选/.test(noModels.json?.error || '')
    && noEfforts.status === 400 && /allowedEfforts 必选/.test(noEfforts.json?.error || '')
    && noCwds.status === 400 && /allowedCwds 必填/.test(noCwds.json?.error || ''),
    `缺 models/efforts/cwds 均拒建 → ${noModels.status}/${noEfforts.status}/${noCwds.status}`);

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

  // ---- F. 心跳 ----
  r = await req('POST', '/api/external/heartbeat', { token: chatKey.plaintext });
  const hbNoAuth = await req('POST', '/api/external/heartbeat');
  record('F1-heartbeat', r.status === 200 && r.json?.ok === true && hbNoAuth.status === 401,
    `心跳 200 / 无鉴权 401 → ${r.status}/${hbNoAuth.status}`);

  // ---- P. per-key 策略白名单 ----
  r = await req('POST', '/api/apikeys/create', {
    body: {
      label: '策略钥', source: 'policy',
      allowedModels: ['claude-opus-4-8', 'claude-sonnet-5'],
      allowedEfforts: ['xhigh'],
      allowedCwds: [DATA_ROOT],
    },
  });
  const polKey = r.json;
  record('P1-create-policy-key', r.status === 200 && polKey?.ok
    && polKey.key.allowedModels.length === 2 && polKey.key.allowedEfforts[0] === 'xhigh' && polKey.key.allowedCwds.length === 1,
    `建带策略密钥 → ${r.status} models=${polKey?.key?.allowedModels?.join('/')} efforts=${polKey?.key?.allowedEfforts} cwds=${polKey?.key?.allowedCwds?.length}`);

  r = await req('POST', '/api/apikeys/create', { body: { label: 'x', source: 'p2', allowedModels: ['gpt-4o'] } });
  record('P2-bad-model-rejected', r.status === 400 && /allowedModels/.test(r.json?.error || ''), `非白名单模型拒绝 → ${r.status} ${r.json?.error}`);

  r = await req('POST', '/api/apikeys/create', { body: { label: 'x', source: 'p3', allowedModels: ['claude-opus-4-8'], allowedEfforts: ['xhigh'], allowedCwds: ['relative/path'] } });
  record('P3-relative-cwd-rejected', r.status === 400 && /绝对路径/.test(r.json?.error || ''), `相对路径拒绝 → ${r.status} ${r.json?.error}`);

  // 省略 model/effort/cwd → 取白名单首项为默认
  r = await req('POST', '/api/external/task/create', {
    body: { title: '策略默认', prompt: 'p', externalKey: 'pol-1' }, token: polKey.plaintext,
  });
  let tj = {};
  if (r.status === 200 && DATA_ROOT) {
    try { tj = JSON.parse(fs.readFileSync(path.join(taskDirOf(r.json.taskKey), 'task.json'), 'utf8')); } catch { }
  }
  record('P4-policy-defaults', r.status === 200 && tj.model === 'claude-opus-4-8' && tj.effort === 'xhigh'
    && String(tj.cwd || '').toLowerCase() === path.resolve(DATA_ROOT).toLowerCase(),
    `省略字段取白名单首项 → model=${tj.model} effort=${tj.effort} cwd=${tj.cwd}`);

  // 白名单内显式值放行（cwd 用允许目录的子目录）
  const subDir = path.join(DATA_ROOT, 'runtime');
  r = await req('POST', '/api/external/task/create', {
    body: { title: '策略子目录', prompt: 'p', model: 'claude-sonnet-5', effort: 'xhigh', cwd: subDir, externalKey: 'pol-2' }, token: polKey.plaintext,
  });
  record('P5-in-policy-ok', r.status === 200, `白名单内值 + 子目录 cwd 放行 → ${r.status} ${r.json?.taskKey || r.json?.error}`);

  // 越界一律 400
  const outModel = await req('POST', '/api/external/task/create', { body: { title: 't', prompt: 'p', model: 'claude-haiku-4-5-20251001' }, token: polKey.plaintext });
  const outEffort = await req('POST', '/api/external/task/create', { body: { title: 't', prompt: 'p', effort: 'low' }, token: polKey.plaintext });
  const outCwd = await req('POST', '/api/external/task/create', { body: { title: 't', prompt: 'p', cwd: 'C:\\Windows' }, token: polKey.plaintext });
  record('P6-out-of-policy-400', outModel.status === 400 && outEffort.status === 400 && outCwd.status === 400
    && /不在该密钥允许范围/.test(outModel.json?.error + outEffort.json?.error + outCwd.json?.error),
    `越界 model/effort/cwd → ${outModel.status}/${outEffort.status}/${outCwd.status}`);

  // ---- Q. 直接执行权限（allowQueued）+ 密钥编辑 ----
  // policy 钥未开 allowQueued → plan:false 拒绝（issue 钥已在 D4 删除，不可用于此例）
  r = await req('POST', '/api/external/task/create', {
    body: { title: 't', prompt: 'p', plan: false }, token: polKey.plaintext,
  });
  record('Q1-queued-denied', r.status === 400 && /不允许直接排队执行/.test(r.json?.error || ''),
    `未开 allowQueued 传 plan:false → ${r.status} ${r.json?.error}`);

  // chat 钥开了 allowQueued → plan:false 直进 queued（隔离实例 PATH 无 claude，spawn 秒死零副作用）
  r = await req('POST', '/api/external/task/create', {
    body: { title: '直执任务', prompt: 'p', plan: false, externalKey: 'q2-1' }, token: chatKey.plaintext,
  });
  let q2Init = null;
  if (r.status === 200 && DATA_ROOT) {
    try { q2Init = JSON.parse(fs.readFileSync(path.join(taskDirOf(r.json.taskKey), 'state.json'), 'utf8')).history?.[0]?.state; } catch { }
  }
  record('Q2-queued-allowed', r.status === 200 && r.json?.state !== 'plan' && q2Init === 'queued',
    `开 allowQueued 传 plan:false → ${r.status} state=${r.json?.state}（磁盘初态 ${q2Init}）`);

  // 编辑：建单模型钥 → 越界 400 → update 扩白名单/改 label → 同请求 200
  r = await req('POST', '/api/apikeys/create', { body: { label: '待编辑钥', source: 'upd', allowedModels: ['claude-opus-4-8'], allowedEfforts: ['xhigh'], allowedCwds: [DATA_ROOT] } });
  const updKey = r.json;
  const q3a = await req('POST', '/api/external/task/create', { body: { title: 't', prompt: 'p', model: 'claude-sonnet-5' }, token: updKey.plaintext });
  r = await req('POST', '/api/apikeys/update', {
    body: { id: updKey.key.id, label: '已编辑钥', source: 'upd', allowedModels: ['claude-opus-4-8', 'claude-sonnet-5'], allowedEfforts: ['xhigh'], allowedCwds: [DATA_ROOT], allowQueued: false },
  });
  const q3c = await req('POST', '/api/external/task/create', { body: { title: 't', prompt: 'p', model: 'claude-sonnet-5', externalKey: 'q3-1' }, token: updKey.plaintext });
  record('Q3-update-key', q3a.status === 400 && r.status === 200 && r.json?.key?.label === '已编辑钥'
    && r.json.key.allowedModels.length === 2 && q3c.status === 200 && q3c.json?.state === 'plan',
    `编辑前越界 ${q3a.status} → update 后同请求 ${q3c.status}（label=${r.json?.key?.label}）`);

  // 编辑校验：缺策略 / 未知 id → 400
  const q4a = await req('POST', '/api/apikeys/update', { body: { id: updKey.key.id, label: 'x', source: 'upd', allowedEfforts: ['xhigh'], allowedCwds: [DATA_ROOT] } });
  const q4b = await req('POST', '/api/apikeys/update', { body: { id: 'nope', label: 'x', source: 'upd', allowedModels: ['claude-opus-4-8'], allowedEfforts: ['xhigh'], allowedCwds: [DATA_ROOT] } });
  record('Q4-update-validate', q4a.status === 400 && /allowedModels 必选/.test(q4a.json?.error || '') && q4b.status === 400 && /key not found/.test(q4b.json?.error || ''),
    `update 缺策略 ${q4a.status} / 未知 id ${q4b.status}`);

  // 旧格式无策略密钥（现 API 已建不出，直接注入 keys 文件模拟存量）→ 建任务一律拒绝（无权限）
  const legacyPlain = 'swak_' + 'L'.repeat(43);
  if (DATA_ROOT) {
    const kf = path.join(DATA_ROOT, 'runtime', 'api-keys.json');
    const store = JSON.parse(fs.readFileSync(kf, 'utf8'));
    store.keys.push({
      id: 'legacy01', label: '旧格式无策略钥', source: 'legacy', prefix: legacyPlain.slice(0, 12),
      hash: crypto.createHash('sha256').update(legacyPlain, 'utf8').digest('hex'),
      createdAt: '2026-07-17 00:00:00', disabled: false, lastUsedAt: null,
    });
    fs.writeFileSync(kf, JSON.stringify(store, null, 2));
    r = await req('POST', '/api/external/task/create', { body: { title: 't', prompt: 'p' }, token: legacyPlain });
    record('P7-legacy-no-policy-denied', r.status === 400 && /未配置.*无权限/.test(r.json?.error || ''),
      `旧无策略钥建任务被拒 → ${r.status} ${r.json?.error}`);
  } else {
    record('P7-legacy-no-policy-denied', false, '未传 dataRoot，无法注入旧格式密钥');
  }

  const fails = results.filter((x) => !x.pass);
  console.log(`\n== ${results.length - fails.length}/${results.length} PASS ==`);
  process.exit(fails.length ? 1 : 0);
};

main().catch((e) => { console.error('driver error:', e); process.exit(2); });
