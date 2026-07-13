// 验证 sub goal 1：readWorkerLog 对 CLI 与分身产出同构 round 字段（cwd/gitBranch/model/workMs）。
// 跑：node docs/acceptance/unify-task-source/scripts/verify-fields.mjs
// 纯只读（默认数据根 ~/.scrumws，与桌面 app 一致），不写任何文件、不起服务。
import { readWorkerLog } from '../../../../platform/lib/logs.js';

const cases = [
  { label: 'CLI-1', taskKey: 'cli:bcaecb0b' },
  { label: 'CLI-2', taskKey: 'cli:a88d2a69' },
  { label: '分身-1', taskKey: 'manual:20260713163053-373' },
  { label: '分身-2', taskKey: 'manual:20260713152722-938' },
];

for (const c of cases) {
  let r;
  try { r = readWorkerLog(c.taskKey); } catch (e) { console.log(`[${c.label}] ${c.taskKey} -> THROW: ${e.message}`); continue; }
  if (!r.ok) { console.log(`[${c.label}] ${c.taskKey} -> ERROR: ${r.error}`); continue; }
  const rounds = (r.rounds || []).filter((x) => !x.error);
  const last = rounds[rounds.length - 1] || {};
  // 复刻前端 renderTaskSide 归一后的取值
  const model = last.ccSummary?.model || last.systemInit?.model || '(t.meta.model 兜底)';
  const gitVal = last.gitBranch || '(t.cli.gitBranch 兜底)';
  const cwdVal = last.cwd || last.systemInit?.cwd || '(t.cli.cwd/t.cwd 兜底)';
  const workMs = rounds.reduce((s, rd) => s + (rd.ccSummary?.workMs || 0), 0);
  console.log(`[${c.label}] ${c.taskKey}  rounds=${rounds.length} state=${r.state ?? '-'}`);
  console.log(`   cwd      = ${cwdVal}`);
  console.log(`   gitBranch= ${gitVal}   <-- CLI 归一关键字段`);
  console.log(`   model    = ${model}`);
  console.log(`   workMs   = ${workMs}`);
}
