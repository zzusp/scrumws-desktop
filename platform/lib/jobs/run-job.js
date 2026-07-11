import { pathToFileURL } from 'node:url';
import { buildCtx } from './ctx.js';

// 派发 job 子进程入口：调度器每 tick fork 一个本进程（隔离——脚本写崩不拖死看板）。
//   node run-job.js <scriptPath> <jobId> <logFile> [--dry-run]
// 脚本契约：export default async function tick(ctx)。exit 0=本轮正常收敛，非 0=异常（调度器记 lastOutcome=error）。
// 也可手动跑（DryRun 决策对比 / 排障）：
//   node dashboard/lib/jobs/run-job.js runtime/dispatchers/chat-watch.mjs chat-watch runtime/dispatch-chat.log --dry-run

// Electron 宿主 fork 本进程时置了 ELECTRON_RUN_AS_NODE；入口即清除，防经 pwsh 扩散到 worker/claude 后代
delete process.env.ELECTRON_RUN_AS_NODE;

const [, , scriptPath, jobId, logFile, flag] = process.argv;
if (!scriptPath || !jobId || !logFile) {
  console.error('usage: node run-job.js <scriptPath> <jobId> <logFile> [--dry-run]');
  process.exit(2);
}
const ctx = buildCtx({ id: jobId, logFile, dryRun: flag === '--dry-run' });

try {
  const mod = await import(pathToFileURL(scriptPath).href);
  if (typeof mod.default !== 'function') throw new Error('脚本缺少 export default async function tick(ctx)');
  await mod.default(ctx);
  process.exit(0);
} catch (e) {
  try { ctx.log(`ERROR job=${jobId} tick 异常：${e.stack || e.message}`); } catch { /* 日志都写不了就只能靠 stderr */ }
  console.error(e.stack || e.message);
  process.exit(1);
}
