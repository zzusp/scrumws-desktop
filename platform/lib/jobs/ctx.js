import fs from 'node:fs';
import path from 'node:path';
import { P, ROOT } from '../paths.js';
import { fmt, parse } from '../timeutil.js';
import { leaseAlive } from '../lease.js';

// 平台守护 Runner Checker 的 job ctx 库：只提供通用文件读写 + 判活给孤儿收纳器用。
// （2026-07-12 去派发器 → 交互会话统一为任务后，dws 授权熔断 / quota-block 那套看板任务链残留已删。）

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
export function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

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
    leaseAlive,
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
