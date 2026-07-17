import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { P } from './paths.js';
import { fmt, parse, ago } from './timeutil.js';
import { CHECKER, checkerIntervalSec } from './jobs/checker-meta.js';
import * as scheduler from './scheduler.js';
import { readConfig } from './runner-config.js';
import { leaseAlive } from './lease.js';
import { collectCliSessions, readAttachedSessions, backgroundTaskCountBySid } from './collect-cli.js';
import { getTaskSessionId } from './task-runner.js';
import { listSessions } from './session-manager.js';
import { modelContextLimits, usageSnapshot } from './claude-usage.js';
import { getDailyUsage } from './daily-usage.js';

// ---------- 通用小工具 ----------
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
function tailLine(file, bytes = 8192) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
      return lines.length ? lines[lines.length - 1] : '';
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}
// lease alive：单份实现在 lease.js（pid 为主 + HardTTL，与 scripts/lib/runner-common.ps1 同语义）

// 卡片「最近更新时间」：取所有活动时间戳的最大值（runner 分身与 CLI 卡片同字段），供各桶统一按最新更新倒序
function taskUpdatedMs(t) {
  const lastHist = Array.isArray(t.history) && t.history.length ? t.history[t.history.length - 1].at : null;
  return Math.max(
    parse(t.createdAt)?.getTime() || 0,
    parse(t.enteredAt)?.getTime() || 0,
    parse(t.resolvedAt)?.getTime() || 0,
    parse(t.lease?.heartbeatAt)?.getTime() || 0,
    parse(t.meta?.lastRoundAt)?.getTime() || 0,
    parse(lastHist)?.getTime() || 0,
  );
}

// 后台维度派生（runner/cli 统一语义）：主 agent 一轮收敛写 awaiting-human，但若会话进程仍活着且该
// CC session 还有后台任务在跑（后台 subagent / 后台命令 / Monitor）→ 整体仍是 processing——主进程只是
// 让出等后台完成（CC 自动注入 <task-notification> 唤醒续跑），任务未结束。
// sessionAlive 判据必须含 CC 注册表活进程，不能只认看板 Mode B：task-runner 的 claude -p --resume
// 会话登记在 ~/.claude/sessions（att），看板重启后其 mbSessionId 丢失，只认 Mode B 会漏判成 awaiting。
// 会话进程死则后台任务必随之结束（是该进程子进程），sessionAlive 短路避免用陈旧的未配平 launched 误判。
// 仅对"疑似空闲的活会话"读一次 jsonl 探测：其他状态无需（processing 已在忙 / 终态无后台）。
export function deriveBackgroundState(state, sessionAlive, sessionId) {
  if (state !== 'awaiting-human' || !sessionAlive || !sessionId) {
    return { backgroundTaskCount: 0, displayState: state };
  }
  const backgroundTaskCount = backgroundTaskCountBySid(sessionId);
  return { backgroundTaskCount, displayState: backgroundTaskCount > 0 ? 'processing' : state };
}

// ---------- 采集单个任务包 ----------
function collectOne(safeTaskKey, dir, now, isArchive = false, attachedSids = null) {
  const state = readJson(path.join(dir, 'state.json'));
  const task  = readJson(path.join(dir, 'task.json'));
  const meta  = readJson(path.join(dir, 'meta.json'));
  const lease = readJson(path.join(dir, 'lease.json'));
  const business = readJson(path.join(dir, 'business.json'));

  // 无 state 就跳（还没跑过的空目录）——除非有 lease（刚 spawn 未写 state）
  if (!state && !lease) return null;

  // taskKey：state 里可能没有、从 task.json 或 safeKey 逆推（<source>__<slug> → <source>:<slug>）
  let taskKey = task?.taskKey || null;
  if (!taskKey) taskKey = safeTaskKey.includes('__') ? safeTaskKey.replace('__', ':') : safeTaskKey;

  const source = task?.source || (taskKey.includes(':') ? taskKey.split(':')[0] : 'unknown');
  const kind = task?.kind || null;

  // lease 信息
  const leaseInfo = lease && leaseAlive(lease, now) ? {
    alive: true,
    pid: lease.pid || null,
    claimedAt: lease.claimedAt || null,
    heartbeatAt: lease.heartbeatAt || null,
    heartbeatAgo: lease.heartbeatAt ? ago(lease.heartbeatAt, now).text : '—',
    intent: lease.intent || null,
    intentAt: lease.intentAt || null,
    durationMin: lease.claimedAt ? Math.max(0, Math.round((now - parse(lease.claimedAt)) / 60000)) : null,
  } : (lease ? { alive: false, pid: lease.pid || null, claimedAt: lease.claimedAt || null } : null);

  // 归一化到面板视图
  const effectiveState = state?.state || 'queued';   // 无 state.json 时视为 queued（罕见）
  const enteredAt = state?.enteredAt || null;
  const resolvedAt = state?.resolvedAt || null;
  const history = Array.isArray(state?.history) ? state.history : [];
  // 总执行时长：createdAt → resolvedAt(终态)/now(进行中)；无 createdAt 时退回到 history 第一条 at
  const startAt = task?.createdAt || history[0]?.at || null;
  const endAt = resolvedAt || fmt(now);
  const durationMs = startAt && endAt
    ? Math.max(0, (parse(endAt)?.getTime() ?? 0) - (parse(startAt)?.getTime() ?? 0))
    : null;

  // chat 侧真人 cc: 提取已随分身链移除；交互任务标题走 task.title（字段保留 [] 供前端 schema 兼容）
  const humanCc = [];

  // 标题优先级：用户 customTitle（rename 写入）> task.title > taskKey
  const title = task?.customTitle || task?.title || taskKey;

  // 内存中活跃 Mode B 会话 id（有=会话进程活，idle-but-alive 也在）
  const mbSessionId = getTaskSessionId(taskKey);
  // 会话活性：看板 Mode B 活会话 ∪ CC 注册表(~/.claude/sessions)里有活进程持有该 sessionId
  // （task-runner 的 claude -p --resume 也登记在 att，看板重启后 mbSessionId 丢失仍据此判活）
  const sessionAlive = !!mbSessionId || (meta?.sessionId && attachedSids ? attachedSids.has(meta.sessionId) : false);
  // 后台维度（统一：与 cli 任务同字段 backgroundTaskCount）
  const { backgroundTaskCount, displayState } = deriveBackgroundState(effectiveState, sessionAlive, meta?.sessionId);

  return {
    taskKey,
    safeTaskKey,
    title,
    hasCustomTitle: !!task?.customTitle,
    description: task?.description || null,   // 纯用户备注（看板编辑，不进 prompt）
    cwd: task?.cwd || null,                   // 任务配置的工作目录（新建/编辑时写入 task.json）；awaiting 卡片非失败态展示
    effort: task?.effort || null,             // 推理档位（新建/编辑写入）；详情侧栏展示
    model: task?.model || null,               // 任务配置的模型（云端对账指纹需感知其变化）
    // prompt 指纹：原文最长 100000 字符，塞进卡片会撑爆 /api/state（前端全量轮询）——只放 40 字节
    // 指纹，云端对账据此感知 prompt 改动，原文由 connector 单独读 task.json 上传。两者都取自已读入的
    // task 对象，零额外 I/O。
    promptSha: task?.prompt ? sha1(task.prompt) : null,
    scheduledAt: task?.scheduledAt || null,   // 定时执行时刻（plan 到点自动执行）；提升后清空
    worktree: !!task?.worktree,               // 是否 worktree 隔离运行
    baseBranch: task?.baseBranch || null,     // worktree 签出基分支（配置）
    worktreeBranch: meta?.worktreeBranch || null,  // 实际建出的 worktree 分支（运行态，meta）
    worktreeDir: meta?.worktreeDir || null,        // 实际 worktree 目录（运行态，meta）
    dynamicWorkflow: task?.dynamicWorkflow == null ? null : !!task?.dynamicWorkflow,  // 动态工作流开关
    source,
    kind,
    state: displayState,
    backgroundTaskCount,
    outcome: state?.outcome || null,
    enteredAt,
    resolvedAt,
    outcomeDetail: state?.outcomeDetail || null,
    createdAt: task?.createdAt || null,
    history,
    durationMs,
    lease: leaseInfo,
    humanCc,
    // 内存中活跃 Mode B 会话 id（有则详情页接 /api/session/stream 实时渲染；无=会话已收敛/未起）
    mbSessionId,
    // meta 关键字段
    meta: meta ? {
      sessionId: meta.sessionId || null,
      sessionHistoryLen: Array.isArray(meta.sessionHistory) ? meta.sessionHistory.length : 0,
      rounds: meta.rounds || 0,
      totalCostUsd: meta.totalCostUsd || 0,
      numTurns: meta.numTurns || 0,
      usage: meta.usage || null,
      lastRoundAt: meta.lastRoundAt || null,
    } : null,
    // business tag（issue 侧）
    business: business ? {
      awaitingInfo: !!business.awaitingInfo,
      commentUrl: business.commentUrl || null,
      closedAt: business.closedAt || null,
      closedReason: business.closedReason || null,
    } : null,
    // 用于 done 分区排序
    resolvedAgo: resolvedAt ? ago(resolvedAt, now).text : null,
    resolvedAgoSec: resolvedAt ? Math.max(0, Math.round((now - parse(resolvedAt)) / 1000)) : null,
    // 用于 queued 分区标红：queued > 2min 未起
    queuedAgeMin: (effectiveState === 'queued' && enteredAt) ? Math.round((now - parse(enteredAt)) / 60000) : null,
    isArchive,
  };
}

// ---------- 汇总所有任务包 ----------
function collectAll(now) {
  // cancelled 不再是独立 state（2026-07-10 并入 awaiting-human，outcome=cancelled 记录"谁停的"）；旧值落 other 仍可见
  // plan = 待用户确认的计划态（queued 之前；per-source 配置或 manual 勾选"先计划"进入）
  const buckets = { plan: [], processing: [], queued: [], done: [], 'awaiting-human': [], archived: [], other: [] };
  // CC 注册表活进程的 sessionId 集合（读一次，供 collectOne 判会话活性——含 task-runner 的 claude -p --resume）
  const attachedSids = new Set(readAttachedSessions().keys());
  const scan = (root, isArchive) => {
    let names = [];
    try { names = fs.readdirSync(root); } catch { return; }
    for (const name of names) {
      const dir = path.join(root, name);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      const task = collectOne(name, dir, now, isArchive, attachedSids);
      if (!task) continue;
      // 「真正处理过」判据：只过滤阶段 2 迁移进来的历史（outcomeDetail.migratedFrom 有值 = migration by 标记）
      // 新建/运行中的任务（无论跑成功/中/失败）都要显示——processing/queued 阶段无 meta 也是"正在处理"
      if (task.outcomeDetail?.migratedFrom) continue;
      if (isArchive) { buckets.archived.push(task); continue; }
      const s = task.state;
      if (buckets[s]) buckets[s].push(task);
      else buckets.other.push(task);
    }
  };
  scan(P.runnerRoot, false);
  scan(P.archiveRoot, true);

  // CLI session 卡片（用户显式加入 watchlist 的本机 claude 会话；不写 runner-state/，纯反读 jsonl）
  // 三态映射：processing / awaiting-human / archived（大于 30min 自动落归档区，不占活跃桶）
  for (const cli of collectCliSessions(now)) {
    // 收养会话按 taskKey 反查活会话 id（getTaskSessionId 内含 session-manager 兜底）→ 详情据此进 live 模式
    cli.mbSessionId = getTaskSessionId(cli.taskKey);
    if (cli.state === 'archived') { cli.isArchive = true; buckets.archived.push(cli); }
    else if (buckets[cli.state]) buckets[cli.state].push(cli);
    else buckets.other.push(cli);
  }

  // 统一「最近活动」字段（复用 taskUpdatedMs，与排序同源）：卡片显示 + 各桶按其倒序。
  // runner 分身与 CLI 会话共用同一时间戳全集，卡片跨来源一致展示「最后一次活动时间」。
  for (const b of Object.values(buckets)) {
    for (const t of b) {
      const ms = taskUpdatedMs(t);
      t.lastActivityMs = ms || null;
      t.lastActivityAt = ms ? fmt(new Date(ms)) : null;
      t.lastActivityAgo = ms ? ago(fmt(new Date(ms)), now).text : null;
    }
    b.sort((a, x) => (x.lastActivityMs || 0) - (a.lastActivityMs || 0));
  }
  return buckets;
}

// ---------- Claude Code 运行时探测（版本 / 路径 / 在线，缓存 5min）----------
// online 语义：本机能解析并执行 `claude --version` = 在线可用；失败（未装/PATH 缺失）= 离线。
// 探测走后台 execFile 不阻塞 /api/state；模块加载即触发首探，TTL 到点后台重探，读缓存返回。
// 不硬编码 .cmd：Windows 下配 shell 由 PATHEXT 解析，原生装(claude.exe) / npm 全局装(claude.cmd) 皆可命中
const CLAUDE_BIN = 'claude';
const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which';
const RT_DETECT_TTL = 5 * 60 * 1000;
let claudeRt = { detectedAt: 0, online: null, version: null, binPath: null };   // online:null=检测中
let rtDetecting = false;

function detectClaudeRuntime() {
  if (rtDetecting) return;
  if (claudeRt.detectedAt && Date.now() - claudeRt.detectedAt < RT_DETECT_TTL) return;
  rtDetecting = true;
  // Windows 须走 shell：CVE-2024-27980 后 Node 拒绝无 shell spawn .cmd（同步抛 EINVAL 崩溃启动）；shell 亦让 PATHEXT 解析 claude.exe/.cmd
  execFile(CLAUDE_BIN, ['--version'], { timeout: 5000, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout) => {
    if (err) {
      claudeRt = { detectedAt: Date.now(), online: false, version: null, binPath: null };
      rtDetecting = false;
      return;
    }
    // "2.1.207 (Claude Code)" → 取版本号；无法匹配则原样 trim
    const version = (String(stdout).trim().match(/\d+\.\d+\.\d+[\w.-]*/) || [String(stdout).trim() || null])[0];
    execFile(WHICH_CMD, ['claude'], { timeout: 5000, windowsHide: true }, (e2, out2) => {
      const binPath = e2 ? null : (String(out2).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null);
      claudeRt = { detectedAt: Date.now(), online: true, version, binPath };
      rtDetecting = false;
    });
  });
}
detectClaudeRuntime();   // 模块加载即触发首探

// ---------- 运行时用量汇总（跨任务聚合 meta）----------
// totalCostUsd/rounds/numTurns：累计口径（CC result 事件累计值，逐轮覆盖式写盘，跨任务求和即总量）。
// tokens：取各任务已记录的 meta.usage（末轮快照，CC result.usage 为单轮口径）——真实记录值，非估算。
// CLI 会话 v1 不计 token（usage=null），单独计数标注，不混入。
function computeRuntimeUsage(buckets) {
  const agg = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalCostUsd: 0, rounds: 0, numTurns: 0, tasksWithUsage: 0, cliCount: 0,
  };
  const all = [
    ...buckets.plan, ...buckets.processing, ...buckets.queued,
    ...buckets.done, ...buckets['awaiting-human'], ...buckets.archived, ...buckets.other,
  ];
  for (const t of all) {
    // 被旁观的 CLI 会话（t.cli；meta 无真实 usage/cost）单独计数、不进用量聚合；物化后的 CLI 任务无 t.cli、
    // 有真实 usage meta，与其它托管任务一并聚合（按 t.cli 判、不按 source——任务来源不变量）
    if (t.cli) { agg.cliCount++; continue; }
    const m = t.meta;
    if (!m) continue;
    agg.totalCostUsd += m.totalCostUsd || 0;
    agg.rounds += m.rounds || 0;
    agg.numTurns += m.numTurns || 0;
    const u = m.usage;
    if (u) {
      agg.tasksWithUsage++;
      agg.inputTokens += Number(u.input_tokens) || 0;
      agg.outputTokens += Number(u.output_tokens) || 0;
      agg.cacheReadTokens += Number(u.cache_read_input_tokens) || 0;
      agg.cacheCreationTokens += Number(u.cache_creation_input_tokens) || 0;
    }
  }
  return agg;
}

// ---------- 运行时卡片（本机 Claude Code 执行环境 + 活跃会话计数）----------
function buildRuntime(buckets) {
  // 活跃会话：看板持有的 Mode B 会话（未收敛）+ 终端 CLI 会话（CC 注册表活进程），按 sessionId 去重
  const boardLive = listSessions().filter((s) => s.state !== 'closed' && s.state !== 'error');
  const boardSids = new Set(boardLive.map((s) => s.claudeSessionId).filter(Boolean));
  const attached = readAttachedSessions();
  let attachedCli = 0;
  for (const sid of attached.keys()) if (!boardSids.has(sid)) attachedCli++;

  detectClaudeRuntime();   // TTL 到点则后台重探（读缓存，不阻塞）
  const snap = usageSnapshot();   // 账号级用量（session/本周）+ 定时拉取实况（纯读定时器缓存，不 spawn）
  // scrumws 平台任务的 sessionId 集合（有任务包的托管任务 meta.sessionId，不含被旁观的 cli watchlist 会话）
  // → 日用量柱状图「平台子集」过滤。按 t.cli 判：物化后的 CLI 任务无 t.cli、算平台任务（任务来源不变量）
  const platformSids = new Set();
  for (const b of Object.values(buckets)) for (const t of b) {
    if (!t.cli && t.meta?.sessionId) platformSids.add(t.meta.sessionId);
  }
  return {
    tool: 'Claude Code',
    host: os.hostname(),
    platform: process.platform,
    online: claudeRt.online,
    version: claudeRt.version,
    binPath: claudeRt.binPath,
    sessions: {
      total: boardLive.length + attachedCli,
      board: boardLive.length,
      cli: attachedCli,
      processing: buckets.processing.length,
    },
    usage: computeRuntimeUsage(buckets),
    claudeUsage: snap.data,     // 账号级用量（经官方 CLI /usage）：{ ok, subscription, session, weekAll } | null
    usagePoll: snap.poll,       // 定时拉取实况：{ intervalSec, lastRunAt, nextRunAt, lastOk, lastError }
    dailyUsage: getDailyUsage(platformSids),   // 近 30 天每天用量（token）：[{ date, input, output, cache, total, platform }] | null（首次扫描中）。柱状图取后 7 天(total+platform)，表格按 tab 取后 7/15/30 天
  };
}

// ---------- /api/state 主入口 ----------
// job 实况卡（进程内调度器实况 + 心跳日志）——去派发器后仅 Runner Checker 用
function liveJobCard(id, logFile, enabled, intervalSec, sched, now) {
  // 心跳：读对应 log 末行时间（跨看板重启仍可信；调度器 lastTick 是本进程内存值）
  let heartbeatAt = null;
  if (logFile && fs.existsSync(logFile)) {
    const last = tailLine(logFile);
    const m = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/.exec(last);
    if (m) heartbeatAt = m[1];
  }
  const hb = heartbeatAt ? ago(heartbeatAt, now) : { text: '—', sec: null };
  const j = sched.jobs[id] || null;
  return {
    enabled,
    intervalSec,
    heartbeat: hb.text,
    heartbeatAt,
    ticking: !!j?.scheduled,                      // 本实例调度器是否在给它计时
    running: !!j?.running,                        // 当前 tick 子进程在跑
    lastTickStart: j?.lastTickStart || null,
    lastTickEnd: j?.lastTickEnd || null,
    lastOutcome: j?.lastOutcome || null,          // ok / error / timeout / null
    lastError: j?.lastError || null,
    ticks: j?.ticks ?? 0,
    skips: j?.skips ?? 0,
  };
}

// ---------- 进程内缓存 + 广播 ----------
// collectState() 是全量重扫（readdir + 每个任务包读 5 个 JSON + 反读 jsonl 数后台子 agent），不便宜。
// 但前端本来就在轮询它——所以云端 connector 不得自己触发扫描，两边共享同一次扫描结果。
// TTL 取值依据：前端轮询默认 15s、夹在 [5s, 600s]（app.js:6）。
//   · /api/state 用 3000 → UI 最快也只有 5s 一次（>3s）故永远不被降级，TTL 只起「合并瞬时并发请求」
//     的作用（多标签页 / modal 关闭时的补拉）；
//   · connector 用 15000 → 基本必然命中 UI 那次扫描的缓存，UI 关着时才自己触发（上报必需）。
// 净账：UI 开着时扫描次数不增（connector +0），UI 关着时 4 次/分（原来 0 次，这是上报的必要成本）。
export const STATE_CACHE_TTL_MS = 3000;

let cached = null;        // { snapshot, at, gen }
let inflight = null;      // { promise, gen }  single-flight：扫描期间所有 getState 复用同一 Promise
let generation = 0;       // 写代次：写请求 +1，作废「写之前的扫描」（见 invalidateState）
const stateListeners = new Set();

/**
 * 作废状态缓存：写请求改完磁盘后调（server.js 在每个 POST 的 res 'finish' 上统一挂）。
 * 只推进代次、不清 cached —— peekState() 仍能拿到最后一次快照（陈旧好过没有）。
 */
export function invalidateState() { generation++; }

/**
 * 缓存 + single-flight 入口。**所有新调用方都走这个，不要直接调 collectState()**。
 * maxAgeMs=0 → 跳过年龄判断，但仍参与 single-flight。
 * ⚠ 代次是 read-your-writes 的保证：前端每个 mutation 都紧跟一次 refreshState()（app.js:2190），
 *   若只按年龄判，mutation 前 3s 内的任何扫描（UI 上一轮轮询 / connector tick）都会让这次回拉
 *   命中旧缓存 → 拿到 mutation 之前的快照，要等下一轮轮询（默认 15s）才自愈。
 */
export async function getState(opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? STATE_CACHE_TTL_MS;
  if (cached && cached.gen === generation && maxAgeMs > 0 && Date.now() - cached.at <= maxAgeMs) {
    return cached.snapshot;
  }
  // 搭便车也只能搭「本代」的：写之前发起的那次扫描读不到本次写入，返回它等于丢更新。
  // 同代则合并——否则 UI + connector 撞在同一秒 = 两次全量扫描，比不加缓存还糟。
  if (inflight && inflight.gen === generation) return inflight.promise;
  const gen = generation;
  const promise = collectState().finally(() => { if (inflight?.promise === promise) inflight = null; });
  inflight = { promise, gen };
  return promise;
}

/** 同步取最后一次快照，**永不触发扫描**。从没扫过 → null。 */
export function peekState() { return cached; }

/** 订阅：每次扫描成功完成后回调（同一快照对象，只读，勿改）。返回退订函数。 */
export function onState(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export async function collectState() {
  // 按「扫描开始」记代次：扫描途中发生的写入本次未必读到，记成当前代会把它当成「已包含」→ 丢更新。
  const startGen = generation;
  const now = new Date();
  const sched = scheduler.status();

  // 平台守护卡（Runner Checker，数据看板页）——去派发器后调度器只剩这一个 job
  const checker = {
    id: CHECKER.id,
    label: CHECKER.label,
    hint: CHECKER.hint,
    ...liveJobCard(CHECKER.id, CHECKER.logFile, true, checkerIntervalSec(), sched, now),   // 项目固有调度：常开
  };

  const buckets = collectAll(now);
  const cfg = readConfig();

  const snapshot = {
    now: fmt(now),
    scheduler: { mode: sched.mode, lockPid: sched.lockPid },
    checker,
    runtime: buildRuntime(buckets),
    lifecycle: {
      plan: buckets.plan,
      processing: buckets.processing,
      queued: buckets.queued,
      done: buckets.done,
      awaitingHuman: buckets['awaiting-human'],
      archived: buckets.archived,
    },
    runnerConfig: {
      maxConcurrentRunners: cfg.maxConcurrentRunners ?? 5,
      usagePollSec: cfg.usagePollSec ?? 600,          // 账号用量定时拉取「基准」间隔（秒，默认 10min；每次实际叠加随机抖动 ×[0.6,1.6)）
      modelContextLimits: modelContextLimits(),       // 生效的 model→上下文上限映射（内置默认 + 用户配置）：设置页据此回填、详情页环形取分母
    },
  };
  // 扫描成功才写缓存 + 广播（抛异常时旧缓存保留——陈旧好过没有）
  cached = { snapshot, at: Date.now(), gen: startGen };
  for (const fn of stateListeners) {
    try { fn(snapshot); } catch (e) { console.error('[collect] onState listener error:', e.message); }
  }
  return snapshot;
}
