// 合成任务包供迁移验证：1 个 cwd 被 worktree 污染的任务(应迁移) + 1 个干净任务 + 1 个已正确的 worktree 任务(应跳过)。
// 用法：SCRUMWS_DATA_ROOT=<dir> node seed-migrate.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SCRUMWS_DATA_ROOT;
if (!ROOT) { console.error('需 SCRUMWS_DATA_ROOT'); process.exit(1); }
const runnerRoot = path.join(ROOT, 'runtime', 'runner-state');
fs.mkdirSync(runnerRoot, { recursive: true });

const BASE = 'D:\\project\\scrumws-desktop';
const WT = BASE + '\\.claude\\worktrees\\cli-abc123';
// [safeKey, task.json, meta.json]
const packs = [
  // ① 污染：cli 物化任务，cwd 误存了 worktree 目录、worktree=false、meta 无 worktreeDir → 应迁移
  ['cli__abc123', { taskKey: 'cli:abc123', source: 'cli', title: '污染任务', prompt: 'x', cwd: WT, createdAt: '2026-07-15 10:00:00' },
    { sessionId: 'abc12300-0000-0000-0000-000000000000', cwd: WT }],
  // ② 干净：普通 base cwd → 应跳过
  ['manual__clean', { taskKey: 'manual:clean', source: 'manual', title: '干净任务', prompt: 'x', cwd: BASE, createdAt: '2026-07-15 10:00:00' }, null],
  // ③ 已正确的 worktree 任务：cwd=base + worktree=true + meta.worktreeDir 已设 → 应跳过
  ['manual__wtok', { taskKey: 'manual:wtok', source: 'manual', title: 'worktree 已正确', prompt: 'x', cwd: BASE, worktree: true, baseBranch: 'master', createdAt: '2026-07-15 10:00:00' },
    { sessionId: 'ok000000-0000-0000-0000-000000000000', worktreeDir: BASE + '\\.claude\\worktrees\\wtok', worktreeBranch: 'worktree-wtok' }],
];
const state = { state: 'plan', enteredAt: '2026-07-15 10:00:00', history: [{ state: 'plan', at: '2026-07-15 10:00:00' }] };
for (const [safeKey, task, meta] of packs) {
  const dir = path.join(runnerRoot, safeKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task, null, 2));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  if (meta) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}
console.log(`seeded ${packs.length} tasks → ${runnerRoot}`);
