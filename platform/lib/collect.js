import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';
import { fmt, parse, ago } from './timeutil.js';
import { CHECKER, checkerEnabled, checkerIntervalSec } from './jobs/checker-meta.js';
import * as scheduler from './scheduler.js';
import { readConfig } from './runner-config.js';
import { leaseAlive } from './lease.js';
import { collectCliSessions } from './collect-cli.js';
import { getTaskSessionId } from './task-runner.js';

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

  return {
    taskKey,
    safeTaskKey,
    title,
    hasCustomTitle: !!task?.customTitle,
    description: task?.description || null,   // 纯用户备注（看板编辑，不进 prompt）
    source,
    kind,
    state: effectiveState,
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
    mbSessionId: getTaskSessionId(taskKey),
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
