import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { readConfig } from './runner-config.js';

// Claude Code 账号级用量（5 小时 / 7 天滚动窗）：只有 Pro/Max 订阅才有，读本机 OAuth 凭据打官方 usage 端点。
// 数据源与 CC statusline 同一份（claude 进程 stdin 的 rate_limits 即来自此端点）；桌面平台不常驻 claude 进程，
// 故直接用 ~/.claude/.credentials.json 里的 accessToken 自查。
//
// 为何走 curl 而非 Node fetch：受限地区直连该端点会被地域拦截（403「Request not allowed」），必须经代理。
// curl 自动读 HTTP(S)_PROXY 环境变量走代理 → 200；Node 原生 fetch/核心 https 不认代理 env（Node 22 无
// NODE_USE_ENV_PROXY，那是 24+），直连一律 403（curl 强制 --noproxy 也同样 403 —— 与 TLS/UA/HTTP 版本无关，纯代理差异）。
// 让 fetch 走代理需 undici ProxyAgent，但本项目零运行时依赖、electron-builder 打包只含 electron+platform 不含 node_modules → 用不了。
// curl 各桌面系统自带（Windows 10+ curl.exe / macOS / Linux），零依赖最省事。代理来源：设置页 proxyUrl（-x 显式）
// 优先，空则回退 curl 默认的系统 HTTP(S)_PROXY env（与 claude 自身同一套代理）。
const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';
const TTL = 60_000;   // 账号级用量变化慢 + 详情页 5s 轮询：60s 内直接回缓存，外部端点至多 1 次/分钟

let cache = { at: 0, data: null };
let inflight = null;

// 读 OAuth 凭据（accessToken / 订阅类型 / 过期时刻）；文件缺失或无 token → null
function readCred() {
  try {
    const o = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'))?.claudeAiOauth;
    return o?.accessToken ? o : null;
  } catch { return null; }
}

// pro/max 才有 5h/7d 滚动窗；api-key / 无订阅不查用量
const isSubscription = (t) => t === 'pro' || t === 'max';

// 单个窗口取用量百分比 + 刷新时刻（端点字段：utilization 0-100、resets_at ISO）
const pickWindow = (w) => (w && w.utilization != null) ? { utilization: Number(w.utilization), resetsAt: w.resets_at || null } : null;

// curl GET → { status, body }；末行 %{http_code}，其余为响应体（execFile 不过 shell，token 不进命令行解析）。
// 代理优先级：设置页配置的 proxyUrl（-x 显式指定）> 空则不传 -x、由 curl 回退系统 HTTP(S)_PROXY 环境变量。
function curlGet(url, headers, timeoutMs = 8000) {
  const args = ['-s', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-w', '\n%{http_code}'];
  const proxy = (readConfig().proxyUrl || '').trim();
  if (proxy) args.push('-x', proxy);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(url);
  return new Promise((resolve) => {
    execFile(CURL, args, { timeout: timeoutMs + 2000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (!stdout) return resolve({ status: 0, body: null, err: err ? String(err.code || err.message) : 'no-output' });
      const nl = stdout.lastIndexOf('\n');
      resolve({ status: Number(stdout.slice(nl + 1).trim()) || 0, body: stdout.slice(0, nl) });
    });
  });
}

async function fetchUsage() {
  const cred = readCred();
  if (!cred) return { ok: false, error: 'no-credentials' };
  const plan = cred.subscriptionType || null;
  const base = { ok: true, plan, subscription: isSubscription(plan), tier: cred.rateLimitTier || null };
  if (!base.subscription) return base;                                   // 非订阅：只回套餐名，不打端点
  if (cred.expiresAt && Date.now() > cred.expiresAt) return { ...base, error: 'token-expired' };
  const resp = await curlGet(USAGE_URL, { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': OAUTH_BETA });
  if (resp.status !== 200) return { ...base, error: resp.status ? `http-${resp.status}` : `curl-${resp.err || 'failed'}` };
  let u;
  try { u = JSON.parse(resp.body); } catch { return { ...base, error: 'parse-failed' }; }
  return { ...base, fiveHour: pickWindow(u.five_hour), sevenDay: pickWindow(u.seven_day) };
}

// TTL 缓存 + 并发去重（对齐 collect.js detectClaudeRuntime 的自查节流思路）。
// 成功结果缓存 60s；失败时若已有旧数据则沿用（避免网络抖动把进度条闪空），无旧数据才缓存错误态。
export async function getClaudeUsage() {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;
  if (inflight) return inflight;
  inflight = fetchUsage().then((data) => {
    inflight = null;
    if (!data.error) cache = { at: Date.now(), data };
    else if (!cache.data) cache = { at: Date.now(), data };
    return cache.data;
  }).catch(() => {
    inflight = null;
    return cache.data || { ok: false, error: 'fetch-failed' };
  });
  return inflight;
}

// 代理配置变更后清缓存，令下次拉取立即用新代理（否则最长 60s 沿用旧结果）
export function invalidateClaudeUsage() { cache = { at: 0, data: null }; }

// ---- 模型上下文窗口（Models API：GET /v1/models/{id} → max_input_tokens）----
// 详情页上下文用量环形的「上限」取真实值，不按 model 名硬编码/猜测：直接问 Anthropic 该 model 报告的
// max_input_tokens。桌面平台 spawn 的 --model 会话上限即此（实测 opus/opus-4-7/sonnet-5/fable=1,000,000、
// haiku=200,000；真实会话单条上下文已见 892k，反证 1M 窗口确在生效）。上下文窗口是 model 静态属性、几乎
// 不变 → 每 model 缓存 6h；无凭据/网络失败回退旧值或错误态，前端据此显「上限未知」而非编造。
const MODELS_URL = 'https://api.anthropic.com/v1/models/';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_TTL = 6 * 60 * 60_000;          // 6h
const modelCache = new Map();               // model → { at, data }
const modelInflight = new Map();            // model → Promise（并发去重）

// 打 Models API 取单个 model 的 max_input_tokens（与用量端点同一套 curl+OAuth+代理路径）
async function fetchModelLimit(model) {
  const cred = readCred();
  if (!cred) return { ok: false, model, error: 'no-credentials' };
  if (cred.expiresAt && Date.now() > cred.expiresAt) return { ok: false, model, error: 'token-expired' };
  const resp = await curlGet(MODELS_URL + encodeURIComponent(model), {
    Authorization: `Bearer ${cred.accessToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': OAUTH_BETA,
  });
  if (resp.status !== 200) return { ok: false, model, error: resp.status ? `http-${resp.status}` : `curl-${resp.err || 'failed'}` };
  let m;
  try { m = JSON.parse(resp.body); } catch { return { ok: false, model, error: 'parse-failed' }; }
  const max = Number(m.max_input_tokens);
  if (!Number.isFinite(max) || max <= 0) return { ok: false, model, error: 'no-max-input-tokens' };
  return { ok: true, model, maxInputTokens: max };
}

// 查某 model 的上下文窗口上限（TTL 缓存 + 并发去重，语义对齐 getClaudeUsage：失败若有旧值则沿用）
export async function getModelContextLimit(model) {
  const key = (model || '').trim();
  if (!key) return { ok: false, error: 'no-model' };
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < MODEL_TTL) return hit.data;
  if (modelInflight.has(key)) return modelInflight.get(key);
  const p = fetchModelLimit(key).then((data) => {
    modelInflight.delete(key);
    if (data.ok || !hit) modelCache.set(key, { at: Date.now(), data });   // 成功、或无旧值才写；失败但有旧值 → 沿用旧值
    return modelCache.get(key).data;
  }).catch(() => {
    modelInflight.delete(key);
    return hit ? hit.data : { ok: false, model: key, error: 'fetch-failed' };
  });
  modelInflight.set(key, p);
  return p;
}
