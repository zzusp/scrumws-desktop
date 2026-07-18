// P2 云端下发端点端到端自测：一次性库 + 真起 cloud server（端口 8791，绝不用 8790 生产）。
// 建用户/机器 → 登录 → 建意图（在线机器 201 / 离线机器 409）→ 机器取件 → ack/reject → 取消 → 绊线封禁。
// 绝不碰生产库 scrumws（用户 CLAUDE.md「共享远程资源别就地验证」+ 本任务硬约束 3/4）。
//
// 用法（DATABASE_URL 从仓库根 .env 注入，绝不落命令行 / 日志）：
//   node selftest-endpoints.mjs --check   零副作用自检：连库、验迁移在位、验 server.js 在位
//   node selftest-endpoints.mjs --run     建一次性库 → 001+002 → 灌样本 → 起 8791 服务 → 跑断言 → DROP
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const pg = createRequire(path.join(REPO_ROOT, 'cloud/package.json'))('pg');

const M001 = path.join(REPO_ROOT, 'cloud/migrations/001_p0p1_init.sql');
const M002 = path.join(REPO_ROOT, 'cloud/migrations/002_p2_intent_dispatch.sql');
const SERVER = path.join(REPO_ROOT, 'cloud/src/server.js');
const SANDBOX_DB = 'scrumws_p2_selftest';
const baseOf = (port) => `http://127.0.0.1:${port}`;

// ⚠ 端口：绝不用 8790 生产 / 8799 本地 app。原打算钉死 8791/8797，但实测这两口可能被并行 subagent 占用，
//   且 Windows SO_REUSEADDR 会让「第二个绑定者」静默拿不到流量（健康检查永远 404/超时）。
//   改为向 OS 要一个空闲端口（listen(0) 拿到即用），彻底规避与任何并行进程的冲突；仍满足「不碰 8790/8799」。
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const mint = (prefix) => { const p = prefix + crypto.randomBytes(32).toString('base64url'); return { plaintext: p, hash: sha256(p), prefix: p.slice(0, 9) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnv() {
  const file = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(file)) throw new Error('仓库根缺少 .env');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const val = m[2].trim().replace(/^["'](.*)["']$/, '$1');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
  if (!process.env.DATABASE_URL) throw new Error('.env 里没有 DATABASE_URL');
}
const urlWithDb = (name) => { const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + name; return u.toString(); };
const adminUrl = () => urlWithDb('postgres');
const sandboxUrl = () => urlWithDb(SANDBOX_DB);
const safe = (name) => `<DATABASE_URL 同主机>/${name}`;

async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

let pass = 0, fail = 0;
function assert(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// 手动管理 cookie 的 HTTP 客户端（node fetch）。set-cookie 的 Secure 属性由浏览器强制，
// 原始客户端不强制 → 直接把 swsession 值回传即可，无需 CLOUD_INSECURE_COOKIE。
function makeClient(base) {
  let cookie = null;
  return {
    async req(method, pathname, { body, bearer, noCookie } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      if (cookie && !noCookie) headers.cookie = cookie;
      const res = await fetch(base + pathname, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setc = res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
      for (const sc of setc) {
        const m = /^(swsession=[^;]*)/.exec(sc);
        if (m) cookie = m[1];
      }
      let json = null;
      try { json = await res.json(); } catch { /* 空体 */ }
      return { status: res.status, json };
    },
  };
}

async function waitHealthy(base) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.status === 200) return true; } catch { /* 未起 */ }
    await sleep(250);
  }
  return false;
}

function startServer(port, extraEnv) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: sandboxUrl(), CLOUD_PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  return { child, logs };
}
async function stopServer(s) {
  if (!s?.child || s.child.exitCode !== null) return;
  const exited = new Promise((r) => s.child.once('exit', r));
  s.child.kill('SIGTERM');
  await Promise.race([exited, sleep(3000)]);
  if (s.child.exitCode === null) { s.child.kill('SIGKILL'); await Promise.race([exited, sleep(1000)]); }
}

const arg = process.argv[2] || '--check';

if (arg === '--check') {
  loadEnv();
  for (const f of [M001, M002, SERVER]) if (!fs.existsSync(f)) throw new Error('缺文件：' + f);
  await withClient(adminUrl(), async (c) => {
    const v = await c.query('select version()');
    console.log('[check] 库可达：', v.rows[0].version.split(',')[0]);
    const e = await c.query('select 1 from pg_database where datname=$1', [SANDBOX_DB]);
    console.log('[check] 验收库', safe(SANDBOX_DB), e.rowCount ? '已存在（--run 会先 drop 再建）' : '不存在（--run 会新建）');
  });
  console.log('[check] 001/002/server.js 均在位；--run 会在一次性库上起两个 OS 分配的空闲端口服务（功能/绊线）跑断言后 DROP');
  console.log('[check] 零副作用自检完成，未写任何行，未起服务，未碰生产库');
  process.exit(0);
}
if (arg !== '--run') throw new Error('未知参数：' + arg + '（用 --check | --run）');

loadEnv();
// —— 建库 + 迁移 + 灌样本 ——
await withClient(adminUrl(), async (c) => {
  await c.query(`drop database if exists ${SANDBOX_DB} with (force)`);
  await c.query(`create database ${SANDBOX_DB}`);
});
console.log(`[run] 已建一次性库 ${safe(SANDBOX_DB)}`);

const seed = {};
const servers = []; // 所有起过的服务；无论从哪抛错，外层 finally 都逐个收（避免 waitHealthy 抛在 try 前时留僵尸）
try {
  await withClient(sandboxUrl(), async (c) => {
    await c.query(fs.readFileSync(M001, 'utf8'));
    await c.query(fs.readFileSync(M002, 'utf8'));
    console.log('[run] 001 + 002 迁移跑通');

    seed.ws = (await c.query(`insert into workspace(name,slug) values('W','w') returning id`)).rows[0].id;
    seed.user = (await c.query(`insert into app_user(name) values('孙鹏') returning id`)).rows[0].id;
    await c.query(`insert into member(workspace_id,user_id,role) values($1,$2,'owner')`, [seed.ws, seed.user]);

    seed.userKey = mint('swuk_');
    await c.query(`insert into user_key(user_id,key_hash,key_prefix) values($1,$2,$3)`,
      [seed.user, seed.userKey.hash, seed.userKey.prefix]);

    seed.online = (await c.query(
      `insert into machine(workspace_id,machine_uid,owner_user_id,display_name,status)
       values($1,'uid-online',$2,'在线机','online') returning id`, [seed.ws, seed.user])).rows[0].id;
    seed.mToken = mint('swmt_');
    await c.query(`insert into machine_token(machine_id,token_hash,token_prefix) values($1,$2,$3)`,
      [seed.online, seed.mToken.hash, seed.mToken.prefix]);

    seed.offline = (await c.query(
      `insert into machine(workspace_id,machine_uid,owner_user_id,display_name,status)
       values($1,'uid-offline',$2,'离线机','offline') returning id`, [seed.ws, seed.user])).rows[0].id;

    // 1 条 origin=local 任务 + status：验证 LEFT JOIN 不回归 P1 行
    seed.localTask = (await c.query(
      `insert into task(workspace_id,machine_id,origin,title,local_task_key,local_created_at)
       values($1,$2,'local','本地任务','manual:20260101',now()) returning id`, [seed.ws, seed.online])).rows[0].id;
    await c.query(`insert into task_status(task_id,state,rev,last_activity_at) values($1,'processing','r1',now())`, [seed.localTask]);

    // enroll 用：注册密钥 + 一次性配对码
    seed.regKey = mint('swrk_');
    await c.query(`insert into registration_key(workspace_id,key_hash,key_prefix,created_by) values($1,$2,$3,$4)`,
      [seed.ws, seed.regKey.hash, seed.regKey.prefix, seed.user]);
    seed.enrollCode = 'ABCD2345';
    await c.query(`insert into enrollment_code(code_hash,code_prefix,workspace_id,created_by,expires_at)
                   values($1,$2,$3,$4, now()+interval '10 min')`,
      [sha256(seed.enrollCode), seed.enrollCode.slice(0, 2), seed.ws, seed.user]);
  });
  console.log('[run] 已灌样本（1 workspace / 1 user / 在线机 + 离线机 / 1 local 任务 / rk+配对码）\n');

  // ============================================================
  // 场景 A：绊线开放（不设 CLOUD_INSECURE_COOKIE）—— 功能全链路
  // ============================================================
  const portA = await freePort();
  const srvA = startServer(portA, {});
  servers.push(srvA);
  if (!(await waitHealthy(baseOf(portA)))) { console.error(srvA.logs.join('')); throw new Error(`服务 A 未在 :${portA} 起来`); }
  console.log(`[run] 服务 A 已就绪（:${portA}，绊线开放）\n`);

  const cli = makeClient(baseOf(portA));
  let intentId, deliveredId;
  try {
    console.log('[断言 · 场景 A]');

    // 1. 登录
    const login = await cli.req('POST', '/api/auth/login', { body: { key: seed.userKey.plaintext } });
    assert('登录返回 200 且带会话', login.status === 200 && login.json?.user?.name === '孙鹏', `status=${login.status}`);

    // 2. 建意图 → 在线机器 201 pending
    const create = await cli.req('POST', '/api/tasks', { body: {
      machineId: seed.online, title: '云端派活', prompt: '请执行 A', cwd: 'D:\\proj\\app',
      model: 'claude-opus-4-8', effort: 'xhigh', worktree: false, autoRun: true,
    } });
    intentId = create.json?.id;
    assert('POST /api/tasks 在线机器 → 201 dispatch=pending', create.status === 201 && create.json?.dispatch === 'pending' && !!intentId, `status=${create.status} body=${JSON.stringify(create.json)}`);

    // 3. 负例：离线机器 → 409 MACHINE_UNAVAILABLE
    const off = await cli.req('POST', '/api/tasks', { body: { machineId: seed.offline, title: 'x', prompt: 'y', cwd: 'D:\\proj' } });
    assert('POST /api/tasks 离线机器 → 409 MACHINE_UNAVAILABLE', off.status === 409 && off.json?.error?.code === 'MACHINE_UNAVAILABLE', `status=${off.status} code=${off.json?.error?.code}`);

    // 4. 负例：不存在的机器 → 404
    const noMachine = await cli.req('POST', '/api/tasks', { body: { machineId: crypto.randomUUID(), title: 'x', prompt: 'y', cwd: 'D:\\proj' } });
    assert('POST /api/tasks 机器不存在 → 404 NOT_FOUND', noMachine.status === 404 && noMachine.json?.error?.code === 'NOT_FOUND', `status=${noMachine.status}`);

    // 5. 负例：model 白名单外 → 400
    const badModel = await cli.req('POST', '/api/tasks', { body: { machineId: seed.online, title: 'x', prompt: 'y', cwd: 'D:\\p', model: 'gpt-4' } });
    assert('POST /api/tasks model 白名单外 → 400', badModel.status === 400 && badModel.json?.error?.code === 'BAD_REQUEST', `status=${badModel.status}`);

    // 6. 负例：cwd 相对路径 → 400
    const relCwd = await cli.req('POST', '/api/tasks', { body: { machineId: seed.online, title: 'x', prompt: 'y', cwd: 'relative/dir' } });
    assert('POST /api/tasks 相对 cwd → 400', relCwd.status === 400, `status=${relCwd.status}`);

    // 7. cwd 为 POSIX 绝对路径也接受（跨平台绝对判定）
    const posixCwd = await cli.req('POST', '/api/tasks', { body: { machineId: seed.online, title: 'posix', prompt: 'y', cwd: '/home/dev/app' } });
    assert('POST /api/tasks POSIX 绝对 cwd → 201', posixCwd.status === 201, `status=${posixCwd.status}`);
    const posixIntentId = posixCwd.json?.id;

    // 8. ⚠ 红线：creator 只从会话取，body 里塞 creatorUserId 被无视
    const spoof = await cli.req('POST', '/api/tasks', { body: { machineId: seed.online, title: 'spoof', prompt: 'y', cwd: 'D:\\p', creatorUserId: crypto.randomUUID() } });
    assert('POST /api/tasks body.creatorUserId 被无视（仍 201）', spoof.status === 201, `status=${spoof.status}`);
    const spoofCreator = await withClient(sandboxUrl(), (c) => c.query('select creator_user_id from task where id=$1', [spoof.json.id]));
    assert('意图 creator_user_id = 会话用户（非 body 伪造值）', spoofCreator.rows[0].creator_user_id === seed.user);

    // 9. 人侧看板 GET /api/tasks：pending 意图可见、status=null、dispatch=pending；local 行仍有 status
    const board = await cli.req('GET', '/api/tasks');
    const bIntent = board.json?.tasks?.find((t) => t.id === intentId);
    const bLocal = board.json?.tasks?.find((t) => t.id === seed.localTask);
    assert('GET /api/tasks 能看到 pending 意图（LEFT JOIN）', !!bIntent, `total=${board.json?.total}`);
    assert('pending 意图 status=null 且 dispatch=pending / autoRun=true', bIntent && bIntent.status === null && bIntent.dispatch === 'pending' && bIntent.autoRun === true, JSON.stringify(bIntent && { status: bIntent.status, dispatch: bIntent.dispatch, autoRun: bIntent.autoRun }));
    assert('origin=local 行仍带 status（LEFT JOIN 未回归 P1）', bLocal && bLocal.status?.state === 'processing' && bLocal.dispatch === null, JSON.stringify(bLocal && { state: bLocal.status?.state, dispatch: bLocal.dispatch }));

    // 10. 详情 GET /api/tasks/:id：意图可查，status=null，dispatch=pending
    const detail = await cli.req('GET', `/api/tasks/${intentId}`);
    assert('GET /api/tasks/:id 意图详情 status=null + dispatch=pending', detail.status === 200 && detail.json?.status === null && detail.json?.dispatch === 'pending', `status=${detail.status} body.status=${JSON.stringify(detail.json?.status)}`);

    // 11. 心跳返回 pendingIntents 计数
    const hb = await cli.req('POST', '/api/machine/heartbeat', { bearer: seed.mToken.plaintext, body: { appVersion: '1.0.0', load: { processing: 0, queued: 0, cap: 2 } } });
    // 此刻在线机器上的 pending 意图：intentId + posixIntentId + spoof = 3（badModel/relCwd 未建、offline/noMachine 未建）
    assert('心跳返回 pendingIntents 计数', hb.status === 200 && hb.json?.pendingIntents === 3, `pendingIntents=${hb.json?.pendingIntents}`);

    // 12. 机器取件 GET /api/machine/intents
    const intents = await cli.req('GET', '/api/machine/intents', { bearer: seed.mToken.plaintext });
    const got = intents.json?.intents?.find((x) => x.intentId === intentId);
    assert('GET /api/machine/intents 取到 pending 意图', intents.status === 200 && !!got, `count=${intents.json?.intents?.length}`);
    assert('取件项含 cwd/autoRun 且 createdBy.userId=creator', got && got.cwd === 'D:\\proj\\app' && got.autoRun === true && got.createdBy?.userId === seed.user && got.createdBy?.name === '孙鹏', JSON.stringify(got && { cwd: got.cwd, autoRun: got.autoRun, createdBy: got.createdBy }));
    // FIFO：最早建的 intentId 排第一
    assert('取件 FIFO（最早的意图排第一）', intents.json.intents[0].intentId === intentId, `first=${intents.json.intents[0]?.intentId}`);

    // 13. GET 不改 dispatch（取件后仍 pending）
    const stillPending = await withClient(sandboxUrl(), (c) => c.query('select dispatch from task where id=$1', [intentId]));
    assert('GET /api/machine/intents 不改 dispatch（仍 pending）', stillPending.rows[0].dispatch === 'pending');

    // 14. ack → delivered + 回填 local_task_key
    const ack = await cli.req('POST', `/api/machine/intents/${intentId}/ack`, { bearer: seed.mToken.plaintext, body: { localTaskKey: 'cloud:20260718-001' } });
    assert('ack → 200 且带 dispatchedAt', ack.status === 200 && ack.json?.ok === true && !!ack.json?.dispatchedAt, `status=${ack.status}`);
    const afterAck = await withClient(sandboxUrl(), (c) => c.query('select dispatch,local_task_key,dispatched_at from task where id=$1', [intentId]));
    assert('ack 后 dispatch=delivered + local_task_key 回填', afterAck.rows[0].dispatch === 'delivered' && afterAck.rows[0].local_task_key === 'cloud:20260718-001');
    deliveredId = intentId;

    // 15. ack 幂等：同 key 重发 → 200，dispatched_at 不变
    const dispatchedAt1 = afterAck.rows[0].dispatched_at.toISOString();
    await sleep(20);
    const ack2 = await cli.req('POST', `/api/machine/intents/${intentId}/ack`, { bearer: seed.mToken.plaintext, body: { localTaskKey: 'cloud:20260718-001' } });
    assert('ack 幂等（同 key 重发 → 200，dispatchedAt 不刷新）', ack2.status === 200 && ack2.json?.dispatchedAt === dispatchedAt1, `${ack2.json?.dispatchedAt} vs ${dispatchedAt1}`);

    // 16. ack 冲突：不同 key → 409 ALREADY_ACKED
    const ack3 = await cli.req('POST', `/api/machine/intents/${intentId}/ack`, { bearer: seed.mToken.plaintext, body: { localTaskKey: 'cloud:different' } });
    assert('ack 不同 key → 409 ALREADY_ACKED', ack3.status === 409 && ack3.json?.error?.code === 'ALREADY_ACKED', `status=${ack3.status} code=${ack3.json?.error?.code}`);

    // 17. 已 delivered 的意图不再出现在取件列表
    const intents2 = await cli.req('GET', '/api/machine/intents', { bearer: seed.mToken.plaintext });
    assert('已 delivered 意图不再被取件', !intents2.json.intents.find((x) => x.intentId === intentId));

    // 18. reject（用 posixIntentId）→ rejected + reason
    const rej = await cli.req('POST', `/api/machine/intents/${posixIntentId}/reject`, { bearer: seed.mToken.plaintext, body: { reason: '工作目录不在本机白名单：/home/dev/app' } });
    assert('reject → 200', rej.status === 200 && rej.json?.ok === true, `status=${rej.status}`);
    const afterRej = await withClient(sandboxUrl(), (c) => c.query('select dispatch,reject_reason from task where id=$1', [posixIntentId]));
    assert('reject 后 dispatch=rejected + reject_reason 落库', afterRej.rows[0].dispatch === 'rejected' && /白名单/.test(afterRej.rows[0].reject_reason));

    // 19. reject 幂等：同 reason 重发 → 200
    const rej2 = await cli.req('POST', `/api/machine/intents/${posixIntentId}/reject`, { bearer: seed.mToken.plaintext, body: { reason: '工作目录不在本机白名单：/home/dev/app' } });
    assert('reject 幂等（同 reason 重发 → 200）', rej2.status === 200);

    // 20. reject 已 delivered 的意图 → 409 ALREADY_ACKED
    const rejDelivered = await cli.req('POST', `/api/machine/intents/${deliveredId}/reject`, { bearer: seed.mToken.plaintext, body: { reason: 'x' } });
    assert('reject 已 delivered → 409 ALREADY_ACKED', rejDelivered.status === 409 && rejDelivered.json?.error?.code === 'ALREADY_ACKED', `status=${rejDelivered.status}`);

    // 21. 取消未下发意图（用 spoof 那条，仍 pending）→ 200 + 行被删
    const cancel = await cli.req('POST', `/api/tasks/${spoof.json.id}/cancel`);
    assert('取消未下发意图 → 200 cancelled', cancel.status === 200 && cancel.json?.cancelled === true, `status=${cancel.status}`);
    const gone = await withClient(sandboxUrl(), (c) => c.query('select 1 from task where id=$1', [spoof.json.id]));
    assert('取消后 task 行被 DELETE（无残留）', gone.rowCount === 0);

    // 22. 取消已 delivered 的意图 → 409 ALREADY_DISPATCHED（带当前 dispatch）
    const cancelDelivered = await cli.req('POST', `/api/tasks/${deliveredId}/cancel`);
    assert('取消已 delivered → 409 ALREADY_DISPATCHED + 带 dispatch', cancelDelivered.status === 409 && cancelDelivered.json?.error?.code === 'ALREADY_DISPATCHED' && cancelDelivered.json?.dispatch === 'delivered', `status=${cancelDelivered.status} dispatch=${cancelDelivered.json?.dispatch}`);

    // 23. 取消不存在的意图 → 404
    const cancelNone = await cli.req('POST', `/api/tasks/${crypto.randomUUID()}/cancel`);
    assert('取消不存在意图 → 404', cancelNone.status === 404);

    // 24. 铁律：云端从不写 task_status —— 云端建的意图（含已 delivered）无 task_status 行
    const noStatus = await withClient(sandboxUrl(), (c) => c.query(
      `select count(*)::int n from task_status ts join task t on t.id=ts.task_id where t.origin='cloud'`));
    assert('云端 origin=cloud 任务无 task_status 行（云端永不写执行真相）', noStatus.rows[0].n === 0, `n=${noStatus.rows[0].n}`);

    // 25. enroll 响应带 ownerUserId（owner-only 闸门前提）
    const enroll = await cli.req('POST', '/api/machine/enroll', { noCookie: true, body: {
      registrationKey: seed.regKey.plaintext, code: seed.enrollCode, machineUid: crypto.randomUUID(),
      hostname: 'dev-box', platform: 'win32', arch: 'x64', appVersion: '1.0.0',
    } });
    assert('enroll → 201 且响应带 ownerUserId=配对码创建者', enroll.status === 201 && enroll.json?.ownerUserId === seed.user, `status=${enroll.status} ownerUserId=${enroll.json?.ownerUserId}`);
  } finally {
    await stopServer(srvA);
  }
  console.log('');

  // ============================================================
  // 场景 B：绊线封禁（CLOUD_INSECURE_COOKIE=1 + 绑 0.0.0.0）—— 验证 preHandler 接线
  // ============================================================
  const portB = await freePort();
  const srvB = startServer(portB, { CLOUD_INSECURE_COOKIE: '1' });
  servers.push(srvB);
  if (!(await waitHealthy(baseOf(portB)))) { console.error(srvB.logs.join('')); throw new Error(`服务 B 未在 :${portB} 起来`); }
  console.log(`[断言 · 场景 B 绊线封禁（:${portB}）]`);
  try {
    const anon = makeClient(baseOf(portB));
    // 绊线在鉴权之前：无凭据也应先被 503 挡下（造成下发的两个端点）
    const blockedCreate = await anon.req('POST', '/api/tasks', { body: { machineId: seed.online, title: 'x', prompt: 'y', cwd: 'D:\\p' } });
    assert('绊线封禁：POST /api/tasks → 503 PLAINTEXT_DISPATCH_BLOCKED（先于鉴权）', blockedCreate.status === 503 && blockedCreate.json?.error?.code === 'PLAINTEXT_DISPATCH_BLOCKED', `status=${blockedCreate.status} code=${blockedCreate.json?.error?.code}`);
    const blockedIntents = await anon.req('GET', '/api/machine/intents');
    assert('绊线封禁：GET /api/machine/intents → 503（先于鉴权）', blockedIntents.status === 503 && blockedIntents.json?.error?.code === 'PLAINTEXT_DISPATCH_BLOCKED', `status=${blockedIntents.status}`);
    // 收口面不挂绊线：cancel/ack 不应是 503（无凭据 → 401，证明没挂绊线）
    const cancelNotBlocked = await anon.req('POST', `/api/tasks/${crypto.randomUUID()}/cancel`);
    assert('收口面不封：cancel 非 503（无凭据得 401）', cancelNotBlocked.status === 401, `status=${cancelNotBlocked.status}`);
    const ackNotBlocked = await anon.req('POST', `/api/machine/intents/${crypto.randomUUID()}/ack`, { body: { localTaskKey: 'x' } });
    assert('收口面不封：ack 非 503（无凭据得 401）', ackNotBlocked.status === 401, `status=${ackNotBlocked.status}`);
  } finally {
    await stopServer(srvB);
  }
} finally {
  // 先收所有服务（只按自己 spawn 的 child 定点 kill，绝不按端口/进程名扫杀），再 DROP 库（否则连接占用导致 drop 失败）
  for (const s of servers) await stopServer(s);
  await withClient(adminUrl(), (c) => c.query(`drop database if exists ${SANDBOX_DB} with (force)`));
  console.log(`\n[run] 一次性库 ${safe(SANDBOX_DB)} 已 DROP`);
}

console.log(`\n[run] 断言汇总：PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
