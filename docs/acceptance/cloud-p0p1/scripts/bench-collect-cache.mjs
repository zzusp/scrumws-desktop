// 量化设计 §9b.1：collect.js 缓存层的实际影响面。
// 回答四问：① 实际扫描次数（加缓存前 vs 后）② /api/state 的 P50 延迟 ③ TTL 取多少、依据是什么
//          ④ UI 会不会看到过期数据（read-your-writes）
//
// 扫描次数怎么数：onState 的语义就是「每次扫描成功完成后回调」（契约 §8.2）——它本身就是精确的扫描计数器，
// 不用去插桩内部。（顺带：这也是 onState 导出后的第一个真实调用方。）
//
// 用法：SCRUMWS_DATA_ROOT=<sandbox> node bench-collect-cache.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SCRUMWS_DATA_ROOT;
if (!ROOT) throw new Error('必须显式给 SCRUMWS_DATA_ROOT（沙箱数据根）');
if (ROOT.includes('.scrumws')) throw new Error('拒绝跑在用户真实数据根上：' + ROOT);

const COLLECT = new URL('../../../../platform/lib/collect.js', import.meta.url);
const { getState, collectState, onState, invalidateState, STATE_CACHE_TTL_MS } = await import(COLLECT);

const p50 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)]; };
const ms = (n) => n.toFixed(1) + 'ms';

let scans = 0;
onState(() => { scans++; });

const timed = async (fn) => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

const taskCount = (() => {
  const d = path.join(ROOT, 'runtime', 'runner-state');
  try { return fs.readdirSync(d).length; } catch { return 0; }
})();

console.log('='.repeat(78));
console.log(`量化 §9b.1 · collect.js 缓存层   数据根任务包 = ${taskCount} 个   TTL 常量 = ${STATE_CACHE_TTL_MS}ms`);
console.log('='.repeat(78));

// ---------- 0. 单次全量扫描的裸成本 ----------
await collectState();                       // 预热（首次含模块初始化 / OS 缓存未命中）
const cold = [];
for (let i = 0; i < 8; i++) cold.push(await timed(() => collectState()));
console.log(`\n【0】单次全量扫描裸成本（collectState 直调，无缓存）`);
console.log(`     P50 = ${ms(p50(cold))}   P95 = ${ms(p95(cold))}   n=8`);

// ---------- 1. 加缓存「前」：每次 /api/state 都是一次全量扫描 ----------
// 改造前 /api/state 就是 `sendJson(200, await collectState())`（无条件重扫）。
let uncachedP50;
{
  scans = 0;
  const uiLat = [];      // 每时刻的第一次（冷）—— 这一条才是 /api/state 的真实处境
  const connLat = [];    // 紧随其后的第二次（热）
  // 场景：UI 轮询 + connector tick 共存，每时刻两边各打一次 → 10 个时刻 = 20 次请求。
  // ⚠ 两个陷阱，都会让【1】【2】不是同一把尺子：
  //   ① 时刻间必须留与【2】**相同**的 3.1s 间隔（紧凑循环会让 OS 文件缓存全程滚烫）；
  //   ② UI 与 connector 的两次必须**分开统计**：connector 那次紧跟 UI 之后跑，文件缓存滚烫、
  //      明显更快。把 20 个混在一起取 P50，会被这 10 个「热」样本拉低，得出
  //      「加了缓存反而慢」的假结论 —— 实际量的是「热 vs 冷」，不是「有无缓存」。
  const ROUNDS_1 = 10;
  for (let round = 0; round < ROUNDS_1; round++) {
    uiLat.push(await timed(() => collectState()));     // UI：距上次 3.1s，冷
    connLat.push(await timed(() => collectState()));   // connector：改造前它也得自己扫一次，热
    if (round < ROUNDS_1 - 1) await new Promise((r) => setTimeout(r, 3100));
  }
  uncachedP50 = p50(uiLat);
  console.log(`\n【1】改造前（无缓存）· 10 个时刻 × (UI + connector) = 20 次请求，时刻间隔 3.1s`);
  console.log(`     实际扫描次数 = ${scans} 次（每次请求都重扫）`);
  console.log(`     /api/state（UI，冷）P50 = ${ms(uncachedP50)}   ← 与【2】对比用这个`);
  console.log(`     connector 那次（紧随其后，文件缓存热）P50 = ${ms(p50(connLat))}`);
}

// ---------- 2. 加缓存「后」：UI 与 connector 共享同一次扫描 ----------
{
  await new Promise((r) => setTimeout(r, 3100));   // 先让上一节留下的缓存过期，否则首轮白嫖它、数字失真
  scans = 0;
  const uiLat = [];
  // 同样 10 个「时刻」：每个时刻 UI 与 connector 几乎同时打（真实情形：两个 15s 定时器会漂移相撞）
  const ROUNDS = 10;
  for (let round = 0; round < ROUNDS; round++) {
    const [u] = await Promise.all([
      timed(() => getState({ maxAgeMs: 3000 })),    // /api/state（server.js:183）
      timed(() => getState({ maxAgeMs: 15000 })),   // connector（connector.js:83）
    ]);
    uiLat.push(u);
    if (round < ROUNDS - 1) await new Promise((r) => setTimeout(r, 3100)); // 跨过 3s TTL，模拟下一轮轮询
  }
  console.log(`\n【2】改造后（缓存 + single-flight）· 同样 10 个时刻、每时刻 UI+connector 并发`);
  console.log(`     实际扫描次数 = ${scans} 次（20 次请求合并成 ${scans} 次扫描 = 每时刻 1 次）`);
  const d = ((p50(uiLat) - uncachedP50) / uncachedP50 * 100);
  console.log(`     /api/state（UI，冷）P50 = ${ms(p50(uiLat))}（改造前同口径 ${ms(uncachedP50)}，差 ${d >= 0 ? '+' : ''}${d.toFixed(0)}%）`);
  console.log(`     → UI 侧延迟不变（同为一次冷的全量扫描）：UI 轮询最快 5s > TTL 3s，**每次必然重扫**，`);
  console.log(`       TTL 从不降级 UI 的新鲜度。省下来的是 connector 那 10 次（它白嫖 UI 的扫描）。`);
}

// ---------- 3. 瞬时并发合并（多标签页 / modal 关闭补拉） ----------
{
  scans = 0;
  await new Promise((r) => setTimeout(r, 3100));   // 让缓存过期，保证这批要真扫
  const t = process.hrtime.bigint();
  const rs = await Promise.all(Array.from({ length: 20 }, () => getState({ maxAgeMs: 3000 })));
  const wall = Number(process.hrtime.bigint() - t) / 1e6;
  const same = rs.every((r) => r === rs[0]);
  console.log(`\n【3】20 个并发 /api/state（多标签页 / modal 补拉）`);
  console.log(`     实际扫描次数 = ${scans} 次   墙钟 = ${ms(wall)}   20 个返回同一对象 = ${same}`);
  console.log(`     → single-flight 生效：并发不放大扫描（否则这里是 20 次全量扫描）`);
}

// ---------- 4. connector 白嫖 UI 那次扫描 ----------
{
  scans = 0;
  await new Promise((r) => setTimeout(r, 3100));
  await getState({ maxAgeMs: 3000 });              // UI 轮询：真扫
  const afterUi = scans;
  const cl = await timed(() => getState({ maxAgeMs: 15000 }));  // connector：应命中缓存
  console.log(`\n【4】UI 扫完后 connector 紧接着 tick（maxAgeMs=15000）`);
  console.log(`     UI 扫描 ${afterUi} 次 → connector 后总扫描 ${scans} 次（+${scans - afterUi}）   connector 取数耗时 = ${ms(cl)}`);
  console.log(`     → connector 白嫖 UI 的扫描，上报不额外增加扫描成本`);
}

// ---------- 5. read-your-writes（红线 2）----------
{
  const dir = path.join(ROOT, 'runtime', 'runner-state');
  const pick = fs.readdirSync(dir)[0];
  const tf = path.join(dir, pick, 'task.json');
  const orig = JSON.parse(fs.readFileSync(tf, 'utf8'));
  const restore = () => fs.writeFileSync(tf, JSON.stringify(orig, null, 2));
  const titleOf = (s) => Object.values(s.lifecycle).flat().find((c) => c.safeTaskKey === pick)?.title;

  try {
    await getState({ maxAgeMs: 3000 });                       // 先让缓存热起来（模拟 mutation 前的轮询）
    const before = titleOf(await getState({ maxAgeMs: 3000 }));

    // 模拟一次 mutation：重命名（logs.js:607 renameTask 只写 task.json.customTitle）
    fs.writeFileSync(tf, JSON.stringify({ ...orig, customTitle: 'RENAMED-BY-USER' }, null, 2));
    // 前端的 mutation 回拉：await api(POST…) 紧跟 await refreshState()（app.js:752 等 27 处）
    // ⚠ 关键：server.js 在每个 POST 的 res 'finish' 上调 invalidateState()，这里如实复现那一步
    invalidateState();
    const afterWithFix = titleOf(await getState({ maxAgeMs: 3000 }));

    console.log(`\n【5】read-your-writes（红线 2）· 写 customTitle 后立刻回拉 /api/state`);
    console.log(`     mutation 前标题 = ${JSON.stringify(before)}`);
    console.log(`     mutation 后回拉 = ${JSON.stringify(afterWithFix)}  ← 期望 "RENAMED-BY-USER"`);
    console.log(`     ${afterWithFix === 'RENAMED-BY-USER' ? '✅ PASS：写后立刻可读' : '❌ FAIL：拿到过期数据'}`);

    // 对照：若不作废缓存（= 修复前的行为）会怎样
    fs.writeFileSync(tf, JSON.stringify({ ...orig, customTitle: 'RENAMED-AGAIN' }, null, 2));
    const afterNoInvalidate = titleOf(await getState({ maxAgeMs: 3000 }));   // 故意不调 invalidateState
    console.log(`     对照（不调 invalidateState，= 修复前）：回拉得到 ${JSON.stringify(afterNoInvalidate)}`);
    console.log(`     → ${afterNoInvalidate === 'RENAMED-AGAIN' ? '（本次恰好缓存已过期，未复现）' : '这就是修复前 UI 看到过期数据的原因：命中 3s 缓存，返回 mutation 之前的快照'}`);
  } finally {
    restore();
  }
}

console.log('\n' + '='.repeat(78));
console.log('扫描成本随任务包数怎么长 → 见 bench-scan-scale.mjs（换根必须换进程：');
console.log('collect.js 的 ROOT 在模块加载时由 paths.js:7 定死，同进程内改 env 无效）');
console.log('='.repeat(78));
process.exit(0);
