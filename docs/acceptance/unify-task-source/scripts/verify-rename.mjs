// 验证 sub goal 2：标题与描述按来源分派（CLI→watchlist / 分身→task.json）。
// 用独立临时数据根（SCRUMWS_DATA_ROOT），造完即删，零污染真实 ~/.scrumws。
// 跑：node docs/acceptance/unify-task-source/scripts/verify-rename.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), `scrumws-verify-rename-${process.pid}`);
process.env.SCRUMWS_DATA_ROOT = TMP;   // 必须在 import paths.js 前设（模块加载即读 env）

const { P } = await import('../../../../platform/lib/paths.js');
const { renameTask, setTaskDescription } = await import('../../../../platform/lib/logs.js');
const wl = await import('../../../../platform/lib/cli-watchlist.js');

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}  (got: ${JSON.stringify(got)})`); }
};

try {
  fs.mkdirSync(P.tmpDir, { recursive: true });

  // --- CLI 分支：写 watchlist.customTitle ---
  const sid = '11111111-2222-3333-4444-555555555555';
  wl.upsertWatchlist(sid, {});
  let r = renameTask('cli:11111111', 'CLI-title-A');
  check('CLI rename ok', r.ok === true, r);
  check('CLI 写入 watchlist.customTitle', wl.readWatchlist().sessions[sid]?.customTitle === 'CLI-title-A', wl.readWatchlist().sessions[sid]?.customTitle);
  renameTask('cli:11111111', '');
  check('CLI 空标题 -> null（清除）', wl.readWatchlist().sessions[sid]?.customTitle === null, wl.readWatchlist().sessions[sid]?.customTitle);
  r = setTaskDescription('cli:11111111', 'CLI-note-A');
  check('CLI 保存描述 ok', r.ok === true, r);
  check('CLI 写入 watchlist.note', wl.readWatchlist().sessions[sid]?.note === 'CLI-note-A', wl.readWatchlist().sessions[sid]?.note);
  setTaskDescription('cli:11111111', '');
  check('CLI 清空描述 -> null', wl.readWatchlist().sessions[sid]?.note === null, wl.readWatchlist().sessions[sid]?.note);
  r = renameTask('cli:99999999', 'x');
  check('CLI 不在 watchlist -> 报错', r.ok === false && /not in watchlist/.test(r.error || ''), r);

  // --- 分身分支：写 task.json.customTitle ---
  const safeDir = path.join(P.runnerRoot, 'manual__test1');
  fs.mkdirSync(safeDir, { recursive: true });
  fs.writeFileSync(path.join(safeDir, 'task.json'), JSON.stringify({ taskKey: 'manual:test1' }), 'utf8');
  r = renameTask('manual:test1', 'clone-title-B');
  check('分身 rename ok', r.ok === true, r);
  const tj = JSON.parse(fs.readFileSync(path.join(safeDir, 'task.json'), 'utf8'));
  check('分身 写入 task.json.customTitle', tj.customTitle === 'clone-title-B', tj.customTitle);
  renameTask('manual:test1', '');
  const tj2 = JSON.parse(fs.readFileSync(path.join(safeDir, 'task.json'), 'utf8'));
  check('分身 空标题 -> 删字段（恢复默认）', tj2.customTitle === undefined, tj2.customTitle);
  r = setTaskDescription('manual:test1', '任务包-note-B');
  check('分身 保存描述 ok', r.ok === true, r);
  const tj3 = JSON.parse(fs.readFileSync(path.join(safeDir, 'task.json'), 'utf8'));
  check('分身 写入 task.json.description', tj3.description === '任务包-note-B', tj3.description);
  setTaskDescription('manual:test1', '');
  const tj4 = JSON.parse(fs.readFileSync(path.join(safeDir, 'task.json'), 'utf8'));
  check('分身 清空描述 -> 删字段', tj4.description === undefined, tj4.description);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n== ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
