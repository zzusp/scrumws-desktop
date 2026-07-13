// 反读本机 CLI session jsonl → 看板 task 卡片 schema。
// 数据源：~/.claude/projects/<encoded-cwd>/<sid>.jsonl（CC 官方历史目录），每次交互 append 一行 JSON。
// state（v4，进程信号判据，见下方 buildCliCard）：终端/回复在跑=processing，空闲=awaiting-human，archived/done 仅手动。
// done：人工标完成（watchlist.doneAt），优先级 archived > done > 存活推导；done 后 jsonl 又有活动会自动清 doneAt 退出 done。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fmt, parse, ago } from './timeutil.js';
import { listWatchlist, upsertWatchlist, setDoneWatchlist } from './cli-watchlist.js';
import { P } from './paths.js';
import { listSessions } from './session-manager.js';

const CC_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CC_SESSIONS = path.join(os.homedir(), '.claude', 'sessions');

// CC 活进程注册表：~/.claude/sessions/<pid>.json = {pid, sessionId, cwd, status: idle|busy, kind}
// 进程死后文件可能残留 → process.kill(pid,0) 判活兜底（EPERM 也算活）
function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// sessionId → { pid, status }（仅活进程）
export function readAttachedSessions() {
  const map = new Map();
  let names = [];
  try { names = fs.readdirSync(CC_SESSIONS); } catch { return map; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(CC_SESSIONS, name), 'utf8'));
      if (typeof o.pid !== 'number' || typeof o.sessionId !== 'string') continue;
      if (!pidAlive(o.pid)) continue;
      map.set(o.sessionId, { pid: o.pid, status: o.status || null, cwd: o.cwd || null });
    } catch { /* 跳过坏文件 */ }
  }
  return map;
}

// sid → 活着的 headless reply runner pid（spawnCliReply 写的 sentinel；runner 外壳跑完即退，pid 死=收敛）
function readActiveReplyRunners(tmpDir) {
  const map = new Map();
  const dir = path.join(tmpDir, 'cli-reply-active');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return map; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const sid = name.slice(0, -5);
    const file = path.join(dir, name);
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (o.pid && pidAlive(o.pid)) map.set(sid, o.pid);
      else fs.unlinkSync(file);   // pid 死 = runner 已收敛，顺手清 sentinel
    } catch { try { fs.unlinkSync(file); } catch { } }
  }
  return map;
}

// 看板持有的 Mode B 会话 state（running|idle|starting）——"在跑/等人"的权威信号。
// 会话引擎按 stream-json 事件实时维护（system/init→running, result→idle），比反读 CC 注册表的
// att.status 准：headless/sdk-cli 进程根本不写 status，只能靠这里判 processing。
// 收养会话 taskKey=cli:<short>、init 后 claudeSessionId=<sid>，两键都留兜底。
function readBoardSessions() {
  const byTask = new Map(), bySid = new Map();
  for (const s of listSessions()) {
    if (s.state === 'closed' || s.state === 'error') continue;
    if (s.taskKey) byTask.set(s.taskKey, s.state);
    if (s.claudeSessionId) bySid.set(s.claudeSessionId, s.state);
  }
  return { byTask, bySid };
}

// 单个 CLI session 的"在跑"权威信号（进程信号 v4，与 buildCliCard 卡片状态桶同源、同优先级）：
// 看板 Mode B 会话 running/starting、CC 注册表 att.status=busy、或 headless reply runner 存活 → 在跑。
// worker-log 的 inflight/state 据此判定，避免 mtime 阈值滞后卡片状态（卡片已进 awaiting-human、详情仍显示"● 实时 / 进行中"）。
export function isCliSessionActive(sid) {
  const board = readBoardSessions();
  const boardState = board.bySid.get(sid) || board.byTask.get(`cli:${sid.slice(0, 8)}`) || null;
  if (boardState) return boardState !== 'idle';
  const att = readAttachedSessions().get(sid) || null;
  if (att) return att.status === 'busy';
  return !!readActiveReplyRunners(P.tmpDir).get(sid);
}

// 全局扫 ~/.claude/projects/*/<sid>.jsonl，返回首个命中的 { jsonlPath, projectDir }。
// 加入 watchlist 时算一次即可；collect 时兜底（jsonl 被搬走/删除时会 rescan）。
export function locateJsonlBySid(sid) {
  let projects = [];
  try { projects = fs.readdirSync(CC_PROJECTS); } catch { return null; }
  for (const projectDir of projects) {
    const p = path.join(CC_PROJECTS, projectDir, `${sid}.jsonl`);
    if (fs.existsSync(p)) return { jsonlPath: p, projectDir };
  }
  return null;
}

// 小文件全读；大文件 head + tail 折中
// head 用于首条 event + 首条真人 user message
// tail 需覆盖到最近一次 turn_duration event（可能被静默的 background 事件挤远）
const FULL_READ_LIMIT = 1024 * 1024; // 1MB
const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 256 * 1024;

function readLinesSplit(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      if (size <= FULL_READ_LIMIT) {
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, 0);
        const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
        return { head: lines, tail: lines, size };
      }
      // head
      const headBuf = Buffer.alloc(HEAD_BYTES);
      fs.readSync(fd, headBuf, 0, HEAD_BYTES, 0);
      const headLines = headBuf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
      // tail（起点非 0 则首行可能被截断，丢掉）
      const tailStart = size - TAIL_BYTES;
      const tailBuf = Buffer.alloc(TAIL_BYTES);
      fs.readSync(fd, tailBuf, 0, TAIL_BYTES, tailStart);
      const tailLines = tailBuf.toString('utf8').split(/\r?\n/).filter((l) => l.trim()).slice(1);
      return { head: headLines, tail: tailLines, size };
    } finally { fs.closeSync(fd); }
  } catch { return { head: [], tail: [], size: 0 }; }
}

function tryParse(line) { try { return JSON.parse(line); } catch { return null; } }

// 从头部行里找首条 event（有 timestamp 和 sessionId），以及首条"真人 user message"（type:user && !isMeta && content 非 caveat/system 前缀）
function extractHeadInfo(headLines) {
  const events = headLines.map(tryParse).filter(Boolean);
  const first = events.find((e) => e.timestamp) || events[0] || null;
  // 真人首条 user：跳过 isMeta 和 <local-command-*> / <command-name>*
  const firstUser = events.find((e) => {
    if (e.type !== 'user' || e.isMeta) return false;
    const c = typeof e.message?.content === 'string' ? e.message.content : '';
    if (/^<local-command-|^<command-name>|^<system-reminder>|^<user-prompt-submit-hook>/.test(c.trim())) return false;
    return c.trim().length > 0;
  }) || null;
  let firstUserText = null;
  if (firstUser) {
    const c = firstUser.message?.content;
    firstUserText = (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join(' ') : '').trim();
  }
  // cwd/gitBranch/version 只挂在真实 user/assistant/attachment 行，元事件（queue-operation/last-prompt/
  // ai-title/mode）不带 → 扫首条带该字段的事件，别只认 first（首行可能恰是元事件，取空）。
  const firstEnv = events.find((e) => e.cwd || e.gitBranch || e.version) || null;
  return { first, firstUserText, firstEnv };
}

// 从尾部行里找最后一条 event，以及最后一条 turn_duration / assistant / user / mode
// turn_duration 后 CC 会追加元事件（last-prompt/ai-title/mode/permission-mode），
// 判"是否在跑"不能只看 last.type，要看核心事件（user/assistant）时间 vs turn_duration 时间
function extractTailInfo(tailLines) {
  const events = tailLines.map(tryParse).filter(Boolean);
  if (events.length === 0) return {};
  const last = events[events.length - 1];
  let lastTurn = null, lastAssistant = null, lastUser = null, lastMode = null, lastEnv = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!lastTurn && e.type === 'system' && e.subtype === 'turn_duration') lastTurn = e;
    if (!lastAssistant && e.type === 'assistant') lastAssistant = e;
    if (!lastUser && e.type === 'user') lastUser = e;
    if (!lastMode && e.type === 'mode') lastMode = e;
    if (!lastEnv && (e.cwd || e.gitBranch || e.version)) lastEnv = e;   // 末尾侧首条带 cwd/git 的真实事件
    if (lastTurn && lastAssistant && lastUser && lastMode && lastEnv) break;
  }
  return { last, lastTurn, lastAssistant, lastUser, lastMode, lastEnv };
}

// 单个 watchlist entry → 卡片对象；jsonl 缺失时返回 stub 卡片（提示"文件已消失"）
// attached / replyRunners 由调用方传入（避免每个 sid 重扫注册表）
function collectOneCli(sidEntry, now, attached, replyRunners, board) {
  const { sid } = sidEntry;
  let jsonlPath = sidEntry.jsonlPath;
  let projectDir = sidEntry.projectDir;
  // 兜底重扫：watchlist 里没记路径 或 记的路径已失效
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    const found = locateJsonlBySid(sid);
    if (found) {
      jsonlPath = found.jsonlPath;
      projectDir = found.projectDir;
      // 回写 watchlist 记住新路径
      upsertWatchlist(sid, { jsonlPath, projectDir });
    } else {
      // jsonl 真消失：返回 stub 卡片让用户能看到 + 移除
      return {
        taskKey: `cli:${sid.slice(0, 8)}`,
        safeTaskKey: `cli__${sid}`,
        title: sidEntry.customTitle || `cli:${sid.slice(0, 8)}（jsonl 已消失）`,
        hasCustomTitle: !!sidEntry.customTitle,
        description: sidEntry.note || null,
        source: 'cli',
        kind: null,
        state: 'awaiting-human',
        outcome: 'jsonl-missing',
        outcomeDetail: { failureReason: 'jsonl 文件已消失（可能被清理）' },
        enteredAt: sidEntry.addedAt,
        resolvedAt: sidEntry.addedAt,
        createdAt: sidEntry.addedAt,
        history: [],
        durationMs: null,
        lease: null,
        humanCc: [],
        meta: { sessionId: sid, sessionHistoryLen: 0, rounds: 0, totalCostUsd: 0, numTurns: 0, usage: null, lastRoundAt: null },
        business: null,
        cli: { cwd: null, gitBranch: null, version: null, pendingBackgroundAgentCount: 0, mode: null, jsonlPath: null, jsonlBytes: 0, projectDir: null, attachedPid: null, attachedStatus: null },
        resolvedAgo: '—',
        resolvedAgoSec: null,
        queuedAgeMin: null,
        isArchive: false,
      };
    }
  }

  let stat;
  try { stat = fs.statSync(jsonlPath); } catch { return null; }
  const mtimeMs = stat.mtimeMs;
  const mtimeIso = new Date(mtimeMs).toISOString();

  const { head, tail } = readLinesSplit(jsonlPath);
  const { first, firstUserText, firstEnv } = extractHeadInfo(head);
  const { last, lastTurn, lastAssistant, lastUser, lastMode, lastEnv } = extractTailInfo(tail);

  // 活进程占用（CC 官方注册表 ~/.claude/sessions/）：终端还开着 = 不能从看板回复
  const att = attached?.get(sid) || null;

  // state 判据 v4（进程信号，不用 mtime 阈值）：
  //   - 终端占用：CC 注册表 ~/.claude/sessions/ 自带实时 status（busy=在跑 / idle=等输入），直接用
  //   - headless 回复：spawnCliReply 落的 runner sentinel，pid 存活=在跑、退出=收敛（零延迟）
  //   - archived：**仅手动归档**（archivedAt）——CLI 会话不再按空闲时长自动归档（用户拍板：归档只手动）
  // 历史：v1 纯 mtime 阈值 → v2 turn_duration → v3 全事件化(仍保留 >30min 自动归档) → v4 去掉自动归档
  const replyRunnerPid = replyRunners?.get(sid) || null;
  // 手动完成（doneAt）：优先级在归档之下、存活推导之上。
  // 但若标 done 之后 jsonl 又有新活动（回终端跑 / 看板继续对话都会 append 抬 mtime）
  // → 视为"会话又跑起来了"，自动清 doneAt 退出 done、回落存活推导（用户选定语义）。+2s 防同秒误判。
  let doneAt = sidEntry.doneAt || null;
  const doneAtMs = doneAt ? parse(doneAt)?.getTime() : null;   // parse 返回 Date，取 ms 再比较（Date+number 会退化成字符串拼接）
  if (doneAtMs != null && mtimeMs > doneAtMs + 2000) {
    setDoneWatchlist(sid, false);
    doneAt = null;
  }
  // 看板持有的 Mode B 会话在跑=权威 processing 信号（sdk-cli 进程不写 att.status，只能靠它判在跑）。
  // running/starting=正在生成回复 → processing；idle=一轮收敛等下一条 → awaiting-human。
  const boardState = board ? (board.bySid.get(sid) || board.byTask.get(`cli:${sid.slice(0, 8)}`) || null) : null;
  let state;
  if (sidEntry.archivedAt) state = 'archived';
  else if (doneAt) state = 'done';
  else if (boardState) state = boardState === 'idle' ? 'awaiting-human' : 'processing';
  else if (att) state = att.status === 'busy' ? 'processing' : 'awaiting-human';
  else if (replyRunnerPid) state = 'processing';
  else state = 'awaiting-human';

  const createdAt = first?.timestamp ? fmt(new Date(first.timestamp)) : sidEntry.addedAt;
  const lastActivity = last?.timestamp ? fmt(new Date(last.timestamp)) : fmt(new Date(mtimeMs));
  // cwd/git/version：att（CC 注册表活进程，最新值）> 事件里首条带该字段的真实行（末尾侧优先，更新）。
  // 不再直接用 first/last —— 它们可能恰是不带 cwd/git 的元事件（queue-operation/last-prompt）。
  const cwd = att?.cwd || lastEnv?.cwd || firstEnv?.cwd || null;
  const gitBranch = lastEnv?.gitBranch || firstEnv?.gitBranch || null;
  const version = lastEnv?.version || firstEnv?.version || null;
  const pendingBg = Number(last?.pendingBackgroundAgentCount) || 0;
  const mode = lastMode?.mode || 'normal';

  // title：customTitle > 真人首条 user 首行（保留完整，仅上限 200 防超长；显示端再截断）> cli:<short>
  const shortSid = sid.slice(0, 8);
  let title = sidEntry.customTitle || null;
  if (!title && firstUserText) {
    const oneLine = firstUserText.split(/\r?\n/).find((l) => l.trim()) || firstUserText;
    title = oneLine.trim().slice(0, 200);
  }
  if (!title) title = `cli:${shortSid}`;

  // meta：numTurns 取末条 turn_duration.messageCount；usage v1 不算（tokens 显示 —）
  const numTurns = Number(lastTurn?.messageCount) || 0;
  const lastRoundAt = lastTurn?.timestamp ? fmt(new Date(lastTurn.timestamp)) : null;
  const lastAssistantModel = lastAssistant?.message?.model || null;

  // durationMs：createdAt → last activity 的墙钟
  const durationMs = first?.timestamp ? Math.max(0, mtimeMs - new Date(first.timestamp).getTime()) : null;

  const alive = state === 'processing';
  const leaseInfo = {
    alive,
    pid: att?.pid || null,
    claimedAt: createdAt,
    heartbeatAt: lastActivity,
    heartbeatAgo: ago(lastActivity, now).text,
    intent: last ? (last.subtype ? `${last.type}:${last.subtype}` : last.type) : null,
    intentAt: lastActivity,
    durationMin: createdAt ? Math.max(0, Math.round((now - parse(createdAt)) / 60000)) : null,
  };

  // 动态时间线：CLI 无持久 state 流转日志（state 每次 collect 现场从进程信号推导），
  // 用现成真实时间戳合成流转序列，与分身同一 {state,at,by} 结构（前端时间线零改动即渲染）。
  // 会话开跑(首条 jsonl 事件 → processing) → 收敛到等输入(末次活动 → awaiting-human) → 人工完成/归档(by:user)。
  // 在跑(processing)时不追 awaiting（仍停在开跑那条）；单事件会话(created==lastActivity)同理不重复追加。
  const history = [];
  if (createdAt) history.push({ state: 'processing', at: createdAt });
  if (state !== 'processing' && lastActivity && lastActivity !== createdAt) {
    history.push({ state: 'awaiting-human', at: lastActivity });
  }
  if (doneAt) history.push({ state: 'done', at: doneAt, by: 'user' });
  if (sidEntry.archivedAt) history.push({ state: 'archived', at: sidEntry.archivedAt, by: 'user' });

  return {
    taskKey: `cli:${shortSid}`,
    safeTaskKey: `cli__${sid}`,
    title,
    hasCustomTitle: !!sidEntry.customTitle,
    description: sidEntry.note || null,
    source: 'cli',
    kind: 'interactive',
    state,
    outcome: state === 'done' ? 'success' : null,
    enteredAt: createdAt,
    resolvedAt: state === 'archived' ? lastActivity : state === 'done' ? doneAt : null,
    // done 标 resolvedBy=user，复用卡片「人工完成」标（app.js manualDoneTag）
    outcomeDetail: state === 'done' ? { resolvedBy: 'user' } : null,
    createdAt,
    history,
    durationMs,
    lease: leaseInfo,
    humanCc: [],
    meta: {
      sessionId: sid,
      sessionHistoryLen: 1,
      rounds: numTurns > 0 ? 1 : 0,
      totalCostUsd: 0,
      numTurns,
      usage: null,
      lastRoundAt,
      model: lastAssistantModel,
    },
    business: null,
    // CLI 独有字段
    cli: {
      cwd,
      gitBranch,
      version,
      pendingBackgroundAgentCount: pendingBg,
      mode,
      jsonlPath,
      jsonlBytes: stat.size,
      projectDir,
      addedAt: sidEntry.addedAt,
      archivedAt: sidEntry.archivedAt || null,
      doneAt: doneAt || null,
      // 活进程占用：非 null = 有终端进程持有该 session（看板不可回复，去终端里继续）
      attachedPid: att?.pid || null,
      attachedStatus: att?.status || null,
    },
    resolvedAgo: state === 'archived' ? ago(lastActivity, now).text : state === 'done' ? ago(doneAt, now).text : null,
    resolvedAgoSec: state === 'archived' ? Math.max(0, Math.round((now - parse(lastActivity)) / 1000)) : state === 'done' ? Math.max(0, Math.round((now - parse(doneAt)) / 1000)) : null,
    queuedAgeMin: null,
    isArchive: false,
  };
}

// 收集所有 watchlist 里的 CLI session 卡片
export function collectCliSessions(now) {
  const list = listWatchlist();
  if (list.length === 0) return [];
  const attached = readAttachedSessions();
  const replyRunners = readActiveReplyRunners(P.tmpDir);
  const board = readBoardSessions();
  const cards = [];
  for (const entry of list) {
    try {
      const c = collectOneCli(entry, now, attached, replyRunners, board);
      if (c) cards.push(c);
    } catch (e) {
      // 单个 sid 出错不影响其他；打日志到 stderr 便于排查
      console.error(`[collect-cli] sid=${entry.sid} error:`, e.message);
    }
  }
  return cards;
}
