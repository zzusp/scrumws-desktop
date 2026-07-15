// /api/cli/* 端点后端逻辑：搜索候选 sid + add/remove watchlist。
// 数据源：~/.claude/projects/<encoded-cwd>/*.jsonl（CC 官方历史），只读扫描；不动 jsonl 本体。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fmt } from './timeutil.js';
import * as watchlist from './cli-watchlist.js';
import { locateJsonlBySid, isCliSessionActive } from './collect-cli.js';
import { collectKnownSessionIds } from './logs.js';

// 「已在看板」判据：候选 sid 命中 watchlist（显式加入的 CLI 会话）∪ 全库任务包的 sessionId/sessionHistory
// （分身 / adopt 到 Mode B 的任务，其会话 sid 不落 watchlist）。按 sessionId 判，避免同一会话被重复添加成两张卡。
function boardSessionIds() {
  const set = collectKnownSessionIds();
  for (const sid of Object.keys(watchlist.readWatchlist().sessions)) set.add(sid);
  return set;
}

// 默认 ~/.claude/projects；SCRUMWS_CC_PROJECTS 可覆盖（沙箱验证隔离用，对齐 SCRUMWS_* 约定）
const CC_PROJECTS = process.env.SCRUMWS_CC_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const SID_FILE_RE = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i;

// 罗列所有 <projectDir>/<sid>.jsonl，返回 stat（mtime/size）+ 路径。
// 关键字搜时用；UUID 前缀走 targeted lookup 更快。
function listAllJsonl({ maxAgeDays = 30 } = {}) {
  const now = Date.now();
  const cutoff = now - maxAgeDays * 24 * 3600 * 1000;
  let projects = [];
  try { projects = fs.readdirSync(CC_PROJECTS); } catch { return []; }
  const items = [];
  for (const projectDir of projects) {
    const dir = path.join(CC_PROJECTS, projectDir);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const m = SID_FILE_RE.exec(f);
      if (!m) continue;
      const sid = m[1];
      const p = path.join(dir, f);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      items.push({ sid, projectDir, jsonlPath: p, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

// 从 jsonl 头 N 字节提取首条真人 user message（前 60 字）+ 真实 cwd（event 直接带）
function extractHeadPreview(jsonlPath, bytes = 32768) {
  const result = { firstUserMsg: null, cwd: null, gitBranch: null };
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const buf = Buffer.alloc(Math.min(bytes, size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
      for (const line of lines) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!result.cwd && e.cwd) result.cwd = e.cwd;
        if (!result.gitBranch && e.gitBranch) result.gitBranch = e.gitBranch;
        if (!result.firstUserMsg && e.type === 'user' && !e.isMeta) {
          const c = typeof e.message?.content === 'string' ? e.message.content
                  : Array.isArray(e.message?.content) ? e.message.content.map((x) => x?.text || '').join(' ')
                  : '';
          const s = c.trim();
          if (s && !/^<local-command-|^<command-name>|^<system-reminder>|^<user-prompt-submit-hook>/.test(s)) {
            result.firstUserMsg = s.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) || null;
          }
        }
        if (result.firstUserMsg && result.cwd && result.gitBranch) break;
      }
    } finally { fs.closeSync(fd); }
  } catch { }
  return result;
}

// 关键字快搜：读 head 32KB 判断是否包含所有关键词
function jsonlMatchesKeywords(jsonlPath, keywords) {
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const buf = Buffer.alloc(Math.min(32768, size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString('utf8').toLowerCase();
      return keywords.every((kw) => text.includes(kw));
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

// 命中词前后取一小段上下文（earliest 命中居中，附省略号），供搜索结果展示「为什么命中」
function windowAround(text, keywords, before, after) {
  const lower = text.toLowerCase();
  let hit = -1;
  let hitLen = 0;
  for (const kw of keywords) {
    const i = lower.indexOf(kw);
    if (i >= 0 && (hit < 0 || i < hit)) { hit = i; hitLen = kw.length; }
  }
  if (hit < 0) return null;
  const start = Math.max(0, hit - before);
  const end = Math.min(text.length, hit + hitLen + after);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// 关键字命中片段：与过滤同一语料（head 32KB），保证每个命中行都能给出上下文。
// 两级取值：① 优先从可读对话正文（user/assistant 文本，跳过命令/系统注入）取——命中在对话里给干净片段；
//          ② 回退从原始 head 文本取并清洗 JSON 转义——命中落在工具结果/元数据时也能展示上下文。
function extractMatchSnippet(jsonlPath, keywords, { bytes = 32768, before = 50, after = 90 } = {}) {
  let raw = '';
  const parts = [];
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const buf = Buffer.alloc(Math.min(bytes, size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      raw = buf.toString('utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if ((e.type !== 'user' && e.type !== 'assistant') || e.isMeta) continue;
        const c = typeof e.message?.content === 'string' ? e.message.content
                : Array.isArray(e.message?.content) ? e.message.content.map((x) => x?.text || '').join(' ')
                : '';
        const s = c.replace(/\s+/g, ' ').trim();
        if (s && !/^<local-command-|^<command-name>|^<system-reminder>|^<user-prompt-submit-hook>/.test(s)) parts.push(s);
      }
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  // ① 可读对话正文
  const pretty = windowAround(parts.join('  ·  '), keywords, before, after);
  if (pretty) return pretty;
  // ② 回退：原始 head 清洗后取窗口（消掉 JSON 转义与多余空白）
  const cleaned = raw.replace(/\\u[0-9a-fA-F]{4}/g, ' ').replace(/\\[nrt"\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  return windowAround(cleaned, keywords, before, after);
}

const HEX_RE = /^[a-f0-9-]{6,}$/i;

// POST /api/cli/search
// body: { q: string, limit?: 20 }
// - q 全为 hex/dash 且 ≥6 字符 → UUID 前缀模式（跨全部项目目录直接命中）
// - 否则关键字 → 近 30d 内 jsonl 头 32KB grep（避免全文扫）
export function searchCliSessions({ q, limit = 20 } = {}) {
  const query = String(q || '').trim();
  if (!query) return { ok: false, error: 'q required' };
  const addedSet = boardSessionIds();
  const items = listAllJsonl({ maxAgeDays: 30 });
  const isHex = HEX_RE.test(query);
  let keywords = [];
  let candidates;
  if (isHex) {
    const qLower = query.toLowerCase();
    candidates = items.filter((it) => it.sid.toLowerCase().startsWith(qLower) || it.sid.toLowerCase().includes(qLower));
  } else {
    keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    candidates = items.filter((it) => jsonlMatchesKeywords(it.jsonlPath, keywords));
  }
  candidates = candidates.slice(0, Math.max(1, Math.min(50, Number(limit) || 20)));
  const result = candidates.map((it) => {
    const head = extractHeadPreview(it.jsonlPath);
    return {
      sid: it.sid,
      projectDir: it.projectDir,
      cwd: head.cwd,
      gitBranch: head.gitBranch,
      firstUserMsg: head.firstUserMsg,
      // 关键字搜索时给出命中上下文片段 + 命中词，供前端高亮展示（sid 前缀搜索无此需求）
      matchSnippet: isHex ? null : extractMatchSnippet(it.jsonlPath, keywords),
      matchKeywords: isHex ? null : keywords,
      mtime: fmt(new Date(it.mtimeMs)),
      sizeMb: +(it.size / 1024 / 1024).toFixed(3),
      jsonlPath: it.jsonlPath,
      alreadyAdded: addedSet.has(it.sid),
    };
  });
  return { ok: true, candidates: result, total: candidates.length };
}

// GET /api/cli/recent —— 添加弹窗默认列表：近 N 分钟内活跃（jsonl mtime）的 CLI session，免关键字
// 复用 listAllJsonl（已按 mtime 倒序）+ head 预览，返回结构与 searchCliSessions 的 candidates 一致
export function recentCliSessions({ withinMinutes = 30, limit = 30 } = {}) {
  const mins = Math.max(1, Math.min(1440, Number(withinMinutes) || 30));
  const addedSet = boardSessionIds();
  const cutoff = Date.now() - mins * 60 * 1000;
  const items = listAllJsonl({ maxAgeDays: 1 }).filter((it) => it.mtimeMs >= cutoff);
  const picked = items.slice(0, Math.max(1, Math.min(50, Number(limit) || 30)));
  const candidates = picked.map((it) => {
    const head = extractHeadPreview(it.jsonlPath);
    return {
      sid: it.sid,
      projectDir: it.projectDir,
      cwd: head.cwd,
      gitBranch: head.gitBranch,
      firstUserMsg: head.firstUserMsg,
      mtime: fmt(new Date(it.mtimeMs)),
      sizeMb: +(it.size / 1024 / 1024).toFixed(3),
      jsonlPath: it.jsonlPath,
      alreadyAdded: addedSet.has(it.sid),
    };
  });
  return { ok: true, candidates, total: candidates.length, withinMinutes: mins };
}

// 近 30 天 CLI session 的 cwd 去重列表（本机常用工作目录来源）—— 新建任务「选已有工作目录」下拉用
export function sessionCwds({ limit = 60 } = {}) {
  const items = listAllJsonl({ maxAgeDays: 30 }).slice(0, Math.max(1, Math.min(300, Number(limit) || 60)));
  const seen = new Set();
  for (const it of items) {
    const head = extractHeadPreview(it.jsonlPath, 8192);   // cwd 在首个 event，读 8KB 足够
    const c = String(head.cwd || '').trim();
    if (c) seen.add(c);
  }
  return [...seen];
}

// POST /api/cli/add
// body: { sid: string, customTitle?: string }
export function addCliSession({ sid, customTitle } = {}) {
  if (!watchlist.isValidSid(sid)) return { ok: false, error: 'invalid sid（需完整 uuid）' };
  const located = locateJsonlBySid(sid);
  if (!located) return { ok: false, error: 'jsonl not found（sid 在本机 ~/.claude/projects 下不存在）' };
  const r = watchlist.upsertWatchlist(sid, {
    customTitle: customTitle ? String(customTitle).trim().slice(0, 200) : null,
    jsonlPath: located.jsonlPath,
    projectDir: located.projectDir,
  });
  if (!r.ok) return r;
  return { ok: true, sid, taskKey: `cli:${sid.slice(0, 8)}`, entry: r.entry };
}

// POST /api/cli/remove?sid=<uuid>  或  body { sid }
export function removeCliSession({ sid } = {}) {
  if (!watchlist.isValidSid(sid)) return { ok: false, error: 'invalid sid' };
  return watchlist.removeWatchlist(sid);
}

// 原地 rewind：改写历史 user 消息并从那里重新执行（对齐 CC 交互 double-Esc rewind 语义：
// 同一 session、同一张卡片）。本函数只负责「截断」：把原 jsonl 截到目标消息之前（写回原文件，sid 不变）
// → 返回 { sid, cwd } 交前端收养成 Mode B live 会话（createSession(resume=sid) + 把改写后的消息作新一轮
// 从截断处叶子重跑，同「续接」路径）。不再走已废弃的 cli-reply-runner.ps1（桌面版脚本资产不随数据根走，
// 方向是无 ps1、一律 Mode B 引擎）。截掉的时间线直接丢弃（2026-07-10 用户拍板：不做备份）。
// guard：终端进程占用时拒绝——终端内存持有完整会话状态，动文件会错乱；且终端里本来就有原生 rewind。
export function rewindCliSession({ taskKey, uuid, message } = {}) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'message required' };
  if (!uuid || !/^[a-f0-9-]{36}$/i.test(String(uuid))) return { ok: false, error: 'invalid uuid（目标消息）' };
  const shortSid = String(taskKey || '').replace(/^cli:/, '');
  const w = watchlist.readWatchlist();
  const entry = Object.entries(w.sessions).find(([sid]) => sid.startsWith(shortSid));
  if (!entry) return { ok: false, error: 'cli session not in watchlist' };
  const [sid, meta] = entry;

  // guard ①：活终端进程占用 → 拒绝（会撞终端内存态；终端里请用 CC 原生 rewind：连按两次 Esc）
  const attached = readAttachedSessions();
  const att = attached.get(sid);
  if (att) {
    return { ok: false, error: `session 正被终端进程占用（pid=${att.pid}），不能改写历史。请在那个终端里连按两次 Esc 用 CC 原生 rewind` };
  }

  let jsonlPath = meta?.jsonlPath;
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    const found = locateJsonlBySid(sid);
    if (!found) return { ok: false, error: 'jsonl not found' };
    jsonlPath = found.jsonlPath;
  }

  // guard ②：真有活写者才拦——看板 Mode B 会话 running/starting、CC 注册表 busy、或 headless runner 存活。
  // 不用 jsonl mtime 阈值：CC 在轮次结束后会异步补写 last-prompt/mode/ai-title 等元事件（可滞后数分钟），
  // mtime 新 ≠ 回复在跑，会误拦已停会话（栽过：会话 16:46 停、16:51 才补 last-prompt，rewind 被误判"回复还在跑"）。
  if (isCliSessionActive(sid)) {
    return { ok: false, error: 'session 仍在运行（看板会话/终端/回复进程活着），停下后再 rewind' };
  }

  // 按行读原 jsonl，找目标消息行
  let lines;
  try { lines = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter((l) => l.trim()); }
  catch (e) { return { ok: false, error: `读 jsonl 失败: ${e.message}` }; }
  let cutIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    try {
      const o = JSON.parse(lines[i]);
      if (o.uuid === uuid && o.type === 'user') { cutIdx = i; break; }
    } catch { /* 跳过坏行 */ }
  }
  if (cutIdx < 0) return { ok: false, error: '目标消息不在该会话中（uuid 未命中）' };
  if (cutIdx === 0) return { ok: false, error: '目标是首条消息——直接新建会话更合适' };

  // cwd 先读（截断前后 head 相同，但顺序上先校验免得白截）
  const head = extractHeadPreview(jsonlPath);
  const cwd = head.cwd;
  if (!cwd || !fs.existsSync(cwd)) {
    return { ok: false, error: `session 原 cwd 不存在（${cwd || '未知'}），无法 resume` };
  }

  // 截断写回原文件（tmp + rename 原子替换；sid 不变；截掉的时间线直接丢弃）
  try {
    const tmp = jsonlPath + '.rewind-tmp';
    fs.writeFileSync(tmp, lines.slice(0, cutIdx).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, jsonlPath);
  } catch (e) {
    return { ok: false, error: `截断写回失败: ${e.message}` };
  }

  // 截断完成 → 交前端收养成 Mode B live 会话（/api/session/adopt + 改写后的消息经 live 视图发出重跑）。
  return { ok: true, sid, taskKey: `cli:${sid.slice(0, 8)}`, cwd };
}

// 看板向 CLI session 发回复：spawn cli-reply-runner.ps1 → claude --resume 追加一轮。
// guard：① 有活终端进程持有该 session → 拒绝（双进程写同一 session 会撞）；
//        ② session 正在算（headless 回复在跑）→ 拒绝
import { spawn } from 'node:child_process';
import { readAttachedSessions } from './collect-cli.js';
import { P, ROOT } from './paths.js';

const PWSH_CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
];
const PWSH_EXE = PWSH_CANDIDATES.find((p) => fs.existsSync(p)) || 'pwsh';

export function replyCliSession({ taskKey, message, model } = {}) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'message required' };
  const shortSid = String(taskKey || '').replace(/^cli:/, '');
  const w = watchlist.readWatchlist();
  const entry = Object.entries(w.sessions).find(([sid]) => sid.startsWith(shortSid));
  if (!entry) return { ok: false, error: 'cli session not in watchlist' };
  const [sid, meta] = entry;

  // guard ①：活终端进程占用
  const attached = readAttachedSessions();
  const att = attached.get(sid);
  if (att) {
    return { ok: false, error: `session 正被终端进程占用（pid=${att.pid}${att.status ? ` · ${att.status}` : ''}），请直接在那个终端里回复` };
  }

  // 定位 jsonl 拿 cwd（session 必须在原 cwd 下 resume）
  let jsonlPath = meta?.jsonlPath;
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    const found = locateJsonlBySid(sid);
    if (!found) return { ok: false, error: 'jsonl not found' };
    jsonlPath = found.jsonlPath;
  }
  const head = extractHeadPreview(jsonlPath);
  const cwd = head.cwd;
  if (!cwd || !fs.existsSync(cwd)) {
    return { ok: false, error: `session 原 cwd 不存在（${cwd || '未知'}），无法 resume` };
  }

  // guard ②：jsonl 最近 60s 内有写入 = 可能有 headless 回复在跑
  try {
    const stat = fs.statSync(jsonlPath);
    if (Date.now() - stat.mtimeMs < 60 * 1000) {
      return { ok: false, error: 'session 一分钟内有活动（可能上一条回复还在跑），稍后再试' };
    }
  } catch { /* stat 失败不拦 */ }

  const spawnErr = spawnCliReply({ sid, message: msg, model, cwd });
  if (spawnErr) return { ok: false, error: spawnErr };
  return { ok: true, taskKey: `cli:${sid.slice(0, 8)}`, spawned: true };
}

// 公共 spawn：消息落临时文件（避免命令行转义）→ detached cli-reply-runner.ps1
// 返回 null=成功，字符串=错误信息（reply / rewind 共用）
// 顺手写 runner sentinel（runtime/cli-reply-active/<sid>.json = {pid, startedAt}）——
// collect-cli 用"runner pid 是否存活"精准判 processing，runner 退出即收敛，无需 mtime 阈值猜
function spawnCliReply({ sid, message, model, cwd }) {
  const msgFile = path.join(P.tmpDir, `cli-reply-msg-${sid.slice(0, 8)}-${Date.now()}.txt`);
  try {
    fs.mkdirSync(P.tmpDir, { recursive: true });
    fs.writeFileSync(msgFile, message, 'utf8');
  } catch (e) {
    return `写消息文件失败: ${e.message}`;
  }
  const spawnLog = path.join(P.tmpDir, 'cli-reply-spawn.log');
  try {
    const errFd = fs.openSync(spawnLog, 'a');
    fs.writeSync(errFd, `\n[${new Date().toISOString()}] reply cli:${sid.slice(0, 8)} cwd=${cwd}\n`);
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(ROOT, 'scripts', 'cli-reply-runner.ps1'),
      '-Sid', sid,
      '-MessageFile', msgFile,
      '-Cwd', cwd,
    ];
    if (model) { args.push('-Model'); args.push(model); }
    const psi = spawn(PWSH_EXE, args, {
      cwd: ROOT,
      detached: false,
      stdio: ['ignore', errFd, errFd],
      windowsHide: true,
      shell: PWSH_EXE === 'pwsh',
    });
    psi.unref();
    fs.closeSync(errFd);
    // runner sentinel：pid 死了自然失效（外壳跑完即退出），无需 runner 自删
    const activeDir = path.join(P.tmpDir, 'cli-reply-active');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, `${sid}.json`), JSON.stringify({ pid: psi.pid || 0, startedAt: new Date().toISOString() }), 'utf8');
  } catch (e) {
    return `spawn 失败: ${e.message}`;
  }
  return null;
}
