// 端到端：起真 Mode B 会话 → 让它起两个后台任务 → 走真实 HTTP API 验列表/查看/停止。
// 同时是 CC 任务协议的回归：真跑 background_tasks_changed 全表推送 + stop_task 控制请求，
// CC 升级后若这里红了，多半是协议变了（见 docs/spec/background-task-strip-sdk-channel.md 的取证方法）。
//
// 跑法（沙箱数据根，别碰用户真实 ~/.scrumws）：
//   $env:SCRUMWS_DATA_ROOT="$env:TEMP\scrumws-strip-e2e"; $env:SCRUMWS_PORT="8893"
//   Start-Process node -ArgumentList "platform/standalone.js" -WindowStyle Hidden -PassThru   # 记下 PID，完事按 PID 停
//   node docs/acceptance/background-task-strip/scripts/e2e-api.mjs
// 会真实调用 claude（haiku）起两条 sleep，约 1~2 分钟。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = process.env.SCRUMWS_PORT || 8893;
const B = `http://127.0.0.1:${PORT}`;
const j = async (u, o) => (await fetch(B + u, o)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-strip-'));

// 1) 起会话，要求它起两个后台任务
const created = await j('/api/session/create', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    cwd, model: 'claude-haiku-4-5-20251001', bypass: true,
    prompt: '请用 Bash 工具以 run_in_background:true 起两条命令：`sleep 240` 和 `sleep 241`。起完立刻回复"已起"，不要做其他事、不要读文件。',
  }),
});
if (!created.ok) { console.log('起会话失败：', created.error); process.exit(1); }
const id = created.id;
console.log('会话 id =', id, '\n');

// 2) 等后台任务起来 —— 轮询 /api/session/list 看 backgroundTasks
let tasks = [];
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  const l = await j('/api/session/list');
  const s = (l.sessions || []).find((x) => x.id === id);
  tasks = s?.backgroundTasks || [];
  if (tasks.length >= 2) break;
}
console.log('backgroundTasks =', JSON.stringify(tasks, null, 1), '\n');
t('会话 info 暴露 backgroundTasks 全表（2 条）', tasks.length === 2, `实际 ${tasks.length} 条`);
t('每条带 task_id / task_type / description',
  tasks.every((x) => x.task_id && x.task_type && x.description), JSON.stringify(tasks.map((x) => x.task_type)));

if (!tasks.length) { console.log('\n无后台任务，终止'); await j(`/api/session/close?id=${id}`, { method: 'POST' }); process.exit(1); }

// 3) 查看输出
const out = await j(`/api/session/task-output?id=${id}&taskId=${tasks[0].task_id}`);
t('查看输出：能定位到 CC 的 .output 文件', out.ok === true, out.ok ? `size=${out.size} path=${path.basename(out.path)}` : out.error);

// 4) 停止第一个
const stopped = await j(`/api/session/stop-task?id=${id}&taskId=${tasks[0].task_id}`, { method: 'POST' });
t('stop-task 接口返回 ok', stopped.ok === true, JSON.stringify(stopped));

// 5) 等 CC 推移除 → 列表应只剩 1 条
let after = tasks;
for (let i = 0; i < 12; i++) {
  await sleep(1500);
  const l = await j('/api/session/list');
  after = (l.sessions || []).find((x) => x.id === id)?.backgroundTasks || [];
  if (after.length < tasks.length) break;
}
t('停掉后 CC 推移除、栏数据自动收敛为 1 条', after.length === 1, `实际 ${after.length} 条`);
t('被停的正是指定那条（另一条仍在）',
  after.length === 1 && after[0].task_id === tasks[1].task_id, `剩 ${after.map((x) => x.task_id).join(',')}`);

// 6) 停掉的任务输出文件应已被 CC evict → 查看接口给出可读理由而非崩
const gone = await j(`/api/session/task-output?id=${id}&taskId=${tasks[0].task_id}`);
t('已停任务查看输出：不崩，给出可读结果', typeof gone.ok === 'boolean', gone.ok ? 'ok（文件仍在）' : gone.error);

console.log(`\n合计 PASS=${pass} FAIL=${fail}`);
await j(`/api/session/close?id=${id}`, { method: 'POST' });
try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* EBUSY */ }
process.exit(fail ? 1 : 0);
