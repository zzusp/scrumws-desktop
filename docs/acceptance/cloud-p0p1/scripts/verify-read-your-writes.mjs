// 红线 2（read-your-writes）在**真实跑着的看板进程**上的验证 —— 不是单测、不是模拟。
// 复现前端的真实时序（app.js:752 等 27 处）：await api(POST…) 紧跟 await refreshState()。
//   refreshState = 裸 api('/api/state')（app.js:2190），无 cache-buster（app.js:85-88），
//   而 /api/state 走 getState({maxAgeMs:3000})（server.js:183）。
// 修复前：mutation 前 3s 内发生过任何扫描（UI 上一轮轮询 / connector tick）→ 回拉命中缓存 →
//        拿到 mutation **之前**的快照，要等下一轮轮询（默认 15s）才自愈。
//
// 用法：node verify-read-your-writes.mjs <localUrl> <taskKey>
const [, , LOCAL, TASK_KEY] = process.argv;
if (!LOCAL || !TASK_KEY) throw new Error('用法：node verify-read-your-writes.mjs <localUrl> <taskKey>');

const state = async () => (await fetch(LOCAL + '/api/state')).json();
const titleOf = (s) => Object.values(s.lifecycle).flat().find((c) => c.taskKey === TASK_KEY)?.title;
const rename = async (title) => {
  const r = await fetch(`${LOCAL}/api/task/rename?taskKey=${encodeURIComponent(TASK_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  });
  return r.status;
};

const orig = titleOf(await state());
console.log(`任务 ${TASK_KEY}\n原标题 = ${JSON.stringify(orig)}\n`);

let pass = true;
try {
  // 关键前置：先打一次 /api/state，让缓存**刚刚**热起来（模拟 mutation 前 3s 内的轮询/connector tick）。
  // 没有这一步，缓存早过期，回拉自然重扫 —— 那就绕开了 bug、测了个寂寞。
  await state();
  const t0 = Date.now();

  // 前端时序：mutation → 立刻回拉
  const st = await rename('RENAMED-BY-USER');
  const back = titleOf(await state());
  const dt = Date.now() - t0;

  console.log(`POST /api/task/rename → HTTP ${st}`);
  console.log(`紧接着 GET /api/state（距上次扫描 ${dt}ms，在 3s TTL 窗口内）`);
  console.log(`  回拉标题 = ${JSON.stringify(back)}`);
  console.log(`  期望     = "RENAMED-BY-USER"`);
  if (dt >= 3000) {
    console.log(`  ⚠ 间隔已超 3s TTL，本次没落在缓存窗口内 → 这轮不足以证伪，判 FAIL 要求重跑`);
    pass = false;
  } else if (back === 'RENAMED-BY-USER') {
    console.log(`  ✅ PASS：写后立刻可读（invalidateState 在 POST 的 res 'finish' 上生效）`);
  } else {
    console.log(`  ❌ FAIL：拿到 mutation 之前的快照 —— 缓存破坏了 read-your-writes`);
    pass = false;
  }

  // 再验一次：连续两次 mutation + 回拉（每次都必须读到自己刚写的）
  for (const t of ['第二次改名-AAA', '第三次改名-BBB']) {
    await state();                       // 再次把缓存焐热
    await rename(t);
    const got = titleOf(await state());
    const ok = got === t;
    if (!ok) pass = false;
    console.log(`  连续 mutation：写 ${JSON.stringify(t)} → 回拉 ${JSON.stringify(got)}  ${ok ? '✅' : '❌'}`);
  }
} finally {
  // 还原（rename 空串 = 清 customTitle，回到 task.title）
  await rename('');
  console.log(`\n已还原标题 → ${JSON.stringify(titleOf(await state()))}`);
}
process.exit(pass ? 0 : 1);
