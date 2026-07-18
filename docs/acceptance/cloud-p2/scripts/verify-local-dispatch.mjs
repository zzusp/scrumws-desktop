#!/usr/bin/env node
// P2 本地下行验证（B 块）：假云端(8791) + 沙箱数据根(.sandbox/p2b) + stub claude(PATH 首位) + 沙箱看板(8797)。
//
// 用法：
//   node verify-local-dispatch.mjs --check   零副作用自检：查端口空闲、查用户 8799 在跑、打印将要做什么
//   node verify-local-dispatch.mjs --run      实跑：起两个服务 → 断言 → 无论成败都按 PID 收进程
//
// ⚠ 红线（本脚本自己也守）：
//   · 用户的真实桌面 app 在 8799 —— 只读探活，绝不碰。收进程一律 taskkill /PID <自己起的> /T /F，
//     绝不按进程名/路径杀 node/electron（会连用户的 app 一起杀）。
//   · stub claude 只挂在子进程的 PATH 上（不改系统 PATH），避免真 claude 被下发的测试任务拉起来跑。
//   · 不碰生产库 / 不碰真云端 8790：假云端只在 127.0.0.1:8791 上。
//   · 决策 14 对账过滤（reconcile 按 link 过滤）是 #67 的活、本 worktree 未落地，本脚本不验它。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const SANDBOX = path.join(REPO, '.sandbox', 'p2b');
const STUB_DIR = path.join(SANDBOX, 'stub-bin');
const CWD_ALLOWED = path.join(SANDBOX, 'work');      // 白名单里的目录
const CWD_EVIL = path.join(SANDBOX, 'work-evil');    // 白名单外的目录（同父目录，防前缀误放行）
const CLOUD_PORT = 8791;
const APP_PORT = 8797;
const USER_APP_PORT = 8799;                          // 用户真实 app：只读探活
const OWNER_USER = 'user-owner-0001';
const OTHER_USER = 'user-other-0002';
const TICK_MS = 15000;

const results = [];
const pass = (n, ev) => { results.push({ ok: true, n, ev }); console.log(`  PASS  ${n}\n        ${ev}`); };
const fail = (n, ev) => { results.push({ ok: false, n, ev }); console.log(`  FAIL  ${n}\n        ${ev}`); };
const log = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

function req(port, method, p, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(extraHeaders || {}) };
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { } resolve({ status: res.statusCode, json: j, text: b }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 轮询等待条件成立（下行靠 15s tick，等三轮 + 余量）。 */
async function waitFor(what, pred, timeoutMs = TICK_MS * 3 + 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v = null;
    try { v = await pred(); } catch { v = null; }
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）：${what}`);
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const links = () => readJson(path.join(SANDBOX, 'runtime', 'cloud', 'links.json')) || {};
const taskDirs = () => { try { return fs.readdirSync(path.join(SANDBOX, 'runtime', 'runner-state')); } catch { return []; } };
const taskState = (taskKey) => readJson(path.join(SANDBOX, 'runtime', 'runner-state', String(taskKey).replace(/:/g, '__'), 'state.json'));
const taskJson = (taskKey) => readJson(path.join(SANDBOX, 'runtime', 'runner-state', String(taskKey).replace(/:/g, '__'), 'task.json'));

// ---- 假云端（只实现 connector 会打的那几个机器面端点）----
const cloud = {
  intents: new Map(),   // id → { …intent, dispatch }
  acks: [],             // { id, localTaskKey, status }
  rejects: [],          // { id, reason }
  upserts: [],          // taskKey（reconcile 增量推）
  intentGets: 0,        // GET /api/machine/intents 次数（门铃验证用）
  failAckOnce: new Set(),
};

function addIntent(o) {
  cloud.intents.set(o.intentId, {
    intentId: o.intentId, title: o.title || `意图 ${o.intentId}`, prompt: o.prompt || '把这件事做完',
    cwd: o.cwd, model: o.model ?? null, effort: o.effort ?? null, worktree: !!o.worktree,
    baseBranch: o.baseBranch ?? null, description: o.description ?? null,
    autoRun: !!o.autoRun, createdBy: { userId: o.createdBy || OWNER_USER, name: '测试' },
    dispatch: 'pending',
  });
}
const pendingCount = () => [...cloud.intents.values()].filter((i) => i.dispatch === 'pending').length;

function startFakeCloud() {
  const srv = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => {
      const j = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const send = (code, o) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(o)); };
      const u = new URL(rq.url, 'http://x');
      const p = u.pathname;

      if (p === '/api/machine/enroll') {
        return send(201, { token: 'swmt_faketoken_for_sandbox', machineId: 'machine-0001',
          workspaceId: 'ws-0001', workspaceName: '沙箱工作区', displayName: 'sandbox', ownerUserId: OWNER_USER });
      }
      // §5.7b：心跳带回 pendingIntents（取件门铃）——本脚本据此验 connector 的门铃真按它取舍
      if (p === '/api/machine/heartbeat') return send(200, { serverTime: new Date().toISOString(), pendingIntents: pendingCount() });
      if (p === '/api/machine/tasks/digest') return send(200, { needFull: [], markedMissing: 0 });
      if (p === '/api/machine/tasks/upsert') {
        for (const t of (j.tasks || [])) cloud.upserts.push(t.taskKey);
        return send(200, { results: (j.tasks || []).map((t) => ({ taskKey: t.taskKey, ok: true })) });
      }
      if (p === '/api/machine/intents' && rq.method === 'GET') {
        cloud.intentGets++;
        const list = [...cloud.intents.values()].filter((i) => i.dispatch === 'pending')
          .map(({ dispatch, rejectReason, localTaskKey, ...rest }) => rest);
        return send(200, { intents: list });
      }
      let m = p.match(/^\/api\/machine\/intents\/([^/]+)\/ack$/);
      if (m && rq.method === 'POST') {
        const it = cloud.intents.get(m[1]);
        if (!it) return send(404, { error: { code: 'NOT_FOUND' } });
        // 模拟「ack 响应丢包」：第一次 ack 记下但回 500 且**不**翻 delivered → 意图仍 pending → 下轮重拉
        if (cloud.failAckOnce.has(m[1])) {
          cloud.failAckOnce.delete(m[1]);
          cloud.acks.push({ id: m[1], localTaskKey: j.localTaskKey, status: 500 });
          return send(500, { error: { code: 'BOOM' } });
        }
        it.dispatch = 'delivered';
        it.localTaskKey = j.localTaskKey;
        cloud.acks.push({ id: m[1], localTaskKey: j.localTaskKey, status: 200 });
        return send(200, { ok: true, dispatchedAt: new Date().toISOString() });
      }
      m = p.match(/^\/api\/machine\/intents\/([^/]+)\/reject$/);
      if (m && rq.method === 'POST') {
        const it = cloud.intents.get(m[1]);
        if (!it) return send(404, { error: { code: 'NOT_FOUND' } });
        it.dispatch = 'rejected';
        it.rejectReason = j.reason;
        cloud.rejects.push({ id: m[1], reason: j.reason });
        return send(200, { ok: true });
      }
      send(404, { error: { code: 'NOT_FOUND', message: p } });
    });
  });
  return new Promise((res) => srv.listen(CLOUD_PORT, '127.0.0.1', () => res(srv)));
}

// ---- stub claude：只为验证 args/env，绝不真跑 claude ----
function writeStub() {
  fs.mkdirSync(STUB_DIR, { recursive: true });
  const dump = path.join(STUB_DIR, 'stub-claude.mjs');
  fs.writeFileSync(dump, `import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const OUT = path.join(import.meta.dirname, 'spawns.jsonl');
// collect.js 探测 \`claude --version\`（5s 超时）→ 必须秒回，否则看板 runtime 永远「检测中」
if (argv.includes('--version')) { console.log('2.1.207 (Claude Code)'); process.exit(0); }
// 会话模式（-p --input-format stream-json）：记下 args + 注入的 env，然后挂住（保持 processing 态）
if (argv.includes('--input-format')) {
  fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), argv,
    env: { SCRUMWS_TASK_KEY: process.env.SCRUMWS_TASK_KEY ?? null, SCRUMWS_API_BASE: process.env.SCRUMWS_API_BASE ?? null } }) + '\\n');
  process.stdin.resume();
  setInterval(() => { }, 1 << 30);
} else { process.exit(0); }   // 其它（如 -p /usage）：直接退，别让用量定时器等
`, 'utf8');
  fs.writeFileSync(path.join(STUB_DIR, 'claude.cmd'), `@echo off\r\nnode "%~dp0stub-claude.mjs" %*\r\n`, 'utf8');
  return dump;
}

/**
 * 收掉「孙子进程」stub claude。
 * ⚠ session-manager 在 Windows 走 shell:true → 进程链是 看板 → cmd.exe → node stub。中间那层 cmd.exe
 * 先退了的话，taskkill /T 从看板 PID 走不到 stub → 它活下来攥着沙箱 work 目录 → 下一轮 rmSync 报 EBUSY。
 * 判据是「命令行含**本沙箱的 stub 路径**」—— 那是本脚本自己写出来的文件，只可能是自己起的进程，
 * 绝不会误伤用户 8799 的 app 或别的 node（**绝不按进程名杀**）。
 */
function killStubStragglers() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${STUB_DIR}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' }); } catch { }
}

/** 沙箱清空：stub 攥着目录时 rmSync 会 EBUSY —— 先收 stub，再退让重试几轮 */
function resetSandbox() {
  killStubStragglers();
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); return; }
    catch (e) { if (i === 7) throw e; execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400'], { stdio: 'ignore' }); }
  }
}

const spawnsOf = () => {
  try {
    return fs.readFileSync(path.join(STUB_DIR, 'spawns.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};

// 设置本地下行两道闸（走设置页的真实端点，与 UI 同一条路）：
//   白名单 → /api/cloud/remote-config（与手机中继共用一份 cloudAllowedCwds）
//   自动执行档 → /api/cloud/dispatch-config（本期新增）
async function setConfig(cwds, mode) {
  const a = await req(APP_PORT, 'POST', '/api/cloud/remote-config', { cloudRemoteControl: false, cloudAllowedCwds: cwds });
  const b = await req(APP_PORT, 'POST', '/api/cloud/dispatch-config', { acceptAutoRun: mode });
  if (!a.json?.ok || !b.json?.ok) throw new Error(`配置失败：remote-config=${a.text} dispatch-config=${b.text}`);
}

// ---- --check：零副作用自检 ----
async function check() {
  log('== 零副作用自检 ==');
  let ok = true;
  for (const f of ['platform/standalone.js', 'platform/lib/cloud/connector.js', 'platform/lib/cloud/links.js',
    'platform/lib/cloud/cwd-allow.js', 'platform/lib/cloud/gate.js', 'platform/lib/cloud/completion-protocol.js']) {
    const e = fs.existsSync(path.join(REPO, f));
    log(`  ${e ? 'ok  ' : 'MISS'} ${f}`);
    if (!e) ok = false;
  }
  for (const p of [CLOUD_PORT, APP_PORT]) {
    const free = await portFree(p);
    log(`  ${free ? 'ok  ' : 'BUSY'} 端口 ${p} ${free ? '空闲' : '被占用（换端口或先收掉占用者）'}`);
    if (!free) ok = false;
  }
  let user = null;
  try { user = await req(USER_APP_PORT, 'GET', '/api/state'); } catch { }
  log(`  ${user?.status === 200 ? 'ok  ' : '注意'} 用户真实 app 8799：${user?.status === 200 ? 'HTTP 200（本脚本全程不碰它）' : '未在跑（本脚本也不会碰它）'}`);
  log(`  计划：沙箱数据根 ${SANDBOX}（--run 会先清空重建）`);
  log(`  计划：假云端 127.0.0.1:${CLOUD_PORT} / 沙箱看板 127.0.0.1:${APP_PORT} / stub claude 只进子进程 PATH`);
  log(`  收尾：taskkill /PID <本脚本起的看板 PID> /T /F（绝不按进程名杀）`);
  log(ok ? '自检通过，可以 --run' : '自检未通过');
  return ok ? 0 : 1;
}

// ---- --run ----
async function run() {
  if (!(await portFree(CLOUD_PORT)) || !(await portFree(APP_PORT))) {
    console.log(`端口 ${CLOUD_PORT}/${APP_PORT} 不空闲，先收掉占用者再跑`); return 1;
  }
  resetSandbox();
  fs.mkdirSync(CWD_ALLOWED, { recursive: true });
  fs.mkdirSync(CWD_EVIL, { recursive: true });
  writeStub();

  const cloudSrv = await startFakeCloud();
  log(`假云端已起：http://127.0.0.1:${CLOUD_PORT}`);

  const app = spawn(process.execPath, [path.join(REPO, 'platform', 'standalone.js')], {
    cwd: REPO, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SCRUMWS_DATA_ROOT: SANDBOX, SCRUMWS_PORT: String(APP_PORT),
      PATH: `${STUB_DIR}${path.delimiter}${process.env.PATH}` },
  });
  const appOut = [];
  app.stdout.on('data', (d) => appOut.push(String(d)));
  app.stderr.on('data', (d) => appOut.push(String(d)));
  log(`沙箱看板已起：pid=${app.pid} port=${APP_PORT} dataRoot=${SANDBOX}`);

  try {
    await waitFor('沙箱看板就绪', async () => (await req(APP_PORT, 'GET', '/api/state')).status === 200, 30000);

    // ---- S0：enroll（假云端返回 ownerUserId）→ 立刻一轮 tick ----
    const en = await req(APP_PORT, 'POST', '/api/cloud/enroll',
      { cloudUrl: `http://127.0.0.1:${CLOUD_PORT}`, registrationKey: 'swrk_sandbox', code: 'SANDBOX1' });
    if (!en.json?.ok) throw new Error(`enroll 失败：${en.text}`);
    const idFile = readJson(path.join(SANDBOX, 'runtime', 'cloud', 'identity.json'));
    if (idFile?.ownerUserId === OWNER_USER) pass('S0 enroll 落 ownerUserId（owner-only 闸门的判据）', `identity.json ownerUserId=${idFile.ownerUserId}`);
    else fail('S0 enroll 落 ownerUserId', `identity.json ownerUserId=${idFile?.ownerUserId}`);

    // ---- R1：白名单默认空 → 一切云端任务被 reject（最硬的防线）----
    addIntent({ intentId: 'i-nowhitelist', cwd: CWD_ALLOWED, autoRun: true, createdBy: OWNER_USER });
    await waitFor('R1 reject', () => cloud.rejects.find((r) => r.id === 'i-nowhitelist'));
    const r1 = cloud.rejects.find((r) => r.id === 'i-nowhitelist');
    const r1NoTask = Object.keys(links()).length === 0 && taskDirs().length === 0;
    if (r1 && r1NoTask && /白名单/.test(r1.reason)) pass('R1 白名单默认空 → 云端任务被拒收，且本地零任务零 link', `reject reason="${r1.reason}" · links={} · runner-state=[]`);
    else fail('R1 白名单默认空 → 拒收', `reject=${JSON.stringify(r1)} links=${JSON.stringify(links())} dirs=${JSON.stringify(taskDirs())}`);

    // ---- 配白名单 + owner-only（走设置页那两条路）----
    await setConfig([CWD_ALLOWED], 'owner-only');
    log(`  已配白名单：${CWD_ALLOWED} · acceptAutoRun=owner-only`);

    // ---- R2 + R3：白名单边界 + 闸门 owner-only 三种输入（同一 owner-only 配置，一批喂 ）----
    addIntent({ intentId: 'i-evilcwd', cwd: CWD_EVIL, autoRun: true, createdBy: OWNER_USER });          // 白名单外
    addIntent({ intentId: 'i-own-auto', cwd: CWD_ALLOWED, autoRun: true, createdBy: OWNER_USER });      // 自己派 + auto
    addIntent({ intentId: 'i-other-auto', cwd: CWD_ALLOWED, autoRun: true, createdBy: OTHER_USER });    // 别人派 + auto
    addIntent({ intentId: 'i-own-noauto', cwd: CWD_ALLOWED, autoRun: false, createdBy: OWNER_USER });   // 自己派 + 没勾
    cloud.failAckOnce.add('i-idem');                                                                     // R4 一并喂
    addIntent({ intentId: 'i-idem', cwd: CWD_ALLOWED, autoRun: false, createdBy: OWNER_USER });
    await waitFor('R2 reject', () => cloud.rejects.find((r) => r.id === 'i-evilcwd'));
    const r2 = cloud.rejects.find((r) => r.id === 'i-evilcwd');
    if (r2 && !links()['i-evilcwd']) pass('R2 白名单外的 cwd 被拒（work-evil 与白名单 work 前缀相邻，未被误放行）', `reject reason="${r2.reason}"`);
    else fail('R2 白名单外的 cwd 被拒', `reject=${JSON.stringify(r2)}`);

    await waitFor('R3 三条 ack', () => ['i-own-auto', 'i-other-auto', 'i-own-noauto']
      .every((i) => cloud.acks.find((a) => a.id === i && a.status === 200)));
    const sOwnAuto = taskState(links()['i-own-auto']?.taskKey)?.state;
    const sOtherAuto = taskState(links()['i-other-auto']?.taskKey)?.state;
    const sOwnNoauto = taskState(links()['i-own-noauto']?.taskKey)?.state;
    if (sOwnAuto && sOwnAuto !== 'plan') pass('R3a owner-only + 自己派 + autoRun → 直接跑（不落 plan）', `${links()['i-own-auto'].taskKey} state=${sOwnAuto}`);
    else fail('R3a owner-only + 自己派 → 直接跑', `state=${sOwnAuto}`);
    if (sOtherAuto === 'plan') pass('R3b owner-only + 别人派 + autoRun → 落 plan 等人确认', `${links()['i-other-auto'].taskKey} state=plan`);
    else fail('R3b owner-only + 别人派 → 落 plan', `state=${sOtherAuto}`);
    if (sOwnNoauto === 'plan') pass('R3c 云端没勾 autoRun → 一票否决，落 plan', `${links()['i-own-noauto'].taskKey} state=plan`);
    else fail('R3c 没勾 autoRun → 落 plan', `state=${sOwnNoauto}`);

    // ---- R4：幂等（ack 响应丢包 → 下轮凭 link 重 ack，绝不建第二个任务）----
    await waitFor('R4 首次 ack（被丢包）', () => cloud.acks.find((a) => a.id === 'i-idem' && a.status === 500));
    const dirsAfter1 = taskDirs().length;
    await waitFor('R4 重 ack', () => cloud.acks.find((a) => a.id === 'i-idem' && a.status === 200));
    const idemAcks = cloud.acks.filter((a) => a.id === 'i-idem');
    const sameKey = new Set(idemAcks.map((a) => a.localTaskKey)).size === 1;
    const dirsAfter2 = taskDirs().length;
    if (sameKey && dirsAfter2 === dirsAfter1) pass('R4 同一 intentId 拉两次 → 只建一个任务、凭 link 重 ack（幂等）', `ack×${idemAcks.length}（500→200）localTaskKey 恒为 ${idemAcks[0].localTaskKey} · 任务目录数 ${dirsAfter1}→${dirsAfter2}`);
    else fail('R4 幂等', `acks=${JSON.stringify(idemAcks)} dirs ${dirsAfter1}→${dirsAfter2}`);

    // ---- R5：闸门 off → 自己派的 autoRun 也落 plan ----
    await setConfig([CWD_ALLOWED], 'off');
    addIntent({ intentId: 'i-off', cwd: CWD_ALLOWED, autoRun: true, createdBy: OWNER_USER });
    await waitFor('R5 ack', () => cloud.acks.find((a) => a.id === 'i-off' && a.status === 200));
    const sOff = taskState(links()['i-off']?.taskKey)?.state;
    if (sOff === 'plan') pass('R5 闸门 off → 自己派的 autoRun 也落 plan', `${links()['i-off'].taskKey} state=plan`);
    else fail('R5 闸门 off → 落 plan', `state=${sOff}`);

    // ---- R6：闸门 on → 别人派的 autoRun 也直接跑 ----
    await setConfig([CWD_ALLOWED], 'on');
    addIntent({ intentId: 'i-on', cwd: CWD_ALLOWED, autoRun: true, createdBy: OTHER_USER });
    await waitFor('R6 ack', () => cloud.acks.find((a) => a.id === 'i-on' && a.status === 200));
    const sOn = taskState(links()['i-on']?.taskKey)?.state;
    if (sOn && sOn !== 'plan') pass('R6 闸门 on → 别人派的 autoRun 直接跑', `${links()['i-on'].taskKey} state=${sOn}`);
    else fail('R6 闸门 on → 直接跑', `state=${sOn}`);

    // ---- R7：完成协议只追加给云端任务；本地手敲任务不带（P1 零回归）----
    // /api/task/create 有同源守卫（2026-07-18 收口，server.js:445）：必带指向本服务的 Origin，否则 403（走看板页面那条路）
    const man = await req(APP_PORT, 'POST', '/api/task/create',
      { source: 'manual', title: '本机手敲的活', prompt: '这条不该带完成协议', plan: true, cwd: CWD_ALLOWED },
      { Origin: `http://127.0.0.1:${APP_PORT}` });
    const manKey = man.json?.taskKey;
    if (!manKey) throw new Error(`建本地任务失败：${man.text}`);
    const cloudPrompt = taskJson(links()['i-on']?.taskKey)?.prompt || '';
    const manPrompt = taskJson(manKey)?.prompt || '';
    if (/任务完成协议 · 由看板注入/.test(cloudPrompt) && /resolvedBy=agent/.test(cloudPrompt) && !/任务完成协议/.test(manPrompt)) {
      pass('R7 完成协议只追加在云端任务的 prompt 尾，本地手建任务不带（P1 零回归）',
        `cloud task prompt 含完成协议（${cloudPrompt.length} 字符）；manual task prompt="${manPrompt}"`);
    } else fail('R7 完成协议只给云端任务', `cloudPrompt含=${/任务完成协议/.test(cloudPrompt)} manPrompt="${manPrompt}"`);

    // ---- R8：决策 15 的两处注入（stub claude 记下的真实 argv/env）----
    const sp = spawnsOf();
    const withTool = sp.filter((s) => {
      const i = s.argv.indexOf('--disallowedTools');
      return i >= 0 && s.argv[i + 1] === 'AskUserQuestion' && s.argv.includes('--dangerously-skip-permissions');
    });
    if (sp.length && withTool.length === sp.length) {
      pass('R8a --disallowedTools AskUserQuestion 真在 args 里（且与 --dangerously-skip-permissions 同挂 bypass）',
        `${sp.length}/${sp.length} 次 spawn 命中 · argv 片段：${JSON.stringify(sp[0].argv.slice(0, 12))}`);
    } else fail('R8a --disallowedTools 在 args 里', `spawn=${sp.length} 命中=${withTool.length} argv=${JSON.stringify(sp[0]?.argv)}`);
    const envOk = sp.filter((s) => s.env.SCRUMWS_TASK_KEY && s.env.SCRUMWS_API_BASE === `http://127.0.0.1:${APP_PORT}`);
    if (sp.length && envOk.length === sp.length) {
      pass('R8b agent 靠 env 知道自己的 taskKey 与本机端点（SCRUMWS_TASK_KEY / SCRUMWS_API_BASE）',
        `${envOk.length}/${sp.length} 次 spawn 命中 · env=${JSON.stringify(sp[0].env)}`);
    } else fail('R8b env 注入', `spawn=${sp.length} 命中=${envOk.length} env=${JSON.stringify(sp[0]?.env)}`);

    // ---- R9：agent 声明完成（awaiting-human → done, by=agent），状态机未变 ----
    const victim = links()['i-other-auto']?.taskKey;   // plan 态任务，手动摆到 awaiting-human
    const vf = path.join(SANDBOX, 'runtime', 'runner-state', victim.replace(/:/g, '__'), 'state.json');
    const vs = readJson(vf);
    fs.writeFileSync(vf, JSON.stringify({ ...vs, state: 'awaiting-human', history: [...(vs.history || [])] }, null, 2));
    const done = await req(APP_PORT, 'POST', `/api/task/complete?taskKey=${encodeURIComponent(victim)}&resolvedBy=agent`);
    const after = readJson(vf);
    const lastBy = after?.history?.[after.history.length - 1]?.by;
    if (done.json?.ok && after.state === 'done' && lastBy === 'agent' && after.outcomeDetail?.resolvedBy === 'agent') {
      pass('R9 agent 显式声明完成：awaiting-human → done，by/resolvedBy 记 agent（状态机未变）',
        `${victim} state=done history.by=agent outcomeDetail.resolvedBy=agent`);
    } else fail('R9 agent 声明完成', `resp=${done.text} state=${after?.state} by=${lastBy} resolvedBy=${after?.outcomeDetail?.resolvedBy}`);
    // 同端点不带 resolvedBy → 仍记 user（既有行为零回归）
    const victim2 = links()['i-own-noauto']?.taskKey;
    const vf2 = path.join(SANDBOX, 'runtime', 'runner-state', victim2.replace(/:/g, '__'), 'state.json');
    const vs2 = readJson(vf2);
    fs.writeFileSync(vf2, JSON.stringify({ ...vs2, state: 'awaiting-human' }, null, 2));
    await req(APP_PORT, 'POST', `/api/task/complete?taskKey=${encodeURIComponent(victim2)}`);
    const after2 = readJson(vf2);
    const lastBy2 = after2?.history?.[after2.history.length - 1]?.by;
    if (after2.state === 'done' && lastBy2 === 'user' && after2.outcomeDetail?.resolvedBy === 'user') {
      pass('R9b 不带 resolvedBy → 仍记 user（人工确认路径零回归）', `${victim2} history.by=user resolvedBy=user`);
    } else fail('R9b 缺省仍记 user', `state=${after2?.state} by=${lastBy2}`);

    // ---- R10：门铃 —— 所有意图已 delivered/rejected（pendingIntents=0）时，connector 跳过 GET intents ----
    if (pendingCount() === 0) {
      const getsBefore = cloud.intentGets;
      await sleep(TICK_MS * 2 + 3000);   // 等两轮 tick：心跳照打，但门铃应把 GET intents 挡住
      const delta = cloud.intentGets - getsBefore;
      if (delta === 0) pass('R10 取件门铃：pendingIntents=0 时 connector 跳过 GET /api/machine/intents（idle 省一次请求）', `等 2 轮 tick 内 GET intents 增量=${delta}`);
      else fail('R10 门铃跳过', `等 2 轮内 GET intents 增量=${delta}（应为 0）`);
    } else {
      fail('R10 门铃跳过', `前置不满足：仍有 ${pendingCount()} 条 pending`);
    }
  } catch (e) {
    fail('执行中断', e.message);
    log(`  看板输出片段：${appOut.join('').split('\n').slice(-8).join(' | ')}`);
  } finally {
    // 只按自己起的 PID 收（/T 连带 cmd.exe 子进程）；绝不按进程名/路径杀
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { }
    killStubStragglers();   // 兜住 taskkill /T 走不到的孙子进程（见函数头注）
    cloudSrv.close();
    await sleep(600);
    let user = null;
    try { user = await req(USER_APP_PORT, 'GET', '/api/state'); } catch { }
    log(`\n用户真实 app 8799 收尾探活：HTTP ${user?.status ?? '(无响应)'}`);
    const sandboxDead = await portFree(APP_PORT);
    log(`沙箱看板 ${APP_PORT} 已收：${sandboxDead ? '是' : '否（残留！）'}`);
  }

  const bad = results.filter((r) => !r.ok);
  log(`\n== ${results.length - bad.length}/${results.length} PASS ==`);
  return bad.length ? 1 : 0;
}

const mode = process.argv[2];
if (mode === '--check') process.exit(await check());
else if (mode === '--run') process.exit(await run());
else { console.log('用法：node verify-local-dispatch.mjs --check | --run'); process.exit(2); }
