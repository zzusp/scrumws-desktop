import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { P, ROOT } from '../paths.js';
import { fmt, parse } from '../timeutil.js';
import { leaseAlive, pidAlive } from '../lease.js';

// 派发 job 公共判据库（2026-07-10 派发链 Node 化）——scripts/lib/runner-common.ps1 +
// dws-auth.ps1 + notifier.ps1 的逐条移植，语义与 .ps1 版（worker 链仍在用）保持一致，改判据两边一起改：
//   · leaseAlive：pid 为主判据 + leaseHardTtlMinutes(默认 240) 硬兜底（lease.js 单份实现）
//   · quotaBlockActive：读侧单份、过期自动清
//   · spawnLoop / addSpawnRecord / spawnLoopAlert：重派循环防护（5min ≥4 次拦截 + 30min 去重告警）
//   · stopZombieWorker：回收僵尸先 taskkill /T 杀树，防双 worker
//   · dwsAuthGate：dws auth status 熔断判据（token+refresh 双失效才熔断），sentinel 写/清
//   · notifyOwner：runner-config.ownerNotifier 路由（dws → twin-send.ps1 脱敏+回读核验）
// 磁盘契约（task.json/state.json/lease.json/watermark/quota-block/auth-block/spawns.jsonl）与 .ps1 时代一字不改。

const RUNNER_CFG = path.join(P.tmpDir, 'runner-config.json');

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
export function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

export function runnerConfig() {
  return readJson(RUNNER_CFG) || {};
}

export function planRequired(source) {
  const c = runnerConfig();
  return Array.isArray(c.planSources) && c.planSources.includes(source);
}

// execFile 封装：不因非零退出码 throw（对齐 PS `2>$null | Out-String` + $LASTEXITCODE 模式）
export function exec(file, args, { timeout = 60000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code === undefined || typeof err.code === 'string' ? -1 : err.code) : 0,
        killed: !!err?.killed,
        stdout: stdout || '',
        stderr: stderr || '',
        all: (stdout || '') + (stderr || ''),
      });
    });
  });
}

export function countLiveLeases() {
  let n = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(P.runnerRoot); } catch { return 0; }
  for (const name of dirs) {
    const lf = path.join(P.runnerRoot, name, 'lease.json');
    const l = readJson(lf);
    if (l && leaseAlive(l)) n++;
  }
  return n;
}

// 回收 lease 前调：pid 活但心跳超 HardTTL 的僵尸 → 杀整棵进程树（外壳 pwsh + claude 子进程）
export async function stopZombieWorker(lease, log) {
  if (!lease || !lease.pid || lease.pid === 0) return;
  if (pidAlive(lease.pid)) {
    await exec('taskkill', ['/PID', String(lease.pid), '/T', '/F']);
    if (log) log(`回收僵尸 worker：taskkill /T pid=${lease.pid}（heartbeat 超 HardTTL）`);
  }
}

// quota-block 读侧单份：生效中返回 Date（blockUntil），已过期/超 5.5h 上限则清除并返回 null
export function quotaBlockActive(quotaBlk = P.quotaBlk, log = null) {
  if (!fs.existsSync(quotaBlk)) return null;
  try {
    const blockUntil = parse(fs.readFileSync(quotaBlk, 'utf8').trim());
    if (!blockUntil) throw new Error('bad datetime');
    const writtenAt = fs.statSync(quotaBlk).mtime;
    const hours = (Date.now() - writtenAt.getTime()) / 3600000;
    if (Date.now() < blockUntil.getTime() && hours < 5.5) return blockUntil;
    fs.rmSync(quotaBlk, { force: true });
    const reason = Date.now() >= blockUntil.getTime()
      ? `已过 reset ${fmt(blockUntil).slice(11)}`
      : `写入已 ${Math.round(hours * 10) / 10}h 超 5.5h 上限`;
    if (log) log(`quota-block 自动清除（${reason}），恢复派发`);
    return null;
  } catch {
    fs.rmSync(quotaBlk, { force: true });
    return null;
  }
}

// ---- 重派循环防护（07-06 group-2：15s 一个新 pid 循环 34 次白烧）----
// 判据：同 taskDir 5min 窗口内已 spawn ≥ 4 次 → 拦截本轮 spawn
export function spawnLoop(taskDir, windowMinutes = 5, maxSpawns = 4) {
  const f = path.join(taskDir, 'spawns.jsonl');
  if (!fs.existsSync(f)) return false;
  const cutoff = Date.now() - windowMinutes * 60000;
  let recent = 0;
  let lines = [];
  try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(-30); } catch { return false; }
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      const d = parse(o.at);
      if (d && d.getTime() > cutoff) recent++;
    } catch { /* 跳过坏行 */ }
  }
  return recent >= maxSpawns;
}

export function addSpawnRecord(taskDir, by = 'dispatcher') {
  fs.appendFileSync(path.join(taskDir, 'spawns.jsonl'), JSON.stringify({ at: fmt(new Date()), by }) + '\n', 'utf8');
}

// 循环告警（哨兵去重：30min 内同一 taskKey 只发一次）
export async function spawnLoopAlert(taskDir, taskKey, log = null) {
  const sentinel = path.join(taskDir, 'spawn-loop-alerted');
  if (fs.existsSync(sentinel)) {
    const age = (Date.now() - fs.statSync(sentinel).mtime.getTime()) / 60000;
    if (age < 30) return;
  }
  fs.writeFileSync(sentinel, fmt(new Date()), 'utf8');
  try {
    await notifyOwner(`小小鹏拦截重派循环 · ${taskKey}`,
      `${taskKey} 在 5min 内被 spawn ≥4 次，疑似重派循环，已拦截后续 spawn。\n请查 runner-state 任务包与 dispatch 日志定位原因（水位没推进 / state 异常）。\n\n- 小小鹏代回`);
    if (log) log(`重派循环告警已私发 owner（${taskKey}）`);
  } catch (e) {
    if (log) log(`重派循环告警私发失败（${taskKey}）：${e.message}`);
  }
}

// 通用 owner 通知（notifier.ps1 移植）：渠道由 runner-config.json.ownerNotifier 决定
// dws → twin-send.ps1（脱敏 + 回读核验，不重写）；失败 throw，调用方自行 catch+log
export async function notifyOwner(title, body) {
  const cfg = runnerConfig();
  const notifier = cfg.ownerNotifier || null;
  const type = notifier?.type || 'none';
  if (type === 'none') return;
  if (type !== 'dws') throw new Error(`未知的 ownerNotifier.type: ${type}（当前支持：dws / none）`);
  const userId = notifier.userId ? String(notifier.userId) : null;
  if (!userId) throw new Error('ownerNotifier.type=dws 但 userId 未配置');
  const r = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'scripts', 'twin-send.ps1'),
    '-User', userId, '-Title', title, '-Text', body], { timeout: 120000 });
  if (r.code !== 0) throw new Error(`twin-send exit=${r.code}：${r.all.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
}

// ---- dws 授权熔断闸门（dws-auth.ps1 移植）----
// token/refresh 双失效时任何 dws chat 命令都会弹浏览器 OAuth；入口纯查询判定，熔断落 sentinel + 返回 false
export async function dwsAuthGate(sentinel, log, source) {
  const ts = fmt(new Date());
  const wasBlocked = fs.existsSync(sentinel);
  const r = await exec('dws', ['auth', 'status', '--format', 'json', '--timeout', '10'], { timeout: 30000 });

  let blockReason = null;
  let status = null;
  if (r.code !== 0) {
    let tail = r.all.replace(/\s+/g, ' ').trim();
    if (tail.length > 200) tail = tail.slice(0, 200) + '…';
    blockReason = `dws auth status 失败（exit=${r.code}）：${tail}`;
  } else {
    try { status = JSON.parse(r.all); } catch (e) { blockReason = `dws auth status JSON 解析失败：${e.message}`; }
  }
  if (!blockReason && status) {
    if (!status.authenticated) blockReason = 'authenticated=false（已登出，需要重新扫码）';
    else if (!status.token_valid && !status.refresh_token_valid) blockReason = 'token 与 refresh 都已过期，必须重新登录';
  }

  if (blockReason) {
    const payload = {
      writtenAt: ts,
      reason: blockReason,
      authenticated: status ? !!status.authenticated : false,
      tokenValid: status ? !!status.token_valid : false,
      refreshTokenValid: status ? !!status.refresh_token_valid : false,
      expiresAt: status ? (status.expires_at ?? null) : null,
      hint: '在本机跑一次：dws auth login',
      source,
    };
    try { fs.writeFileSync(sentinel, JSON.stringify(payload), 'utf8'); }
    catch (e) { log(`[${source}] 写 auth-block sentinel 失败：${e.message}`); }
    if (!wasBlocked) log(`[${source}] dws 授权失效，熔断（${blockReason}）；本轮 exit 0，等孙鹏本机执行 dws auth login`);
    return false;
  }
  if (wasBlocked) {
    fs.rmSync(sentinel, { force: true });
    log(`[${source}] dws 授权已恢复（authenticated=true），清除 auth-block，恢复派发`);
  }
  return true;
}

// ---- 授权熔断复查（recovery-only）：平台常驻 runner-checker 调，不依赖派发器 ----
// 背景：auth-block sentinel 原本只有 dwsAuthGate 在派发 tick 里写/清；派发器一关就没 tick，
//       熔断标记永远清不掉、告警一直挂着（stale）。这里给平台侧一条独立清除路径。
// 约束：**只清不写**——sentinel 存在才复查一次 dws auth status，恢复即清；仍失效则原样保留（绝不新写，
//       熔断仍归 dwsAuthGate/派发链）。判据与 dwsAuthGate 一致（authenticated 且 token/refresh 至少一有效），改判据两边一起改。
export async function recheckAuthBlock(sentinel, log, { dryRun = false } = {}) {
  if (!fs.existsSync(sentinel)) return null;   // 无熔断标记 → 无需复查（常态 no-op，不跑 dws）
  const r = await exec('dws', ['auth', 'status', '--format', 'json', '--timeout', '10'], { timeout: 30000 });
  if (r.code !== 0) return false;              // 查询失败（仍未登录 / dws 不可用）→ 维持熔断
  let status = null;
  try { status = JSON.parse(r.all); } catch { return false; }
  const recovered = !!(status && status.authenticated && (status.token_valid || status.refresh_token_valid));
  if (!recovered) return false;                // 仍双失效 → 维持熔断（sentinel 已在，不重写）
  if (dryRun) { log('[checker] dws 授权已恢复（DryRun，不清 auth-block）'); return true; }
  fs.rmSync(sentinel, { force: true });
  log('[checker] dws 授权已恢复（authenticated=true），清除 auth-block —— 平台复查兜底，不依赖派发器');
  return true;
}

// ---- spawn detached worker 外壳 ----
// 不能用 Node spawn 直起 pwsh worker：
//   · detached:true → DETACHED_PROCESS 无控制台，pwsh 秒退 exit 0（task-actions.js:347 同坑）
//   · detached:false → worker 进 libuv kill-on-close job object，随 run-job tick 结束被陪葬（实测 dbg3）
// 方案：经一层短命 pwsh 中介跑与 .ps1 派发器完全一致的 Start-Process（Hidden + 重定向 + PassThru +
// 300ms HasExited 检查）；孙进程走 job 的 silent breakaway 脱离、独立长跑。
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
export async function spawnWorker({ script, args = [], stdoutLog, stderrLog }) {
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
  const argList = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', abs(script), ...args.map(String)]
    .map(psq).join(',');
  const cmd = [
    `$proc = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList ${argList} -WorkingDirectory ${psq(ROOT)} -WindowStyle Hidden -RedirectStandardOutput ${psq(abs(stdoutLog))} -RedirectStandardError ${psq(abs(stderrLog))} -PassThru`,
    `Start-Sleep -Milliseconds 300`,
    `$res = if (-not $proc) { @{ ok = $false; error = 'Start-Process 返回 null' } } elseif ($proc.HasExited) { @{ ok = $false; pid = $proc.Id; exitedEarly = $true; exitCode = $proc.ExitCode } } else { @{ ok = $true; pid = $proc.Id } }`,
    `$res | ConvertTo-Json -Compress`,
  ].join('\n');
  const r = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 30000 });
  if (r.code !== 0) return { ok: false, error: `spawn 中介失败（exit=${r.code}）：${r.all.replace(/\s+/g, ' ').trim().slice(0, 300)}` };
  try {
    const line = r.stdout.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
    return JSON.parse(line);
  } catch {
    return { ok: false, error: `spawn 中介输出不可解析：${r.all.trim().slice(0, 300)}` };
  }
}

// ---- 每 tick 的 ctx：模板脚本唯一入口 ----
// 脚本契约：export default async function tick(ctx) {...}；ctx.dryRun 时不写盘、不 spawn、决策打 stdout
export function buildCtx({ id, logFile, dryRun = false }) {
  const ts = fmt(new Date());   // 对齐 .ps1：每 tick 一个固定时间戳
  const log = (m) => fs.appendFileSync(logFile, `[${ts}] ${m}\n`, 'utf8');
  const out = (m) => process.stdout.write(m + '\n');   // DryRun 决策输出
  return {
    id, dryRun, ts, now: new Date(),
    ROOT, P,
    log, out,
    fmt, parse,
    readJson, writeJson,
    exec,
    leaseAlive, pidAlive,
    countLiveLeases,
    stopZombieWorker: (l) => stopZombieWorker(l, log),
    quotaBlockActive: () => quotaBlockActive(P.quotaBlk, log),
    dwsAuthGate: (source) => dwsAuthGate(P.authBlk, log, source),
    recheckAuthBlock: () => recheckAuthBlock(P.authBlk, log, { dryRun }),
    runnerConfig, planRequired,
    spawnLoop, addSpawnRecord,
    spawnLoopAlert: (taskDir, taskKey) => spawnLoopAlert(taskDir, taskKey, log),
    notifyOwner,
    spawnWorker,
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    exists: (p) => fs.existsSync(p),
    rm: (p) => fs.rmSync(p, { force: true }),
    readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    writeText: (p, s) => fs.writeFileSync(p, s, 'utf8'),
    appendText: (p, s) => fs.appendFileSync(p, s, 'utf8'),
    listDirs: (root, filter = null) => {
      try {
        return fs.readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && (!filter || filter.test(d.name)))
          .map((d) => d.name);
      } catch { return []; }
    },
    listFiles: (dir, ext = null) => {
      try { return fs.readdirSync(dir).filter((f) => !ext || f.endsWith(ext)).map((f) => path.join(dir, f)); } catch { return []; }
    },
    join: path.join,
  };
}
