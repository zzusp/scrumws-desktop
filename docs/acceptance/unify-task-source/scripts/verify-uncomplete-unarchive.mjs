// 验证 sub goal 3：取消完成 / 取消归档 对分身与 CLI 统一。
// - uncompleteTask（分身 done→awaiting-human）
// - unarchiveTask（分身 archive 目录移回 / CLI 清 watchlist.archivedAt）
// 独立临时数据根，造完即删，零污染真实 ~/.scrumws。
// 跑：node docs/acceptance/unify-task-source/scripts/verify-uncomplete-unarchive.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), `scrumws-verify-unc-${process.pid}`);
process.env.SCRUMWS_DATA_ROOT = TMP;

const { P } = await import('../../../../platform/lib/paths.js');
const { uncompleteTask } = await import('../../../../platform/lib/task-actions.js');
const { unarchiveTask } = await import('../../../../platform/lib/logs.js');
const wl = await import('../../../../platform/lib/cli-watchlist.js');

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}  (got: ${JSON.stringify(got)})`); }
};
const mkTask = (root, safeKey, state) => {
  const dir = path.join(root, safeKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ taskKey: safeKey.replace('__', ':') }), 'utf8');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    state, outcome: 'success', resolvedAt: '2026-07-14 10:00:00',
    outcomeDetail: { resolvedBy: 'user' }, history: [{ state, at: '2026-07-14 10:00:00', by: 'user' }],
  }), 'utf8');
  return dir;
};
const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

try {
  // ===== 分身 取消完成 =====
  const d1 = mkTask(P.runnerRoot, 'manual__u1', 'done');
  let r = uncompleteTask({ taskKey: 'manual:u1' });
  check('分身 uncomplete ok', r.ok === true, r);
  const s1 = readState(d1);
  check('分身 done→awaiting-human', s1.state === 'awaiting-human', s1.state);
  check('分身 outcome 清空', s1.outcome === null, s1.outcome);
  check('分身 resolvedBy 清空', s1.outcomeDetail?.resolvedBy === null, s1.outcomeDetail?.resolvedBy);

  mkTask(P.runnerRoot, 'manual__u2', 'awaiting-human');
  r = uncompleteTask({ taskKey: 'manual:u2' });
  check('分身 非 done 拒绝取消完成', r.ok === false && /只有 done/.test(r.error || ''), r);

  // ===== 分身 取消归档（目录 archive→runner-state）=====
  mkTask(P.archiveRoot, 'manual__a1', 'done');
  r = unarchiveTask('manual:a1');
  check('分身 unarchive ok', r.ok === true, r);
  check('分身 目录已回 runner-state', fs.existsSync(path.join(P.runnerRoot, 'manual__a1')), null);
  check('分身 archive 目录已移走', !fs.existsSync(path.join(P.archiveRoot, 'manual__a1')), null);

  mkTask(P.archiveRoot, 'manual__a2', 'done');
  mkTask(P.runnerRoot, 'manual__a2', 'done');   // 制造同名冲突
  r = unarchiveTask('manual:a2');
  check('分身 取消归档目标已存在→拒绝', r.ok === false && /已存在/.test(r.error || ''), r);

  r = unarchiveTask('manual:nope');
  check('分身 归档区无此任务→拒绝', r.ok === false && /not found in archive/.test(r.error || ''), r);

  // ===== CLI 取消归档（清 watchlist.archivedAt）=====
  const sid = '22222222-3333-4444-5555-666666666666';
  fs.mkdirSync(P.tmpDir, { recursive: true });
  wl.upsertWatchlist(sid, {});
  wl.setArchivedWatchlist(sid, true);
  check('CLI 预置 archivedAt', !!wl.readWatchlist().sessions[sid]?.archivedAt, null);
  r = unarchiveTask('cli:22222222');
  check('CLI unarchive ok', r.ok === true, r);
  check('CLI archivedAt 已清', wl.readWatchlist().sessions[sid]?.archivedAt === null, wl.readWatchlist().sessions[sid]?.archivedAt);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n== ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
