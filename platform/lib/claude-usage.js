import { readConfig } from './runner-config.js';
import { execFile } from 'node:child_process';

// 本模块两职责，都不由桌面直接打 Anthropic 端点：
//   1) 模型上下文窗口上限（详情页环形分母）：读设置页配置的映射表。
//   2) 账号级用量（session / 本周）：spawn 官方 `claude -p "/usage"`，解析其输出。
//
// 背景：桌面曾用本机 OAuth 凭据 curl 打 api.anthropic.com（oauth/usage 取用量、/v1/models 取上限）。
// 用订阅 token 以非官方客户端身份主动打端点有账号风控风险，故全部改掉——
//   · 上下文上限：改读本地配置（下方 DEFAULT_MODEL_LIMITS + 用户覆盖）。
//   · 账号用量：改为 spawn 官方 CLI 的 `/usage`，由 CLI 自己去查、桌面只解析文本。等同用户手敲 /usage，
//     风控视角就是「正常使用官方客户端」，而非第三方拿 token 打端点。

// ============ 1) 模型上下文窗口上限（读配置）============

// CLI --model 白名单对应的上下文窗口上限（与 session-manager.js ALLOWED_MODELS 对齐）。
// 历史实测：opus / opus-4-7 / sonnet-5 / fable = 1,000,000、haiku = 200,000；同家族按此推断，用户可在设置页修正。
const DEFAULT_MODEL_LIMITS = {
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-1': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-5': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
};

// 内置默认 + 用户配置合并（用户配置覆盖同名默认）。供设置页回填「当前生效映射」。
export function modelContextLimits() {
  const cfg = readConfig().modelContextLimits;
  return { ...DEFAULT_MODEL_LIMITS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
}

// 查某 model 的上下文窗口上限：命中配置/默认映射 → { ok, model, maxInputTokens }；未命中 → { ok:false, error }。
export function getModelContextLimit(model) {
  const key = (model || '').trim();
  if (!key) return { ok: false, error: 'no-model' };
  const max = Number(modelContextLimits()[key]);
  if (Number.isFinite(max) && max > 0) return { ok: true, model: key, maxInputTokens: max };
  return { ok: false, model: key, error: 'no-config' };
}

// ============ 2) 账号级用量（spawn 官方 CLI 的 /usage）============

const CLAUDE_BIN = 'claude';
const USAGE_TIMEOUT_MS = 30_000;               // `claude -p /usage` 实测约 11-13s，留足余量
const DEFAULT_POLL_SEC = 600;                  // 默认 10min：spawn 一个 claude 进程较重，比原 curl 拉长
const MIN_POLL_SEC = 120, MAX_POLL_SEC = 3600; // 夹 [2min, 1h]
const usagePollSec = () => Math.min(MAX_POLL_SEC, Math.max(MIN_POLL_SEC, Number(readConfig().usagePollSec) || DEFAULT_POLL_SEC));

let cache = { at: 0, data: null };   // 定时器写入的最近一次结果；getClaudeUsage / usageSnapshot 只读它
let inflight = null;                 // tick 去重
let pollTimer = null;                // setTimeout handle（非固定 setInterval，见下方随机抖动排程）
let stopped = true;                  // 定时器是否已停（未 start / 一次性拉取时为 true）
let poll = { lastRunAt: null, nextRunAt: null, lastOk: null, lastError: null };

// 把 resets 人类可读串解析成 epoch ms（供前端算「X 后刷新」相对倒计时）。
// 格式如 "Jul 16, 2:40pm (Asia/Shanghai)" / "Jul 20, 2am (Asia/Shanghai)"（无年份、12h 制、可省分钟）。
// 机器时区即该时区（本机 Asia/Shanghai），按本地时间构造 Date。resets 恒在未来：解析成 >1 天前的过去 → 判跨年 +1。
// 解析不了返回 null，前端回退直显原串。
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseResetAt(s) {
  const m = String(s || '').match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  const mi = MONTHS[m[1].toLowerCase()];
  if (mi == null) return null;
  let hr = Number(m[3]) % 12;
  if (/pm/i.test(m[5])) hr += 12;
  const min = m[4] ? Number(m[4]) : 0;
  const now = new Date();
  let d = new Date(now.getFullYear(), mi, Number(m[2]), hr, min, 0, 0);
  if (d.getTime() < now.getTime() - 86400_000) d = new Date(now.getFullYear() + 1, mi, Number(m[2]), hr, min, 0, 0);
  return d.getTime();
}

// 解析 `claude -p /usage` 的 stdout。三行格式（实测稳定）：
//   Current session: 12% used · resets Jul 16, 2:40pm (Asia/Shanghai)
//   Current week (all models): 2% used · resets Jul 20, 2am (Asia/Shanghai)
//   Current week (Fable): 0% used
// 每窗口带 pct、原始 resets 文本、以及解析出的 resetsAt（epoch ms | null）。
export function parseUsage(text) {
  const raw = String(text || '');
  const lines = raw.split('\n').map((l) => l.trim());
  const subscription = /using your subscription/i.test(raw);
  const pick = (labelRe) => {
    for (const l of lines) {
      const m = l.match(labelRe);
      if (m) {
        const resets = (m[2] || '').trim() || null;
        return { pct: Number(m[1]), resets, resetsAt: parseResetAt(resets) };
      }
    }
    return null;
  };
  const session = pick(/^Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+))?$/i);
  const weekAll = pick(/^Current week \(all models\):\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+))?$/i);
  // 「Current week (Fable)」按需求不展示，故不解析。
  if (!session && !weekAll) return { ok: false, error: 'parse-failed' };
  return { ok: true, subscription, session, weekAll };
}

// spawn 官方 CLI 查用量。Windows 须 shell:true 执行 claude.cmd（CVE-2024-27980 后 Node 拒绝无 shell spawn .cmd）。
// --no-session-persistence：/usage 每次会新建一个 session jsonl（实测落 ~/.claude/projects 下、无 assistant/token
// 故不污染用量统计，但会堆积空 session 文件 + 进 /resume 列表）。该 flag（仅 --print 生效）让本次查询不落盘，
// 不留 session，无需事后清理。
function fetchUsage() {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['-p', '/usage', '--no-session-persistence'], {
      timeout: USAGE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1 << 20,
      shell: process.platform === 'win32',
    }, (err, stdout) => {
      if (!stdout) return resolve({ ok: false, error: err ? `cli-${err.code || err.message}` : 'no-output' });
      resolve(parseUsage(stdout));
    });
  });
}

// 定时 tick：唯一真 spawn CLI 的地方。拉取 → 写缓存 → 记录本轮实况。inflight 去重。
// 失败时若已有旧数据则沿用（不把进度条闪空），无旧数据才存错误态。
function tickUsage() {
  if (inflight) return inflight;
  inflight = fetchUsage().then((data) => {
    inflight = null;
    if (data.ok) cache = { at: Date.now(), data };
    else if (!cache.data) cache = { at: Date.now(), data };
    poll.lastRunAt = Date.now();
    poll.lastOk = !!data.ok;
    poll.lastError = data.ok ? null : data.error;
    return cache.data;
  }).catch((e) => {
    inflight = null;
    poll.lastRunAt = Date.now();
    poll.lastOk = false;
    poll.lastError = String(e?.message || e);
    return cache.data;
  });
  return inflight;
}

// /api/claude-usage + collectState 用：纯读定时器最近一次结果，绝不主动 spawn（打点频率严格 = 定时器间隔）。
export async function getClaudeUsage() {
  return cache.data || { ok: false, error: 'pending' };
}

// collectState 用：账号用量 + 定时器实况（供运行时面板展示 session/本周 + 刷新时间）
export function usageSnapshot() {
  return { data: cache.data, poll: { intervalSec: usagePollSec(), ...poll } };
}

// 下一次延迟：基准间隔叠加随机抖动 [0.6, 1.6) 倍（默认 10min → 实际落在 6–16min 随机）。
// 关键：绝不用固定 setInterval——固定心跳是明显的自动化信号，易被风控识别；每拉一次都重掷一个随机延迟。
function nextDelayMs() {
  return Math.round(usagePollSec() * 1000 * (0.6 + Math.random()));
}

// 递归排程：每次用不同的随机延迟安排下一拉。先清旧 handle 防并发重排叠出两个定时器。
function scheduleNext() {
  if (stopped) { poll.nextRunAt = null; return; }
  if (pollTimer) clearTimeout(pollTimer);
  const ms = nextDelayMs();
  poll.nextRunAt = Date.now() + ms;
  pollTimer = setTimeout(() => { tickUsage().finally(scheduleNext); }, ms);
  pollTimer.unref?.();
}

// 启动定时器：立即拉一次，之后按随机抖动间隔递归排程。重复调用先停旧定时器。
export function startUsageTimer() {
  stopped = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  tickUsage().finally(scheduleNext);
  return usagePollSec();
}

// 间隔变更后热更：定时器在跑才按新基准重排（立即用新节奏拉一次）
export function reloadUsageTimer() { if (!stopped) startUsageTimer(); }
