// SG5 端到端集成驱动：真 cloud server + 真 platform + 一次性库，三层真连跑 matrix 后端主体。
// 与 SG2/SG3 的 stub 冒烟不同——这里 SG3 的 downlink 客户端真的连 SG2 的 downlink 端点，
// rpc / watch 走完整三级转发，验证接缝（SSE 格式、字段命名、错误码）。
//
// 用法（凭据只经 env，绝不落命令行/源码）：
//   CLOUD=http://127.0.0.1:18790 PLATFORM=http://127.0.0.1:18899 \
//   SWUK=swuk_… SWUK2=swuk_… CWD='C:\…\sg5-workdir' OUTCWD='C:\…\sg5-outside' \
//   PGURL=postgres://… node e2e-integration.mjs
import pg from '../../../../cloud/node_modules/pg/lib/index.js';

const CLOUD = process.env.CLOUD, PLATFORM = process.env.PLATFORM;
const SWUK = process.env.SWUK, SWUK2 = process.env.SWUK2;
const CWD = process.env.CWD, OUTCWD = process.env.OUTCWD;
const PGURL = process.env.PGURL;

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function check(id, cond, detail = '') {
  if (cond) { pass++; log(`  PASS ${id}${detail ? ' — ' + detail : ''}`); }
  else { fail++; log(`  FAIL ${id}${detail ? ' — ' + detail : ''}`); }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- HTTP helpers（手动管 cookie）----
function mkClient(base) {
  let cookie = '';
  const call = async (method, path, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  return {
    GET: (p, h) => call('GET', p, undefined, h),
    POST: (p, b, h) => call('POST', p, b, h),
  };
}

async function main() {
  const cloud = mkClient(CLOUD);       // owner 会话
  const cloud2 = mkClient(CLOUD);      // 非 owner 会话
  const plat = mkClient(PLATFORM);     // 本地（无鉴权）
  const db = new pg.Client({ connectionString: PGURL });
  await db.connect();
  const taskRows = async () => {
    const r = await db.query('select count(*)::int c from task');
    const s = await db.query('select count(*)::int c from task_status');
    const h = await db.query('select count(*)::int c from task_history');
    return { task: r.rows[0].c, status: s.rows[0].c, history: h.rows[0].c };
  };

  log('\n### 0. 前置：登录 + 生成 rk + 配对码');
  const login = await cloud.POST('/api/auth/login', { key: SWUK });
  check('login', login.status === 200 && login.json?.user?.id, `user=${login.json?.user?.name}`);
  const ownerUserId = login.json?.user?.id;
  const login2 = await cloud2.POST('/api/auth/login', { key: SWUK2 });
  check('login-other', login2.status === 200 && login2.json?.user?.id !== ownerUserId, 'second user session');
  const rk = (await cloud.POST('/api/registration-keys', { label: 'sg5' })).json?.key;
  const code = (await cloud.POST('/api/machines/enrollment-codes', {})).json?.code;
  check('rk+code', !!rk && !!code, `code=${code}`);

  // 测试隔离：identity/runner-config 跨轮持久，先把开关复位为关并等 downlink 断，
  // 否则上一轮残留的 true 会让 C01「默认关」的前置失效。
  log('\n### 复位：关开关 + 等 relayOnline=false');
  await plat.POST('/api/cloud/remote-config', { cloudRemoteControl: false, cloudAllowedCwds: [] });
  const enr0 = await plat.POST('/api/cloud/enroll', { cloudUrl: CLOUD, registrationKey: rk, code });
  check('enroll', enr0.status === 200 && enr0.json?.ok, `ws=${enr0.json?.workspaceName}`);
  let mid;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const m = (await cloud.GET('/api/my/machines')).json?.machines?.[0];
    mid = m?.id;
    if (m && m.relayOnline === false) break;
  }

  const before = await taskRows();

  log('\n### C01 开关默认关：relayOnline=false');
  let machines = (await cloud.GET('/api/my/machines')).json?.machines || [];
  check('C01', machines.length === 1 && machines[0].relayOnline === false,
    `machine=${machines[0]?.displayName} relayOnline=${machines[0]?.relayOnline}`);

  log('\n### C02 开开关 → relayOnline=true（轮询 ≤20s）');
  await plat.POST('/api/cloud/remote-config', { cloudRemoteControl: true, cloudAllowedCwds: [CWD] });
  let online = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const m = (await cloud.GET('/api/my/machines')).json?.machines?.[0];
    if (m?.relayOnline) { online = true; check('C02', true, `relayOnline=true @${i + 1}s`); break; }
  }
  if (!online) check('C02', false, 'downlink 20s 内未建立');

  log('\n### C03 只列本人机器；非 owner rpc/watch/list → 404');
  const m2list = (await cloud2.GET('/api/my/machines')).json?.machines || [];
  check('C03-list', m2list.length === 0, `非 owner 看到 ${m2list.length} 台`);
  const m2rpc = await cloud2.POST(`/api/my/machines/${mid}/rpc`, { verb: 'state' });
  check('C03-rpc', m2rpc.status === 404, `非 owner rpc → ${m2rpc.status}`);

  log('\n### C04 rpc state 六桶与本地 /api/state 一致');
  // 两侧同形：{ now, lifecycle:{桶} }。桶在 lifecycle 下（rpc state 保留 envelope，只裁剪卡片字段）。
  const rpcState = (await cloud.POST(`/api/my/machines/${mid}/rpc`, { verb: 'state' })).json?.data;
  const platState = (await plat.GET('/api/state')).json;
  const keysFrom = (buckets) => {
    const out = [];
    for (const k of Object.keys(buckets || {})) {
      const arr = buckets[k];
      if (Array.isArray(arr)) for (const c of arr) if (c?.taskKey) out.push(c.taskKey);
    }
    return new Set(out);
  };
  const cardsOf = (buckets) => Object.values(buckets || {}).filter(Array.isArray).flat()
    .filter((c) => c && typeof c === 'object' && c.taskKey);
  const rpcKeys = keysFrom(rpcState?.lifecycle);
  const platKeys = keysFrom(platState.lifecycle);
  const same = rpcKeys.size === platKeys.size && [...rpcKeys].every((k) => platKeys.has(k));
  check('C04', same, `rpc ${rpcKeys.size} 卡 vs local ${platKeys.size} 卡`);
  // 卡片不含 prompt 全文（六桶裁剪）
  const anyCard = cardsOf(rpcState?.lifecycle)[0];
  check('C04-no-prompt', !anyCard || !('prompt' in anyCard), 'state 卡片无 prompt 全文');

  log('\n### C06 createTask：白名单内成功(plan)；白名单外拒绝');
  const okCreate = await cloud.POST(`/api/my/machines/${mid}/rpc`, {
    verb: 'createTask',
    args: { title: 'sg5 集成任务', prompt: '请只回复 done。', cwd: CWD, plan: true },
  });
  const newKey = okCreate.json?.data?.taskKey;
  check('C06-ok', okCreate.status === 200 && okCreate.json?.ok && okCreate.json?.data?.state === 'plan',
    `taskKey=${newKey} state=${okCreate.json?.data?.state}`);
  const badCreate = await cloud.POST(`/api/my/machines/${mid}/rpc`, {
    verb: 'createTask',
    args: { title: 'x', prompt: 'x', cwd: OUTCWD, plan: true },
  });
  check('C06-reject', badCreate.status === 502, `白名单外 → ${badCreate.status} ${badCreate.json?.error?.message || ''}`);

  log('\n### C05 taskDetail 含 prompt/history；workerLog 尾窗');
  const detail = (await cloud.POST(`/api/my/machines/${mid}/rpc`, { verb: 'taskDetail', args: { taskKey: newKey } })).json?.data;
  check('C05-detail', detail?.prompt === '请只回复 done。' && Array.isArray(detail?.history),
    `prompt+history(${detail?.history?.length})`);
  const wlog = (await cloud.POST(`/api/my/machines/${mid}/rpc`, { verb: 'workerLog', args: { taskKey: newKey, tail: 30 } })).json?.data;
  check('C05-log', wlog && typeof wlog.total === 'number' && Array.isArray(wlog.blocks), `total=${wlog?.total}`);

  log('\n### C04b 建任务后非空对拍：新 plan 卡在两侧都出现');
  const rpcState2 = (await cloud.POST(`/api/my/machines/${mid}/rpc`, { verb: 'state' })).json?.data;
  const platState2 = (await plat.GET('/api/state')).json;
  const rk2 = keysFrom(rpcState2?.lifecycle), pk2 = keysFrom(platState2.lifecycle);
  check('C04b', rk2.has(newKey) && pk2.has(newKey) && rk2.size === pk2.size,
    `新卡 ${newKey} 两侧可见，rpc ${rk2.size} vs local ${pk2.size}`);

  log('\n### C07 message：plan 任务无会话 → ok:false 带原因（502 透传）');
  const msg = await cloud.POST(`/api/my/machines/${mid}/rpc`, { verb: 'message', args: { taskKey: newKey, text: '补充说明' } });
  check('C07-plan-reject', msg.status === 502 && /sessionId|会话|resume/.test(msg.json?.error?.message || ''),
    `→ ${msg.status} ${msg.json?.error?.message || ''}`);

  log('\n### C08 动作机经中继：非法迁移拒绝 + 合法迁移生效（approve 真跑留 B 段）');
  // 非法：complete 只允许 awaiting-human（task-actions.js:134）→ plan 上 complete 必拒
  const illegal = await cloud.POST(`/api/my/machines/${mid}/rpc`, { verb: 'complete', args: { taskKey: newKey } });
  check('C08-illegal', illegal.status === 502 && /awaiting-human/.test(illegal.json?.error?.message || ''),
    `plan 上 complete → ${illegal.status} ${illegal.json?.error?.message || ''}`);
  // 合法：cancel 对 plan 合法（非终态）→ plan → awaiting-human/cancelled（task-actions.js:62 只拒终态）
  const legal = await cloud.POST(`/api/my/machines/${mid}/rpc`, { verb: 'cancel', args: { taskKey: newKey } });
  check('C08-legal', legal.status === 200 && legal.json?.ok, `plan 上 cancel → ok，落 awaiting-human/cancelled`);
  // 再合法：complete 现在应放行（awaiting-human → done）
  const legal2 = await cloud.POST(`/api/my/machines/${mid}/rpc`, { verb: 'complete', args: { taskKey: newKey } });
  check('C08-legal2', legal2.status === 200 && legal2.json?.ok, `cancel 后 complete → done`);
  const badVerb = await cloud.POST(`/api/my/machines/${mid}/rpc`, { verb: 'nope', args: {} });
  check('C08-verb-whitelist', badVerb.status === 400, `未知 verb → ${badVerb.status}`);

  log('\n### C10 rpc 无 downlink → 503（关开关后立即测）');
  await plat.POST('/api/cloud/remote-config', { cloudRemoteControl: false, cloudAllowedCwds: [CWD] });
  let offline = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const r = await cloud.POST(`/api/my/machines/${mid}/rpc`, { verb: 'state' });
    if (r.status === 503) { offline = true; check('C10-503', true, `关开关后 rpc → 503 @${i + 1}s`); break; }
  }
  if (!offline) check('C10-503', false, '关开关 20s 后 rpc 仍未 503');
  const m0 = (await cloud.GET('/api/my/machines')).json?.machines?.[0];
  check('C02-off', m0?.relayOnline === false, `热关闭后 relayOnline=${m0?.relayOnline}`);

  log('\n### C12 中继端点自身零 DB 写（纯 relay 读操作前后行数不变）');
  // 中继的承诺（spec 决策 1）= relay 路径不写云库。用一批纯读 rpc 前后测行数：
  // state / taskDetail / workerLog / message-reject 都不落库。
  const c12before = await taskRows();
  for (const v of [{ verb: 'state' }, { verb: 'taskDetail', args: { taskKey: newKey } },
    { verb: 'workerLog', args: { taskKey: newKey, tail: 10 } }, { verb: 'cwds' }]) {
    await cloud.POST(`/api/my/machines/${mid}/rpc`, v);
  }
  const c12after = await taskRows();
  check('C12', c12after.task === c12before.task && c12after.status === c12before.status
    && c12after.history === c12before.history,
    `纯读 rpc 前后 task ${c12before.task}->${c12after.task}`);
  // 诚实标注（非 pass/fail）：createTask 建的本地任务经**既有 P1 reconcile**（origin='local'）镜像到 cloud.task，
  // 那是 P0/P1 子系统、非中继写；决策 14 的 reconcile 过滤（并行工作）落地后本地任务停止上云。
  const originRow = await db.query(`select origin, source from task where local_task_key=$1`, [newKey]);
  log(`  [注] 新任务在 cloud.task: origin=${originRow.rows[0]?.origin} source=${originRow.rows[0]?.source}`
    + `（P1 reconcile 写入，非中继；见报告「与决策 14 的关系」）`);

  await db.end();
  log(`\n### 后端集成结果：PASS ${pass} / FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('DRIVER ERROR', e); process.exit(2); });
