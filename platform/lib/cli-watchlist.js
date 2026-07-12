// CLI session watchlist：用户显式加入看板的本机 claude CLI session sid 白名单。
// 存储：runtime/cli-watchlist.json；schema { sessions: { <sid>: {addedAt, customTitle?, note?} } }
// 不占 runner-state/：CLI session 数据源是 CC 官方 jsonl，白名单只存 sid 元数据。
import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';
import { fmt } from './timeutil.js';

const FILE = path.join(P.tmpDir, 'cli-watchlist.json');
const SID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function readRaw() {
  try {
    const txt = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(txt);
    if (!j || typeof j !== 'object' || !j.sessions) return { sessions: {} };
    return j;
  } catch {
    return { sessions: {} };
  }
}

function writeRaw(obj) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

export function isValidSid(sid) {
  return typeof sid === 'string' && SID_RE.test(sid);
}

export function readWatchlist() {
  return readRaw();
}

export function listWatchlist() {
  const { sessions } = readRaw();
  return Object.entries(sessions).map(([sid, meta]) => ({ sid, ...meta }));
}

export function hasWatchlist(sid) {
  if (!isValidSid(sid)) return false;
  return !!readRaw().sessions[sid];
}

export function upsertWatchlist(sid, { customTitle = null, note = null, jsonlPath = null, projectDir = null } = {}) {
  if (!isValidSid(sid)) return { ok: false, error: 'invalid sid' };
  const w = readRaw();
  const now = fmt(new Date());
  const prev = w.sessions[sid] || {};
  w.sessions[sid] = {
    addedAt: prev.addedAt || now,
    customTitle: customTitle === '' ? null : (customTitle ?? prev.customTitle ?? null),
    note: note === '' ? null : (note ?? prev.note ?? null),
    // add 时定位一次 jsonl，后续 collect 免扫 500+ 项目目录；文件被删/搬则 collect 时兜底重扫
    jsonlPath: jsonlPath || prev.jsonlPath || null,
    projectDir: projectDir || prev.projectDir || null,
    // 手动归档时间戳（用户主动"收起来"；null=未归档，走 mtime 自动判态）
    archivedAt: prev.archivedAt || null,
    // 手动完成时间戳（人工判定会话已完成 → 落 done 态；会话之后又有活动 collect 会自动清、退出 done）
    doneAt: prev.doneAt || null,
  };
  writeRaw(w);
  return { ok: true, sid, entry: w.sessions[sid] };
}

export function removeWatchlist(sid) {
  if (!isValidSid(sid)) return { ok: false, error: 'invalid sid' };
  const w = readRaw();
  if (!w.sessions[sid]) return { ok: true, removed: false };
  delete w.sessions[sid];
  writeRaw(w);
  return { ok: true, removed: true };
}

// 手动归档 / 取消归档：只写 archivedAt 字段。归档 = 强制落已归档桶；取消归档 = 恢复 mtime 自动判态
export function setArchivedWatchlist(sid, archived) {
  if (!isValidSid(sid)) return { ok: false, error: 'invalid sid' };
  const w = readRaw();
  if (!w.sessions[sid]) return { ok: false, error: 'sid not in watchlist' };
  w.sessions[sid].archivedAt = archived ? fmt(new Date()) : null;
  writeRaw(w);
  return { ok: true, sid, archivedAt: w.sessions[sid].archivedAt };
}

// 手动完成 / 取消完成：只写 doneAt 字段。done = 落 done 态（优先级低于归档、高于存活推导）；
// 取消完成 = 清 doneAt 回落存活自动判态。注意：collect 时若 doneAt 之后 jsonl 又有新活动，会自动清 doneAt（会话又跑起来了）。
export function setDoneWatchlist(sid, done) {
  if (!isValidSid(sid)) return { ok: false, error: 'invalid sid' };
  const w = readRaw();
  if (!w.sessions[sid]) return { ok: false, error: 'sid not in watchlist' };
  w.sessions[sid].doneAt = done ? fmt(new Date()) : null;
  writeRaw(w);
  return { ok: true, sid, doneAt: w.sessions[sid].doneAt };
}
