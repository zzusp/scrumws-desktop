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
import { detectWorktreeBase } from './git.js';

// CC 会话 jsonl 根：默认 ~/.claude/projects；SCRUMWS_CC_PROJECTS 可覆盖（沙箱验证隔离用，对齐 SCRUMWS_* 约定）
const CC_PROJECTS = process.env.SCRUMWS_CC_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
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

// 后台任务启动后超过死线仍未被终态 <task-notification> 配平 → 视为已结束、兜底剔除。
// 会话崩溃 / 通知真丢时不能把看板永久钉在"N 个后台任务运行中"；真卡死超此阈值的极少，
// 宁可少报不永久误报。Monitor 另有自带硬死线（见 bgLaunchTtlMs），比此统一阈值精确。
const BG_STALE_MS = 15 * 60 * 1000;
const BG_TTL_GRACE_MS = 60 * 1000;   // 自带死线的宽限：到点杀进程 + 落通知有延迟

// 终态 status：只有它们代表后台任务真结束。stopped = CC 在会话 resume 时对上轮遗留后台命令的对账补发。
const TERMINAL_STATUS = new Set(['completed', 'failed', 'killed', 'stopped']);

// 读 CC 原生落盘的 toolUseResult（tool_result 行的兄弟字段，CC 侧写入）：该 tool_result 是否"起了一个
// 后台任务"。命中返回该任务自带的硬死线 ttl(ms)，0 = 无声明死线（落 BG_STALE_MS）；null = 不是后台启动。
// 四类后台任务的结构化签名互斥（实测全库 1682 个 jsonl，键签名两两不重叠）：
//   Agent 后台 subagent                → isAsync:true（status=async_launched）
//   Bash/PowerShell run_in_background  → backgroundTaskId（含超预算自动转后台；前台命令无此键）
//   Monitor（恒后台）                   → taskId + timeoutMs + persistent
//   Workflow 动态工作流（恒后台）        → taskType:'local_workflow'（status=async_launched + runId + workflowName）
// 为什么不匹配回执文案（"Command running in background with ID" / "Async agent launched successfully"）：
// 命令自身 stdout 可能原样含该串（实测 10 条误命中，全是打印过该串的脚本输出），且真后台命令另有变体
// 文案会漏；toolUseResult 由 CC 写入，命令输出污染不到。判据纯净度实测：13355 条前台命令全部无
// backgroundTaskId；Agent 的 isAsync 与锚定字符串 41/41 一致。
function bgLaunchTtlMs(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.isAsync === true) return 0;
  if (r.backgroundTaskId) return 0;
  // Workflow：整条工作流（编排若干 subagent）在后台跑，无自带死线。它的 subagent 落在自己的
  // transcriptDir、不进主 jsonl，故整条工作流按一个后台任务计。死线锚点另算，见 lastActivityMs。
  if (r.taskType === 'local_workflow') return 0;
  // Monitor 的 timeoutMs 是 CC 的硬死线（到点必杀进程），persistent 则跑到 TaskStop / 会话结束
  if (r.taskId && typeof r.timeoutMs === 'number' && typeof r.persistent === 'boolean') {
    return r.persistent ? 0 : r.timeoutMs;
  }
  return null;
}

// Workflow 的「最后活动时刻」= transcriptDir 里最新文件的 mtime（0 = 取不到）。
// 为什么 workflow 不能像 subagent / 后台命令那样用「启动至今」比 BG_STALE_MS：workflow 编排多个 subagent、
// 实测单次跑 3～31min，还盯完过一条跑满 108.9min 才收尾的 —— 15min 死线会在它干到第 15 分钟时抹掉它、
// 之后 90 多分钟一直错报"没有后台任务"，而这恰是最该显示的那种。它又没有心跳可用：主 jsonl 从启动到终态只有一条记录（实测在跑的 w302v3gbz
// 全文件仅 1 次命中），tasks/<taskId>.output 恒 0 字节且 mtime 停在启动时刻 —— 两者都判不了活。
// CC 在 toolUseResult 给了 transcriptDir（该工作流的 subagent 全落那），拿它当锚点即可把判据从
// "跑了多久"换成"多久没动静"：长工作流不误杀，会话崩了也照样在 15min 静默后自然收敛。
// 只看目录里文件的 mtime，不看目录自身：NTFS 的目录 mtime 只在增删条目时更新，文件内容追加不刷新。
function lastActivityMs(dir) {
  let newest = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const m = fs.statSync(path.join(dir, name)).mtimeMs;
        if (m > newest) newest = m;
      } catch { }
    }
  } catch { return 0; }
  return newest;
}

// <task-notification> 的三种落盘载体（实测全库终态通知：queue-operation 506 / attachment 298 / user 195
// 条）——只认 user 会漏掉大多数完成通知，launched 便永远配不平、看板永久误报 processing。
function taskNotificationText(o) {
  if (o.type === 'user' && typeof o.message?.content === 'string') return o.message.content;
  if (o.type === 'attachment' && o.attachment?.commandMode === 'task-notification') return o.attachment.prompt;
  if (o.type === 'queue-operation' && typeof o.content === 'string') return o.content;
  return null;
}

// 统计会话 jsonl 里"当前在跑的后台任务"数（后台 subagent + 后台命令 + Monitor）——对 headless
// (entrypoint=sdk-cli，task-runner 的 claude -p) 与交互(entrypoint=cli) 会话统一。
// 为什么不用 pendingBackgroundAgentCount：它只挂在 system/turn_duration 事件上，而 turn_duration
// 仅交互会话写、headless -p 根本不写（实测 262 个 sdk-cli 会话该事件全为 0）——对 manual/file 等
// 走 task-runner 的任务恒 0，不通用。
// 通用信号（三类后台任务同构，两种会话都有）：
//   启动：tool_result 的 toolUseResult 命中后台签名（见 bgLaunchTtlMs），记其 tool_use_id
//   完成：<task-notification> 携带 <tool-use-id> + 终态 <status>，与启动的 tool_use_id 精确匹配
//   当前在跑 = 启动集合 − 完成集合 − 过死线（每个后台任务停时都 fire 终态通知，用集合去重）
export function countRunningBackgroundTasks(jsonlPath, now = Date.now()) {
  let content;
  try { content = fs.readFileSync(jsonlPath, 'utf8'); } catch { return 0; }
  // launched: tool_use_id → { at: 启动时刻, ttl: 自带死线, key: TaskStop 寻址用的任务 id }
  const launched = new Map(), done = new Set(), stopped = new Set();
  for (const line of content.split(/\r?\n/)) {
    // 粗筛：只 parse 可能相关的行（后台启动回执 / 完成通知 / TaskStop 回执），大 jsonl 省 JSON.parse。
    // 前四个键与 bgLaunchTtlMs 的签名一一对应，改判据要同步改这里。
    if (!line.includes('"isAsync":true') && !line.includes('"backgroundTaskId":"')
      && !line.includes('"timeoutMs":') && !line.includes('"local_workflow"')
      && !line.includes('"task_id":"')
      && !line.includes('<task-notification>')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    // 完成：仅终态通知才配平。Monitor 的每条事件也发 <task-notification>（无 tool-use-id / 无 status）、
    // 后台命令卡交互输入时发的"疑似阻塞"提醒带 tool-use-id 但无 status——都不是结束，不能据此配平。
    const notif = taskNotificationText(o);
    if (notif && notif.includes('<task-notification>')) {
      const id = notif.match(/<tool-use-id>(toolu_[^<]+)<\/tool-use-id>/);
      const st = notif.match(/<status>(\w+)<\/status>/);
      if (id && st && TERMINAL_STATUS.has(st[1])) done.add(id[1]);
      continue;
    }
    const r = o.toolUseResult;
    // TaskStop 主动停掉的后台任务不发终态通知（leak TaskStopTool.ts 的 call() 只 stopTask、无 enqueue），
    // 只能读 TaskStop 自己的成功回执 { message, task_id, task_type, command } 配平——否则会一直挂到死线。
    // persistent Monitor 只能靠 TaskStop 结束，不认这条就必然误报。
    if (r?.task_id && r.task_type) { stopped.add(r.task_id); continue; }
    // 启动：tool_result 行的 toolUseResult 命中后台签名；行时间戳 = 后台任务启动时刻
    const ttl = bgLaunchTtlMs(r);
    if (ttl === null || !Array.isArray(o.message?.content)) continue;
    const at = Date.parse(o.timestamp) || 0;
    const key = r.taskId || r.backgroundTaskId || r.agentId || null;   // TaskStop 按此 id 寻址
    // workflow 判活锚点（见 lastActivityMs）；其余三类无此需求，dir=null 时仍按启动时刻比死线
    const dir = r.taskType === 'local_workflow' ? (r.transcriptDir || null) : null;
    for (const b of o.message.content) {
      if (b?.type === 'tool_result' && b.tool_use_id) launched.set(b.tool_use_id, { at, ttl, key, dir });
    }
  }
  let n = 0;
  for (const [id, { at, ttl, key, dir }] of launched) {
    if (done.has(id) || (key && stopped.has(key))) continue;
    // 死线锚点：一般后台任务按启动时刻；workflow 按它最后一次有动静的时刻（长工作流不误杀，见 lastActivityMs）
    const anchor = dir ? Math.max(at, lastActivityMs(dir)) : at;
    // 锚点已久仍未配平 → 会话崩溃 / 通知丢失（见 BG_STALE_MS），兜底剔除避免永久误报
    if (anchor && now > anchor + (ttl > 0 ? ttl + BG_TTL_GRACE_MS : BG_STALE_MS)) continue;
    n++;
  }
  return n;
}

// 经 sessionId 定位 jsonl 再统计——runner-state 任务无 jsonlPath，靠 meta.sessionId 反查。
export function backgroundTaskCountBySid(sid) {
  if (!sid) return 0;
  const found = locateJsonlBySid(sid);
  return found ? countRunningBackgroundTasks(found.jsonlPath) : 0;
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
      // jsonl 真消失：返回 stub 卡片让用户能看到 + 移除。
      // 手动态（archivedAt/doneAt）与正常路径同优先级照常生效——jsonl 没了只是推不出存活态，
      // 不代表用户点的归档/完成不算数。曾漏此判：归档已写进 watchlist，卡片却恒停在 awaiting-human
      // 桶，而「移除」只在归档区渲染 → 脏卡永远清不掉（2026-07-16）。
      const stubState = sidEntry.archivedAt ? 'archived' : sidEntry.doneAt ? 'done' : 'awaiting-human';
      return {
        taskKey: `cli:${sid.slice(0, 8)}`,
        safeTaskKey: `cli__${sid}`,
        title: sidEntry.customTitle || `cli:${sid.slice(0, 8)}（jsonl 已消失）`,
        hasCustomTitle: !!sidEntry.customTitle,
        description: sidEntry.note || null,
        source: 'cli',
        kind: null,
        state: stubState,
        cwd: null,
        worktreeDir: null,
        backgroundTaskCount: 0,
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
        cli: { cwd: null, gitBranch: null, version: null, mode: null, jsonlPath: null, jsonlBytes: 0, projectDir: null, attachedPid: null, attachedStatus: null },
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
  // 后台任务计数（统一维度，见 countRunningBackgroundTasks）。会话进程活着才算数——后台任务是该
  // 进程的子进程，进程死则后台必随之结束，历史 jsonl 里未配平的 launched 便是陈旧值。
  const backgroundTaskCount = countRunningBackgroundTasks(jsonlPath);
  const sessionAlive = !!(boardState || att || replyRunnerPid);
  let state;
  if (sidEntry.archivedAt) state = 'archived';
  else if (doneAt) state = 'done';
  else if (boardState) state = boardState === 'idle' ? 'awaiting-human' : 'processing';
  else if (att) state = att.status === 'busy' ? 'processing' : 'awaiting-human';
  else if (replyRunnerPid) state = 'processing';
  else state = 'awaiting-human';
  // 后台维度：主 agent 已收敛(awaiting-human)但会话活 + 仍有后台任务在跑 → 整体仍 processing。
  // 主进程只是让出等后台完成（CC 自动注入 <task-notification> 唤醒续跑），任务未结束。
  if (state === 'awaiting-human' && sessionAlive && backgroundTaskCount > 0) state = 'processing';

  const createdAt = first?.timestamp ? fmt(new Date(first.timestamp)) : sidEntry.addedAt;
  const lastActivity = last?.timestamp ? fmt(new Date(last.timestamp)) : fmt(new Date(mtimeMs));
  // cwd/git/version：att（CC 注册表活进程，最新值）> 事件里首条带该字段的真实行（末尾侧优先，更新）。
  // 不再直接用 first/last —— 它们可能恰是不带 cwd/git 的元事件（queue-operation/last-prompt）。
  const cwd = att?.cwd || lastEnv?.cwd || firstEnv?.cwd || null;
  // 工作目录不变量：卡片展示的工作目录取 base 仓库根；会话跑在 worktree 里时 worktree 路径另记 worktreeDir。
  // cli.cwd 保留会话实际运行目录（resume 须回原目录，见 cli-actions rewind/reply）。
  const wtc = cwd ? detectWorktreeBase(cwd) : { isWorktree: false, baseCwd: null };
  const baseCwd = wtc.baseCwd;
  const worktreeDir = wtc.isWorktree ? cwd : null;
  const gitBranch = lastEnv?.gitBranch || firstEnv?.gitBranch || null;
  const version = lastEnv?.version || firstEnv?.version || null;
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
    // 工作目录/worktree 目录（与 runner 任务同字段）：cwd=base 仓库根供卡片展示，worktreeDir=实际 worktree 运行目录
    cwd: baseCwd,
    worktreeDir,
    // 统一后台维度（runner/cli 同字段）：>0 = 该会话仍有后台任务在跑，卡片/详情据此渲染
    backgroundTaskCount,
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
