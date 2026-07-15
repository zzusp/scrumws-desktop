// 看板筛选迭代验收：往指定数据根塞合成任务包（覆盖 manual/chat/issue 多来源 + 多工作目录 + sessionId），
// 供 standalone web 服务 /api/state 渲染，验证筛选面板选项取自真实数据 + 卡片精简 + 文案改动。
// 用法：SCRUMWS_DATA_ROOT=<dir> node seed-tasks.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SCRUMWS_DATA_ROOT;
if (!ROOT) { console.error('需 SCRUMWS_DATA_ROOT'); process.exit(1); }
const runnerRoot = path.join(ROOT, 'runtime', 'runner-state');
fs.mkdirSync(runnerRoot, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const minsAgo = (m) => fmt(new Date(Date.now() - m * 60000));

// [safeKey, task.json, state.json, meta.json, lease.json]
const CWD_A = 'D:\\project\\scrumws-desktop';
const CWD_B = 'D:\\work\\another-repo\\packages\\ui';
const WT_DELTA = CWD_B + '\\.claude\\worktrees\\wt-delta';   // delta 的实际 worktree 运行目录
const packs = [
  ['manual__alpha', {
    taskKey: 'manual:alpha', source: 'manual', kind: 'interactive', title: '手动任务·登录页重构', cwd: CWD_A,
    description: '备注：先做表单校验', createdAt: minsAgo(3),
  }, { state: 'plan', enteredAt: minsAgo(3), history: [{ state: 'plan', at: minsAgo(3) }] }, null, null],

  ['chat__bravo', {
    taskKey: 'chat:bravo', source: 'chat', kind: 'interactive', title: 'dws 链任务·导出报表', cwd: CWD_B, createdAt: minsAgo(30),
  }, { state: 'processing', enteredAt: minsAgo(28), history: [{ state: 'queued', at: minsAgo(28) }, { state: 'processing', at: minsAgo(20) }] },
    { sessionId: 'aaaa1111-2222-3333-4444-555566667777', rounds: 2, totalCostUsd: 0.12, numTurns: 5, lastRoundAt: minsAgo(2) },
    { pid: process.pid, claimedAt: minsAgo(20), heartbeatAt: minsAgo(1), intent: '正在编辑组件' }],

  ['issue__charlie', {
    taskKey: 'issue:charlie', source: 'issue', kind: 'interactive', title: 'issue 修复·崩溃回归', cwd: CWD_A, createdAt: minsAgo(120),
  }, { state: 'awaiting-human', enteredAt: minsAgo(118), resolvedAt: minsAgo(90), outcome: 'need-input',
       history: [{ state: 'processing', at: minsAgo(118) }, { state: 'awaiting-human', at: minsAgo(90) }] },
    { sessionId: 'bbbb1111-2222-3333-4444-555566667777', rounds: 3, lastRoundAt: minsAgo(90) }, null],

  // worktree 任务：配置工作目录 CWD_B，但实际运行在 worktree 目录 WT_DELTA（meta.worktreeDir）
  ['manual__delta', {
    taskKey: 'manual:delta', source: 'manual', kind: 'interactive', title: '手动任务·文档补全', cwd: CWD_B,
    worktree: true, baseBranch: 'master', createdAt: minsAgo(300),
  }, { state: 'done', enteredAt: minsAgo(298), resolvedAt: minsAgo(240), outcome: 'success',
       history: [{ state: 'processing', at: minsAgo(298) }, { state: 'done', at: minsAgo(240) }] },
    { sessionId: 'cccc1111-2222-3333-4444-555566667777', rounds: 4, totalCostUsd: 0.44, lastRoundAt: minsAgo(240),
      worktreeDir: WT_DELTA, worktreeBranch: 'worktree-delta' }, null],
];

for (const [safeKey, task, state, meta, lease] of packs) {
  const dir = path.join(runnerRoot, safeKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task, null, 2));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  if (meta) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  if (lease) fs.writeFileSync(path.join(dir, 'lease.json'), JSON.stringify(lease, null, 2));
}
console.log(`seeded ${packs.length} tasks → ${runnerRoot}`);
