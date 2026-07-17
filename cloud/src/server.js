// Fastify 实例 · 8790（契约 §11）。
// 配置全部走 env：DATABASE_URL（只从 process.env 读）、CLOUD_PORT（默认 8790）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { pool } from './db.js';
import { sendError } from './http.js';
import userRoutes from './routes/user.js';
import machineRoutes from './routes/machine.js';
import machineRelayRoutes from './routes/machine-relay.js';
import myRoutes from './routes/my.js';
import { BIND_HOST, logDispatchPosture } from './dispatch-gate.js';
import { startSweeper } from './sweeper.js';

const PORT = Number(process.env.CLOUD_PORT || 8790);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function buildServer() {
  const app = Fastify({
    logger: true,
    // 默认 1MB；两个上行端点在各自路由上放宽到 8MB（§6.9）
    bodyLimit: 1024 * 1024,
    // trustProxy 刻意不开：开了就等于信任任意客户端的 X-Forwarded-For，限流的 key 会被伪造。
    // 代价见 README「部署」：前置 TLS 反代时，限流会按反代 IP 聚合。
  });

  // 统一错误体（§6）：框架抛出的错误也必须长这样，不能漏出 fastify 的默认 { statusCode, error, message }
  app.setErrorHandler((err, req, reply) => {
    // schema 校验失败 = 形状问题（字段缺失 / 类型不对），与凭据内容无关 → 400
    if (err.validation) return sendError(reply, 400, 'BAD_REQUEST', err.message);
    const status = Number(err.statusCode) || 500;
    // 框架级 4xx：body 过大(413) / JSON 畸形(400) / 媒体类型不支持(415) —— 都归「body 不合法」
    if (status >= 400 && status < 500) return sendError(reply, 400, 'BAD_REQUEST', err.message);
    req.log.error({ err }, '未处理的服务端错误');
    return sendError(reply, 500, 'INTERNAL', '服务内部错误');
  });

  app.setNotFoundHandler((req, reply) => sendError(reply, 404, 'NOT_FOUND', '端点不存在'));

  // 存活探针（不碰库，给部署用）
  app.get('/api/health', async () => ({ ok: true }));

  app.register(userRoutes);
  app.register(machineRoutes);
  app.register(machineRelayRoutes); // 手机中继：下行长连 + rpc/watch 上行（spec §4.1/4.2）
  app.register(myRoutes);           // 手机中继：owner API（spec §4.3）

  // 云端前端（cloud/public）必须由本服务托管、与 API 同源：public/app.js 用相对路径 /api/… +
  // credentials:'same-origin' 发请求，会话是 HttpOnly cookie —— 静态站与 API 分家就拿不到 cookie。
  // 前端是 hash 路由（public/app.js:478 读 location.hash），浏览器只会请求 '/' 与 '/app.js'，
  // 故不需要 SPA history 回退：'/' 由 index 命中，取不到的资源照常落 404。
  app.register(fastifyStatic, { root: PUBLIC_DIR, index: ['index.html'] });

  return app;
}

async function main() {
  const app = buildServer();
  // 起服务前先确认库可达：连不上就别假装健康
  await pool.query('select 1');
  const stopSweeper = startSweeper(app.log);

  const shutdown = async (sig) => {
    app.log.info({ sig }, '收到退出信号，正在关闭');
    stopSweeper();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });

  // 0.0.0.0：云端服务必须对外可达（与本地看板 8799 只绑 127.0.0.1 的规矩相反，那是两种东西）。
  // 常量住在 dispatch-gate.js —— 绊线判据的「非仅绑 localhost」必须看真实绑定面，不许两处各写一份。
  await app.listen({ port: PORT, host: BIND_HOST });

  // 安全姿态必须在启动日志里可见：这个开关一旦设错，症状是「凭据明文过网」——
  // 不报错、不影响功能，运行期没有任何迹象。只有开机这一行能让人发现设错了。
  if (process.env.CLOUD_INSECURE_COOKIE === '1') {
    app.log.warn(
      '[cloud] CLOUD_INSECURE_COOKIE=1：会话 cookie 已摘掉 Secure，允许裸 HTTP。' +
      ' swuk_ 登录密钥与 swmt_ 机器令牌将明文过网 —— 仅限内网/可信链路，公网部署务必关掉并前置 TLS 反代。'
    );
  }
  logDispatchPosture(app.log); // 手机中继绊线姿态（spec §4.6），同上理由：只有开机这一行能发现设错
}

main().catch((err) => {
  // 绝不回显 DATABASE_URL
  console.error('[cloud] 启动失败：', err.message);
  process.exit(1);
});
