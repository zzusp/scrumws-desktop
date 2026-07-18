// Codex CLI/桌面 rollout 观察态：只读取 ~/.codex/sessions 的结构化元数据，绝不改写历史。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fmt, parse, ago } from './timeutil.js';
import { listWatchlist, upsertWatchlist, setDoneWatchlist } from './cli-watchlist.js';

const CODEX_SESSIONS = process.env.SCRUMWS_CODEX_SESSIONS || path.join(os.homedir(), '.codex', 'sessions');
const SID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ROLLOUT_RE = /rollout-[^-]+(?:-[^-]+){2}-(?<sid>[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i;

function firstLine(file, cap = 8 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = []; let total = 0; let pos = 0;
    while (total < cap) {
      const buf = Buffer.alloc(Math.min(64 * 1024, cap - total));
      const read = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!read) break;
      const slice = buf.subarray(0, read); const nl = slice.indexOf(10);
      if (nl >= 0) { chunks.push(slice.subarray(0, nl)); return Buffer.concat(chunks).toString('utf8'); }
      chunks.push(slice); total += read; pos += read;
    }
  } catch { /* unreadable rollout */ }
  finally { if (fd != null) try { fs.closeSync(fd); } catch { } }
  return '';
}

function parseMeta(file) {
  try {
    const event = JSON.parse(firstLine(file));
    const payload = event?.type === 'session_meta' ? event.payload : null;
    const sid = String(payload?.session_id || payload?.id || '').trim();
    return SID_RE.test(sid) ? { sid, cwd: payload.cwd || null, version: payload.cli_version || null, originator: payload.originator || null, model: payload.model || null } : null;
  } catch { return null; }
}

function listRollouts({ maxAgeDays = 30 } = {}) {
  const cutoff = Date.now() - Math.max(1, maxAgeDays) * 86400000;
  const items = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      let stat; try { stat = fs.statSync(file); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;
      const meta = parseMeta(file);
      if (!meta) continue;
      items.push({ ...meta, jsonlPath: file, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  };
  walk(CODEX_SESSIONS);
  return items.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function locateCodexRollout(sid) {
  if (!SID_RE.test(String(sid || ''))) return null;
  return listRollouts({ maxAgeDays: 3650 }).find((item) => item.sid === sid) || null;
}

export function readCodexCliSession(sid, jsonlPath = null) {
  let located = null;
  if (jsonlPath && fs.existsSync(jsonlPath)) {
    const stat = fs.statSync(jsonlPath);
    located = { ...parseMeta(jsonlPath), jsonlPath, mtimeMs: stat.mtimeMs, size: stat.size };
  } else {
    located = locateCodexRollout(sid);
  }
  return located?.sid === sid ? located : null;
}

function candidate(item, alreadyAdded) {
  return {
    provider: 'codex', sid: item.sid, cwd: item.cwd, gitBranch: null,
    firstUserMsg: item.originator ? `${item.originator} 会话` : 'Codex CLI 会话',
    mtime: fmt(new Date(item.mtimeMs)), sizeMb: +(item.size / 1024 / 1024).toFixed(3), jsonlPath: item.jsonlPath,
    alreadyAdded, version: item.version, model: item.model, readOnly: true,
  };
}

export function searchCodexCliSessions({ q, limit = 20, added = new Set() } = {}) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return { ok: false, error: 'q required' };
  const rows = listRollouts().filter((item) => item.sid.includes(query) || String(item.cwd || '').toLowerCase().includes(query));
  const candidates = rows.slice(0, Math.max(1, Math.min(50, Number(limit) || 20))).map((item) => candidate(item, added.has(item.sid)));
  return { ok: true, candidates, total: candidates.length };
}

export function recentCodexCliSessions({ withinMinutes = 30, limit = 30, added = new Set() } = {}) {
  const cutoff = Date.now() - Math.max(1, Math.min(1440, Number(withinMinutes) || 30)) * 60000;
  const candidates = listRollouts({ maxAgeDays: 1 }).filter((item) => item.mtimeMs >= cutoff)
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 30))).map((item) => candidate(item, added.has(item.sid)));
  return { ok: true, candidates, total: candidates.length, withinMinutes: Number(withinMinutes) || 30 };
}

export function collectCodexCliSessions(now) {
  const cards = [];
  for (const entry of listWatchlist().filter((item) => item.provider === 'codex')) {
    const located = entry.jsonlPath && fs.existsSync(entry.jsonlPath)
      ? { ...parseMeta(entry.jsonlPath), jsonlPath: entry.jsonlPath, mtimeMs: fs.statSync(entry.jsonlPath).mtimeMs, size: fs.statSync(entry.jsonlPath).size }
      : locateCodexRollout(entry.sid);
    const state = entry.archivedAt ? 'archived' : entry.doneAt ? 'done' : 'awaiting-human';
    const at = located?.mtimeMs ? fmt(new Date(located.mtimeMs)) : entry.addedAt;
    if (entry.doneAt && located?.mtimeMs && located.mtimeMs > (parse(entry.doneAt)?.getTime() || 0) + 2000) { setDoneWatchlist(entry.sid, false); }
    cards.push({
      taskKey: `cli:${entry.sid.slice(0, 8)}`, safeTaskKey: `cli__${entry.sid}`, provider: 'codex', source: 'cli', kind: 'interactive',
      title: entry.customTitle || `Codex CLI · ${entry.sid.slice(0, 8)}`, description: entry.note || null, hasCustomTitle: !!entry.customTitle,
      state, cwd: located?.cwd || null, worktreeDir: null, backgroundTaskCount: 0, outcome: state === 'done' ? 'success' : null,
      outcomeDetail: state === 'done' ? { resolvedBy: 'user' } : null, enteredAt: entry.addedAt, resolvedAt: state === 'done' ? entry.doneAt : state === 'archived' ? at : null,
      createdAt: entry.addedAt, history: [{ state: 'awaiting-human', at: entry.addedAt }, ...(entry.doneAt ? [{ state: 'done', at: entry.doneAt, by: 'user' }] : []), ...(entry.archivedAt ? [{ state: 'archived', at: entry.archivedAt, by: 'user' }] : [])],
      durationMs: null, lease: { alive: false, pid: null, claimedAt: entry.addedAt, heartbeatAt: at, heartbeatAgo: at ? ago(at, now).text : '—', intent: 'read-only', intentAt: at, durationMin: null }, humanCc: [],
      meta: { sessionId: entry.sid, sessionHistoryLen: 1, rounds: 0, totalCostUsd: 0, numTurns: 0, usage: null, lastRoundAt: at, model: located?.model || null }, business: null,
      cli: { provider: 'codex', readOnly: true, cwd: located?.cwd || null, gitBranch: null, version: located?.version || null, mode: 'read-only', jsonlPath: located?.jsonlPath || null, jsonlBytes: located?.size || 0, projectDir: null, addedAt: entry.addedAt, archivedAt: entry.archivedAt || null, doneAt: entry.doneAt || null, attachedPid: null, attachedStatus: null },
      resolvedAgo: state === 'done' ? ago(entry.doneAt, now).text : state === 'archived' ? ago(at, now).text : null, resolvedAgoSec: null, queuedAgeMin: null, isArchive: state === 'archived',
    });
  }
  return cards;
}

export function addCodexCliSession({ sid, customTitle } = {}) {
  const located = locateCodexRollout(sid);
  if (!located) return { ok: false, error: 'rollout 不存在（未在本机 ~/.codex/sessions 找到该 thread）' };
  return upsertWatchlist(sid, { provider: 'codex', customTitle: customTitle ? String(customTitle).trim().slice(0, 200) : null, jsonlPath: located.jsonlPath, projectDir: null });
}
