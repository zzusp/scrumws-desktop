// 跨路由共用的 HTTP 小工具：统一错误体 + 限流。
// 单独成文件而不是塞进 server.js —— routes/* 要用它，而 server.js 要 import routes/*，
// 放 server.js 会成循环依赖。

/**
 * 统一错误体（契约 §6）：所有非 2xx 一律 { error: { code, message } }。
 * code 取值：BAD_REQUEST | UNAUTHORIZED | NOT_FOUND | RATE_LIMITED | INTERNAL。
 * 在 preHandler 里用时必须 `return sendError(...)`：返回 reply 是 fastify 终止后续链路的约定。
 */
export function sendError(reply, status, code, message) {
  reply.code(status).send({ error: { code, message } });
  return reply;
}

/**
 * 进程内滑动窗口限流（契约 §6：/api/auth/login 与 /api/machine/enroll 各 10 次 / 5 分钟 / IP）。
 *
 * 手写而非引 @fastify/rate-limit：cloud/package.json 的依赖面被契约 §11 钉死为 fastify + pg。
 * 代价（已知，写在 README 部署一节）：
 *   · 状态在进程内，多实例不共享 —— 本服务是单实例，暂不构成问题；
 *   · key 取 request.ip，而 trustProxy 未开 —— 前置反代时全部请求会算到反代 IP 上。
 * @param {{limit:number, windowMs:number}} opts
 */
export function rateLimit({ limit, windowMs }) {
  /** @type {Map<string, number[]>} ip → 命中时刻（epoch ms） */
  const hits = new Map();

  // 过期桶清理：不清的话 Map 会随 IP 数无限增长。
  const pruner = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, stamps] of hits) {
      const live = stamps.filter((t) => t > cutoff);
      if (live.length) hits.set(ip, live);
      else hits.delete(ip);
    }
  }, windowMs);
  pruner.unref?.();

  return async function rateLimitHook(req, reply) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const stamps = (hits.get(req.ip) ?? []).filter((t) => t > cutoff);
    if (stamps.length >= limit) {
      // 最老那次命中滑出窗口后才放行
      const retryAfter = Math.max(1, Math.ceil((stamps[0] - cutoff) / 1000));
      reply.header('retry-after', String(retryAfter));
      return sendError(reply, 429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
    }
    stamps.push(now);
    hits.set(req.ip, stamps);
  };
}
