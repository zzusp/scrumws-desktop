// Codex CLI/桌面 rollout 观察态：只读取 ~/.codex/sessions 的结构化元数据，绝不改写历史。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

// Codex 没有像 Claude ~/.claude/sessions 那样的 session 注册表。仅将命令行里显式带该
// thread id 的本机 Codex 进程视为“外部占用”，避免把其它 Codex 会话误判为本会话。
export function readCodexAttachedSession(sid) {
  const sessionId = String(sid || '').trim();
  if (!SID_RE.test(sessionId)) return null;
  try {
    if (process.platform === 'win32') {
      // sessionId 已由 SID_RE 校验为 UUID，可安全嵌入 PowerShell 单引号字面量；避免 -Command 后的参数在
      // Windows PowerShell 中不稳定地落入 $args。
      const script = `$sid = '${sessionId}'; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($sid, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -match '(?i)codex' } | Select-Object -First 1 ProcessId, CommandLine | ConvertTo-Json -Compress`;
      const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 2500 }).trim();
      if (!raw) return null;
      const row = JSON.parse(raw);
      return Number.isFinite(Number(row?.ProcessId)) ? { pid: Number(row.ProcessId), status: 'external', cwd: null } : null;
    }
    const raw = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 2500 });
    const row = raw.split(/\r?\n/).find((line) => line.toLowerCase().includes(sessionId.toLowerCase()) && /(^|[^a-z0-9_-])codex([^a-z0-9_-]|$)/i.test(line));
    const pid = Number(row?.trim().split(/\s+/, 1)[0]);
    return Number.isFinite(pid) && pid > 0 ? { pid, status: 'external', cwd: null } : null;
  } catch { return null; }
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
  if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n');
  return '';
}

function toolInput(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return { value: value ?? null };
  try { return JSON.parse(value); } catch { return { input: value }; }
}

// rollout 的 event_msg 是可读执行轨迹，response_item 是工具调用/输出；统一成现有详情页的 message shape。
export function readCodexCliSessionHistory(sid, jsonlPath = null) {
  const located = readCodexCliSession(sid, jsonlPath);
  if (!located) return { ok: false, error: 'Codex rollout not found' };
  let lines;
  try { lines = fs.readFileSync(located.jsonlPath, 'utf8').split(/\r?\n/); }
  catch (error) { return { ok: false, error: `读取 Codex rollout 失败: ${error.message}` }; }
  const messages = [];
  let actualModel = null;
  let actualEffort = null;
  for (const line of lines) {
    if (!line) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    const payload = event.payload || {};
    const at = event.timestamp || null;
    if (event.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model.trim()) actualModel = payload.model.trim();
      if (typeof payload.effort === 'string' && payload.effort.trim()) actualEffort = payload.effort.trim();
    }
    if (event.type === 'event_msg' && payload.type === 'user_message') {
      const text = String(payload.message || '').trim();
      if (text) messages.push({ role: 'user', at, content: [{ type: 'text', text, _ts: at }] });
    } else if (event.type === 'event_msg' && payload.type === 'agent_message') {
      const text = String(payload.message || '').trim();
      if (text) messages.push({ role: 'assistant', at, content: [{ type: 'text', text, _ts: at }] });
    } else if (event.type === 'event_msg' && payload.type === 'agent_reasoning') {
      const text = String(payload.text || '').trim();
      if (text) messages.push({ role: 'assistant', at, content: [{ type: 'thinking', thinking: text, _ts: at }] });
    } else if (event.type === 'response_item' && (payload.type === 'custom_tool_call' || payload.type === 'function_call')) {
      const id = payload.call_id || payload.id;
      const name = payload.name || 'tool';
      messages.push({ role: 'assistant', at, content: [{ type: 'tool_use', id, name, input: toolInput(payload.input ?? payload.arguments), _ts: at }] });
    } else if (event.type === 'response_item' && (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output')) {
      const output = Array.isArray(payload.output) ? payload.output.map((part) => textOf(part)).filter(Boolean).join('\n') : textOf(payload.output);
      messages.push({ role: 'user', at, content: [{ type: 'tool_result', tool_use_id: payload.call_id || payload.id, content: output, is_error: false, _ts: at }] });
    }
  }
  return { ok: true, sid, cwd: located.cwd, model: actualModel, effort: actualEffort, messages, jsonlPath: located.jsonlPath };
}

export function codexMessagesToModeBSeed(messages) {
  return (messages || []).map((message) => ({
    type: 'message', provider: 'codex', at: message.at || new Date().toISOString(), message: {
      role: message.role, content: message.content || [], model: message.model || null,
    },
  }));
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
    const attached = readCodexAttachedSession(entry.sid);
    cards.push({
      taskKey: `cli:${entry.sid.slice(0, 8)}`, safeTaskKey: `cli__${entry.sid}`, provider: 'codex', source: 'cli', kind: 'interactive',
      title: entry.customTitle || `Codex CLI · ${entry.sid.slice(0, 8)}`, description: entry.note || null, hasCustomTitle: !!entry.customTitle,
      state, cwd: located?.cwd || null, worktreeDir: null, backgroundTaskCount: 0, outcome: state === 'done' ? 'success' : null,
      outcomeDetail: state === 'done' ? { resolvedBy: 'user' } : null, enteredAt: entry.addedAt, resolvedAt: state === 'done' ? entry.doneAt : state === 'archived' ? at : null,
      createdAt: entry.addedAt, history: [{ state: 'awaiting-human', at: entry.addedAt }, ...(entry.doneAt ? [{ state: 'done', at: entry.doneAt, by: 'user' }] : []), ...(entry.archivedAt ? [{ state: 'archived', at: entry.archivedAt, by: 'user' }] : [])],
      durationMs: null, lease: { alive: false, pid: null, claimedAt: entry.addedAt, heartbeatAt: at, heartbeatAgo: at ? ago(at, now).text : '—', intent: 'read-only', intentAt: at, durationMin: null }, humanCc: [],
      meta: { sessionId: entry.sid, sessionHistoryLen: 1, rounds: 0, totalCostUsd: 0, numTurns: 0, usage: null, lastRoundAt: at, model: located?.model || null }, business: null,
      externalSession: attached ? { provider: 'codex', ...attached } : null,
      cli: { provider: 'codex', readOnly: true, cwd: located?.cwd || null, gitBranch: null, version: located?.version || null, mode: 'read-only', jsonlPath: located?.jsonlPath || null, jsonlBytes: located?.size || 0, projectDir: null, addedAt: entry.addedAt, archivedAt: entry.archivedAt || null, doneAt: entry.doneAt || null, attachedPid: attached?.pid || null, attachedStatus: attached?.status || null },
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
