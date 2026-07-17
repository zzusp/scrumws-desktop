import http from 'node:http';
import crypto from 'node:crypto';

// 中继冒烟用 stub 云端（SG3 本地侧联调 / SG5 复用）：只演云端的「机器侧」半边——
//   GET  /api/machine/downlink            SSE 下行（同机重复建连 = 顶掉旧连接）
//   POST /api/machine/rpc/:id/result      收 rpc 结果（未知 id → 404）
//   POST /api/machine/watch/:id/frames    收 watch 帧（未知 id → 404）
//   POST /api/machine/heartbeat|tasks/digest|tasks/upsert   connector 常规上报的 200 桩
// 并额外开一组 /stub/* 控制端点给测试驱动（curl 即可全程操控）：
//   POST /stub/rpc {verb,args}      → 经 downlink 下发 rpc，同步等结果（10s 超时 → 504）
//   POST /stub/watch-start {taskKey}→ 下发 watch_start，返回 {watchId}
//   POST /stub/watch-stop {watchId} → 下发 watch_stop
//   GET  /stub/frames?watchId=…     → 已收帧 {taskKey, done, frames:[{at, body}]}
//   GET  /stub/status               → {downlinkConnected, lastAuth, pendingRpc, watches}
// 用法：node relay-stub-cloud.js --port 18790

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return Number(i >= 0 ? process.argv[i + 1] : process.env.STUB_PORT) || 18790;
})();

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);

let downlink = null;        // 当前 SSE 连接的 res（同机重复建连 = 顶掉旧的）
let lastAuth = null;
let pingTimer = null;
const pendingRpc = new Map();   // rpcId → {resolve, timer}
const watches = new Map();      // watchId → {taskKey, frames:[{at, body}], done}

function sendEvent(name, data) {
  if (!downlink) return false;
  try { downlink.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); return true; }
  catch { return false; }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 32 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve(null); } });
  });
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');

  // ---- 机器侧契约面 ----
  if (pathname === '/api/machine/downlink') {
    lastAuth = req.headers.authorization || null;
    if (downlink) { log('downlink: 新连接顶掉旧连接'); try { downlink.end(); } catch { /* 已断 */ } }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    downlink = res;
    log(`downlink: 已连接（auth=${lastAuth ? lastAuth.slice(0, 18) + '…' : '无'}）`);
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => sendEvent('ping', {}), 20000);
    req.on('close', () => {
      if (downlink === res) { downlink = null; log('downlink: 连接断开'); }
    });
    return;
  }
  if (req.method === 'POST' && /^\/api\/machine\/rpc\/[^/]+\/result$/.test(pathname)) {
    const rpcId = decodeURIComponent(pathname.split('/')[4]);
    const body = await readBody(req);
    const p = pendingRpc.get(rpcId);
    if (!p) { log(`rpc-result: 未知 rpcId=${rpcId}（迟到/顶替后的响应）→ 404`); return json(res, 404, { error: 'unknown rpcId' }); }
    pendingRpc.delete(rpcId);
    clearTimeout(p.timer);
    log(`rpc-result: ${rpcId} ok=${body?.ok} ${body?.ok ? '' : `error=${body?.error}`}`);
    p.resolve(body);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && /^\/api\/machine\/watch\/[^/]+\/frames$/.test(pathname)) {
    const watchId = decodeURIComponent(pathname.split('/')[4]);
    const body = await readBody(req);
    const w = watches.get(watchId);
    if (!w) { log(`frames: 未知 watchId=${watchId} → 404`); return json(res, 404, { error: 'unknown watchId' }); }
    w.frames.push({ at: new Date().toISOString(), body });
    if (body?.done) w.done = true;
    log(`frames: ${watchId} +${(body?.frames || []).length} 帧 done=${!!body?.done}（帧内块数=${(body?.frames || []).map((f) => (f.blocks || []).length).join(',')}）`);
    return json(res, 200, { ok: true });
  }
  // connector 常规上报（心跳 / 对账）：200 桩，让 connector 保持绿灯继续 tick
  if (req.method === 'POST' && pathname === '/api/machine/heartbeat') { await readBody(req); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && pathname === '/api/machine/tasks/digest') { await readBody(req); return json(res, 200, { needFull: [], markedMissing: 0 }); }
  if (req.method === 'POST' && pathname === '/api/machine/tasks/upsert') { const b = await readBody(req); return json(res, 200, { results: (b?.tasks || []).map((t) => ({ taskKey: t.taskKey, ok: true })) }); }

  // ---- 测试驱动控制面 ----
  if (pathname === '/stub/status') {
    return json(res, 200, {
      downlinkConnected: !!downlink,
      lastAuth,
      pendingRpc: [...pendingRpc.keys()],
      watches: [...watches.entries()].map(([id, w]) => ({ watchId: id, taskKey: w.taskKey, frames: w.frames.length, done: w.done })),
    });
  }
  if (req.method === 'POST' && pathname === '/stub/rpc') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'invalid json' });
    if (!downlink) return json(res, 503, { error: { code: 'MACHINE_OFFLINE' } });
    const rpcId = crypto.randomUUID();
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { pendingRpc.delete(rpcId); resolve(null); }, Number(body.timeoutMs) || 10000);
      pendingRpc.set(rpcId, { resolve, timer });
      log(`rpc: 下发 ${rpcId} verb=${body.verb}`);
      sendEvent('rpc', { rpcId, verb: body.verb, args: body.args || {} });
    });
    if (!result) return json(res, 504, { error: { code: 'RELAY_TIMEOUT' } });
    return json(res, 200, result);
  }
  if (req.method === 'POST' && pathname === '/stub/watch-start') {
    const body = await readBody(req);
    if (!body?.taskKey) return json(res, 400, { error: 'taskKey required' });
    if (!downlink) return json(res, 503, { error: { code: 'MACHINE_OFFLINE' } });
    const watchId = crypto.randomUUID();
    watches.set(watchId, { taskKey: body.taskKey, frames: [], done: false });
    log(`watch: 下发 watch_start ${watchId} taskKey=${body.taskKey}`);
    sendEvent('watch_start', { watchId, taskKey: body.taskKey });
    return json(res, 200, { watchId });
  }
  if (req.method === 'POST' && pathname === '/stub/watch-stop') {
    const body = await readBody(req);
    if (!body?.watchId) return json(res, 400, { error: 'watchId required' });
    log(`watch: 下发 watch_stop ${body.watchId}`);
    sendEvent('watch_stop', { watchId: body.watchId });
    return json(res, 200, { ok: true });
  }
  if (pathname === '/stub/frames') {
    const w = watches.get(searchParams.get('watchId') || '');
    if (!w) return json(res, 404, { error: 'unknown watchId' });
    return json(res, 200, w);
  }
  json(res, 404, { error: `no route: ${req.method} ${pathname}` });
});

server.listen(PORT, '127.0.0.1', () => log(`stub 云端就绪 → http://127.0.0.1:${PORT}（downlink + rpc/watch 上行 + /stub/* 控制面）`));
