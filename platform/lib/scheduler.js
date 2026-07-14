import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { P, ROOT } from './paths.js';
import { fmt } from './timeutil.js';
import { CHECKER, checkerIntervalSec } from './jobs/checker-meta.js';
import { pidAlive } from './lease.js';
import { promoteDueScheduledTasks, drainQueued } from './task-runner.js';

// 看板进程内调度器（2026-07-12 去派发器后只调度平台守护 Runner Checker 一个 job）：
// · 每 job 一个 interval 定时器；tick = fork 子进程跑 run-job.js（隔离——脚本写崩不拖死看板）
// · 上一轮未结束 → 本轮跳过（= 原 schtasks IgnoreNew 语义）
// · tick 超时（默认 240s）→ 杀直接子进程（ctx.exec 每个 CLI 调用自带超时，正常挂不满 240s）
// · 单实例锁 runtime/scheduler.lock（pid 判活）：防双看板实例双 tick；
//   测试实例用 DASHBOARD_NO_SCHEDULER=1 起（只看不调度）
// · job stdout/stderr → runtime/job-<id>.out.log（每 tick 覆写，崩溃排障用）

const LOCK_FILE = path.join(P.tmpDir, 'scheduler.lock');
// run-job.js 是应用代码资产，跟随本模块所在目录解析（ROOT 现在是数据根，不再指向代码目录）
const RUN_JOB = path.join(import.meta.dirname, 'jobs', 'run-job.js');
const TICK_TIMEOUT_MS = 240000;

const jobs = new Map();   // id → job
let mode = 'stopped';     // running | disabled-env | disabled-lock | stopped
let lockInfo = null;

// plan 定时执行扫描：in-process（须与 session-manager 同进程才能 spawn），仅持锁实例跑，防双实例双提升。
const PROMOTE_INTERVAL_MS = 30000;
let promoteTimer = null;
function runPromoteSweep() {
  try {
    const r = promoteDueScheduledTasks();
    if (r.promoted?.length) console.log(`定时执行：${r.promoted.length} 个 plan 任务到点提升（${r.promoted.join(', ')}）`);
    for (const e of r.errors || []) console.log(`定时执行失败 ${e.taskKey}：${e.error}`);
    // 兜底排空 queued（名额空出的事件驱动排空之外，30s 再兜一次，覆盖漏事件 / 起失败重试）
    const d = drainQueued();
    if (d.started?.length) console.log(`并发排空：起 ${d.started.length} 个 queued 任务（${d.started.join(', ')}）`);
  } catch (e) { console.log(`定时执行扫描出错：${e.message}`); }
}

function acquireLock() {
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (existing.pid && existing.pid !== process.pid && pidAlive(existing.pid)) {
      lockInfo = existing;
      return false;
    }
  } catch { /* 无锁或坏锁 → 抢 */ }
  fs.mkdirSync(P.tmpDir, { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: fmt(new Date()) }), 'utf8');
  lockInfo = { pid: process.pid, at: fmt(new Date()) };
  return true;
}
function releaseLock() {
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (existing.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch { /* 无妨 */ }
}

function tick(job) {
  if (job.child && job.child.exitCode === null) {   // 上一轮未结束 → 跳过（IgnoreNew）
    job.skips++;
    job.lastSkipAt = fmt(new Date());
    return;
  }
  let outFd;
  try { outFd = fs.openSync(job.outLog, 'w'); } catch { outFd = 'ignore'; }
  const args = [RUN_JOB, job.scriptFile, job.id, job.logFile];
  let child;
  try {
    // ELECTRON_RUN_AS_NODE：Electron 宿主下 process.execPath 是 electron.exe，
    // 置此变量让子进程以纯 Node 语义跑 run-job.js（纯 Node 宿主下无副作用；run-job.js 入口即清除防扩散）
    child = spawn(process.execPath, args, {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', outFd, outFd],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (e) {
    if (outFd !== 'ignore') fs.closeSync(outFd);
    job.lastOutcome = 'error';
    job.lastError = `spawn 失败：${e.message}`;
    return;
  }
  if (outFd !== 'ignore') fs.closeSync(outFd);
  job.child = child;
  job.runningPid = child.pid;
  job.lastTickStart = fmt(new Date());
  job.ticks++;
  const killer = setTimeout(() => {
    if (child.exitCode === null) {
      execFile('taskkill', ['/PID', String(child.pid), '/F'], { windowsHide: true }, () => {});
      job.lastOutcome = 'timeout';
      job.lastError = `tick 超 ${TICK_TIMEOUT_MS / 1000}s 被杀`;
    }
  }, TICK_TIMEOUT_MS);
  child.once('exit', (code) => {
    clearTimeout(killer);
    job.runningPid = null;
    job.lastTickEnd = fmt(new Date());
    if (job.lastOutcome !== 'timeout' || code === 0) {
      job.lastOutcome = code === 0 ? 'ok' : 'error';
      job.lastError = code === 0 ? null : tailOf(job.outLog);
    }
  });
}

function tailOf(file, max = 400) {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    return s ? s.slice(-max) : '(无输出)';
  } catch { return null; }
}

function upsertJob(desired) {
  let job = jobs.get(desired.id);
  if (!job) {
    job = { child: null, runningPid: null, ticks: 0, skips: 0, lastTickStart: null, lastTickEnd: null, lastSkipAt: null, lastOutcome: null, lastError: null, timer: null };
    jobs.set(desired.id, job);
  }
  Object.assign(job, {
    id: desired.id, kind: desired.kind, label: desired.label,
    scriptFile: desired.scriptFile, logFile: desired.logFile,
    outLog: path.join(P.tmpDir, `job-${desired.id}.out.log`),
    enabled: desired.enabled,
  });
  const needTimer = desired.enabled && mode === 'running';
  const intervalChanged = job.intervalSec !== desired.intervalSec;
  job.intervalSec = desired.intervalSec;
  if (job.timer && (!needTimer || intervalChanged)) { clearInterval(job.timer); job.timer = null; }
  if (needTimer && !job.timer) {
    job.timer = setInterval(() => tick(job), desired.intervalSec * 1000);
    job.timer.unref?.();
  }
  return job;
}

// 配置变更后调：对齐 jobs 表与定时器（去派发器后只有平台守护 Runner Checker 一个 job）
export function reload() {
  const desired = new Map();
  if (mode === 'running' || mode === 'stopped') {
    desired.set(CHECKER.id, {
      id: CHECKER.id, kind: 'checker', label: CHECKER.label, enabled: true,   // 项目固有调度：常开不可停
      intervalSec: checkerIntervalSec(), scriptFile: CHECKER.script, logFile: CHECKER.logFile,
    });
  }
  for (const [id, job] of jobs) {
    if (!desired.has(id)) {
      if (job.timer) clearInterval(job.timer);
      jobs.delete(id);
    }
  }
  for (const d of desired.values()) upsertJob(d);
}

export function start() {
  if (process.env.DASHBOARD_NO_SCHEDULER) {
    mode = 'disabled-env';
    console.log('调度器未启动（DASHBOARD_NO_SCHEDULER=1，仅看板只读实例）');
    return mode;
  }
  if (!acquireLock()) {
    mode = 'disabled-lock';
    console.log(`调度器未启动（scheduler.lock 由 pid=${lockInfo?.pid} 持有，本实例只看不调度）`);
    return mode;
  }
  mode = 'running';
  for (const sig of ['exit']) process.on(sig, releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  reload();
  // plan 定时执行：启动即扫一次（补偿离线期间到点的任务）+ 周期扫描
  runPromoteSweep();
  if (!promoteTimer) { promoteTimer = setInterval(runPromoteSweep, PROMOTE_INTERVAL_MS); promoteTimer.unref?.(); }
  console.log(`调度器已启动（pid=${process.pid}，jobs=${[...jobs.keys()].join(',')}）`);
  return mode;
}

// /api/state 用：调度器与各 job 实况
export function status() {
  const jobStatus = {};
  for (const [id, j] of jobs) {
    jobStatus[id] = {
      kind: j.kind, enabled: j.enabled, intervalSec: j.intervalSec,
      running: !!(j.child && j.child.exitCode === null),
      runningPid: j.runningPid,
      ticks: j.ticks, skips: j.skips,
      lastTickStart: j.lastTickStart, lastTickEnd: j.lastTickEnd,
      lastOutcome: j.lastOutcome, lastError: j.lastError,
      scheduled: !!j.timer,
    };
  }
  return { mode, lockPid: lockInfo?.pid || null, jobs: jobStatus };
}
