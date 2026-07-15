// 迁移：把 task.json.cwd 被 worktree 目录污染的历史任务修正为「工作目录=base 仓库根 + worktree 路径进 meta.worktreeDir」。
// 工作目录不变量：task.cwd 只存 base 仓库根；worktree 实际运行目录归 meta.worktreeDir（复用既有字段）。
// 用法：
//   node migrate-cwd-worktree.mjs --check   零副作用 dry-run，只打印命中清单
//   node migrate-cwd-worktree.mjs           真正写入（先跑 --check 确认无误）
// 数据根随 SCRUMWS_DATA_ROOT（默认 ~/.scrumws），与 paths.js 一致。
import fs from 'node:fs';
import path from 'node:path';
import { P } from '../../../../platform/lib/paths.js';
import { detectWorktreeBase } from '../../../../platform/lib/git.js';

const CHECK = process.argv.includes('--check');
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

let scanned = 0, wrote = 0;
const plans = [];
for (const root of [P.runnerRoot, P.archiveRoot]) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { continue; }
  for (const n of names) {
    const dir = path.join(root, n);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    const taskFile = path.join(dir, 'task.json');
    const metaFile = path.join(dir, 'meta.json');
    const task = rd(taskFile);
    if (!task) continue;
    scanned++;
    const cwd = String(task.cwd || '').trim();
    if (!cwd) continue;
    const wt = detectWorktreeBase(cwd);
    if (!wt.isWorktree) continue;   // cwd 已是 base（干净）→ 跳过

    const meta = rd(metaFile) || {};
    const plan = {
      taskKey: task.taskKey || n,
      root: root === P.archiveRoot ? 'archive' : 'runner-state',
      oldCwd: cwd,
      newCwd: wt.baseCwd,
      worktreeChange: task.worktree === true ? 'true(不变)' : 'false → true',
      metaWorktreeDir: meta.worktreeDir ? `${meta.worktreeDir}（已有，不覆盖）` : `${cwd}（新增）`,
    };
    plans.push(plan);

    if (!CHECK) {
      task.cwd = wt.baseCwd;
      task.worktree = true;                          // cwd 曾是 worktree → 确认执行须回该 worktree（resolveRunCwd 据 meta.worktreeDir）
      if (!meta.worktreeDir) meta.worktreeDir = cwd;  // 不覆盖已有正确值
      fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8');
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
      wrote++;
    }
  }
}

console.log(`数据根: ${P.tmpDir}`);
console.log(`扫描任务: ${scanned} | 命中(cwd 是 worktree 目录): ${plans.length}${CHECK ? ' | 模式: --check（零写入）' : ` | 已写入: ${wrote}`}`);
for (const p of plans) {
  console.log(`\n[${p.taskKey}] (${p.root})`);
  console.log(`  cwd:               ${p.oldCwd}`);
  console.log(`    → 改为:          ${p.newCwd}`);
  console.log(`  task.worktree:     ${p.worktreeChange}`);
  console.log(`  meta.worktreeDir:  ${p.metaWorktreeDir}`);
}
if (!plans.length) console.log('\n✓ 无需迁移：没有 cwd 被 worktree 目录污染的任务。');
else if (CHECK) console.log('\n以上为将执行的改动（未写入）。确认无误后去掉 --check 真跑。');
