// 中继内存注册表（手机中继 spec §4.1–4.3）—— 云端不落库的那半边。
//
// 三张 Map 就是中继的全部状态，进程重启即清零（connector 会退避重连，浏览器会重开 SSE）：
//   downlinks   machineId → downlink 连接（同机重复建连 = 顶掉旧的，§4.1）
//   pendingRpcs rpcId     → { machineId, resolve, timer }（10s 超时，§4.3）
//   watches     watchId   → { machineId, sink }（浏览器 SSE 回调，§4.3）
//
// 【不变式】本文件零 DB 访问：中继数据只在这几张 Map 和 SSE 管道里过一遍，
// task / task_status 等表零写入（spec 决策 1「不落云库」）。
import crypto from 'node:crypto';

/** rpc 等待上限（spec §4.3：10s 内无响应 → 504 RELAY_TIMEOUT）。 */
export const RPC_TIMEOUT_MS = 10_000;

/** @type {Map<string, {send(event:string,data:object):void, close():void}>} machineId → downlink */
const downlinks = new Map();
/** @type {Map<string, {machineId:string, resolve(out:object):void, timer:NodeJS.Timeout}>} */
const pendingRpcs = new Map();
/** @type {Map<string, {machineId:string, sink:{push(payload:object):void, end():void}}>} */
const watches = new Map();

// ============================================================
// SSE 写帧小工具 —— machine-relay.js（下行长连）与 my.js（浏览器 watch 流）共用，
// 放这里免得两个路由文件互相 import。
// ============================================================

/**
 * 往已 hijack 的原始响应上写一条 SSE 事件。流已关则静默丢弃（write-after-end 会抛）。
 * @param {import('node:http').ServerResponse} res
 */
export function sseSend(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ============================================================
// downlink：machineId → 连接
// ============================================================

/**
 * 登记下行连接。同机重复建连 = 顶掉旧的（§4.1：本地重启 / 断网重连后不留幽灵连接）。
 * 先 set 再 close：旧连接的 close 事件走 unregisterDownlink 的同一性检查，不会误清新连接，
 * 也不会把该机器在途的 pending / watch 错杀（机器仍在场）。
 */
export function registerDownlink(machineId, conn) {
  const old = downlinks.get(machineId);
  downlinks.set(machineId, conn);
  if (old) old.close();
}

/**
 * 下行连接断开。只有「断的就是当前这条」才算机器离场（被顶掉的旧连接不算）：
 * 该机器的 pending 全部按 MACHINE_OFFLINE 收场、watch 给浏览器补一帧 done 后关流。
 */
export function unregisterDownlink(machineId, conn) {
  if (downlinks.get(machineId) !== conn) return;
  downlinks.delete(machineId);
  for (const [rpcId, p] of pendingRpcs) {
    if (p.machineId !== machineId) continue;
    pendingRpcs.delete(rpcId);
    clearTimeout(p.timer);
    p.resolve({ kind: 'offline' });
  }
  for (const [watchId, w] of watches) {
    if (w.machineId !== machineId) continue;
    watches.delete(watchId);
    w.sink.push({ frames: [], done: true }); // 让浏览器能与网络错误区分开
    w.sink.end();
  }
}

/** 下行连接在场 = relayOnline: true（§4.1）。 */
export const relayOnline = (machineId) => downlinks.has(machineId);

// ============================================================
// rpc：下发 + 等结果（结果经 POST /api/machine/rpc/:rpcId/result 回来，与下行连接是两条通路）
// ============================================================

/**
 * 经 downlink 下发一条 rpc 并等待结果。永不 reject —— 三种收场用 kind 区分，
 * 由路由映射状态码（§4.3）：
 *   { kind:'offline' }                       → 503 MACHINE_OFFLINE（不在场 / 等待中连接断开）
 *   { kind:'timeout' }                       → 504 RELAY_TIMEOUT（10s 无响应）
 *   { kind:'result', ok, data?, error? }     → ok ? 200 : 502 RELAY_FAILED
 */
export function dispatchRpc(machineId, verb, args) {
  const conn = downlinks.get(machineId);
  if (!conn) return Promise.resolve({ kind: 'offline' });
  const rpcId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRpcs.delete(rpcId);
      resolve({ kind: 'timeout' });
    }, RPC_TIMEOUT_MS);
    timer.unref?.();
    pendingRpcs.set(rpcId, { machineId, resolve, timer });
    conn.send('rpc', { rpcId, verb, args });
  });
}

/**
 * 机器上行的 rpc 结果。未知 rpcId（超时清掉 / 连接顶替后的迟到响应）或 machineId 对不上
 * （别的机器拿不属于自己的 rpcId 来交差）→ false，路由回 404 丢弃即可（§4.2）。
 */
export function resolveRpc(rpcId, machineId, body) {
  const p = pendingRpcs.get(rpcId);
  if (!p || p.machineId !== machineId) return false;
  pendingRpcs.delete(rpcId);
  clearTimeout(p.timer);
  p.resolve({ kind: 'result', ok: body.ok === true, data: body.data, error: body.error });
  return true;
}

// ============================================================
// watch：浏览器 SSE ↔ 本地轮询器
// ============================================================

/**
 * 开一路 watch：登记 sink 并向机器下发 watch_start（§4.1）。机器不在场 → null。
 * @param {{push(payload:object):void, end():void}} sink 浏览器 SSE 的写回调
 * @returns {string|null} watchId
 */
export function openWatch(machineId, taskKey, sink) {
  const conn = downlinks.get(machineId);
  if (!conn) return null;
  const watchId = crypto.randomUUID();
  watches.set(watchId, { machineId, sink });
  conn.send('watch_start', { watchId, taskKey });
  return watchId;
}

/**
 * 浏览器断开：移除并向机器下发 watch_stop（§4.3）。
 * done 帧收尾的 watch 已被 pushWatchFrames 移除，这里查不到 → 不会重复下发 watch_stop。
 */
export function closeWatch(watchId) {
  const w = watches.get(watchId);
  if (!w) return;
  watches.delete(watchId);
  downlinks.get(w.machineId)?.send('watch_stop', { watchId });
}

/**
 * 机器上行的 watch 帧 → 转发给浏览器；done=true 表示本地侧终止（任务收敛 / 开关被关），
 * 云端随之关闭浏览器流（§4.2）。未知 watchId 或 machineId 对不上 → false，路由回 404。
 */
export function pushWatchFrames(watchId, machineId, frames, done) {
  const w = watches.get(watchId);
  if (!w || w.machineId !== machineId) return false;
  w.sink.push({ frames, done: done === true });
  if (done === true) {
    watches.delete(watchId);
    w.sink.end();
  }
  return true;
}
