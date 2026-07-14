// 退回计划 + 再执行续对话：后端纯逻辑验证（不 spawn claude）。
// 在一次性 sandbox 数据根里造任务包，跑 moveTaskToPlan / deleteTask 的状态机与 guard，断言结果。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SANDBOX = path.join(os.tmpdir(), `replan-verify-${Date.now()}`);
process.env.SCRUMWS_DATA_ROOT = SANDBOX;
const runnerRoot = path.join(SANDBOX, 'runtime', 'runner-state');
fs.mkdirSync(runnerRoot, { recursive: true });

const here = path.dirname(fileURLToPath(import.meta.url));
const { moveTaskToPlan, deleteTask } = await import(
  pathToFileURL(path.join(here, '../../../../platform/lib/task-actions.js')).href
);

let pass = 0, fail = 0;
const assert = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

// 造一个任务包
function mkTask(slug, stateObj, { withSession = false } = {}) {
  const safeKey = `manual__${slug}`;
  const dir = path.join(runnerRoot, safeKey);
  fs.mkdirSync(dir, { recursive: true });
  const taskKey = `manual:${slug}`;
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ taskKey, source: 'manual', title: slug, prompt: 'do it' }, null, 2));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ history: [{ state: stateObj.state, at: '2026-07-15 10:00:00', by: 'test' }], ...stateObj }, null, 2));
  if (withSession) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ sessionId: 'sess-' + slug, rounds: 1 }, null, 2));
  return { taskKey, dir };
}
const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

console.log('\n[1] awaiting-human → plan（保留 meta.sessionId）');
{
  const { taskKey, dir } = mkTask('aw1', { state: 'awaiting-human', outcome: 'success', resolvedAt: '2026-07-15 11:00:00', outcomeDetail: { failureReason: 'x' } }, { withSession: true });
  const r = moveTaskToPlan({ taskKey });
  assert(r.ok && r.state === 'plan', 'moveTaskToPlan ok=plan', JSON.stringify(r));
  const s = readState(dir);
  assert(s.state === 'plan', 'state.json 落 plan', s.state);
  assert(s.outcome === null && s.resolvedAt === null, 'outcome/resolvedAt 清空');
  assert(s.outcomeDetail.failureReason === null, 'failureReason 清空');
  assert(s.history.at(-1).state === 'plan' && s.history.at(-1).by === 'user', 'history 追 plan/by:user');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert(meta.sessionId === 'sess-aw1', 'meta.sessionId 保留（供 --resume）', meta.sessionId);
}

console.log('\n[2] done → plan');
{
  const { taskKey, dir } = mkTask('dn1', { state: 'done', outcome: 'success', resolvedAt: '2026-07-15 11:00:00', outcomeDetail: {} }, { withSession: true });
  const r = moveTaskToPlan({ taskKey });
  assert(r.ok && readState(dir).state === 'plan', 'done 可退回 plan', JSON.stringify(r));
}

console.log('\n[3] 非终态拒绝退回');
{
  const { taskKey } = mkTask('pr1', { state: 'processing' });
  const r = moveTaskToPlan({ taskKey });
  assert(!r.ok && /只有 待人工\/完成/.test(r.error), 'processing 拒绝', JSON.stringify(r));
  const p = mkTask('pl1', { state: 'plan' });
  const r2 = moveTaskToPlan({ taskKey: p.taskKey });
  assert(!r2.ok, 'plan 本身拒绝再退回', JSON.stringify(r2));
}

console.log('\n[4] CLI 键拒绝');
{
  const r = moveTaskToPlan({ taskKey: 'cli:abcd1234' });
  assert(!r.ok && /CLI/.test(r.error), 'cli: 拒绝', JSON.stringify(r));
}

console.log('\n[5] deleteTask guard：plan 且有 sessionId 拒删（改归档）');
{
  const { taskKey, dir } = mkTask('del1', { state: 'plan' }, { withSession: true });
  const r = deleteTask({ taskKey });
  assert(!r.ok && /已执行过/.test(r.error), '有 sessionId 的 plan 拒删', JSON.stringify(r));
  assert(fs.existsSync(dir), '目录仍在（未删）');
}

console.log('\n[6] deleteTask：plan 无 sessionId（纯草稿）正常删除');
{
  const { taskKey, dir } = mkTask('del2', { state: 'plan' });
  const r = deleteTask({ taskKey });
  assert(r.ok, '纯草稿删除 ok', JSON.stringify(r));
  assert(!fs.existsSync(dir), '目录已删');
}

console.log(`\n==== ${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'} : ${pass} passed, ${fail} failed ====`);
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
