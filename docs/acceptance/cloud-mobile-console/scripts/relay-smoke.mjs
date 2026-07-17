// 云端中继协议冒烟（SG2 交付验证；SG5 端到端复用）—— 只打云端 API，机器侧用假 connector 模拟。
// 覆盖 spec §4.1–§4.4 契约：downlink 建连/顶替/断开清理、rpc 全部状态码（200/400/404/502/503/504）、
// watch 双向转发与收尾、owner 隔离 404、绊线 503。
//
// 用法（服务已起、bootstrap 已跑）：
//   node relay-smoke.mjs --base http://127.0.0.1:18790 --key <swuk_owner> [--key2 <swuk_另一用户>]
//   node relay-smoke.mjs --base ... --expect-blocked   # 绊线生效姿态：下行面全 503、上行面不受封
//   node relay-smoke.mjs --base ... --expect-open      # 绊线放行姿态：下行面回归鉴权 401
//
// 零依赖：只用 Node >=20 全局 fetch / crypto。凭据只经命令行入参，不落文件。
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    base: { type: 'string' },
    key: { type: 'string' },
    key2: { type: 'string' },
    'expect-blocked': { type: 'boolean', default: false },
    'expect-open': { type: 'boolean', default: false },
  },
});
if (!opt.base) { console.error('缺 --base'); process.exit(2); }
const BASE = opt.base.replace(/\/$/, '');

// ---------- 断言与 HTTP 小工具 ----------
let passed = 0;
const failed = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed.push(name); console.error(`  FAIL ${name}  ${detail ?? ''}`); }
}

async function api(method, path, { cookie, bearer, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE/非 JSON 响应体留 null */ }
  return { status: res.status, json, text };
}
const errCode = (r) => r.json?.error?.code;

// ---------- SSE 客户端（fetch 流式读，解析 event/data/注释帧） ----------
async function openSse(path, headers) {
  const ac = new AbortController();
  const res = await fetch(BASE + path, { headers, signal: ac.signal });
  if (res.status !== 200) {
    ac.abort();
    return { status: res.status, json: JSON.parse(await res.text()) };
  }
  const queue = [];
  const waiters = [];
  const push = (ev) => { const w = waiters.shift(); if (w) w(ev); else queue.push(ev); };
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = { event: 'comment', data: null };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) ev.data = line.slice(5).trim();
          }
          push(ev);
        }
      }
    } catch { /* abort / 服务端关流 */ }
    push({ event: '__closed__', data: null });
  })();
  return {
    status: 200,
    next: (timeoutMs) => new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift());
      const t = setTimeout(() => reject(new Error('等 SSE 事件超时')), timeoutMs);
      waiters.push((ev) => { clearTimeout(t); resolve(ev); });
    }),
    close: () => ac.abort(),
  };
}
/** 等指定事件（跳过 ping / 注释帧）；流关了就抛。 */
async function nextEvent(sse, name, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ev = await sse.next(Math.max(1, deadline - Date.now()));
    if (ev.event === name) return { ...ev, json: ev.data ? JSON.parse(ev.data) : null };
    if (ev.event === '__closed__') throw new Error(`等 ${name} 时流已关闭`);
  }
}
async function waitClosed(sse, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ev = await sse.next(Math.max(1, deadline - Date.now()));
    if (ev.event === '__closed__') return true;
  }
}

// ---------- 前置动作 ----------
// 登录要拿 set-cookie，单独走原生 fetch（api() 不透出响应头）
async function loginCookie(swuk) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: swuk }),
  });
  if (res.status !== 200) throw new Error(`登录失败 HTTP ${res.status} ${await res.text()}`);
  const m = /swsession=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('登录响应没有 swsession cookie');
  return `swsession=${m[1]}`;
}

async function enrollMachine(cookie, name) {
  const rk = await api('POST', '/api/registration-keys', { cookie, body: { label: name } });
  if (rk.status !== 201) throw new Error(`生成 rk 失败 HTTP ${rk.status}`);
  const code = await api('POST', '/api/machines/enrollment-codes', { cookie });
  if (code.status !== 201) throw new Error(`生成配对码失败 HTTP ${code.status}`);
  const en = await api('POST', '/api/machine/enroll', {
    body: {
      registrationKey: rk.json.key, code: code.json.code,
      machineUid: crypto.randomUUID(), displayName: name,
      hostname: `${name}-host`, platform: 'win32', arch: 'x64', appVersion: '0.0.0-smoke',
    },
  });
  if (en.status !== 201) throw new Error(`enroll 失败 HTTP ${en.status} ${en.text}`);
  return { machineId: en.json.machineId, token: en.json.token };
}

// ============================================================
// 绊线姿态专项（--expect-blocked / --expect-open）：不需要任何凭据 ——
// 闸门在鉴权之前判，无凭据请求也必须拿到一致答案。
// ============================================================
const FAKE_UUID = crypto.randomUUID();
if (opt['expect-blocked'] || opt['expect-open']) {
  const downPlane = [
    ['GET', '/api/my/machines'],
    ['POST', `/api/my/machines/${FAKE_UUID}/rpc`, { verb: 'state' }],
    ['GET', `/api/my/machines/${FAKE_UUID}/watch?taskKey=x`],
    ['GET', '/api/machine/downlink'],
    ['POST', `/api/machine/rpc/${FAKE_UUID}/result`, { ok: true }],
    ['POST', `/api/machine/watch/${FAKE_UUID}/frames`, { frames: [] }],
  ];
  if (opt['expect-blocked']) {
    console.log('== 绊线生效姿态：下行面全 503 PLAINTEXT_DISPATCH_BLOCKED ==');
    for (const [method, path, body] of downPlane) {
      const r = await api(method, path, body ? { body } : {});
      check(`绊线 503 ${method} ${path.split('?')[0]}`,
        r.status === 503 && errCode(r) === 'PLAINTEXT_DISPATCH_BLOCKED', `HTTP ${r.status} ${r.text}`);
    }
    const health = await api('GET', '/api/health');
    check('上行面不受封：/api/health 200', health.status === 200, `HTTP ${health.status}`);
    const lg = await api('POST', '/api/auth/login', { body: { key: 'swuk_bogus' } });
    check('上行面不受封：login 走正常 401', lg.status === 401, `HTTP ${lg.status}`);
  } else {
    console.log('== 绊线放行姿态（ACCEPT=1）：下行面回归正常鉴权 ==');
    for (const [method, path, body] of downPlane) {
      const r = await api(method, path, body ? { body } : {});
      check(`放行后回归鉴权 401 ${method} ${path.split('?')[0]}`, r.status === 401, `HTTP ${r.status} ${r.text}`);
    }
  }
  summary();
}

// ============================================================
// 主冒烟
// ============================================================
if (!opt.key) { console.error('缺 --key（owner 的 swuk_）'); process.exit(2); }

console.log('== 阶段 A：前置 + 无 downlink 的负例 ==');
const cookie = await loginCookie(opt.key);
const { machineId, token: swmt } = await enrollMachine(cookie, 'relay-smoke-a');
console.log(`  enroll 完成 machineId=${machineId}`);

{
  const r = await api('GET', '/api/my/machines', { cookie });
  const m = r.json?.machines?.find((x) => x.id === machineId);
  check('A1 /api/my/machines 列出本人机器', r.status === 200 && !!m, `HTTP ${r.status} ${r.text}`);
  check('A2 未建 downlink 时 relayOnline=false', m?.relayOnline === false, JSON.stringify(m));
  check('A3 响应带 status/lastSeenAt/load 字段', m && 'status' in m && 'lastSeenAt' in m && 'load' in m && 'cap' in (m.load ?? {}), JSON.stringify(m));
}
{
  const r = await api('POST', `/api/my/machines/${machineId}/rpc`, { cookie, body: { verb: 'state' } });
  check('A4 无 downlink → rpc 503 MACHINE_OFFLINE', r.status === 503 && errCode(r) === 'MACHINE_OFFLINE', `HTTP ${r.status} ${r.text}`);
  const w = await api('GET', `/api/my/machines/${machineId}/watch?taskKey=manual:x`, { cookie });
  check('A5 无 downlink → watch 503 MACHINE_OFFLINE', w.status === 503 && errCode(w) === 'MACHINE_OFFLINE', `HTTP ${w.status} ${w.text}`);
}

console.log('== 阶段 B：downlink 在场的主链路 ==');
const dl1 = await openSse('/api/machine/downlink', { authorization: `Bearer ${swmt}` });
check('B0 downlink 建连 200', dl1.status === 200, `HTTP ${dl1.status}`);
await nextEvent(dl1, 'comment', 3000).catch(() => {}); // 首帧注释（downlink established），没有也不算错

{
  const r = await api('GET', '/api/my/machines', { cookie });
  check('B1 downlink 在场 → relayOnline=true', r.json?.machines?.find((x) => x.id === machineId)?.relayOnline === true, r.text);
}
{
  // B2 rpc 快乐路径：浏览器发 rpc → downlink 收 rpc 事件 → 机器回 result → 浏览器拿 200+data
  const rpcP = api('POST', `/api/my/machines/${machineId}/rpc`, { cookie, body: { verb: 'state', args: { maxAgeMs: 3000 } } });
  const ev = await nextEvent(dl1, 'rpc');
  check('B2a downlink 收到 rpc 事件（verb/args 原样）', ev.json?.verb === 'state' && ev.json?.args?.maxAgeMs === 3000 && !!ev.json?.rpcId, ev.data);
  const post = await api('POST', `/api/machine/rpc/${ev.json.rpcId}/result`, { bearer: swmt, body: { ok: true, data: { buckets: { processing: 1 } } } });
  check('B2b result 上行 200', post.status === 200, `HTTP ${post.status} ${post.text}`);
  const rpc = await rpcP;
  check('B2c rpc 响应 200 带 data', rpc.status === 200 && rpc.json?.ok === true && rpc.json?.data?.buckets?.processing === 1, `HTTP ${rpc.status} ${rpc.text}`);
}
{
  const r = await api('POST', `/api/my/machines/${machineId}/rpc`, { cookie, body: { verb: 'shellExec', args: {} } });
  check('B3 非白名单 verb → 400 BAD_REQUEST', r.status === 400 && errCode(r) === 'BAD_REQUEST', `HTTP ${r.status} ${r.text}`);
}
{
  // B4 本地拒绝：ok:false → 502 RELAY_FAILED 且 message 透传
  const rpcP = api('POST', `/api/my/machines/${machineId}/rpc`, { cookie, body: { verb: 'createTask', args: { cwd: 'D:/evil' } } });
  const ev = await nextEvent(dl1, 'rpc');
  await api('POST', `/api/machine/rpc/${ev.json.rpcId}/result`, { bearer: swmt, body: { ok: false, error: '白名单外的 cwd' } });
  const rpc = await rpcP;
  check('B4 ok:false → 502 RELAY_FAILED 透传原因', rpc.status === 502 && errCode(rpc) === 'RELAY_FAILED' && rpc.json?.error?.message === '白名单外的 cwd', `HTTP ${rpc.status} ${rpc.text}`);
}
{
  const r = await api('POST', `/api/machine/rpc/${FAKE_UUID}/result`, { bearer: swmt, body: { ok: true, data: {} } });
  check('B5 未知 rpcId → 404', r.status === 404 && errCode(r) === 'NOT_FOUND', `HTTP ${r.status} ${r.text}`);
  const w = await api('POST', `/api/machine/watch/${FAKE_UUID}/frames`, { bearer: swmt, body: { frames: [] } });
  check('B6 未知 watchId → 404', w.status === 404 && errCode(w) === 'NOT_FOUND', `HTTP ${w.status} ${w.text}`);
}
{
  // B7 watch 快乐路径 + 浏览器断开 → watch_stop
  const w1 = await openSse(`/api/my/machines/${machineId}/watch?taskKey=manual:0001`, { cookie });
  check('B7a watch SSE 建连 200', w1.status === 200, `HTTP ${w1.status}`);
  const ws = await nextEvent(dl1, 'watch_start');
  check('B7b downlink 收到 watch_start(taskKey)', ws.json?.taskKey === 'manual:0001' && !!ws.json?.watchId, ws.data);
  const fr = await api('POST', `/api/machine/watch/${ws.json.watchId}/frames`, { bearer: swmt, body: { frames: [{ kind: 'worker-log', total: 3 }], done: false } });
  check('B7c 帧上行 200', fr.status === 200, `HTTP ${fr.status} ${fr.text}`);
  const got = await nextEvent(w1, 'frames');
  check('B7d 浏览器收到帧（原样转发）', got.json?.frames?.[0]?.total === 3 && got.json?.done === false, got.data);
  w1.close(); // 浏览器断开
  const stop = await nextEvent(dl1, 'watch_stop');
  check('B7e 浏览器断开 → downlink 收 watch_stop', stop.json?.watchId === ws.json.watchId, stop.data);
}
{
  // B8 done=true 收尾：浏览器收 done 帧、流被云端关闭、watchId 随即失效
  const w2 = await openSse(`/api/my/machines/${machineId}/watch?taskKey=manual:0002`, { cookie });
  const ws = await nextEvent(dl1, 'watch_start');
  await api('POST', `/api/machine/watch/${ws.json.watchId}/frames`, { bearer: swmt, body: { frames: [{ kind: 'worker-log', total: 9 }], done: true } });
  const got = await nextEvent(w2, 'frames');
  check('B8a 浏览器收到 done:true 终帧', got.json?.done === true, got.data);
  check('B8b done 后云端关闭浏览器流', await waitClosed(w2).catch(() => false), '流未关闭');
  const again = await api('POST', `/api/machine/watch/${ws.json.watchId}/frames`, { bearer: swmt, body: { frames: [] } });
  check('B8c done 后 watchId 失效 → 404', again.status === 404, `HTTP ${again.status}`);
}
{
  // B9 超时：机器不交差 → 10s 后 504；等待期间别的机器拿这个 rpcId 交差 → 404（machineId 核对）
  const { token: swmtB } = await enrollMachine(cookie, 'relay-smoke-b'); // 第二台机器，不建 downlink
  const t0 = Date.now();
  const rpcP = api('POST', `/api/my/machines/${machineId}/rpc`, { cookie, body: { verb: 'state' } });
  const ev = await nextEvent(dl1, 'rpc');
  const steal = await api('POST', `/api/machine/rpc/${ev.json.rpcId}/result`, { bearer: swmtB, body: { ok: true, data: {} } });
  check('B9a 别的机器交差 → 404（rpcId 按 machineId 核对）', steal.status === 404, `HTTP ${steal.status}`);
  const rpc = await rpcP;
  const dt = Date.now() - t0;
  check('B9b 10s 无响应 → 504 RELAY_TIMEOUT', rpc.status === 504 && errCode(rpc) === 'RELAY_TIMEOUT', `HTTP ${rpc.status} ${rpc.text}`);
  check('B9c 超时耗时 ≈10s', dt >= 9500 && dt < 13000, `${dt}ms`);
  const late = await api('POST', `/api/machine/rpc/${ev.json.rpcId}/result`, { bearer: swmt, body: { ok: true, data: {} } });
  check('B9d 超时后迟到的 result → 404', late.status === 404, `HTTP ${late.status}`);
}

console.log('== 阶段 C：顶替与断开清理 ==');
const dl2 = await openSse('/api/machine/downlink', { authorization: `Bearer ${swmt}` });
{
  check('C1a 同机重复建连 → 旧连接被服务端关闭', await waitClosed(dl1).catch(() => false), 'dl1 未被关闭');
  const r = await api('GET', '/api/my/machines', { cookie });
  check('C1b 顶替后 relayOnline 仍 true', r.json?.machines?.find((x) => x.id === machineId)?.relayOnline === true, r.text);
  const rpcP = api('POST', `/api/my/machines/${machineId}/rpc`, { cookie, body: { verb: 'cwds' } });
  const ev = await nextEvent(dl2, 'rpc');
  await api('POST', `/api/machine/rpc/${ev.json.rpcId}/result`, { bearer: swmt, body: { ok: true, data: { cwds: [] } } });
  const rpc = await rpcP;
  check('C1c rpc 经新连接照常工作', rpc.status === 200 && rpc.json?.ok === true, `HTTP ${rpc.status} ${rpc.text}`);
}
{
  // C2 断开清理：挂一路 watch + 一条在途 rpc，断掉 downlink →
  //    rpc 立即 503（不等 10s）、watch 收 done 终帧后关流、relayOnline=false
  const w3 = await openSse(`/api/my/machines/${machineId}/watch?taskKey=manual:0003`, { cookie });
  await nextEvent(dl2, 'watch_start');
  const rpcP = api('POST', `/api/my/machines/${machineId}/rpc`, { cookie, body: { verb: 'state' } });
  await nextEvent(dl2, 'rpc');
  const t0 = Date.now();
  dl2.close(); // 机器侧断开
  const rpc = await rpcP;
  check('C2a downlink 断开 → 在途 rpc 立即 503 MACHINE_OFFLINE', rpc.status === 503 && errCode(rpc) === 'MACHINE_OFFLINE' && Date.now() - t0 < 3000, `HTTP ${rpc.status} 耗时${Date.now() - t0}ms`);
  const fin = await nextEvent(w3, 'frames');
  check('C2b watch 浏览器侧收 done 终帧', fin.json?.done === true && fin.json?.frames?.length === 0, fin.data);
  check('C2c watch 流随之关闭', await waitClosed(w3).catch(() => false), '流未关闭');
  const r = await api('GET', '/api/my/machines', { cookie });
  check('C2d 断开后 relayOnline=false', r.json?.machines?.find((x) => x.id === machineId)?.relayOnline === false, r.text);
}

if (opt.key2) {
  console.log('== 阶段 D：owner 隔离（第二用户） ==');
  const cookie2 = await loginCookie(opt.key2);
  const r = await api('GET', '/api/my/machines', { cookie: cookie2 });
  check('D1 非 owner 列表不含他人机器', r.status === 200 && !r.json.machines.some((x) => x.id === machineId), r.text);
  const rpc = await api('POST', `/api/my/machines/${machineId}/rpc`, { cookie: cookie2, body: { verb: 'state' } });
  check('D2 非 owner rpc → 404（不泄露存在性）', rpc.status === 404 && errCode(rpc) === 'NOT_FOUND', `HTTP ${rpc.status} ${rpc.text}`);
  const w = await api('GET', `/api/my/machines/${machineId}/watch?taskKey=manual:x`, { cookie: cookie2 });
  check('D3 非 owner watch → 404', w.status === 404 && errCode(w) === 'NOT_FOUND', `HTTP ${w.status} ${w.text}`);
} else {
  console.log('== 阶段 D 跳过（未给 --key2）==');
}

summary();

function summary() {
  console.log(`\n结果：PASS ${passed} / FAIL ${failed.length}${failed.length ? '  → ' + failed.join(', ') : ''}`);
  process.exit(failed.length ? 1 : 0);
}
