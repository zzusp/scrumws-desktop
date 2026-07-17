// 单次全量扫描成本 vs 任务包数 —— TTL 取值到底值不值的依据。
// 沙箱只有几个包，拿它的数字去推断线上会低估：collectState 是 readdir + 每包读 5 个 JSON，
// 成本随包数线性长（collect.js:71-76）。
//
// ⚠ 换任务数必须换进程：collect.js 的 ROOT 在模块加载时由 paths.js:7 定死，同进程改 env 无效。
// 本脚本 = 一个「子进程」：给定 SCRUMWS_DATA_ROOT + BENCH_N，造 N 个包、测扫描 P50、打印一行。
// 由 run-scan-scale.sh / 手工用不同 N 各跑一次。
//
// 用法：SCRUMWS_DATA_ROOT=<一次性根> BENCH_N=100 node bench-scan-scale.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SCRUMWS_DATA_ROOT;
const N = Number(process.env.BENCH_N || 0);
if (!ROOT) throw new Error('必须给 SCRUMWS_DATA_ROOT');
if (ROOT.includes('.scrumws')) throw new Error('拒绝跑在用户真实数据根上：' + ROOT);
if (!N) throw new Error('必须给 BENCH_N');

// 造 N 个任务包（终态 done，带 meta；prompt 2KB 贴近真实）
const rs = path.join(ROOT, 'runtime', 'runner-state');
fs.rmSync(rs, { recursive: true, force: true });
fs.mkdirSync(rs, { recursive: true });
for (let i = 0; i < N; i++) {
  const d = path.join(rs, `manual__bench-${String(i).padStart(4, '0')}`);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'task.json'), JSON.stringify({
    taskKey: `manual:bench-${i}`, source: 'manual', title: `压测任务 ${i}`,
    prompt: 'x'.repeat(2000), model: 'claude-opus-4-8', effort: 'xhigh',
    cwd: 'D:\\project\\demo', createdAt: '2026-07-16 10:00:00',
  }));
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({
    state: 'done', enteredAt: '2026-07-16 10:00:00', outcome: 'success', resolvedAt: '2026-07-16 10:05:00',
    history: [{ state: 'queued', at: '2026-07-16 10:00:00', by: 'create:manual' },
              { state: 'processing', at: '2026-07-16 10:00:10', by: 'session' },
              { state: 'done', at: '2026-07-16 10:05:00', by: 'user' }],
  }));
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({
    sessionId: `sid-bench-${i}`, rounds: 2, numTurns: 6, totalCostUsd: 0.1,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
  }));
}

const { collectState } = await import(new URL('../../../../platform/lib/collect.js', import.meta.url));
const p50 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

await collectState();  // 预热
const lat = [];
for (let i = 0; i < 9; i++) {
  const t = process.hrtime.bigint();
  const snap = await collectState();
  lat.push(Number(process.hrtime.bigint() - t) / 1e6);
  if (i === 0) {
    const got = Object.values(snap.lifecycle).flat().length;
    if (got !== N) console.error(`  ⚠ 扫到 ${got} 张，期望 ${N} —— 包没进桶，数字不可信`);
  }
}
console.log(`${String(N).padStart(5)} 个任务包   扫描 P50 = ${p50(lat).toFixed(1)}ms   （每包约 ${(p50(lat) / N).toFixed(3)}ms）`);
