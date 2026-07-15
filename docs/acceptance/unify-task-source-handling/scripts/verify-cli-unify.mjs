// 统一任务来源处理 —— sub-goal 1 后端验证：把被旁观的 CLI 会话物化成一等托管任务，
// 使 退回计划 / 完成 / 取消完成 / 归档 / 取消归档 / 编辑 对 CLI 与其它来源走同一套逻辑（按状态、不按来源）。
// 不 spawn claude：造一次性沙箱数据根 + 沙箱 CC_PROJECTS（放假 session jsonl）+ watchlist 条目，跑动作断言。
// 运行：node docs/acceptance/unify-task-source-handling/scripts/verify-cli-unify.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SANDBOX = path.join(os.tmpdir(), `unify-verify-${Date.now()}`);
const CC = path.join(SANDBOX, 'cc-projects');
process.env.SCRUMWS_DATA_ROOT = SANDBOX;
process.env.SCRUMWS_CC_PROJECTS = CC;
const runnerRoot = path.join(SANDBOX, 'runtime', 'runner-state');
const archiveRoot = path.join(SANDBOX, 'runtime', 'runner-archive');
fs.mkdirSync(runnerRoot, { recursive: true });
fs.mkdirSync(path.join(CC, 'proj1'), { recursive: true });

const imp = (p) => import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../platform/lib', p)).href);
const { moveTaskToPlan, completeTask, uncompleteTask, readTaskEdit, replyToTask } = await imp('task-actions.js');
const { archiveTask, unarchiveTask } = await imp('logs.js');
const { upsertWatchlist, readWatchlist } = await imp('cli-watchlist.js');

let pass = 0, fail = 0;
const assert = (cond, name, extra = '') => { cond ? (pass++, console.log(`  ✅ ${name}`)) : (fail++, console.log(`  ❌ ${name} ${extra}`)); };

// 造一个假 CC 会话 jsonl（parseCcSession 认：每行一个 JSON 事件，顶层 cwd / system init / user・assistant 消息）
function mkCliSession(fullSid, cwd) {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', cwd, model: 'claude-opus-4-8', gitBranch: 'main' }),
    JSON.stringify({ type: 'user', uuid: 'u1', cwd, gitBranch: 'main', timestamp: '2026-07-15T10:00:00Z', message: { role: 'user', content: '帮我修复登录 bug' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-07-15T10:00:05Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '好的' }] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-07-15T10:01:00Z', message: { role: 'user', content: '再补个测试' } }),
  ];
  fs.writeFileSync(path.join(CC, 'proj1', `${fullSid}.jsonl`), lines.join('\n'), 'utf8');
  upsertWatchlist(fullSid, {});
}
const pkgDir = (taskKey) => path.join(runnerRoot, taskKey.replace(/:/g, '__'));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

console.log('\n[1] CLI 会话 退回计划 → 物化成托管任务包 + 落 plan + 从 watchlist 摘除（去重）');
{
  const sid = 'aabbccdd-1122-4333-8444-555566667777';
  const taskKey = 'cli:aabbccdd';
  mkCliSession(sid, SANDBOX);
  const r = moveTaskToPlan({ taskKey });
  assert(r.ok && r.materialized && r.state === 'plan', 'moveTaskToPlan 物化并落 plan', JSON.stringify(r));
  const dir = pkgDir(taskKey);
  assert(fs.existsSync(dir), 'runner-state 任务包已建');
  const tj = readJson(path.join(dir, 'task.json'));
  assert(tj.source === 'cli', 'task.json.source 仍标 cli（仅元数据）', tj.source);
  assert(tj.title === '帮我修复登录 bug', 'title 取首条用户消息', tj.title);
  assert(tj.cwd === SANDBOX, 'cwd 取会话原目录（供 --resume 定位）', tj.cwd);
  assert(tj.model === 'claude-opus-4-8', 'model 取会话原 model', tj.model);
  const st = readJson(path.join(dir, 'state.json'));
  assert(st.state === 'plan' && st.history.at(-1).by === 'user:materialize-cli', 'state plan + history 标记');
  const meta = readJson(path.join(dir, 'meta.json'));
  assert(meta.sessionId === sid, 'meta.sessionId = 全量 sid（供 --resume）', meta.sessionId);
  assert(!readWatchlist().sessions[sid], 'watchlist 已摘除该 sid（collect-cli 不再出卡，去重）');
}

console.log('\n[2] 物化后 编辑 走统一路径：readTaskEdit 可读 + resumeLocked（有 sessionId → 锁目录/worktree）');
{
  const r = readTaskEdit('cli:aabbccdd');
  assert(r.ok && r.resumeLocked === true, 'readTaskEdit ok + resumeLocked=true', JSON.stringify({ ok: r.ok, rl: r.resumeLocked }));
  assert(r.cwd === SANDBOX, '编辑回填 cwd', r.cwd);
}

console.log('\n[3] 物化后 归档/取消归档 走「按包」统一路径（目录搬迁），不再走 watchlist');
{
  const taskKey = 'cli:aabbccdd';
  const ra = archiveTask(taskKey);
  assert(ra.ok && fs.existsSync(path.join(archiveRoot, 'cli__aabbccdd')) && !fs.existsSync(pkgDir(taskKey)), '归档：目录移入 runner-archive', JSON.stringify(ra));
  const ru = unarchiveTask(taskKey);
  assert(ru.ok && fs.existsSync(pkgDir(taskKey)) && !fs.existsSync(path.join(archiveRoot, 'cli__aabbccdd')), '取消归档：目录移回 runner-state', JSON.stringify(ru));
}

console.log('\n[4] 物化的 CLI 包在 awaiting-human 时 完成→done、取消完成→awaiting-human（按包统一，不走 watchlist）');
{
  const sid = 'bbccddee-1122-4333-8444-555566667777';
  const taskKey = 'cli:bbccddee';
  mkCliSession(sid, SANDBOX);
  // 先物化到 plan，再手动把状态改成 awaiting-human 模拟「跑过一轮回到待人工」
  moveTaskToPlan({ taskKey });
  const sf = path.join(pkgDir(taskKey), 'state.json');
  const s = readJson(sf); s.state = 'awaiting-human'; fs.writeFileSync(sf, JSON.stringify(s));
  const rc = completeTask({ taskKey });
  assert(rc.ok && readJson(sf).state === 'done', '完成 → done（package 路径）', JSON.stringify(rc));
  const ru = uncompleteTask({ taskKey });
  assert(ru.ok && readJson(sf).state === 'awaiting-human', '取消完成 → awaiting-human', JSON.stringify(ru));
}

console.log('\n[5] 未物化的 CLI 会话 完成/取消完成 仍回落 watchlist.doneAt（无任务包时来源分派保持）');
{
  const sid = 'ccddeeff-1122-4333-8444-555566667777';
  const taskKey = 'cli:ccddeeff';
  mkCliSession(sid, SANDBOX);   // 只进 watchlist，不物化
  const rc = completeTask({ taskKey });
  assert(rc.ok && !!readWatchlist().sessions[sid]?.doneAt, '完成 → watchlist.doneAt 置位（无包回落）', JSON.stringify(rc));
  const ru = uncompleteTask({ taskKey });
  assert(ru.ok && !readWatchlist().sessions[sid]?.doneAt, '取消完成 → watchlist.doneAt 清空', JSON.stringify(ru));
}

console.log('\n[6] 物化后 回复 走 package-first（Mode B --resume），不再路由到观察侧 replyCliSession');
{
  const sid = 'ddeeff00-1122-4333-8444-555566667777';
  const taskKey = 'cli:ddeeff00';
  mkCliSession(sid, SANDBOX);
  moveTaskToPlan({ taskKey });
  const sf = path.join(pkgDir(taskKey), 'state.json');
  const s = readJson(sf); s.state = 'processing'; fs.writeFileSync(sf, JSON.stringify(s));
  // 有包 + processing：走包路径的「处理中」guard（若仍按 cli 前缀分派到 replyCliSession，错误不会是「处理中」）
  const r = replyToTask({ taskKey, message: '继续' });
  assert(!r.ok && /处理中/.test(r.error || ''), '有包→包路径 processing guard（证明未走 replyCliSession）', JSON.stringify(r));
}

console.log(`\n==== ${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'} : ${pass} passed, ${fail} failed ====`);
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
