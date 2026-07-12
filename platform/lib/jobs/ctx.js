import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { P, ROOT } from '../paths.js';
import { fmt, parse } from '../timeutil.js';
import { leaseAlive } from '../lease.js';

// 平台守护 Runner Checker 的 job ctx 库（2026-07-12 去派发器后瘦身，只留 checker 用到的判据 + 通用文件读写）：
//   · quotaBlockActive：共享 quota-block 读侧单份、过期自动清
//   · recheckAuthBlock：授权熔断复查（recovery-only，只清不写）
// 磁盘契约（state.json/lease.json/quota-block/auth-block）与 .ps1 时代一字不改。

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
export function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
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
    if (log) log(`quota-block 自动清除（${reason}），恢复运行`);
    return null;
  } catch {
    fs.rmSync(quotaBlk, { force: true });
    return null;
  }
}

// ---- 授权熔断复查（recovery-only）：平台常驻 runner-checker 调 ----
// auth-block sentinel 由 scripts 侧 .ps1（dws-auth.ps1）在派发/worker 链里写；这里给平台侧一条独立清除路径，
// 避免派发器缺席时熔断标记永远清不掉、告警一直挂着（stale）。
// 约束：**只清不写**——sentinel 存在才复查一次 dws auth status，恢复即清；仍失效则原样保留（绝不新写）。
//       判据：authenticated 且 token/refresh 至少一有效。
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
// ---- 每 tick 的 ctx：job 脚本唯一入口 ----
// 脚本契约：export default async function tick(ctx) {...}；ctx.dryRun 时不写盘、决策打 stdout
export function buildCtx({ id, logFile, dryRun = false }) {
  const ts = fmt(new Date());   // 每 tick 一个固定时间戳
  const log = (m) => fs.appendFileSync(logFile, `[${ts}] ${m}\n`, 'utf8');
  const out = (m) => process.stdout.write(m + '\n');   // DryRun 决策输出
  return {
    id, dryRun, ts, now: new Date(),
    ROOT, P,
    log, out,
    fmt, parse,
    readJson, writeJson,
    exec,
    leaseAlive,
    quotaBlockActive: () => quotaBlockActive(P.quotaBlk, log),
    recheckAuthBlock: () => recheckAuthBlock(P.authBlk, log, { dryRun }),
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
