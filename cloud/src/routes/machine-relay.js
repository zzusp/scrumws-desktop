// 机器鉴权的中继端点（手机中继 spec §4.1 / §4.2）：下行长连 + rpc 结果上行 + watch 帧上行。
//
// 与 routes/machine.js（P0/P1 状态上行）刻意分文件：那边写库、这边**零 DB 写入**——
// 中继数据只走 relay-registry 的内存表（spec 决策 1「不落云库」）。
// 【§3.5 同款】上行的 rpcId / watchId 都在 registry 里核对 machineId：
// 别的机器拿不属于自己的 id 来交差 → 一律当未知 404。
import { requireMachine } from '../auth.js';
import { sendError } from '../http.js';
import { requireDispatchAllowed } from '../dispatch-gate.js';
import {
  registerDownlink, unregisterDownlink, resolveRpc, pushWatchFrames, sseSend,
} from '../relay-registry.js';

const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
// rpc 结果可能装着 workerLog 尾窗 / taskDetail 全文，watch 帧装着 worker-log 块 ——
// 与 §6.9 上报同一类载荷，沿用同一个 8MB 放宽（默认 1MB 不够）。
const BODY_LIMIT_8MB = 8 * 1024 * 1024;
const PING_INTERVAL_MS = 25_000; // §4.1：25s 保活

export default async function machineRelayRoutes(app) {
  // ============================================================
  // §4.1 GET /api/machine/downlink —— connector 出站 SSE 长连
  // 事件：rpc / watch_start / watch_stop / ping。同机重复建连 = 顶掉旧的。
  // ============================================================
  app.get('/api/machine/downlink', {
    preHandler: [requireDispatchAllowed, requireMachine],
  }, (req, reply) => {
    const { machineId } = req.machine;

    // 长连自己管生命周期，接管原始响应（此后 fastify 不再碰它）
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // 前置反代（nginx）不许缓冲 SSE
    });
    res.write(': downlink established\n\n'); // SSE 注释帧：立刻把响应头冲出去，客户端好判「连上了」

    const conn = {
      send: (event, data) => sseSend(res, event, data),
      close: () => res.end(),
    };
    registerDownlink(machineId, conn);
    req.log.info({ machineId }, 'downlink 建立');

    const ping = setInterval(() => conn.send('ping', {}), PING_INTERVAL_MS);
    ping.unref?.();

    // 断开（含被新连接顶掉时的 res.end()）：停保活 + 注销。
    // 注销带同一性检查 —— 被顶掉的旧连接不会误清新连接与该机器的在途 pending / watch。
    res.on('close', () => {
      clearInterval(ping);
      unregisterDownlink(machineId, conn);
      req.log.info({ machineId }, 'downlink 断开');
    });
  });

  // ============================================================
  // §4.2 POST /api/machine/rpc/:rpcId/result —— rpc 结果上行
  // 未知 rpcId（超时清掉 / 连接顶替后的迟到响应）→ 404，connector 丢弃即可。
  // ============================================================
  app.post('/api/machine/rpc/:rpcId/result', {
    preHandler: [requireDispatchAllowed, requireMachine],
    bodyLimit: BODY_LIMIT_8MB,
    schema: {
      params: { type: 'object', required: ['rpcId'], properties: { rpcId: { type: 'string', pattern: UUID_RE } } },
      body: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          data: {}, // connector 的原样返回，云端不解释（§4.4）
          error: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    if (!resolveRpc(req.params.rpcId, req.machine.machineId, req.body)) {
      return sendError(reply, 404, 'NOT_FOUND', 'rpc 不存在或已超时');
    }
    return { ok: true };
  });

  // ============================================================
  // §4.2 POST /api/machine/watch/:watchId/frames —— watch 帧上行 → 转发浏览器 SSE
  // done=true = 本地侧终止（任务收敛 / 开关被关），云端随之关闭浏览器流。
  // ============================================================
  app.post('/api/machine/watch/:watchId/frames', {
    preHandler: [requireDispatchAllowed, requireMachine],
    bodyLimit: BODY_LIMIT_8MB,
    schema: {
      params: { type: 'object', required: ['watchId'], properties: { watchId: { type: 'string', pattern: UUID_RE } } },
      body: {
        type: 'object',
        required: ['frames'],
        properties: {
          frames: { type: 'array' }, // 帧内容云端不解释，原样转发（§4.5 的 kind 由手机端消费）
          done: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!pushWatchFrames(req.params.watchId, req.machine.machineId, req.body.frames, req.body.done)) {
      return sendError(reply, 404, 'NOT_FOUND', 'watch 不存在或已关闭');
    }
    return { ok: true };
  });
}
