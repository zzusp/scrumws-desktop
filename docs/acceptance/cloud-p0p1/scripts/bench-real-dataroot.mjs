/**
 * §9b.1 在**真实数据根规模**上复测 collect 缓存。
 *
 * 为什么要单独测：round-1 的 bench 跑在只有 4 个任务包、0 张 CLI 卡的沙箱上，
 * 得出「单次扫描 P50 = 4.9ms」并外推「~0.5ms/包，300 包 = 152ms」。但那个外推漏了成本大头——
 * CLI 观察态卡要**反读 CC 自己的 jsonl** 数子 agent（collect-cli.js:195），
 * 而沙箱里一张 CLI 卡都没有，等于这块成本完全没进模型。
 *
 * 本脚本跑在真实数据根的**镜像**上（同样 17 活跃 + 9 归档 + 25 张 CLI 卡，
 * jsonl 仍指向真实的 ~/.claude/projects，共 1683 文件 / 564MB），
 * 只读，不碰用户真实的 ~/.scrumws。
 *
 * 用法：SCRUMWS_DATA_ROOT=<镜像> node bench-real-dataroot.mjs
 */
import { performance } from 'node:perf_hooks';

const ROOT = process.env.SCRUMWS_DATA_ROOT;
if (!ROOT) { console.error('需要 SCRUMWS_DATA_ROOT'); process.exit(1); }
if (/\.scrumws$/.test(ROOT.replace(/[\\/]+$/, ''))) {
  console.error('拒绝在真实数据根上跑：collect-cli.js:57 会 unlink 死 sentinel，那是写操作。请用镜像。');
  process.exit(1);
}

const collect = await import('../../../../platform/lib/collect.js');

const p = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const fmt = (n) => n.toFixed(1).padStart(7);

async function timeIt(fn, n) {
  const ts = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); }
  return ts;
}

console.log('='.repeat(78));
console.log('§9b.1 复测 · 真实数据根规模');
console.log('='.repeat(78));

// 先跑一次让 claude --version 的 5min TTL 缓存就位（collect.js:245），否则首次会把 spawn 成本算进来
const warm = await collect.collectState();
const buckets = warm.lifecycle ?? warm.buckets ?? {};
const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
const total = Object.values(counts).reduce((a, b) => a + b, 0);
const cliCards = Object.values(buckets).flat().filter((c) => c && c.cli).length;
console.log(`\n数据规模：卡片总数 ${total}（其中 CLI 观察态 ${cliCards} 张）`);
console.log(`  分桶：${JSON.stringify(counts)}`);

console.log('\n【1】collectState() 裸成本（无缓存，每次全量重扫 + 反读 jsonl）');
const raw = await timeIt(() => collect.collectState(), 10);
console.log(`     P50 = ${fmt(p(raw, 0.5))}ms   P95 = ${fmt(p(raw, 0.95))}ms   min = ${fmt(Math.min(...raw))}ms   n=10`);
console.log(`     对照 round-1 沙箱（4 包 / 0 CLI 卡）：P50 = 4.9ms`);
const perCard = p(raw, 0.5) / total;
console.log(`     摊到每张卡：${perCard.toFixed(1)}ms/卡   对照 round-1 外推模型：~0.5ms/包`);

console.log('\n【2】single-flight：20 个并发 getState() 应只触发 1 次扫描');
let scans = 0;
const off = collect.onState(() => { scans++; });
collect.invalidateState();
const t0 = performance.now();
const rs = await Promise.all(Array.from({ length: 20 }, () => collect.getState({ maxAgeMs: 3000 })));
const wall = performance.now() - t0;
const same = rs.every((r) => r === rs[0]);
console.log(`     实际扫描 = ${scans} 次   墙钟 = ${wall.toFixed(1)}ms   20 个返回同一对象 = ${same}`);
console.log(`     若无 single-flight，这里是 20 × ${p(raw, 0.5).toFixed(0)}ms ≈ ${(20 * p(raw, 0.5) / 1000).toFixed(1)}s 连续扫描`);

console.log('\n【3】写代次：invalidateState() 后必须重扫（read-your-writes 的根）');
scans = 0;
await collect.getState({ maxAgeMs: 3000 });        // 填充缓存
const before = scans;
await collect.getState({ maxAgeMs: 3000 });        // TTL 内，应命中缓存
const cached = scans;
collect.invalidateState();                          // 模拟一次写操作
await collect.getState({ maxAgeMs: 3000 });        // 应重扫，不得返回旧代次
const after = scans;
console.log(`     填充后扫描数 ${before} → TTL 内再取 ${cached}（+${cached - before}，应为 +0=命中缓存）`);
console.log(`     invalidate 后再取 ${after}（+${after - cached}，应为 +1=强制重扫）`);
console.log(`     结论：${cached - before === 0 && after - cached === 1 ? '✔ 缓存生效且写后必新鲜' : '✘ 异常'}`);

console.log('\n【4】connector 白嫖：UI 扫完后 connector tick（maxAgeMs=15000）应 +0 次扫描');
scans = 0;
collect.invalidateState();
await collect.getState({ maxAgeMs: 3000 });        // UI
const uiScans = scans;
const tc = performance.now();
await collect.getState({ maxAgeMs: 15000 });       // connector
const connCost = performance.now() - tc;
console.log(`     UI 扫描 ${uiScans} 次 → connector 后总扫描 ${scans} 次（+${scans - uiScans}）   connector 取数耗时 ${connCost.toFixed(1)}ms`);

off?.();
console.log('\n' + '='.repeat(78));
