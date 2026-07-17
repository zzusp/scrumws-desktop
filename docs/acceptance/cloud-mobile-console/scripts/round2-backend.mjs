// round-2 后端验证：直接 import relay-verbs 在沙箱数据根跑，无需云端/downlink。
// 覆盖 #2（createTask 透传 scheduledAt 落盘 + 强制 plan）与 #3（verbTaskDetail 对无包 cli: 兜底不崩）。
// 用法：SCRUMWS_DATA_ROOT=<沙箱> CWD=<白名单目录> node round2-backend.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SCRUMWS_DATA_ROOT;
const CWD = process.env.CWD;
if (!ROOT || !CWD) { console.error('需要 SCRUMWS_DATA_ROOT 与 CWD'); process.exit(2); }

// runner-config：开远程控制 + 白名单（relay-verbs 的闸门）。必须在 import relay-verbs 前写好
// （paths.js 的 ROOT 在加载期定值，runner-config 每次 readConfig 现读文件所以顺序不敏感，但一并先备）
const runtimeDir = path.join(ROOT, 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
fs.writeFileSync(path.join(runtimeDir, 'runner-config.json'),
  JSON.stringify({ cloudRemoteControl: true, cloudAllowedCwds: [CWD] }, null, 2));

const { runVerb } = await import('../../../../platform/lib/cloud/relay-verbs.js');

let pass = 0, fail = 0;
const check = (id, cond, d = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${id}${d ? ' — ' + d : ''}`); };

// #2：createTask 带 scheduledAt
const SCHED = '2026-12-31 09:00:00';
const cr = await runVerb('createTask', {
  title: 'round2 定时任务', prompt: '到点自动执行的验证任务。', model: 'claude-opus-4-8',
  cwd: CWD, scheduledAt: SCHED, plan: true,
});
check('#2 createTask ok', cr.ok, cr.ok ? `taskKey=${cr.data?.taskKey}` : cr.error);
const taskKey = cr.data?.taskKey;

if (taskKey) {
  // 落盘核实：task.json.scheduledAt + state=plan（有定时必落 plan）
  const safe = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  const dir = path.join(runtimeDir, 'runner-state', safe);
  const taskJson = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
  const stateJson = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  check('#2 task.json.scheduledAt 落盘', taskJson.scheduledAt === SCHED, taskJson.scheduledAt);
  check('#2 有定时强制 plan', stateJson.state === 'plan', `state=${stateJson.state}`);

  // #2：taskDetail 回读 scheduledAt
  const dt = await runVerb('taskDetail', { taskKey });
  check('#2 taskDetail 回读 scheduledAt', dt.ok && dt.data?.scheduledAt === SCHED, dt.data?.scheduledAt);
}

// #3：verbTaskDetail 对无包 cli: 走 lifecycle 兜底 —— 沙箱无真实 CLI 会话 → 无卡 → 优雅 not found，不抛
const cli = await runVerb('taskDetail', { taskKey: 'cli:deadbeef' });
check('#3 cli: 无卡兜底优雅返回（不抛）', cli.ok === false && /not found/.test(cli.error || ''), cli.error);

// #3：正常任务 detail 仍工作（async 化没破坏原路径）
if (taskKey) {
  const dt2 = await runVerb('taskDetail', { taskKey });
  check('#3 正常任务 detail 仍 ok', dt2.ok && dt2.data?.taskKey === taskKey, dt2.ok ? 'ok' : dt2.error);
}

console.log(`\n### round-2 后端：PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
