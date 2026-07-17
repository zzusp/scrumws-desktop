import http from 'node:http';
import https from 'node:https';
import { readConfig } from '../runner-config.js';
import { cloudRequest } from './http.js';
import { runVerb, workerLogBlocks, WORKER_LOG_TAIL } from './relay-verbs.js';

// 手机中继下行通道（契约 §4.1/4.2/4.5）：connector 出站对云端建一条 SSE 长连，接收 rpc / watch 指令，
// 结果与帧用既有 cloudRequest 上行。零依赖：node:http(s) 手写客户端（风格同 http.js）。
// · cloudRemoteControl=false → 根本不建连（零下行面）；connector 每 tick（15s）经 syncDownlink 热起停
// · 断线指数退避重连 1s → 2s → … → 30s；连接成功即复位
// · 401 与 connector §7.4 同语义：终局停机（不重试），15s 内 connector 心跳同样 401 → 解绑收口
// · watch：每 1.5s 轮询 readWorkerLog 指纹比对，变化才推增量尾部块；500ms 批量合并上行；
//   同 taskKey 多 watch 复用一个轮询器（引用计数）；watch_stop / 断连 / 停机全部清理

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const IDLE_TIMEOUT_MS = 90000;        // 云端每 25s 一个 ping；90s 静默 = 半开连接，主动断开走重连
const EVENT_BUF_MAX = 1024 * 1024;    // 单事件缓冲上限：下行事件都是小 JSON，超限即视为流已坏
const WATCH_POLL_MS = 1500;
const FRAME_BATCH_MS = 500;

let target = null;          // {cloudUrl, token}（enroll 身份，由 syncDownlink 传入）
let wantRun = false;        // start 后为 true；stop 置 false（区分「断线待重连」与「本来就该关」）
let req = null;             // 当前长连请求（node:http ClientRequest）
let connSeq = 0;            // 连接代次：stop/重建时 +1，作废旧连接的在途回调
let connected = false;
let lastError = null;
let lastEventAtMs = null;   // 最近收到任意下行字节的时刻（含 ping / 注释行）
let backoffMs = RECONNECT_MIN_MS;
let reconnectTimer = null;
let idleTimer = null;

const sameTarget = (a, b) => !!a && !!b && a.cloudUrl === b.cloudUrl && a.token === b.token;

/** 启动（幂等：同目标重入无操作；目标变了 → 重建连接）。 */
export function startDownlink(t) {
  if (!t?.cloudUrl || !t?.token) return;
  if (wantRun && sameTarget(target, t)) return;
  stopDownlink();
  target = { cloudUrl: t.cloudUrl, token: t.token };
  wantRun = true;
  backoffMs = RECONNECT_MIN_MS;
  connect();
}

/** 停止：断连 + 撤销重连 + 清全部 watch。幂等。 */
export function stopDownlink() {
  wantRun = false;
  connSeq++;                          // 作废在途回调（旧连接的 error/end 不再触发重连）
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (req) { try { req.destroy(); } catch { /* 已断 */ } req = null; }
  connected = false;
  clearAllWatches();
  target = null;
  lastError = null;
  lastEventAtMs = null;
}

/**
 * connector 每 tick（15s）调：按 runner-config 的 cloudRemoteControl（热加载）与 enroll 身份决定起停。
 * 默认 false = 不建连；未 enroll 同样保持关闭。
 */
export function syncDownlink(identity) {
  const enabled = !!readConfig().cloudRemoteControl;
  const enrolled = !!(identity?.token && identity?.cloudUrl);
  if (enabled && enrolled) startDownlink({ cloudUrl: identity.cloudUrl, token: identity.token });
  else stopDownlink();
}

/** 设置页展示用（connectorStatus().remoteControl）。字段穷举：enabled/connected/lastError/lastEventAt。 */
export function downlinkStatus() {
  return {
    enabled: !!readConfig().cloudRemoteControl,
    connected,
    lastError,
    lastEventAt: lastEventAtMs ? new Date(lastEventAtMs).toISOString() : null,
  };
}

function scheduleReconnect() {
  if (!wantRun || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoffMs);
  reconnectTimer.unref?.();
  backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
}

function armIdle(r) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { try { r.destroy(new Error('downlink 空闲超时（90s 无事件）')); } catch { /* 已断 */ } }, IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

function connect() {
  if (!wantRun || req) return;
  const seq = ++connSeq;
  let url;
  try { url = new URL('/api/machine/downlink', target.cloudUrl); } catch (e) { lastError = `cloudUrl 无效：${e.message}`; return; }
  const mod = url.protocol === 'https:' ? https : http;
  const r = mod.request(url, {
    method: 'GET',
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${target.token}` },
  });
  req = r;

  // 断线收口（本连接专用）：terminal=true 走 401 终局（停机不重试，交回 connector 处理）
  const dead = (msg, terminal) => {
    if (seq !== connSeq) return;      // 已被新连接 / stop 取代，旧回调不再动全局状态
    if (req === r) req = null;
    connected = false;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    clearAllWatches();                // 连接断 = 云端侧 watch 随连接作废，本地轮询器一并清
    if (msg) lastError = msg;
    try { r.destroy(); } catch { /* 已断 */ }
    if (terminal) { const keep = lastError; stopDownlink(); lastError = keep; return; }
    scheduleReconnect();
  };

  r.on('response', (res) => {
    if (seq !== connSeq) { res.destroy(); return; }
    if (res.statusCode === 401) return dead('云端返回 401（令牌无效或已撤销），下行通道已停', true);
    if (res.statusCode !== 200) { res.resume(); return dead(`downlink 建连失败：HTTP ${res.statusCode}`); }
    connected = true;
    lastError = null;
    backoffMs = RECONNECT_MIN_MS;     // 建连成功即复位退避
    lastEventAtMs = Date.now();
    armIdle(r);

    // text/event-stream 逐行解析（跨 chunk 缓冲）：event:/data: 累积，空行 = 一个事件收口
    let buf = '';
    let evName = null;
    let evData = [];
    const feedLine = (line) => {
      if (line === '') {
        if (evData.length || evName) dispatchEvent(evName || 'message', evData.join('\n'));
        evName = null; evData = [];
        return;
      }
      if (line.startsWith(':')) return;               // 注释行（心跳）：只作保活
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') evName = value;
      else if (field === 'data') evData.push(value);
      // retry:/id: 忽略（重连节拍由本模块的指数退避管）
    };
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      if (seq !== connSeq) return;
      lastEventAtMs = Date.now();
      armIdle(r);
      buf += chunk;
      if (buf.length > EVENT_BUF_MAX) return dead('downlink 事件缓冲超限，重建连接');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        feedLine(line);
      }
    });
    res.on('end', () => dead('downlink 连接被云端关闭'));
    res.on('error', (e) => dead(`downlink 连接错误：${e.message}`));
  });
  r.on('error', (e) => dead(`downlink 连接失败：${e.message}`));
  r.end();
}

function dispatchEvent(name, dataStr) {
  let data;
  try { data = dataStr ? JSON.parse(dataStr) : {}; } catch { return; }   // 坏 JSON 事件丢弃
  if (name === 'rpc') handleRpc(data);
  else if (name === 'watch_start') watchStart(data);
  else if (name === 'watch_stop') watchStop(String(data?.watchId || ''));
  // ping / 未知事件：保活已在 data 回调统一刷新，无需处理
}

// ---- rpc：执行 verb → POST 结果回 /api/machine/rpc/:rpcId/result（契约 §4.2）----
async function handleRpc(ev) {
  const rpcId = String(ev?.rpcId || '');
  if (!rpcId) return;
  const t = target;                       // 抓当前目标：执行期间可能已 stop / 换云端，届时不再上行
  let result;
  try { result = await runVerb(ev?.verb, ev?.args || {}); }
  catch (e) { result = { ok: false, error: `verb 执行异常：${e.message}` }; }
  if (!wantRun || !sameTarget(target, t)) return;
  try { await cloudRequest(t, 'POST', `/api/machine/rpc/${encodeURIComponent(rpcId)}/result`, result); }
  catch (e) { lastError = `rpc 结果上行失败：${e.message}`; }   // 迟到/丢失由云端 10s 超时兜底（504）
}

// ---- watch：轮询式 worker-log 尾巴（契约 §4.5）----
// 同 taskKey 复用一个轮询器；帧 500ms 批量合并；任务收敛（state 离开 processing）推 done:true 停表。
const pollers = new Map();   // taskKey → { taskKey, watchIds:Set, timer, lastFp, lastCount, pending:[], flushTimer }

// 块级指纹（参照 server.js wlFingerprint）：块数 + 各块 content block 数 + 末块末 content 文本长度
// + state/hasInflight —— 能感知「同一 assistant 消息逐块增长」，又不必整包 stringify。
function blocksFingerprint(r) {
  const last = r.blocks[r.blocks.length - 1];
  const lc = last && Array.isArray(last.content) ? last.content[last.content.length - 1] : null;
  return JSON.stringify([
    r.blocks.length,
    r.blocks.map((b) => (Array.isArray(b.content) ? b.content.length : 0)),
    lc ? (typeof lc.text === 'string' ? lc.text.length : (lc.type || '')) : 0,
    r.hasInflight, r.state,
  ]);
}

function watchStart(ev) {
  const watchId = String(ev?.watchId || '');
  const taskKey = String(ev?.taskKey || '');
  if (!watchId || !taskKey || !wantRun) return;
  let p = pollers.get(taskKey);
  if (p) {
    p.watchIds.add(watchId);            // 复用轮询器（引用计数）：新观看者补一帧基线尾窗，之后共享增量
    sendBaseline(watchId, taskKey);
    return;
  }
  p = { taskKey, watchIds: new Set([watchId]), timer: null, lastFp: null, lastCount: 0, pending: [], flushTimer: null };
  pollers.set(taskKey, p);
  p.timer = setInterval(() => pollOnce(p), WATCH_POLL_MS);
  p.timer.unref?.();
  pollOnce(p);                          // 立即出首帧（基线尾窗），别让手机端白等 1.5s
}

function watchStop(watchId) {
  if (!watchId) return;
  for (const p of pollers.values()) {
    if (p.watchIds.delete(watchId) && !p.watchIds.size) destroyPoller(p.taskKey);
  }
}

function destroyPoller(taskKey) {
  const p = pollers.get(taskKey);
  if (!p) return;
  pollers.delete(taskKey);
  if (p.timer) { clearInterval(p.timer); p.timer = null; }
  if (p.flushTimer) { clearTimeout(p.flushTimer); p.flushTimer = null; }
}

function clearAllWatches() {
  for (const key of [...pollers.keys()]) destroyPoller(key);
}

// 中途加入的观看者单独补基线（增量流只对老观看者连续）
async function sendBaseline(watchId, taskKey) {
  const t = target;
  if (!t) return;
  const r = workerLogBlocks(taskKey);
  const frame = r.ok
    ? { kind: 'worker-log', blocks: r.blocks.slice(-WORKER_LOG_TAIL), total: r.blocks.length, state: r.state }
    : { kind: 'worker-log', blocks: [], total: 0, state: null, error: r.error };
  try { await cloudRequest(t, 'POST', `/api/machine/watch/${encodeURIComponent(watchId)}/frames`, { frames: [frame], done: !r.ok }); }
  catch { /* 尽力交付：丢帧由手机端 workerLog rpc 随时重对齐 */ }
}

function pollOnce(p) {
  if (!wantRun) return destroyPoller(p.taskKey);
  const r = workerLogBlocks(p.taskKey);
  if (!r.ok) {
    // 任务没了 / 读失败 → 报一帧原因后停表
    p.pending.push({ kind: 'worker-log', blocks: [], total: 0, state: null, error: r.error });
    return flushPoller(p, true);
  }
  const fp = blocksFingerprint(r);
  if (fp !== p.lastFp) {
    p.lastFp = fp;
    // 增量 = 从上次已知末块起（末块可能是「同一消息在长」，重发覆盖）；首帧 / 块数回退（rewind 截断）
    // → 退回整个尾窗重置基线
    const blocks = (p.lastCount === 0 || r.blocks.length < p.lastCount)
      ? r.blocks.slice(-WORKER_LOG_TAIL)
      : r.blocks.slice(Math.max(0, p.lastCount - 1));
    p.lastCount = r.blocks.length;
    p.pending.push({ kind: 'worker-log', blocks, total: r.blocks.length, state: r.state });
    scheduleFlush(p);
  }
  // 收敛判据与 server.js worker-log SSE 的 end('done') 相同：state 离开 processing（本轮变化帧已入 pending，
  // 随 done:true 一并上行 = 「无新输出」后停表）
  if (r.state !== 'processing') flushPoller(p, true);
}

function scheduleFlush(p) {
  if (p.flushTimer) return;
  p.flushTimer = setTimeout(() => { p.flushTimer = null; flushPoller(p, false); }, FRAME_BATCH_MS);
  p.flushTimer.unref?.();
}

async function flushPoller(p, done) {
  if (p.flushTimer) { clearTimeout(p.flushTimer); p.flushTimer = null; }
  const frames = p.pending.splice(0);
  if (done) destroyPoller(p.taskKey);   // 先停表再上行：flush 是异步的，别让下一 tick 又推
  if (!frames.length && !done) return;
  const t = target;
  if (!t) return;
  const body = { frames, done: !!done };
  for (const watchId of [...p.watchIds]) {
    try {
      const r = await cloudRequest(t, 'POST', `/api/machine/watch/${encodeURIComponent(watchId)}/frames`, body);
      if (r.status === 404) p.watchIds.delete(watchId);   // 云端已不认识该 watch（浏览器已断 / 连接顶替后的迟到帧）
    } catch { /* 网络抖动：帧尽力交付，手机端可随时用 workerLog rpc 重新对齐 */ }
  }
  if (!done && !p.watchIds.size) destroyPoller(p.taskKey);
}
