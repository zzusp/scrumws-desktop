// 手机页专用的 owner API（手机中继 spec §4.3 / §4.4）—— 会话 cookie 鉴权。
//
// 【§3.3 写权限矩阵】本文件的 handler 零 DB 写入（requireSession 里的 last_used_at 除外）：
//   任务数据现取现回，只走 relay-registry 的内存管道，task / task_status 等表一个字节不碰。
// 【§3.4 / spec §4.3】全部端点先做 owner 校验：目标机器 owner_user_id != 会话 user →
//   一律 404（不泄露「存在但不是你的」）。
import { requireSession } from '../auth.js';
import { q } from '../db.js';
import { sendError } from '../http.js';
import { requireDispatchAllowed } from '../dispatch-gate.js';
import { relayOnline, dispatchRpc, openWatch, closeWatch, sseSend } from '../relay-registry.js';

const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID_RE } } };
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));

// rpc verb 白名单（spec §4.4，**穷举**）。云端不解释 args，只透传 —— 一切校验在本地
// （connector 侧同样写死这张表，云端被攻破也只能调表内动作）。
const RPC_VERBS = new Set([
  'state', 'cwds', 'taskDetail', 'workerLog', 'createTask',
  'message', 'approve', 'cancel', 'complete', 'uncomplete', 'toPlan',
]);

/**
 * owner 校验：id 属于会话 user 名下（同 workspace + owner 本人 + 未撤销）才返回行。
 * 不存在 / 别人的 / 已撤销 → null，调用方一律回同一句 404。
 */
async function ownedMachine(req) {
  const { rows } = await q(
    `select id from machine
      where id = $1 and workspace_id = $2 and owner_user_id = $3 and revoked_at is null`,
    [req.params.id, req.auth.workspaceId, req.auth.user.id],
  );
  return rows[0] ?? null;
}
const machine404 = (reply) => sendError(reply, 404, 'NOT_FOUND', '机器不存在');

export default async function myRoutes(app) {
  // ============================================================
  // §4.3 GET /api/my/machines —— 只列本人机器（含 relayOnline）
  // ============================================================
  app.get('/api/my/machines', {
    preHandler: [requireDispatchAllowed, requireSession],
  }, async (req) => {
    const { rows } = await q(
      `select id, display_name, status, last_seen_at,
              load_processing, load_queued, max_concurrent_runners
         from machine
        where workspace_id = $1 and owner_user_id = $2 and revoked_at is null
        order by display_name asc`,
      [req.auth.workspaceId, req.auth.user.id],
    );
    return {
      machines: rows.map((r) => ({
        id: r.id,
        displayName: r.display_name,
        status: r.status,
        lastSeenAt: iso(r.last_seen_at),
        // 心跳在场（status）≠ 中继在场（relayOnline）：后者要求本地开了 cloudRemoteControl
        relayOnline: relayOnline(r.id),
        load: { processing: r.load_processing, queued: r.load_queued, cap: r.max_concurrent_runners },
      })),
    };
  });

  // ============================================================
  // §4.3 POST /api/my/machines/:id/rpc —— 经 downlink 下发、阻塞等结果
  // 状态码语义：200 / 400 verb 不在白名单 / 502 RELAY_FAILED / 503 MACHINE_OFFLINE / 504 RELAY_TIMEOUT
  // ============================================================
  app.post('/api/my/machines/:id/rpc', {
    preHandler: [requireDispatchAllowed, requireSession],
    schema: {
      params: uuidParams,
      body: {
        type: 'object',
        required: ['verb'],
        properties: {
          verb: { type: 'string' },
          args: { type: 'object' }, // 云端不解释，原样透传（§4.4）
        },
      },
    },
  }, async (req, reply) => {
    // owner 校验最先：verb 对不对是之后的事，非 owner 连「verb 不合法」都不该探出来
    if (!(await ownedMachine(req))) return machine404(reply);
    if (!RPC_VERBS.has(req.body.verb)) {
      return sendError(reply, 400, 'BAD_REQUEST', `verb 不在白名单内：${req.body.verb}`);
    }
    const out = await dispatchRpc(req.params.id, req.body.verb, req.body.args ?? {});
    if (out.kind === 'offline') return sendError(reply, 503, 'MACHINE_OFFLINE', '机器离线或未开启远程控制');
    if (out.kind === 'timeout') return sendError(reply, 504, 'RELAY_TIMEOUT', '机器 10 秒内未响应');
    // connector 拒绝（闸门 / 白名单 / 状态机）：message 透传本地拒绝原因（§4.3）
    if (!out.ok) return sendError(reply, 502, 'RELAY_FAILED', out.error ?? '本地拒绝，未给出原因');
    return { ok: true, data: out.data ?? null };
  });

  // ============================================================
  // §4.3 GET /api/my/machines/:id/watch?taskKey=… —— 浏览器 EventSource
  // 云端下发 watch_start、转发帧；浏览器断开 → watch_stop + 清理。
  // 浏览器侧事件：frames（data = { frames, done }，与 §4.2 上行体同形）+ ping 保活。
  // ============================================================
  app.get('/api/my/machines/:id/watch', {
    preHandler: [requireDispatchAllowed, requireSession],
    schema: {
      params: uuidParams,
      querystring: {
        type: 'object',
        required: ['taskKey'],
        properties: { taskKey: { type: 'string', minLength: 1 } },
      },
    },
  }, async (req, reply) => {
    if (!(await ownedMachine(req))) return machine404(reply);
    if (!relayOnline(req.params.id)) return sendError(reply, 503, 'MACHINE_OFFLINE', '机器离线或未开启远程控制');

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': watch established\n\n');

    const sink = {
      push: (payload) => sseSend(res, 'frames', payload),
      end: () => res.end(),
    };
    const watchId = openWatch(req.params.id, req.query.taskKey, sink);
    if (!watchId) { res.end(); return; } // relayOnline 判完到这里的窗口内连接刚好断了

    // 浏览器侧也要保活：本地无变化时可以很久没有帧，中间的反代会掐空闲连接
    const ping = setInterval(() => sseSend(res, 'ping', {}), 25_000);
    ping.unref?.();

    // 浏览器断开（含 done 帧后 registry 主动关流）：停保活 + 注销。
    // done 收尾的 watch 在 registry 里已移除，closeWatch 查不到 → 不会多发 watch_stop。
    res.on('close', () => {
      clearInterval(ping);
      closeWatch(watchId);
    });
  });
}
