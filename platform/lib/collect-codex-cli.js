// Codex CLI/桌面 rollout 观察态：只读取 ~/.codex/sessions 的结构化元数据，绝不改写历史。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fmt, parse, ago } from './timeutil.js';
import { listWatchlist, upsertWatchlist, setDoneWatchlist } from './cli-watchlist.js';

const CODEX_SESSIONS = process.env.SCRUMWS_CODEX_SESSIONS || path.join(os.homedir(), '.codex', 'sessions');
// Codex Desktop/CLI 单独维护线程索引；rollout 的 session_meta 不带用户看到的会话标题。
// 该文件只读且很小，按 mtime 缓存，避免看板轮询时为每张卡重复读盘。
const CODEX_SESSION_INDEX = process.env.SCRUMWS_CODEX_SESSION_INDEX || path.join(os.homedir(), '.codex', 'session_index.jsonl');
// Codex Desktop 与 CLI 共用 sessions，但 Desktop 将“本地 thread 已在客户端建立”的信息放在
// 全局 UI state 中。Desktop 只有一个 app-server，命令行不会带具体 thread id，不能只靠进程参数判断。
const CODEX_DESKTOP_STATE = process.env.SCRUMWS_CODEX_DESKTOP_STATE || path.join(os.homedir(), '.codex', '.codex-global-state.json');
const SID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ROLLOUT_RE = /rollout-[^-]+(?:-[^-]+){2}-(?<sid>[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i;
const SID_IN_COMMAND_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/ig;
const PROCESS_CACHE_MS = 15_000;
let attachedCache = new Map();
let attachedCacheAt = 0;
let attachedRefreshRunning = false;
let desktopThreadIds = new Set();
let desktopThreadStateStamp = null;
let sessionNameCache = new Map();
let sessionNameCacheStamp = null;
// 看板轮询要根据 Codex rollout 最后一条 turn 事件判断 processing / awaiting-human，
// 但同一份 jsonl 在一轮采集内也会被详情读取。按文件 revision 缓存事件摘要，避免每秒为
// 每张卡重复扫描整份（Desktop 的一个长会话可以有数 MB）rollout。
const activityCache = new Map();

function refreshSessionNameCache() {
  let stat;
  try { stat = fs.statSync(CODEX_SESSION_INDEX); } catch { return; }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (stamp === sessionNameCacheStamp) return;
  const next = new Map();
  try {
    for (const line of fs.readFileSync(CODEX_SESSION_INDEX, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const id = String(row?.id || '').trim();
      const name = String(row?.thread_name || '').trim();
      if (SID_RE.test(id) && name) next.set(id.toLowerCase(), name.slice(0, 200));
    }
  } catch {
    // 保留上一份完整缓存，避免索引正被 Codex 原子更新时标题闪空。
    return;
  }
  sessionNameCache = next;
  sessionNameCacheStamp = stamp;
}

function sessionNameOf(sid) {
  return sessionNameCache.get(String(sid).toLowerCase()) || null;
}

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
    return SID_RE.test(sid) ? {
      sid, cwd: payload.cwd || null, version: payload.cli_version || null, originator: payload.originator || null, model: payload.model || null,
      sessionName: sessionNameOf(sid),
    } : null;
  } catch { return null; }
}

function listRollouts({ maxAgeDays = 30 } = {}) {
  // 一轮收集只检查一次 session_index；不能放到 parseMeta 里按每个 rollout stat/read。
  refreshSessionNameCache();
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

  // Codex Desktop can leave several rollout files for the same thread id (for
  // example when the thread has been opened by more than one client).  They are
  // alternate local recordings of one conversation, not separate sessions.
  // The add-session picker must therefore expose one row per thread.  Keep the
  // most recently written rollout: it is the one a subsequent add/resume should
  // observe, while the sid remains the stable identity used everywhere else.
  const newestBySid = new Map();
  for (const item of items) {
    const key = item.sid.toLowerCase();
    const current = newestBySid.get(key);
    if (!current || item.mtimeMs > current.mtimeMs || (item.mtimeMs === current.mtimeMs && item.size > current.size)) {
      newestBySid.set(key, item);
    }
  }
  return [...newestBySid.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function locateCodexRollout(sid) {
  if (!SID_RE.test(String(sid || ''))) return null;
  return listRollouts({ maxAgeDays: 3650 }).find((item) => item.sid === sid) || null;
}

export function readCodexCliSession(sid, jsonlPath = null) {
  refreshSessionNameCache();
  let located = null;
  if (jsonlPath && fs.existsSync(jsonlPath)) {
    const stat = fs.statSync(jsonlPath);
    located = { ...parseMeta(jsonlPath), jsonlPath, mtimeMs: stat.mtimeMs, size: stat.size };
  } else {
    located = locateCodexRollout(sid);
  }
  return located?.sid === sid ? located : null;
}

function refreshDesktopThreadIds() {
  let stat;
  try { stat = fs.statSync(CODEX_DESKTOP_STATE); } catch { return; }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (stamp === desktopThreadStateStamp) return;
  let state;
  try { state = JSON.parse(fs.readFileSync(CODEX_DESKTOP_STATE, 'utf8')); } catch { return; }
  const persisted = state?.['electron-persisted-atom-state'];
  if (!persisted || typeof persisted !== 'object') return;
  const next = new Set();
  // 该 key 由 Desktop 为 local thread 生成 client id。只把严格 UUID 的 thread 收进来，避免把
  // 其它 Electron 偏好项当成会话；Desktop 未运行时此集合不会单独触发“占用”。
  for (const key of Object.keys(persisted)) {
    const match = key.match(/^thread-client-id-v1:local%3A([a-f0-9-]+)$/i);
    if (match && SID_RE.test(match[1])) next.add(match[1].toLowerCase());
  }
  desktopThreadIds = next;
  desktopThreadStateStamp = stamp;
}

function isCodexDesktopHost(row, command) {
  const name = String(row?.name ?? row?.Name ?? '');
  // Windows Store Desktop 主进程；排除 Chromium renderer / utility 子进程。
  return /^chatgpt\.exe$/i.test(name)
    && /[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe/i.test(command)
    && !/\s--type=/i.test(command);
}

function updateAttachedCache(rows) {
  const next = new Map();
  const desktopHosts = [];
  for (const row of rows || []) {
    const pid = Number(row?.pid ?? row?.ProcessId);
    const command = String(row?.command ?? row?.CommandLine ?? '');
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (isCodexDesktopHost(row, command)) desktopHosts.push(pid);
    if (!/(^|[^a-z0-9_-])codex([^a-z0-9_-]|$)/i.test(command)) continue;
    for (const sid of command.match(SID_IN_COMMAND_RE) || []) next.set(sid.toLowerCase(), { pid, status: 'external', cwd: null });
  }
  // 精确命令行 session id 的进程优先；仅它不存在时再以正在运行的 Desktop host + Desktop
  // 已登记 thread 做保守占用。Desktop 关闭后不会残留该信号，历史 JSONL 不会被误判为活跃。
  refreshDesktopThreadIds();
  const desktopPid = desktopHosts[0] || null;
  if (desktopPid) {
    for (const sid of desktopThreadIds) {
      if (!next.has(sid)) next.set(sid, { pid: desktopPid, status: 'desktop', cwd: null, client: 'codex-desktop' });
    }
  }
  attachedCache = next;
  attachedCacheAt = Date.now();
}

function refreshAttachedCache() {
  if (attachedRefreshRunning) return;
  attachedRefreshRunning = true;
  const done = (error, stdout) => {
    attachedRefreshRunning = false;
    if (error) return;
    try {
      if (process.platform === 'win32') {
        const parsed = String(stdout || '').trim() ? JSON.parse(String(stdout).trim()) : [];
        updateAttachedCache(Array.isArray(parsed) ? parsed : [parsed]);
      } else {
        const rows = String(stdout || '').split(/\r?\n/).map((line) => {
          const match = line.trim().match(/^(\d+)\s+([\s\S]*)$/);
          return match ? { pid: Number(match[1]), command: match[2] } : null;
        }).filter(Boolean);
        updateAttachedCache(rows);
      }
    } catch { /* 保留上一份可用快照 */ }
  };
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -match '(?i)codex' } | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, done);
  } else {
    execFile('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 5000 }, done);
  }
}

// Codex 没有 Claude 的 session 注册表。进程列表在后台异步刷新成共享快照；状态采集只查缓存，
// 避免每张 Codex 卡都同步启动一次 PowerShell/CIM，把 Node 事件循环阻塞数秒。
export function readCodexAttachedSession(sid) {
  const sessionId = String(sid || '').trim();
  if (!SID_RE.test(sessionId)) return null;
  if (Date.now() - attachedCacheAt >= PROCESS_CACHE_MS) refreshAttachedCache();
  // 首轮进程快照尚未返回时，宁可短暂锁住回复也不能误把 Desktop 正在使用的会话放进并发 resume。
  // 调用方下一次 state 轮询会拿到 desktop/external 或 null 的稳定结果。
  if (attachedRefreshRunning && attachedCacheAt === 0) return { pid: null, status: 'checking', cwd: null };
  return attachedCache.get(sessionId.toLowerCase()) || null;
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

function codexActivityForLocated(located) {
  if (!located?.jsonlPath) return null;
  const revision = `${located.mtimeMs || 0}:${located.size || 0}`;
  const cached = activityCache.get(located.jsonlPath);
  if (cached?.revision === revision) return cached.value;

  let lines;
  try { lines = fs.readFileSync(located.jsonlPath, 'utf8').split(/\r?\n/); }
  catch { return cached?.value || null; }

  let createdAt = null;
  let lastAt = null;
  let model = null;
  let effort = null;
  let activeTurnId = null;
  let activeStartedAt = null;
  let turnCount = 0;
  let workMs = 0;
  const history = [];

  for (const line of lines) {
    if (!line) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    const at = event.timestamp || null;
    const atMs = at ? new Date(at).getTime() : NaN;
    if (at && !createdAt) createdAt = at;
    if (at && !Number.isNaN(atMs)) lastAt = at;
    const payload = event.payload || {};
    if (event.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model.trim()) model = payload.model.trim();
      if (typeof payload.effort === 'string' && payload.effort.trim()) effort = payload.effort.trim();
      continue;
    }
    if (event.type !== 'event_msg') continue;
    if (payload.type === 'task_started') {
      const turnId = String(payload.turn_id || '').trim() || null;
      activeTurnId = turnId || '__unknown__';
      activeStartedAt = at || null;
      turnCount += 1;
      if (at) history.push({ state: 'processing', at: fmt(new Date(at)) });
    } else if (payload.type === 'task_complete') {
      // task_complete 是 Codex 对一轮生成的明确收敛信号；不能用 jsonl 的 mtime
      // 推断成 awaiting-human（最新 task_started 尚未 complete 时会被误判）。
      const duration = Number(payload.duration_ms);
      if (Number.isFinite(duration) && duration > 0) workMs += duration;
      activeTurnId = null;
      activeStartedAt = null;
      if (at) history.push({ state: 'awaiting-human', at: fmt(new Date(at)) });
    } else if (payload.type === 'turn_aborted') {
      // 中断的 turn 也不再处于 processing；后续 task_started 会重新切回 processing。
      activeTurnId = null;
      activeStartedAt = null;
      if (at) history.push({ state: 'awaiting-human', at: fmt(new Date(at)), by: 'turn aborted' });
    }
  }
  const value = {
    createdAt: createdAt ? fmt(new Date(createdAt)) : null,
    lastAt: lastAt ? fmt(new Date(lastAt)) : null,
    lastAtMs: lastAt ? new Date(lastAt).getTime() : null,
    model, effort, turnCount, workMs,
    isRunning: !!activeTurnId,
    activeStartedAt: activeStartedAt ? fmt(new Date(activeStartedAt)) : null,
    // rollout 中可能有 session_meta / 设置等事件而没有可运行 turn；这时保留空动态，
    // 由 collect 的 addedAt 兜底，不伪造一条「正在执行」。
    history,
  };
  activityCache.set(located.jsonlPath, { revision, value });
  // 防止用户持续切换目录、旧 rollout 缓存无限增长；当前 watchlist 通常远小于此阈值。
  if (activityCache.size > 160) activityCache.delete(activityCache.keys().next().value);
  return value;
}

// 供收集层与验证脚本读取的轻量摘要；不会返回正文消息。
export function readCodexCliSessionActivity(sid, jsonlPath = null) {
  const located = readCodexCliSession(sid, jsonlPath);
  if (!located) return { ok: false, error: 'Codex rollout not found' };
  return { ok: true, sid, ...codexActivityForLocated(located) };
}

// rollout 的 event_msg 是可读执行轨迹，response_item 是工具调用/输出；统一成现有详情页的 message shape。
export function readCodexCliSessionHistory(sid, jsonlPath = null) {
  const located = readCodexCliSession(sid, jsonlPath);
  if (!located) return { ok: false, error: 'Codex rollout not found' };
  const activity = codexActivityForLocated(located);
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
  return {
    ok: true, sid, cwd: located.cwd, sessionName: located.sessionName || sessionNameOf(sid),
    model: actualModel || activity?.model || null, effort: actualEffort || activity?.effort || null,
    messages, jsonlPath: located.jsonlPath,
    // 详情侧栏同样使用 round.ccSummary.workMs；把 rollout task_complete 中的真实
    // duration_ms 透传过去，避免 Codex 卡的「工作时长」永远显示为 —。
    workMs: activity?.workMs || 0,
    turnCount: activity?.turnCount || 0,
  };
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
    firstUserMsg: item.sessionName || (item.originator ? `${item.originator} 会话` : 'Codex CLI 会话'),
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
  // watchlist 已保存 jsonlPath 时不会经过 listRollouts，仍需在整轮卡片收集前刷新一次标题索引。
  refreshSessionNameCache();
  const cards = [];
  for (const entry of listWatchlist().filter((item) => item.provider === 'codex')) {
    const located = entry.jsonlPath && fs.existsSync(entry.jsonlPath)
      ? { ...parseMeta(entry.jsonlPath), jsonlPath: entry.jsonlPath, mtimeMs: fs.statSync(entry.jsonlPath).mtimeMs, size: fs.statSync(entry.jsonlPath).size }
      : locateCodexRollout(entry.sid);
    const activity = located ? codexActivityForLocated(located) : null;
    // 手动完成后如果 JSONL 有新的真实事件，说明用户已经在 Desktop/外部终端继续该
    // thread；清掉 done 标记，再按照最新 task_started/task_complete 判态。
    let doneAt = entry.doneAt || null;
    const lastActivityMs = activity?.lastAtMs ?? located?.mtimeMs ?? 0;
    if (doneAt && lastActivityMs > (parse(doneAt)?.getTime() || 0) + 2000) {
      setDoneWatchlist(entry.sid, false);
      doneAt = null;
    }
    const state = entry.archivedAt ? 'archived' : doneAt ? 'done' : activity?.isRunning ? 'processing' : 'awaiting-human';
    const at = activity?.lastAt || (located?.mtimeMs ? fmt(new Date(located.mtimeMs)) : entry.addedAt);
    const createdAt = activity?.createdAt || entry.addedAt;
    const history = [...(activity?.history || [])];
    if (!history.length && createdAt) history.push({ state: state === 'processing' ? 'processing' : 'awaiting-human', at: createdAt });
    if (doneAt) history.push({ state: 'done', at: doneAt, by: 'user' });
    if (entry.archivedAt) history.push({ state: 'archived', at: entry.archivedAt, by: 'user' });
    const attached = readCodexAttachedSession(entry.sid);
    cards.push({
      taskKey: `cli:${entry.sid.slice(0, 8)}`, safeTaskKey: `cli__${entry.sid}`, provider: 'codex', source: 'cli', kind: 'interactive',
      title: entry.customTitle || located?.sessionName || sessionNameOf(entry.sid) || `Codex CLI · ${entry.sid.slice(0, 8)}`, description: entry.note || null, hasCustomTitle: !!entry.customTitle,
      state, cwd: located?.cwd || null, worktreeDir: null, backgroundTaskCount: 0, outcome: state === 'done' ? 'success' : null,
      outcomeDetail: state === 'done' ? { resolvedBy: 'user' } : null, enteredAt: createdAt, resolvedAt: state === 'done' ? doneAt : state === 'archived' ? at : null,
      createdAt, history,
      // 与 Claude CLI 卡相同：总耗时展示真实 session 首事件到末活动的墙钟；不是用户
      // 将它加入看板之后的时长，避免历史会话的动态数据整体后移。
      durationMs: activity?.createdAt && at ? Math.max(0, new Date(at.replace(' ', 'T')) - new Date(activity.createdAt.replace(' ', 'T'))) : null,
      lease: { alive: state === 'processing', pid: attached?.pid || null, claimedAt: createdAt, heartbeatAt: at, heartbeatAgo: at ? ago(at, now).text : '—', intent: activity?.isRunning ? 'task_started' : 'task_complete', intentAt: at, durationMin: createdAt ? Math.max(0, Math.round((now - parse(createdAt)) / 60000)) : null }, humanCc: [],
      meta: { sessionId: entry.sid, sessionHistoryLen: 1, rounds: activity?.turnCount || 0, totalCostUsd: 0, numTurns: activity?.turnCount || 0, usage: null, lastRoundAt: at, model: activity?.model || located?.model || null, effort: activity?.effort || null, workMs: activity?.workMs || 0 }, business: null,
      externalSession: attached ? { provider: 'codex', ...attached } : null,
      cli: { provider: 'codex', readOnly: true, cwd: located?.cwd || null, gitBranch: null, version: located?.version || null, mode: 'read-only', jsonlPath: located?.jsonlPath || null, jsonlBytes: located?.size || 0, projectDir: null, addedAt: entry.addedAt, archivedAt: entry.archivedAt || null, doneAt, attachedPid: attached?.pid || null, attachedStatus: attached?.status || null },
      resolvedAgo: state === 'done' ? ago(doneAt, now).text : state === 'archived' ? ago(at, now).text : null, resolvedAgoSec: null, queuedAgeMin: null, isArchive: state === 'archived',
    });
  }
  return cards;
}

export function addCodexCliSession({ sid, customTitle } = {}) {
  const located = locateCodexRollout(sid);
  if (!located) return { ok: false, error: 'rollout 不存在（未在本机 ~/.codex/sessions 找到该 thread）' };
  return upsertWatchlist(sid, { provider: 'codex', customTitle: customTitle ? String(customTitle).trim().slice(0, 200) : null, jsonlPath: located.jsonlPath, projectDir: null });
}
