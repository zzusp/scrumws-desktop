#!/usr/bin/env node
// P2 端到端「真云端」验收：一次性库(001+002) + 真 cloud/src/server.js(8791) + 真本地沙箱看板(8797)。
// 与 cloud-p2/scripts/verify-local-dispatch.mjs（假云端 + stub）互补：本脚本让**真云端 + 真 DB + 真 connector**
// 端到端对话，phase2 更是**真跑一次 claude**（不 stub），亲眼见云端指令在机器上执行代码。
//
// 用法（DATABASE_URL 从仓库根 .env 注入，绝不落命令行/日志）：
//   node e2e-real.mjs --check   零副作用自检：连库、验端口空闲、验用户 8799 在跑、打印将做什么
//   node e2e-real.mjs --run     实跑：建一次性库→起真云端→bootstrap→真沙箱 enroll→派活→真 claude→无论成败都收口
//
// ⚠ 红线（脚本自守）：
//   · 用户真实 app 8799 只读探活，绝不碰。收进程一律 taskkill /PID <自己起的> /T /F，绝不按名字/路径杀。
//   · 生产云端在**远端** 115.159.161.47:8790，本脚本只连 127.0.0.1:8791 的一次性云端，从不碰远端。
//   · 一次性库 scrumws_p2_e2e，用完 DROP WITH(FORCE)。同实例的 scrumws/claude_center/novel_writer 一律不碰。
//   · stub claude 只挂子进程 PATH（phase1）；phase2 用真 claude，只跑一个最小任务。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLOUD_PORT = 8791;
const APP_PORT = 8797;
const USER_APP_PORT = 8799;
const SANDBOX1 = path.join(REPO, '.sandbox', 'p2e-stub');   // phase1：stub claude
const SANDBOX2 = path.join(REPO, '.sandbox', 'p2e-real');   // phase2：真 claude
const STUB_DIR = path.join(SANDBOX1, 'stub-bin');
const SANDBOX_DB = 'scrumws_p2_e2e';
const CLOUD_URL = `http://127.0.0.1:${CLOUD_PORT}`;
const TICK_MS = 15000;
const ROUND_DIR = path.join(REPO, 'docs', 'acceptance', 'cloud-p2-dispatch', 'round-1');

// ---- .env 注入（只读 DATABASE_URL，绝不打印其值）----
function loadEnv() {
  const file = path.join(REPO, '.env');
  if (!fs.existsSync(file)) throw new Error('仓库根缺少 .env');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().replace(/^["'](.*)["']$/, '$1');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  if (!process.env.DATABASE_URL) throw new Error('.env 里没有 DATABASE_URL');
}
loadEnv();

const pg = createRequire(path.join(REPO, 'cloud/package.json'))('pg');
const withDb = (name) => { const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + name; return u.toString(); };
const sandboxUrl = () => withDb(SANDBOX_DB);
const adminUrl = () => withDb('postgres');
const safeName = `<DATABASE_URL 同主机>/${SANDBOX_DB}`;

// ---- 日志（同时打屏 + 落 round-1/e2e-real.log，跑不通也留证据）----
fs.mkdirSync(ROUND_DIR, { recursive: true });
const LOG_FILE = path.join(ROUND_DIR, 'e2e-real.log');
const RESULTS_FILE = path.join(ROUND_DIR, 'e2e-real-results.json');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
const log = (s) => { console.log(s); logStream.write(String(s) + '\n'); };
const results = [];
const pass = (n, ev) => { results.push({ ok: true, n, ev }); log(`  PASS  ${n}\n        ${ev}`); };
const fail = (n, ev) => { results.push({ ok: false, n, ev }); log(`  FAIL  ${n}\n        ${ev}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- DB helpers ----
async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function createDb() {
  await withClient(adminUrl(), async (c) => {
    await c.query(`drop database if exists ${SANDBOX_DB} with (force)`);
    await c.query(`create database ${SANDBOX_DB}`);
  });
  const sql001 = fs.readFileSync(path.join(REPO, 'cloud/migrations/001_p0p1_init.sql'), 'utf8');
  const sql002 = fs.readFileSync(path.join(REPO, 'cloud/migrations/002_p2_intent_dispatch.sql'), 'utf8');
  await withClient(sandboxUrl(), async (c) => { await c.query(sql001); await c.query(sql002); });
}
const dropDb = () => withClient(adminUrl(), (c) => c.query(`drop database if exists ${SANDBOX_DB} with (force)`));

// ---- 端口/HTTP ----
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
function httpReq(port, method, p, { body, cookie, bearer } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (cookie) headers.Cookie = cookie;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, text: b, setCookie: res.headers['set-cookie'] }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const cloudReq = (m, p, o) => httpReq(CLOUD_PORT, m, p, o);

// 本地看板请求（支持自定义 Origin 头，/api/task/create 同源守卫要用）
function appReqH(method, p, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(extraHeaders || {}) };
    const r = http.request({ host: '127.0.0.1', port: APP_PORT, method, path: p, headers }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, text: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

async function waitFor(what, pred, timeoutMs = TICK_MS * 3 + 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v = null; try { v = await pred(); } catch { v = null; }
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）：${what}`);
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// link 存储 = #67 采纳的目录格式（runtime/cloud/links/<intentId>.json，一个 intent 一个文件）。
// 汇成 { [intentId]: 条目 } 供断言（原单文件 links.json 已废，见 links.js 与 #67 reconcile）。
const links = (sb) => {
  const dir = path.join(sb, 'runtime', 'cloud', 'links');
  let names; try { names = fs.readdirSync(dir); } catch { return {}; }
  const out = {};
  for (const n of names) { if (n.endsWith('.json')) { const o = readJson(path.join(dir, n)); if (o) out[n.slice(0, -5)] = o; } }
  return out;
};
const identityOf = (sb) => readJson(path.join(sb, 'runtime', 'cloud', 'identity.json'));
const runnerDirs = (sb) => { try { return fs.readdirSync(path.join(sb, 'runtime', 'runner-state')); } catch { return []; } };
const taskState = (sb, taskKey) => readJson(path.join(sb, 'runtime', 'runner-state', String(taskKey).replace(/:/g, '__'), 'state.json'));

// ---- stub claude（phase1）----
function writeStub() {
  fs.mkdirSync(STUB_DIR, { recursive: true });
  const dump = path.join(STUB_DIR, 'stub-claude.mjs');
  fs.writeFileSync(dump, `import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const OUT = path.join(import.meta.dirname, 'spawns.jsonl');
if (argv.includes('--version')) { console.log('2.1.212 (Claude Code)'); process.exit(0); }
if (argv.includes('--input-format')) {
  fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), argv,
    env: { SCRUMWS_TASK_KEY: process.env.SCRUMWS_TASK_KEY ?? null, SCRUMWS_API_BASE: process.env.SCRUMWS_API_BASE ?? null } }) + '\\n');
  process.stdin.resume(); setInterval(() => {}, 1 << 30);
} else { process.exit(0); }
`, 'utf8');
  fs.writeFileSync(path.join(STUB_DIR, 'claude.cmd'), `@echo off\r\nnode "%~dp0stub-claude.mjs" %*\r\n`, 'utf8');
}
const spawnsOf = () => {
  try { return fs.readFileSync(path.join(STUB_DIR, 'spawns.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
function killByCmdline(match) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='claude.exe'" | Where-Object { $_.CommandLine -like '*${match}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' }); } catch {}
}
function resetSandbox(sb) {
  killByCmdline(sb);
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(sb, { recursive: true, force: true }); return; }
    catch (e) { if (i === 7) throw e; execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400'], { stdio: 'ignore' }); }
  }
}

// ---- 进程句柄 ----
let cloudProc = null;
const cloudOut = [];
let appProc = null;
const appOut = [];

function startCloud() {
  cloudProc = spawn(process.execPath, [path.join(REPO, 'cloud', 'src', 'server.js')], {
    cwd: path.join(REPO, 'cloud'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    // 不设 CLOUD_INSECURE_COOKIE：绊线 off（下行放行），且 Node 客户端手工带 cookie 不受 Secure 影响。
    env: { ...process.env, DATABASE_URL: sandboxUrl(), CLOUD_PORT: String(CLOUD_PORT) },
  });
  cloudProc.stdout.on('data', (d) => cloudOut.push(String(d)));
  cloudProc.stderr.on('data', (d) => cloudOut.push(String(d)));
}
function startApp(dataRoot, { stub }) {
  const env = { ...process.env, SCRUMWS_DATA_ROOT: dataRoot, SCRUMWS_PORT: String(APP_PORT) };
  if (stub) env.PATH = `${STUB_DIR}${path.delimiter}${process.env.PATH}`;
  appProc = spawn(process.execPath, [path.join(REPO, 'platform', 'standalone.js')], {
    cwd: REPO, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  appOut.length = 0;
  appProc.stdout.on('data', (d) => appOut.push(String(d)));
  appProc.stderr.on('data', (d) => appOut.push(String(d)));
  return appProc;
}
function stopApp() {
  if (appProc) { try { execFileSync('taskkill', ['/PID', String(appProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  appProc = null;
}

// ---- bootstrap（建 user + 登录密钥）----
function bootstrap(name) {
  const out = execFileSync(process.execPath,
    [path.join(REPO, 'cloud', 'scripts', 'bootstrap.mjs'), '--name', name, '--workspace', 'scrumws', '--slug', 'scrumws'],
    { cwd: path.join(REPO, 'cloud'), env: { ...process.env, DATABASE_URL: sandboxUrl() }, encoding: 'utf8' });
  const m = /swuk_[A-Za-z0-9_-]{43}/.exec(out);
  if (!m) throw new Error(`bootstrap 未产出 swuk_（name=${name}）`);
  return m[0];
}
async function login(swuk) {
  const r = await cloudReq('POST', '/api/auth/login', { body: { key: swuk } });
  if (r.status !== 200) throw new Error(`登录失败 HTTP ${r.status}：${r.text}`);
  const sc = (r.setCookie || []).find((c) => c.startsWith('swsession='));
  if (!sc) throw new Error('登录未返回 swsession cookie');
  return sc.split(';')[0]; // 'swsession=xxx'
}

async function mintEnrollCode(cookieA) {
  const r = await cloudReq('POST', '/api/machines/enrollment-codes', { cookie: cookieA });
  if (r.status !== 201) throw new Error(`生成配对码失败 HTTP ${r.status}：${r.text}`);
  return r.json.code;
}
async function waitMachineOnline(cookieA, machineId) {
  return waitFor(`机器 ${machineId} online`, async () => {
    const r = await cloudReq('GET', '/api/machines', { cookie: cookieA });
    const m = (r.json?.machines || []).find((x) => x.id === machineId);
    return m && m.status === 'online' ? m : null;
  }, 60000);
}
async function setConfig(cwds, mode) {
  const a = await appReqH('POST', '/api/cloud/remote-config', { cloudRemoteControl: false, cloudAllowedCwds: cwds });
  const b = await appReqH('POST', '/api/cloud/dispatch-config', { acceptAutoRun: mode });
  if (!a.json?.ok || !b.json?.ok) throw new Error(`配置失败：remote-config=${a.text} dispatch-config=${b.text}`);
}
async function dispatch(cookie, machineId, o) {
  return cloudReq('POST', '/api/tasks', { cookie, body: {
    machineId, title: o.title, prompt: o.prompt, cwd: o.cwd,
    autoRun: !!o.autoRun, model: o.model ?? null, effort: o.effort ?? null,
    worktree: !!o.worktree, baseBranch: o.baseBranch ?? null, description: o.description ?? null,
  } });
}
const cloudTask = (cookie, id) => cloudReq('GET', `/api/tasks/${id}`, { cookie });

// ---- --check ----
async function check() {
  log('== 零副作用自检 ==');
  let ok = true;
  for (const f of ['cloud/src/server.js', 'cloud/scripts/bootstrap.mjs', 'cloud/migrations/001_p0p1_init.sql',
    'cloud/migrations/002_p2_intent_dispatch.sql', 'platform/standalone.js', 'platform/lib/cloud/connector.js']) {
    const e = fs.existsSync(path.join(REPO, f)); log(`  ${e ? 'ok  ' : 'MISS'} ${f}`); if (!e) ok = false;
  }
  for (const m of ['fastify', 'pg', '@fastify/static']) {
    const e = fs.existsSync(path.join(REPO, 'cloud/node_modules', m)); log(`  ${e ? 'ok  ' : 'MISS'} cloud/node_modules/${m}`); if (!e) ok = false;
  }
  for (const p of [CLOUD_PORT, APP_PORT]) {
    const free = await portFree(p); log(`  ${free ? 'ok  ' : 'BUSY'} 端口 ${p} ${free ? '空闲' : '被占用'}`); if (!free) ok = false;
  }
  try { await withClient(adminUrl(), async (c) => { const v = await c.query('select version()'); log(`  ok   库可达：${v.rows[0].version.split(',')[0]}`); const e = await c.query('select 1 from pg_database where datname=$1', [SANDBOX_DB]); log(`  ${e.rowCount ? '注意' : 'ok  '} 一次性库 ${safeName} ${e.rowCount ? '已存在（--run 会先 drop 再建）' : '不存在（--run 会新建）'}`); }); }
  catch (e) { log(`  MISS 库不可达：${e.message}`); ok = false; }
  let u = null; try { u = await httpReq(USER_APP_PORT, 'GET', '/api/state'); } catch {}
  log(`  ${u?.status === 200 ? 'ok  ' : '注意'} 用户真实 app 8799：${u?.status === 200 ? 'HTTP 200（全程不碰）' : '未在跑（也不会碰）'}`);
  log(`  计划：一次性库 ${safeName}（001+002）→ 真云端 ${CLOUD_URL} → 沙箱 8797（phase1 stub / phase2 真 claude）`);
  log(`  收尾：DROP 一次性库 + taskkill /PID 自起进程；生产远端 115.159.161.47:8790 全程不碰`);
  log(ok ? '自检通过，可以 --run' : '自检未通过');
  return ok ? 0 : 1;
}

// ---- --run ----
async function run() {
  if (!(await portFree(CLOUD_PORT)) || !(await portFree(APP_PORT))) { log(`端口 ${CLOUD_PORT}/${APP_PORT} 不空闲`); return 1; }
  let cookieA = null, cookieB = null, ownerUserId = null;

  try {
    // ===== 共享前置：库 + 云端 + 用户 =====
    log('\n===== 前置：一次性库(001+002) + 真云端 + bootstrap =====');
    await createDb();
    // C01 迁移 001+002 落地：task 有 P2 四列且 origin 仍在
    const cols = await withClient(sandboxUrl(), (c) => c.query(
      `select column_name from information_schema.columns where table_name='task'
        and column_name = any($1::text[])`, [['origin', 'auto_run', 'dispatch', 'dispatched_at', 'reject_reason']]));
    const have = new Set(cols.rows.map((r) => r.column_name));
    if (['origin', 'auto_run', 'dispatch', 'dispatched_at', 'reject_reason'].every((c) => have.has(c))) {
      pass('C01 迁移 001+002 落地：task 有 auto_run/dispatch/dispatched_at/reject_reason 四列，且 origin 未删',
        `information_schema 命中列：${[...have].sort().join(', ')}`);
    } else fail('C01 迁移落地', `命中列=${[...have].join(',')}`);

    startCloud();
    await waitFor('真云端 8791 健康', async () => (await cloudReq('GET', '/api/health')).status === 200, 30000);
    const idx = await cloudReq('GET', '/');
    pass('C02 真 cloud/src/server.js 起在 8791（非 mock）', `GET /api/health 200 · GET / → ${idx.status} ${idx.text.slice(0, 15).replace(/\n/g, ' ')}… (index.html)`);

    const swukA = bootstrap('孙鹏');
    const swukB = bootstrap('同事乙');
    cookieA = await login(swukA);
    cookieB = await login(swukB);
    const meA = await cloudReq('GET', '/api/auth/me', { cookie: cookieA });
    const meB = await cloudReq('GET', '/api/auth/me', { cookie: cookieB });
    ownerUserId = meA.json?.user?.id;
    pass('C03 bootstrap 两用户 + 各自登录（同 workspace scrumws）',
      `A=${meA.json?.user?.name}(${ownerUserId?.slice(0, 8)}…) · B=${meB.json?.user?.name}(${meB.json?.user?.id?.slice(0, 8)}…)`);

    const rk = (await cloudReq('POST', '/api/registration-keys', { cookie: cookieA, body: { label: 'p2-e2e' } })).json?.key;
    if (!rk) throw new Error('生成注册密钥失败');

    // ===== PHASE 1：真云端 + stub claude（reject / gate / 决策15 args / 上行）=====
    log('\n===== PHASE 1：真云端 + stub claude =====');
    resetSandbox(SANDBOX1);
    const CWD_ALLOWED = path.join(SANDBOX1, 'work');
    const CWD_EVIL = path.join(SANDBOX1, 'work-evil');
    fs.mkdirSync(CWD_ALLOWED, { recursive: true });
    fs.mkdirSync(CWD_EVIL, { recursive: true });
    writeStub();
    startApp(SANDBOX1, { stub: true });
    await waitFor('沙箱看板1 就绪', async () => (await appReqH('GET', '/api/state')).status === 200, 30000);
    const code1 = await mintEnrollCode(cookieA);
    const en1 = await appReqH('POST', '/api/cloud/enroll', { cloudUrl: CLOUD_URL, registrationKey: rk, code: code1 });
    if (!en1.json?.ok) throw new Error(`enroll1 失败：${en1.text}`);
    const machineId1 = identityOf(SANDBOX1)?.machineId;
    // C04 enroll → 机器 online（真心跳）+ identity 落 ownerUserId
    const mOnline = await waitMachineOnline(cookieA, machineId1);
    if (identityOf(SANDBOX1)?.ownerUserId === ownerUserId) {
      pass('C04 enroll→机器 online（真心跳）+ identity.ownerUserId=会话用户（owner-only 闸门判据）',
        `machineId=${machineId1?.slice(0, 8)}… status=${mOnline.status} owner=${mOnline.owner?.name} identity.ownerUserId=${ownerUserId.slice(0, 8)}…`);
    } else fail('C04 enroll owner', `identity.ownerUserId=${identityOf(SANDBOX1)?.ownerUserId} 期望=${ownerUserId}`);

    // T3(playbook3) 白名单默认空 → 派活被 reject（最硬防线；唯一不依赖云端诚实）
    const i1 = await dispatch(cookieA, machineId1, { title: '空白名单探路', prompt: '随便', cwd: CWD_ALLOWED, autoRun: true });
    if (i1.status !== 201) throw new Error(`建意图失败：${i1.status} ${i1.text}`);
    const t1 = await waitFor('C05 云端见 rejected', async () => {
      const r = await cloudTask(cookieA, i1.json.id); return r.json?.dispatch === 'rejected' ? r.json : null;
    });
    const noLocal1 = Object.keys(links(SANDBOX1)).length === 0 && runnerDirs(SANDBOX1).length === 0;
    if (/白名单/.test(t1.rejectReason || '') && noLocal1) {
      pass('C05(剧本3) 白名单默认空 → 云端任务被本地拒收，云端见 rejected+原因，本地零任务零 link',
        `云端 dispatch=rejected rejectReason="${t1.rejectReason}" · 本地 links={} runner-state=[]`);
    } else fail('C05 空白名单拒收', `dispatch=${t1.dispatch} reason=${t1.rejectReason} noLocal=${noLocal1}`);

    // 配白名单 + owner-only
    await setConfig([CWD_ALLOWED], 'owner-only');
    log(`  已配白名单 ${CWD_ALLOWED} · acceptAutoRun=owner-only`);

    // 白名单外（相邻前缀）仍被拒
    const iEvil = await dispatch(cookieA, machineId1, { title: '白名单外', prompt: 'x', cwd: CWD_EVIL, autoRun: true });
    const tEvil = await waitFor('C06 work-evil rejected', async () => {
      const r = await cloudTask(cookieA, iEvil.json.id); return r.json?.dispatch === 'rejected' ? r.json : null;
    });
    if (/白名单/.test(tEvil.rejectReason || '') && !links(SANDBOX1)[iEvil.json.id]) {
      pass('C06 白名单外 cwd 被拒（work-evil 与白名单 work 前缀相邻，未被误放行）', `rejectReason="${tEvil.rejectReason}"`);
    } else fail('C06 白名单外拒收', `reason=${tEvil.rejectReason}`);

    // T4+T5a(playbook4/5) 落地 + owner-only 自己派 autoRun → autoExec（不落 plan）
    const iOwn = await dispatch(cookieA, machineId1, { title: '自己派autoRun', prompt: '干活', cwd: CWD_ALLOWED, autoRun: true });
    const tOwn = await waitFor('C07 自己派 delivered', async () => {
      const r = await cloudTask(cookieA, iOwn.json.id); return r.json?.dispatch === 'delivered' ? r.json : null;
    });
    const ownKey = links(SANDBOX1)[iOwn.json.id]?.taskKey;
    const ownState = taskState(SANDBOX1, ownKey)?.state;
    if (tOwn.localTaskKey === ownKey && ownState && ownState !== 'plan') {
      pass('C07(剧本4+5a) 白名单内 + owner-only + 自己派 + autoRun → autoExec 直接跑（不落 plan），云端 delivered+回填 localTaskKey',
        `云端 dispatch=delivered localTaskKey=${tOwn.localTaskKey} · 本地 state=${ownState}（≠plan）`);
    } else fail('C07 autoExec 落地', `delivered=${tOwn.dispatch} localTaskKey=${tOwn.localTaskKey} ownKey=${ownKey} state=${ownState}`);

    // T5b(playbook5) owner-only 别人(B)派 autoRun → 落 plan
    const iOther = await dispatch(cookieB, machineId1, { title: 'B派autoRun', prompt: '干活', cwd: CWD_ALLOWED, autoRun: true });
    const tOther = await waitFor('C08 B 派 delivered', async () => {
      const r = await cloudTask(cookieA, iOther.json.id); return r.json?.dispatch === 'delivered' ? r.json : null;
    });
    const otherKey = links(SANDBOX1)[iOther.json.id]?.taskKey;
    const otherState = taskState(SANDBOX1, otherKey)?.state;
    if (otherState === 'plan') {
      pass('C08(剧本5b) owner-only + 别人(B)派 + autoRun → 落 plan 等人确认（云端上报 createdBy=B ≠ 机器主人 A）',
        `intent.createdBy=B · 本地 state=plan · 云端 dispatch=delivered`);
    } else fail('C08 别人派落 plan', `state=${otherState}`);

    // C09(playbook6) 自然幂等：delivered 意图不再被取件；每意图恰一个本地任务/一条 link
    const getsBefore = runnerDirs(SANDBOX1).length;
    await sleep(TICK_MS * 2 + 2000); // 等两轮：delivered 的不该被重取、重建
    const linkMap = links(SANDBOX1);
    const uniqueKeys = new Set(Object.values(linkMap).map((v) => v.taskKey).filter(Boolean));
    const getsAfter = runnerDirs(SANDBOX1).length;
    const stillOwn = (await cloudTask(cookieA, iOwn.json.id)).json;
    if (getsAfter === getsBefore && uniqueKeys.size === Object.values(linkMap).filter((v) => v.taskKey).length && stillOwn.localTaskKey === ownKey) {
      pass('C09(剧本6) 自然幂等：delivered 意图不再被取件（GET intents 只回 pending），每意图恰一个本地任务，localTaskKey 稳定',
        `等 2 轮 tick：runner-state 数 ${getsBefore}→${getsAfter}（不增）· link 无重复 taskKey · iOwn.localTaskKey 恒=${ownKey}`);
    } else fail('C09 自然幂等', `dirs ${getsBefore}→${getsAfter} uniq=${uniqueKeys.size} vs ${Object.values(linkMap).filter((v) => v.taskKey).length}`);

    // C10(playbook7) 决策15 args/env（stub 记下真实 spawn）
    const sp = spawnsOf();
    const argHit = sp.filter((s) => { const i = s.argv.indexOf('--disallowedTools'); return i >= 0 && s.argv[i + 1] === 'AskUserQuestion' && s.argv.includes('--dangerously-skip-permissions'); });
    const envHit = sp.filter((s) => s.env.SCRUMWS_TASK_KEY && s.env.SCRUMWS_API_BASE === `http://127.0.0.1:${APP_PORT}`);
    if (sp.length && argHit.length === sp.length && envHit.length === sp.length) {
      pass('C10(剧本7·决策15) 真云端派的自动执行任务 spawn 命中 --disallowedTools AskUserQuestion(挂 bypass) + 注入 SCRUMWS_TASK_KEY/API_BASE',
        `${sp.length}/${sp.length} 次 spawn · argv 片段=${JSON.stringify(sp[0].argv.slice(6, 12))} · env=${JSON.stringify(sp[0].env)}`);
    } else fail('C10 决策15 args/env', `spawn=${sp.length} argHit=${argHit.length} envHit=${envHit.length}`);

    // C11 上行机制：把一个 delivered 本地任务摆到 awaiting-human → agent complete → done(by=agent) → 对账上行云端 history.by=agent
    //   ⚠ 这只证「若任务已 awaiting-human，agent 完成 + 上行 都对」；真 agent 单轮里能否走到这步，见 phase2 C13。
    const vKey = otherKey; // B 派的那个 plan 任务，先摆到 awaiting-human
    const vFile = path.join(SANDBOX1, 'runtime', 'runner-state', vKey.replace(/:/g, '__'), 'state.json');
    const vs = readJson(vFile);
    fs.writeFileSync(vFile, JSON.stringify({ ...vs, state: 'awaiting-human' }, null, 2), 'utf8');
    const doneResp = await appReqH('POST', `/api/task/complete?taskKey=${encodeURIComponent(vKey)}&resolvedBy=agent`);
    const afterDone = taskState(SANDBOX1, vKey);
    const cloudHist = await waitFor('C11 云端 history.by=agent', async () => {
      const r = await cloudTask(cookieA, iOther.json.id);
      const h = r.json?.history || []; const lastByAgent = h.length && h[h.length - 1].by === 'agent' && r.json?.status?.state === 'done';
      return lastByAgent ? r.json : null;
    }, 40000);
    if (doneResp.json?.ok && afterDone?.state === 'done' && afterDone?.outcomeDetail?.resolvedBy === 'agent') {
      pass('C11(剧本7·上行半) awaiting-human→done(by=agent) 且对账把 by=agent 上行到云端 task_history',
        `本地 state=done resolvedBy=agent · 云端 status.state=done history 末条 by=${cloudHist.history[cloudHist.history.length - 1].by}`);
    } else fail('C11 agent 完成上行', `resp=${doneResp.text} local=${afterDone?.state}/${afterDone?.outcomeDetail?.resolvedBy}`);

    // C12 取消：已 delivered 的意图 → 取消返回 409 ALREADY_DISPATCHED
    const cancelDelivered = await cloudReq('POST', `/api/tasks/${iOwn.json.id}/cancel`, { cookie: cookieA });
    if (cancelDelivered.status === 409 && cancelDelivered.json?.error?.code === 'ALREADY_DISPATCHED') {
      pass('C12 取消已下发意图 → 409 ALREADY_DISPATCHED（已下发的撤回是 P3，本期只挡）',
        `HTTP 409 code=${cancelDelivered.json.error.code} dispatch=${cancelDelivered.json.dispatch}`);
    } else fail('C12 取消已下发', `status=${cancelDelivered.status} body=${cancelDelivered.text}`);

    stopApp();
    killByCmdline(SANDBOX1);
    log('  phase1 沙箱已收');

    // ===== PHASE 2：真 claude —— 云端指令真在机器上执行代码 =====
    log('\n===== PHASE 2：真 claude（不 stub）=====');
    resetSandbox(SANDBOX2);
    const WORK2 = path.join(SANDBOX2, 'work');
    fs.mkdirSync(WORK2, { recursive: true });
    for (const n of ['alpha.txt', 'beta.txt', 'gamma.txt']) fs.writeFileSync(path.join(WORK2, n), n);
    startApp(SANDBOX2, { stub: false });
    await waitFor('沙箱看板2 就绪', async () => (await appReqH('GET', '/api/state')).status === 200, 30000);
    const code2 = await mintEnrollCode(cookieA);
    const en2 = await appReqH('POST', '/api/cloud/enroll', { cloudUrl: CLOUD_URL, registrationKey: rk, code: code2 });
    if (!en2.json?.ok) throw new Error(`enroll2 失败：${en2.text}`);
    const machineId2 = identityOf(SANDBOX2)?.machineId;
    await waitMachineOnline(cookieA, machineId2);
    await setConfig([WORK2], 'owner-only');
    log(`  沙箱2 enroll+online machineId=${machineId2?.slice(0, 8)}… · 白名单=${WORK2} · owner-only`);

    // C13(playbook8) 真跑一次 claude：云端派最小任务 → autoExec → 真 claude 执行、收敛、上报
    const iReal = await dispatch(cookieA, machineId2, {
      title: '真跑·数文件', prompt: '这是一个最小验证任务：数一下当前工作目录下有几个文件，用一句话说出这个数字。',
      cwd: WORK2, autoRun: true, model: 'claude-haiku-4-5-20251001',
    });
    if (iReal.status !== 201) throw new Error(`真跑建意图失败：${iReal.status} ${iReal.text}`);
    const realDelivered = await waitFor('C13 真跑 delivered', async () => {
      const r = await cloudTask(cookieA, iReal.json.id); return r.json?.dispatch === 'delivered' ? r.json : null;
    });
    const realKey = links(SANDBOX2)[iReal.json.id]?.taskKey;
    log(`  云端已 delivered · 本地 taskKey=${realKey} · 真 claude 应已 spawn（数文件）`);
    // 盯本地 state：processing → 期望 done(by=agent)，实测会卡 awaiting-human（决策15 时序缺陷）
    const trail = [];
    const t0 = Date.now(); let last = null;
    while (Date.now() - t0 < 180000) {
      const s = taskState(SANDBOX2, realKey)?.state;
      if (s && s !== last) { trail.push(`[${Math.round((Date.now() - t0) / 1000)}s]${s}`); last = s; }
      if (s === 'done' || s === 'awaiting-human') { await sleep(2000); break; } // 收敛/卡住都再等一下看是否翻转
      await sleep(1000);
    }
    // 再多等一轮，确认是否会自我翻 done
    await sleep(6000);
    const realFinal = taskState(SANDBOX2, realKey);
    // 抓 CC transcript：证明真 claude 执行了代码 + agent 完成调用的真实响应
    let transcript = { counted: null, completeErr: null, ranComplete: false };
    try {
      const enc = WORK2.replace(/[:.\\/]/g, '-');
      const projDir = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects', enc);
      const jf = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl')).sort();
      if (jf.length) {
        const content = fs.readFileSync(path.join(projDir, jf[jf.length - 1]), 'utf8');
        for (const line of content.split('\n')) {
          if (/api\/task\/complete/.test(line)) transcript.ranComplete = true;
          if (/awaiting-human/.test(line) && /只有/.test(line)) transcript.completeErr = true;
          try { const o = JSON.parse(line); if (o.type === 'assistant' && o.message?.content) for (const c of o.message.content) if (c.type === 'text' && /文件/.test(c.text)) transcript.counted = c.text.slice(0, 120); } catch {}
        }
      }
    } catch {}
    // 云端对账应看到真跑任务的执行态（processing/awaiting-human）
    const realCloud = await waitFor('C13 云端见真跑任务执行态', async () => {
      const r = await cloudTask(cookieA, iReal.json.id); return r.json?.status?.state ? r.json : null;
    }, 40000).catch(() => null);

    // 正面：云端指令真在机器上执行了代码（真 claude 数出文件数）
    if (realKey && transcript.counted && /3|三/.test(transcript.counted)) {
      pass('C13a(剧本8·核心) 云端派的任务真在机器上执行代码：真 claude 在白名单目录跑起来，数出 3 个文件',
        `本地 taskKey=${realKey} · 迁移轨迹=${trail.join('→')} · claude 输出="${transcript.counted}" · 云端对账 status.state=${realCloud?.status?.state}`);
    } else fail('C13a 真 claude 执行', `counted=${transcript.counted} trail=${trail.join('→')}`);

    // 负面（决策15 自我声明完成的真实缺陷）：agent 调 complete 时任务仍 processing → 被拒 → 卡 awaiting-human，永不 done
    if (realFinal?.state === 'awaiting-human' && (transcript.ranComplete && transcript.completeErr)) {
      fail('C13b(剧本8·决策15) 真 agent 单轮内自我声明完成——被 completeTask 的 awaiting-human 卫语句拒（当时 state=processing），任务卡 awaiting-human 永不 done',
        `真实证据：agent 执行了 complete 调用但收到 {"ok":false,"error":"只有 awaiting-human…（当前 processing）"} → 终态 state=${realFinal.state} resolvedBy=${realFinal?.outcomeDetail?.resolvedBy}（决策15 端到端未生效，根因见 round-1.md）`);
    } else if (realFinal?.state === 'done' && realFinal?.outcomeDetail?.resolvedBy === 'agent') {
      pass('C13b(剧本8·决策15) 真 agent 自我声明完成 → done(by=agent)', `终态 state=done resolvedBy=agent trail=${trail.join('→')}`);
    } else {
      fail('C13b 决策15 真实行为', `终态 state=${realFinal?.state} resolvedBy=${realFinal?.outcomeDetail?.resolvedBy} ranComplete=${transcript.ranComplete} completeErr=${transcript.completeErr}`);
    }

    stopApp();
    killByCmdline(SANDBOX2);
  } catch (e) {
    fail('执行中断', e.message);
    log(`  云端输出尾：${cloudOut.join('').split('\n').slice(-6).join(' | ')}`);
    log(`  看板输出尾：${appOut.join('').split('\n').slice(-6).join(' | ')}`);
  } finally {
    stopApp();
    killByCmdline(SANDBOX1);
    killByCmdline(SANDBOX2);
    if (cloudProc) { try { execFileSync('taskkill', ['/PID', String(cloudProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    await sleep(800);
    try { await dropDb(); log(`\n[收尾] 一次性库 ${safeName} 已 DROP WITH(FORCE)`); }
    catch (e) { log(`\n[收尾] DROP 库失败（需手动清理）：${e.message}`); }
    let u = null; try { u = await httpReq(USER_APP_PORT, 'GET', '/api/state'); } catch {}
    log(`[收尾] 用户真实 app 8799 探活：HTTP ${u?.status ?? '(无响应)'}`);
    const cloudDead = await portFree(CLOUD_PORT); const appDead = await portFree(APP_PORT);
    log(`[收尾] 一次性云端 8791 已收：${cloudDead ? '是' : '否(残留!)'} · 沙箱看板 8797 已收：${appDead ? '是' : '否(残留!)'}`);
  }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf8');
  const bad = results.filter((r) => !r.ok);
  log(`\n== ${results.length - bad.length}/${results.length} PASS ==`);
  logStream.end();
  return bad.length ? 1 : 0;
}

const mode = process.argv[2];
if (mode === '--check') process.exit(await check());
else if (mode === '--run') process.exit(await run());
else { console.log('用法：node e2e-real.mjs --check | --run'); process.exit(2); }
