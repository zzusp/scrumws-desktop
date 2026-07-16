// 全库反误报：新口径扫本机 ~/.claude/projects 全部 jsonl，看"当下报在跑"的会话是否收敛。
// 与 verify-bg-count.mjs 互补：那边证"该算的都算上"，这边证"不该算的一个都没混进来"。
// 跑：node docs/acceptance/background-task-signals/scripts/scan-corpus.mjs
import { countRunningBackgroundTasks } from '../../../../platform/lib/collect-cli.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = process.env.SCRUMWS_CC_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
})(root);

const now = Date.now();
let hits = 0;
const t0 = Date.now();
for (const f of files) {
  const n = countRunningBackgroundTasks(f, now);
  if (n > 0) {
    hits++;
    const mtime = fs.statSync(f).mtime;
    console.log(`  ${String(n).padStart(2)} 个在跑  ${path.basename(f).slice(0, 8)}  最后活动 ${((now - mtime) / 60000).toFixed(1)} 分钟前`);
  }
}
const ms = Date.now() - t0;
console.log(`\n扫描 ${files.length} 个 jsonl：报"有后台在跑"的 ${hits} 个；耗时 ${ms}ms（均 ${(ms / files.length).toFixed(1)}ms/文件）`);
console.log('预期：只有"此刻真有后台任务在跑"的活会话 >0；历史会话应全 0（过死线）。');
console.log('注：死会话另由 collect 的 sessionAlive 短路兜底，此脚本不判活——只看时间口径是否收敛。');
