// Read-only daily usage aggregation for Codex rollouts.  Codex writes a
// token_count event after each completed turn; last_token_usage is incremental
// for that turn, while total_token_usage is cumulative for the thread.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSIONS_DIR = process.env.SCRUMWS_CODEX_SESSIONS || path.join(os.homedir(), '.codex', 'sessions');
const DAYS = 30;
const TTL = 5 * 60_000;
const SID_RE = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i;

let cache = { at: 0, data: null, account: null };
let inflight = null;

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function emptyDays(now) {
  const rows = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i); d.setHours(0, 0, 0, 0);
    rows.push({ date: dayKey(d), input: 0, output: 0, cache: 0, total: 0, platform: 0 });
  }
  return rows;
}

function recentRollouts(cutMs) {
  // One desktop thread can have several rollout recordings.  They are mirrors,
  // not separate usage, so only scan the most recently written file per thread.
  const newest = new Map();
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const match = entry.name.match(SID_RE);
      if (!match) continue;
      let stat; try { stat = fs.statSync(file); } catch { continue; }
      if (stat.mtimeMs < cutMs) continue;
      const sid = match[1].toLowerCase();
      const previous = newest.get(sid);
      if (!previous || stat.mtimeMs > previous.mtimeMs || (stat.mtimeMs === previous.mtimeMs && stat.size > previous.size)) {
        newest.set(sid, { sid, file, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  };
  walk(SESSIONS_DIR);
  return [...newest.values()];
}

function readUsage(value) {
  const inputRaw = Number(value?.input_tokens) || 0;
  const cacheRead = Number(value?.cached_input_tokens) || 0;
  const cacheWrite = Number(value?.cache_write_input_tokens) || 0;
  // reasoning_output_tokens is a subset diagnostic of output_tokens in Codex
  // (total_tokens === input_tokens + output_tokens), so do not add it again.
  const output = Number(value?.output_tokens) || 0;
  // Codex's input_tokens already includes cache reads/writes.  Expose the
  // same non-overlapping input/output/cache columns used by the Claude table.
  const input = Math.max(0, inputRaw - cacheRead - cacheWrite);
  const cache = cacheRead + cacheWrite;
  const total = Number(value?.total_tokens);
  return { input, output, cache, total: Number.isFinite(total) && total > 0 ? total : input + output + cache };
}

function accountOf(rateLimits, at) {
  const primary = rateLimits?.primary;
  if (!primary || !Number.isFinite(Number(primary.used_percent))) return null;
  const windowMinutes = Number(primary.window_minutes) || null;
  const resetsAtSeconds = Number(primary.resets_at);
  return {
    ok: true,
    source: 'session-jsonl',
    observedAt: at,
    planType: rateLimits?.plan_type || null,
    primary: {
      pct: Number(primary.used_percent),
      windowMinutes,
      resetsAt: Number.isFinite(resetsAtSeconds) && resetsAtSeconds > 0 ? resetsAtSeconds * 1000 : null,
    },
    secondary: rateLimits?.secondary && Number.isFinite(Number(rateLimits.secondary.used_percent)) ? {
      pct: Number(rateLimits.secondary.used_percent),
      windowMinutes: Number(rateLimits.secondary.window_minutes) || null,
      resetsAt: Number(rateLimits.secondary.resets_at) > 0 ? Number(rateLimits.secondary.resets_at) * 1000 : null,
    } : null,
  };
}

async function scan(platformSessionIds) {
  const now = new Date();
  const cutMs = now.getTime() - DAYS * 86400_000;
  const rows = emptyDays(now);
  const byDate = new Map(rows.map((row) => [row.date, row]));
  let latestAccount = null;
  let latestAccountMs = 0;
  for (const rollout of recentRollouts(cutMs)) {
    let text;
    try { text = await fs.promises.readFile(rollout.file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.indexOf('"token_count"') === -1) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event?.type !== 'event_msg' || event?.payload?.type !== 'token_count') continue;
      const atMs = Date.parse(event.timestamp || '');
      const account = accountOf(event.payload.rate_limits, event.timestamp || null);
      if (account && Number.isFinite(atMs) && atMs >= latestAccountMs) { latestAccount = account; latestAccountMs = atMs; }
      if (!Number.isFinite(atMs) || atMs < cutMs) continue;
      const row = byDate.get(dayKey(new Date(atMs)));
      const usage = readUsage(event.payload.info?.last_token_usage);
      if (!row || usage.total <= 0) continue;
      row.input += usage.input; row.output += usage.output; row.cache += usage.cache; row.total += usage.total;
      if (platformSessionIds?.has(rollout.sid)) row.platform += usage.total;
    }
  }
  return { rows, account: latestAccount };
}

// Returns null during the first asynchronous scan.  This keeps /api/state
// polling non-blocking even when the local Codex history is large.
export function getCodexDailyUsage(platformSessionIds = new Set()) {
  if ((!cache.data || Date.now() - cache.at >= TTL) && !inflight) {
    inflight = scan(platformSessionIds)
      .then(({ rows, account }) => { cache = { at: Date.now(), data: rows, account }; return rows; })
      .finally(() => { inflight = null; });
  }
  return cache.data;
}

export function codexUsageSnapshot() {
  return cache.account || { ok: false, error: 'pending', source: 'session-jsonl' };
}
