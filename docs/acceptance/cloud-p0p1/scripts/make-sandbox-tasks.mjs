// 在沙箱数据根造假任务包，覆盖 5 个 state（plan / queued / processing / awaiting-human / done）。
// 磁盘契约照 collect.js:71-76：runner-state/<source>__<slug>/{task,state,meta}.json
// 时间串一律 'yyyy-MM-dd HH:mm:ss' 本地时区（timeutil.js:5）—— 云端收到的必须是 connector 转好的 ISO。
//
// ⚠ 只写 SCRUMWS_DATA_ROOT 指向的沙箱；绝不碰用户真实数据根（~/.scrumws）。
// 用法：SCRUMWS_DATA_ROOT=<sandbox> node make-sandbox-tasks.mjs
//
// processing 卡需要一个**活 lease**：runner-checker 会把「state=processing 但 lease pid 已死」的任务
// 当孤儿收走、标成 awaiting-human（jobs/runner-checker.js:69-95，leaseAlive 判据见 lease.js:17）。
// 这是对的系统行为，不是 bug —— 所以这里起一个 keepalive 子进程持有 lease，pid 写进 keepalive.pid
// 供收尾**按 pid 定点**杀（绝不按进程名/路径杀：会连用户 8799 的真实桌面 app 一起杀）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.env.SCRUMWS_DATA_ROOT;
if (!ROOT) throw new Error('必须显式给 SCRUMWS_DATA_ROOT（沙箱数据根），拒绝默认落 ~/.scrumws');
if (ROOT.includes('.scrumws')) throw new Error('拒绝写用户真实数据根：' + ROOT);

const RUNNER = path.join(ROOT, 'runtime', 'runner-state');
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const minsAgo = (m) => fmt(new Date(Date.now() - m * 60_000));

// 5 张卡，每个 state 一张。slug 用固定值（不随机）→ 重跑幂等，round 之间 taskKey 稳定。
const TASKS = [
  {
    key: 'manual:20260716100000-001', state: 'plan',
    task: { title: '重构看板卡片排序', prompt: '把 done 桶按 resolvedAt 倒序排。', model: 'claude-opus-4-8', effort: 'xhigh', cwd: 'D:\\project\\demo', worktree: false },
    history: [{ state: 'plan', at: minsAgo(50), by: 'create:manual' }],
    meta: null,
  },
  {
    key: 'manual:20260716100100-002', state: 'queued',
    task: { title: '补充 rev 指纹单测', prompt: '给 taskRev 加 4 个用例。', model: 'claude-opus-4-8', effort: 'high', cwd: 'D:\\project\\demo', worktree: false },
    history: [{ state: 'queued', at: minsAgo(40), by: 'create:manual' }],
    meta: null,
  },
  {
    key: 'manual:20260716100200-003', state: 'processing',
    task: { title: '接入云端 connector', prompt: '实现心跳 + 对账。', model: 'claude-opus-4-8', effort: 'xhigh', cwd: 'D:\\project\\demo', worktree: true, baseBranch: 'master' },
    history: [
      { state: 'queued', at: minsAgo(30), by: 'create:manual' },
      { state: 'processing', at: minsAgo(29), by: 'session' },
    ],
    meta: { sessionId: 'sid-processing-0003', rounds: 2, numTurns: 8, totalCostUsd: 0.213456, worktreeBranch: 'worktree-connector', lastRoundAt: minsAgo(3), usage: { input_tokens: 1234, output_tokens: 567, cache_read_input_tokens: 89, cache_creation_input_tokens: 0 } },
  },
  {
    key: 'manual:20260716100300-004', state: 'awaiting-human',
    task: { title: '确认迁移脚本可回滚', prompt: '检查 001 的 drop 列表是否是当前全集。', model: 'claude-sonnet-4-5', effort: 'medium', cwd: 'D:\\project\\demo', worktree: false, description: '等我确认后再合' },
    history: [
      { state: 'queued', at: minsAgo(25), by: 'create:manual' },
      { state: 'processing', at: minsAgo(24), by: 'session' },
      { state: 'awaiting-human', at: minsAgo(10), by: 'session' },
    ],
    meta: { sessionId: 'sid-awaiting-0004', rounds: 1, numTurns: 5, totalCostUsd: 0.087001, lastRoundAt: minsAgo(10), usage: { input_tokens: 800, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 120 } },
  },
  {
    key: 'cli:20260716100400-005', state: 'done', outcome: 'success',
    task: { title: '修好 identity.json 权限', prompt: '尽力 chmod 0600。', model: 'claude-opus-4-8', effort: 'low', cwd: 'D:\\project\\demo', worktree: false },
    history: [
      { state: 'queued', at: minsAgo(120), by: 'create:cli' },
      { state: 'processing', at: minsAgo(119), by: 'session' },
      { state: 'awaiting-human', at: minsAgo(100), by: 'session' },
      { state: 'done', at: minsAgo(95), by: 'user' },
    ],
    meta: { sessionId: 'sid-done-0005', rounds: 3, numTurns: 14, totalCostUsd: 0.451200, lastRoundAt: minsAgo(100), usage: { input_tokens: 2000, output_tokens: 900, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 } },
  },
];

fs.mkdirSync(RUNNER, { recursive: true });

// keepalive：给 processing 卡当 lease 持有者。detached + unref → 父进程退出它仍活着。
const keep = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
  detached: true, stdio: 'ignore', windowsHide: true,
});
keep.unref();
const KEEP_PID_FILE = path.join(ROOT, 'runtime', 'keepalive.pid');
fs.mkdirSync(path.dirname(KEEP_PID_FILE), { recursive: true });
fs.writeFileSync(KEEP_PID_FILE, String(keep.pid));
console.log(`  keepalive 进程 pid=${keep.pid}（持有 processing 卡的 lease；收尾按此 pid 定点杀）\n`);

for (const t of TASKS) {
  const safe = t.key.replace(':', '__');
  const dir = path.join(RUNNER, safe);
  fs.mkdirSync(dir, { recursive: true });
  const first = t.history[0].at;
  const last = t.history[t.history.length - 1];
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
    taskKey: t.key, source: t.key.split(':')[0], createdAt: first, ...t.task,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    state: t.state, enteredAt: last.at, outcome: t.outcome || null,
    resolvedAt: t.state === 'done' ? last.at : null, history: t.history,
  }, null, 2));
  if (t.meta) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(t.meta, null, 2));
  // 只有 processing 卡需要活 lease（其它 state 不被 checker 收）
  if (t.state === 'processing') {
    fs.writeFileSync(path.join(dir, 'lease.json'), JSON.stringify({
      pid: keep.pid, claimedAt: last.at, heartbeatAt: fmt(new Date()), intent: 'run',
    }, null, 2));
  }
  console.log(`  造卡 ${t.state.padEnd(15)} ${t.key}${t.state === 'processing' ? '  (+lease pid=' + keep.pid + ')' : ''}`);
}
console.log(`\n共 ${TASKS.length} 张，落在 ${RUNNER}`);
