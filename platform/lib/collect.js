import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { P } from './paths.js';
import { fmt, parse, ago } from './timeutil.js';
import { CHECKER, checkerEnabled, checkerIntervalSec } from './jobs/checker-meta.js';
import * as scheduler from './scheduler.js';
import { readConfig } from './runner-config.js';
import { leaseAlive } from './lease.js';
import { collectCliSessions, readAttachedSessions, backgroundAgentCountBySid } from './collect-cli.js';
import { getTaskSessionId } from './task-runner.js';
import { listSessions } from './session-manager.js';

// ---------- 通用小工具 ----------
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
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

// 后台维度派生（runner/cli 统一语义）：主 agent 一轮收敛写 awaiting-human，但若会话进程仍活着
// (mbSessionId 非空) 且该 CC session 还有后台 agent 在跑 → 整体仍是 processing——主进程只是让出
// 等后台完成（CC 会自动注入 <task-notification> 唤醒续跑），任务未结束。
// 仅对"疑似空闲的活会话"读一次 jsonl 探测：其他状态无需（processing 已在忙 / 终态无后台）；
// 会话进程死则后台必随之结束（后台 agent 是该进程子进程），mbSessionId 短路避免用陈旧 pbg 误判。
export function deriveBackgroundState(state, mbSessionId, sessionId) {
  if (state !== 'awaiting-human' || !mbSessionId || !sessionId) {
    return { backgroundAgentCount: 0, displayState: state };
  }
  const backgroundAgentCount = backgroundAgentCountBySid(sessionId);
  return { backgroundAgentCount, displayState: backgroundAgentCount > 0 ? 'processing' : state };
}

// ---------- 采集单个任务包 ----------
function collectOne(safeTaskKey, dir, now, isArchive = false) {
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
  // 后台维度（统一：与 cli 任务同字段 backgroundAgentCount）
  const { backgroundAgentCount, displayState } = deriveBackgroundState(effectiveState, mbSessionId, meta?.sessionId);

  return {
    taskKey,
    safeTaskKey,
    title,
    hasCustomTitle: !!task?.customTitle,
    description: task?.description || null,   // 纯用户备注（看板编辑，不进 prompt）
    cwd: task?.cwd || null,                   // 任务配置的工作目录（新建/编辑时写入 task.json）；awaiting 卡片非失败态展示
    source,
    kind,
    state: displayState,
    backgroundAgentCount,
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
  const scan = (root, isArchive) => {
    let names = [];
    try { names = fs.readdirSync(root); } catch { return; }
    for (const name of names) {
      const dir = path.join(root, name);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      const task = collectOne(name, dir, now, isArchive);
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

  // 排序：plan/processing/queued 按时间升序（老的靠前）；done/awaiting-human/archived 按 resolvedAt 降序（新的靠前）
  buckets.plan.sort((a, b) => (parse(a.enteredAt) || 0) - (parse(b.enteredAt) || 0));
  buckets.processing.sort((a, b) => (parse(a.lease?.claimedAt) || 0) - (parse(b.lease?.claimedAt) || 0));
  buckets.queued.sort((a, b) => (parse(a.enteredAt) || 0) - (parse(b.enteredAt) || 0));
  buckets.done.sort((a, b) => (parse(b.resolvedAt) || 0) - (parse(a.resolvedAt) || 0));
  buckets['awaiting-human'].sort((a, b) => (parse(b.resolvedAt) || 0) - (parse(a.resolvedAt) || 0));
  buckets.archived.sort((a, b) => (parse(b.resolvedAt) || 0) - (parse(a.resolvedAt) || 0));
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
    if (t.source === 'cli') { agg.cliCount++; continue; }
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

export async function collectState() {
  const now = new Date();
  const sched = scheduler.status();

  // 平台守护卡（Runner Checker，数据看板页）——去派发器后调度器只剩这一个 job
  const checker = {
    id: CHECKER.id,
    label: CHECKER.label,
    hint: CHECKER.hint,
    ...liveJobCard(CHECKER.id, CHECKER.logFile, checkerEnabled(), checkerIntervalSec(), sched, now),
  };

  const buckets = collectAll(now);
  const cfg = readConfig();

  return {
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
    },
  };
}
