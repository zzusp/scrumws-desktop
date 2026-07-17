// 逐卡对比「本地 /api/state 的 6 个桶」与「云端 GET /api/tasks」的 state，输出 PASS/FAIL。
// 这是 P1 的核心断言：云端镜像必须与本地权威一致（契约 §5.4「云端看板要和本地看板显示一致」）。
//
// 用法：node compare-local-cloud.mjs <localUrl> <cloudUrl> <cookieFile>
import fs from 'node:fs';

const [, , LOCAL, CLOUD, COOKIE_FILE] = process.argv;
if (!LOCAL || !CLOUD || !COOKIE_FILE) throw new Error('用法：node compare-local-cloud.mjs <localUrl> <cloudUrl> <cookieFile>');

const cookie = (() => {
  for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) {
    const p = l.split('\t');
    if (p.length >= 7 && p[5] === 'swsession') return `swsession=${p[6]}`;
  }
  throw new Error('cookie jar 里没有 swsession');
})();

const snap = await (await fetch(LOCAL + '/api/state')).json();
// 本地 6 个桶摊平（与 reconcile.js flattenCards 同源）
const localCards = Object.values(snap.lifecycle).flat();
const local = new Map(localCards.map((c) => [c.taskKey, c]));

// 云端：把 5 个 state 桶各查一次 + 归档桶，凑齐该机器全集
const cloudTasks = [];
for (const st of ['plan', 'queued', 'processing', 'awaiting-human', 'done', 'archived']) {
  const r = await fetch(`${CLOUD}/api/tasks?state=${encodeURIComponent(st)}&limit=200`, { headers: { cookie } });
  const j = await r.json();
  for (const t of j.tasks) cloudTasks.push(t);
}
const cloud = new Map(cloudTasks.map((t) => [t.localTaskKey, t]));

let pass = true;
console.log('taskKey                          本地state        云端state        mirror        一致');
console.log('-'.repeat(96));
for (const [k, c] of local) {
  const t = cloud.get(k);
  // 云端 state 列存底层态，归档由 is_archive 表达 → 期望桶按 isArchive 优先（同 collect.js:204）
  const localBucket = c.isArchive ? 'archived' : c.state;
  const cloudBucket = t ? (t.status.isArchive ? 'archived' : t.status.state) : '（云端没有）';
  const ok = !!t && localBucket === cloudBucket;
  if (!ok) pass = false;
  console.log(
    k.padEnd(33), localBucket.padEnd(16), String(cloudBucket).padEnd(16),
    String(t?.status.mirror ?? '-').padEnd(13), ok ? 'PASS' : 'FAIL',
  );
}
// 云端有、本地没有的（应是 local_missing，不该凭空多出 live 卡）
for (const [k, t] of cloud) {
  if (local.has(k)) continue;
  const ok = t.status.mirror === 'local_missing';
  if (!ok) pass = false;
  console.log(k.padEnd(33), '（本地没有）'.padEnd(12), String(t.status.state).padEnd(16), String(t.status.mirror).padEnd(13), ok ? 'PASS(local_missing)' : 'FAIL');
}
console.log('-'.repeat(96));
console.log(`本地 ${local.size} 张 / 云端 ${cloud.size} 张 → ${pass ? 'PASS 全部一致' : 'FAIL 存在不一致'}`);
process.exit(pass ? 0 : 1);
