// 绊线判据（手机中继 spec §4.6，与 P2 下行面同判据）—— 独立成文件，并行 P2 落地时直接复用。
//
// 判据：CLOUD_INSECURE_COOKIE=1（凭据明文过网）
//    且 服务非仅绑 localhost（明文真的暴露在网络上）
//    且 未设 CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1（没人为这个风险显式签字）
//    → 一切下行面（downlink / rpc 上行 / watch 上行 / /api/my/*）一律 503。
//
// 为什么只封下行面、不阻启动：P0/P1 的只读上行在明文下危害止于「看到任务」，
// 而下行面 = 能对机器发起操作 —— 明文链路上任何人抓到 swmt_ / 会话 cookie 即可冒充派活。
// 风险不同级，闸门也分开：上行照常（大盘还能看），下行 fail-closed。
import { sendError } from './http.js';

// 服务绑定地址。server.js 的 listen 与本判据共用同一常量：
// 「非仅绑 localhost」必须看真实绑定面，两处各写一份就会漂移。
export const BIND_HOST = '0.0.0.0';

const LOCALHOST_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * 下行面是否封禁（判据本体，P2 复用）。
 * env 在调用时读而非模块加载时读：判据必须反映当前进程的真实姿态，也便于测试。
 * @param {string} host 服务绑定地址
 * @returns {boolean}
 */
export function isDispatchBlocked(host) {
  return process.env.CLOUD_INSECURE_COOKIE === '1'
    && !LOCALHOST_HOSTS.has(host)
    && process.env.CLOUD_ACCEPT_PLAINTEXT_DISPATCH !== '1';
}

/**
 * fastify preHandler：绊线生效时 503（统一错误体）。挂在所有下行面端点最前面 ——
 * 在鉴权之前判，封禁姿态下不做任何 DB 查询、对有无凭据一视同仁。
 */
export async function requireDispatchAllowed(req, reply) {
  if (!isDispatchBlocked(BIND_HOST)) return;
  return sendError(reply, 503, 'PLAINTEXT_DISPATCH_BLOCKED',
    '明文链路上的下行面已封禁（CLOUD_INSECURE_COOKIE=1 且服务绑定非仅 localhost）。'
    + '确认链路可信后设 CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1 显式放行，或前置 TLS 反代并关掉 CLOUD_INSECURE_COOKIE。');
}

/**
 * 启动日志打出当前姿态（同 server.js 的 INSECURE_COOKIE 日志：设错时运行期没有任何迹象，
 * 只有开机这一行能让人发现）。
 */
export function logDispatchPosture(log) {
  if (isDispatchBlocked(BIND_HOST)) {
    log.warn(
      `[cloud] 绊线生效：CLOUD_INSECURE_COOKIE=1 且绑定 ${BIND_HOST}（非仅 localhost）、未设 CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1`
      + ' —— 下行面（/api/machine/downlink、/api/machine/rpc/*、/api/machine/watch/*、/api/my/*）一律 503。',
    );
  } else if (process.env.CLOUD_INSECURE_COOKIE === '1' && process.env.CLOUD_ACCEPT_PLAINTEXT_DISPATCH === '1') {
    log.warn(
      '[cloud] CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1：明文链路上的下行面已显式放行 ——'
      + ' swmt_ / 会话 cookie 可被链路上任何人截获并冒充派活，仅限内网/可信链路。',
    );
  }
}
