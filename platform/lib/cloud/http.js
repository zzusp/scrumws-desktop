import http from 'node:http';
import https from 'node:https';

// 出站 JSON 请求。零依赖：node:https（cloudUrl 为 http: 时用 node:http，仅供本地联调）。
/** @typedef {{status:number, json:any|null, text:string}} CloudResponse */

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;   // 响应体上限，防被劫持的 cloudUrl 无限灌数据撑爆桌面进程

/**
 * @param {{cloudUrl:string, token?:string}} target  token 给了就发 Authorization: Bearer
 * @param {'GET'|'POST'} method
 * @param {string} reqPath  '/api/machine/heartbeat'
 * @param {any} [body]      JSON.stringify 后发送
 * @param {{timeoutMs?:number}} [opts]  默认 15000
 * @returns {Promise<CloudResponse>}
 *
 * 不抛 HTTP 状态错误：4xx/5xx 照常返回，由调用方按 status 判（§7.4 的「401 终局 / 5xx 重试」全靠它）。
 * 只有网络层失败（DNS / 连不上 / 超时 / 响应超限）才抛。
 */
export async function cloudRequest(target, method, reqPath, body, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = new URL(reqPath, target.cloudUrl);
  const mod = url.protocol === 'https:' ? https : http;
  const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');

  const headers = { Accept: 'application/json' };
  if (payload) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = String(payload.length);
  }
  if (target.token) headers.Authorization = `Bearer ${target.token}`;

  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { res.destroy(); req.destroy(new Error('云端响应体超限')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        // 非 JSON（网关的 HTML 错误页 / 空体）→ json=null，status 照常返回：
        // 401 的终局判定只认 status，不能因为响应体不是 JSON 就退化成「网络错误重试」。
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* json 保持 null */ }
        resolve({ status: res.statusCode || 0, json, text });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`云端请求超时（${timeoutMs}ms）`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
