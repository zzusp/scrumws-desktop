// countRunningBackgroundTasks 回归套件（合成用例，确定性、不依赖本机历史）。
// 用例即 CC 后台信号契约的快照：CC 版本升级后若此处红了，多半是 CC 改了落盘形态（载体 / status /
// toolUseResult 字段），按 docs/spec/background-task-signals-unification.md 的取证方法重新对齐。
// 跑：node docs/acceptance/background-task-signals/scripts/verify-bg-count.mjs
import { countRunningBackgroundTasks } from '../../../../platform/lib/collect-cli.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  got=${got} want=${want}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bgverify-'));
const NOW = Date.parse('2026-07-16T10:00:00.000Z');
const at = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
const write = (name, lines) => { const p = path.join(tmp, name); fs.writeFileSync(p, lines.join('\n')); return p; };

// —— 真实落盘形态的最小复刻（字段取自真机 jsonl 取证，见 spec）——
const launch = (id, tur, minAgo) => JSON.stringify({
  type: 'user', timestamp: at(minAgo), toolUseResult: tur,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const notifUser = (id, status) => JSON.stringify({
  type: 'user', timestamp: at(0),
  message: { role: 'user', content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>` },
});
const notifQueue = (id, status) => JSON.stringify({
  type: 'queue-operation', operation: 'enqueue', timestamp: at(0),
  content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
});
const notifAttach = (id, status) => JSON.stringify({
  type: 'attachment', timestamp: at(0),
  attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>` },
});
const taskStop = (taskId) => JSON.stringify({
  type: 'user', timestamp: at(0),
  toolUseResult: { message: `Successfully stopped task: ${taskId} (cmd)`, task_id: taskId, task_type: 'local_bash', command: 'cmd' },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stop', content: '{}' }] },
});
const AGENT = { isAsync: true, status: 'async_launched', agentId: 'a1' };
const BASH = { backgroundTaskId: 'b1', stdout: '', stderr: '', interrupted: false };
const MON = (ms, persistent = false) => ({ taskId: 'm1', timeoutMs: ms, persistent });

console.log('=== 三类后台任务都要计入 ===');
t('C01 后台 subagent 在跑', countRunningBackgroundTasks(write('a.jsonl', [launch('toolu_a', AGENT, 1)]), NOW), 1);
t('C02 后台命令(Bash/PowerShell) 在跑', countRunningBackgroundTasks(write('b.jsonl', [launch('toolu_b', BASH, 1)]), NOW), 1);
t('C03 Monitor 在跑', countRunningBackgroundTasks(write('m.jsonl', [launch('toolu_m', MON(600000), 1)]), NOW), 1);
t('C04 三类并发 = 3', countRunningBackgroundTasks(write('all.jsonl',
  [launch('toolu_a', AGENT, 1), launch('toolu_b', BASH, 1), launch('toolu_m', MON(600000), 1)]), NOW), 3);

console.log('\n=== 完成通知的三种落盘载体都要认（旧实现只认 user，漏读大多数）===');
t('C05 user/string 载体配平', countRunningBackgroundTasks(write('n1.jsonl', [launch('toolu_a', AGENT, 1), notifUser('toolu_a', 'completed')]), NOW), 0);
t('C06 queue-operation 载体配平', countRunningBackgroundTasks(write('n2.jsonl', [launch('toolu_m', MON(600000), 1), notifQueue('toolu_m', 'completed')]), NOW), 0);
t('C07 attachment 载体配平', countRunningBackgroundTasks(write('n3.jsonl', [launch('toolu_b', BASH, 1), notifAttach('toolu_b', 'completed')]), NOW), 0);
t('C08 failed 是终态', countRunningBackgroundTasks(write('n4.jsonl', [launch('toolu_b', BASH, 1), notifQueue('toolu_b', 'failed')]), NOW), 0);
t('C09 stopped 是终态(resume 对账补发)', countRunningBackgroundTasks(write('n5.jsonl', [launch('toolu_b', BASH, 1), notifQueue('toolu_b', 'stopped')]), NOW), 0);
t('C10 killed 是终态', countRunningBackgroundTasks(write('n6.jsonl', [launch('toolu_b', BASH, 1), notifQueue('toolu_b', 'killed')]), NOW), 0);

console.log('\n=== 非终态通知不得误配平 ===');
const monEvent = JSON.stringify({
  type: 'queue-operation', operation: 'enqueue', timestamp: at(0),
  content: '<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor event: "x"</summary>\n<event>line</event>\n</task-notification>',
});
t('C11 Monitor 事件通知(无 tool-use-id/status) 不配平', countRunningBackgroundTasks(write('e1.jsonl', [launch('toolu_m', MON(600000), 1), monEvent]), NOW), 1);
const stallPing = JSON.stringify({   // leak LocalShellTask.tsx:74-88：带 tool-use-id 但刻意无 <status>
  type: 'queue-operation', operation: 'enqueue', timestamp: at(0),
  content: '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_b</tool-use-id>\n<summary>Background command "x" appears to be waiting for interactive input</summary>\n</task-notification>',
});
t('C12 后台命令"疑似阻塞"提醒(无 status) 不配平', countRunningBackgroundTasks(write('e2.jsonl', [launch('toolu_b', BASH, 1), stallPing]), NOW), 1);

console.log('\n=== TaskStop 配平（TaskStop 不发终态通知，只能读其回执）===');
t('C13 Monitor 被 TaskStop 停 → 配平', countRunningBackgroundTasks(write('k1.jsonl', [launch('toolu_m', MON(600000), 1), taskStop('m1')]), NOW), 0);
t('C14 后台命令被 TaskStop 停 → 配平', countRunningBackgroundTasks(write('k2.jsonl', [launch('toolu_b', BASH, 1), taskStop('b1')]), NOW), 0);
t('C15 persistent Monitor 被 TaskStop 停 → 配平（否则挂满 15min）', countRunningBackgroundTasks(write('k3.jsonl', [launch('toolu_m', MON(0, true), 1), taskStop('m1')]), NOW), 0);
t('C16 TaskStop 停的是别的任务 → 不误配平', countRunningBackgroundTasks(write('k4.jsonl', [launch('toolu_m', MON(600000), 1), taskStop('other')]), NOW), 1);

console.log('\n=== 反污染：命令 stdout 含回执字样不得误计 ===');
const pollute = JSON.stringify({
  type: 'user', timestamp: at(1),
  toolUseResult: { stdout: 'Command running in background with ID: bfake. Async agent launched successfully.', stderr: '', interrupted: false },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'Command running in background with ID: bfake. Async agent launched successfully.' }] },
});
t('C17 前台命令输出含后台回执字样 → 0', countRunningBackgroundTasks(write('p1.jsonl', [pollute]), NOW), 0);

console.log('\n=== 死线兜底 ===');
t('C18 subagent 启动 16min 未配平 → 剔除(15min 阈值)', countRunningBackgroundTasks(write('s1.jsonl', [launch('toolu_a', AGENT, 16)]), NOW), 0);
t('C19 subagent 启动 14min 未配平 → 仍计', countRunningBackgroundTasks(write('s2.jsonl', [launch('toolu_a', AGENT, 14)]), NOW), 1);
t('C20 Monitor timeout=1h、启动 30min → 仍计（统一阈值会误剔）', countRunningBackgroundTasks(write('s3.jsonl', [launch('toolu_m', MON(3600000), 30)]), NOW), 1);
t('C21 Monitor timeout=5min、启动 7min → 剔除（自带死线更精确）', countRunningBackgroundTasks(write('s4.jsonl', [launch('toolu_m', MON(300000), 7)]), NOW), 0);
t('C22 persistent Monitor 启动 16min → 落统一阈值剔除', countRunningBackgroundTasks(write('s5.jsonl', [launch('toolu_m', MON(0, true), 16)]), NOW), 0);

console.log('\n=== 边界 ===');
t('C23 空 jsonl → 0', countRunningBackgroundTasks(write('z1.jsonl', ['']), NOW), 0);
t('C24 jsonl 不存在 → 0（不抛）', countRunningBackgroundTasks(path.join(tmp, 'nope.jsonl'), NOW), 0);

console.log(`\n合计 PASS=${pass} FAIL=${fail}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
