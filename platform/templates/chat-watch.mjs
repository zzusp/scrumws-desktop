// 盯群派发器（chat-watch）—— scripts/watch-dispatch.ps1 的 Node 移植（2026-07-10 派发链 Node 化）
// 由看板调度器每 intervalSec 秒 fork 一次（上一轮未结束自动跳过 = 原 IgnoreNew 语义）。
// 流程：① dws 授权闸门 → ② quick check 并行拉 3+N 会话（水位线起点）→ ③ 热会话判据
//       （sender=孙鹏 且 cc: 开头 且 晚于水位）→ ④ 额度闸门 → ⑤ 单飞判据 → 建任务包 → spawn watch-worker.ps1
// 磁盘契约与 .ps1 时代一字不改：runner-state/chat__<key>/{task,state,lease}.json + watermark。
// ctx 提供公共判据（lease 判活 / quota / spawn 循环防护 / dws 熔断），见 dashboard/lib/jobs/ctx.js。

const INIT_MINUTES = 10;          // 水位缺失/陈旧时的拉取下限（now - N min）
const ME = '孙鹏';                // 只认他的 cc:
const CONVS = [
  { key: 'group-1', kind: 'group', id: 'cidh68vjTKj0keMxunTPA2LMw==',  title: 'HiQ 产品研发' },
  { key: 'group-2', kind: 'group', id: 'cidq+PGRQW098/2Qh23wrl/ZQ==', title: '广场＆编辑器迭代中...' },
  { key: 'self',    kind: 'self',  id: '2534160801765462',            title: '孙鹏 cc 自聊' },
];

export default async function tick(ctx) {
  const { P, join, log, out, dryRun, ts, fmt, parse } = ctx;
  ctx.mkdirp(P.runnerRoot);
  ctx.mkdirp(P.dispatchChatDir);

  // ---- dws 授权闸门（最前面，token 失效直接熔断避免 quick check 弹浏览器）----
  if (!(await ctx.dwsAuthGate('dispatch-chat'))) return;

  const cfg = ctx.runnerConfig();
  const maxConcurrent = Number(cfg.maxConcurrentRunners) > 0 ? Number(cfg.maxConcurrentRunners) : 5;
  const pauseInvestigation = cfg.pauseInvestigation === true;

  // ---- 会话定义（3 固定 + dm 白名单）----
  const convs = [...CONVS];
  const wlFile = join(P.dispatchChatDir, 'colleagues.json');
  if (ctx.exists(wlFile)) {
    const wl = ctx.readJson(wlFile);
    if (wl && Array.isArray(wl.colleagues)) {
      for (const cg of wl.colleagues) convs.push({ key: `dm-${cg.userId}`, kind: 'dm', id: String(cg.userId), title: `同事-${cg.name}` });
    } else {
      log('警告：colleagues.json 解析失败，dm 路本轮跳过');
    }
  }

  const initFloor = new Date(Date.now() - INIT_MINUTES * 60000);
  const initFloorStr = fmt(initFloor);
  const taskDirOf = (key) => join(P.runnerRoot, `chat__${key}`);

  // ---- ① quick check 并行（水位线即拉取起点：start = max(watermark, now-InitMinutes)）----
  const fetch = await Promise.all(convs.map(async (c) => {
    const wmf = join(taskDirOf(c.key), 'watermark');
    const wm = ctx.exists(wmf) ? (ctx.readText(wmf) || '').trim() : '';
    const wmDate = wm ? parse(wm) : null;
    const start = wmDate && wmDate > initFloor ? wm : initFloorStr;
    const args = c.kind === 'group'
      ? ['chat', 'message', 'list', '--group', c.id, '--time', start, '--limit', '30', '--format', 'json']
      : ['chat', 'message', 'list-direct', '--user', c.id, '--time', start, '--limit', '30', '--format', 'json'];
    const r = await ctx.exec('dws', args, { timeout: 45000 });
    return { ...c, start, raw: r.stdout };
  }));

  // ---- ② 热会话（sender=孙鹏 + cc: 开头 + 晚于水位）----
  const hot = [];
  for (const res of fetch) {
    try {
      const msgs = JSON.parse(res.raw)?.result?.messages || [];
      const startDate = parse(res.start);
      const fresh = msgs.filter((m) => m.sender === ME && /^\s*cc[:：]/.test(m.content || '') && m.createTime && parse(m.createTime) > startDate);
      if (fresh.length > 0) hot.push(res);
    } catch (e) { log(`quick check 解析 ${res.key} 出错：${e.message}（跳过该路）`); }
  }

  if (hot.length === 0) {
    log(`本轮巡检（${convs.length} 会话）：均无新 cc:，跳过`);
    if (dryRun) out(`quick check（initFloor ${initFloorStr}）：无热会话 → 不 spawn`);
    return;
  }

  // ---- ②a 额度闸门 ----
  const blockUntil = ctx.quotaBlockActive();
  if (blockUntil) {
    log(`额度受限至 ${fmt(blockUntil)}，热会话 ${hot.length} 个本轮不 spawn`);
    if (dryRun) out(`=== 额度受限至 ${fmt(blockUntil)}，本轮跳过 spawn（热会话 ${hot.length} 个）===`);
    return;
  }

  // ---- ③ 认领 + spawn 外壳 ----
  let liveLeases = ctx.countLiveLeases();
  const plan = [];
  for (const c of hot) {
    try {
      const taskDir = taskDirOf(c.key);
      const lf = join(taskDir, 'lease.json');
      if (ctx.exists(lf)) {
        const l = ctx.readJson(lf);
        if (l && ctx.leaseAlive(l)) { plan.push(`skip ${c.key}（worker 在处理，pid=${l.pid}）`); continue; }
        if (!dryRun) {
          await ctx.stopZombieWorker(l);   // pid 活但心跳超 HardTTL → 先杀树再回收，防双 worker
          ctx.rm(lf);
        }
        plan.push(`回收陈旧租约 ${c.key}（pid=${l?.pid ?? '?'}）`);
      }
      // ---- 无论是否 spawn 都建/更新任务包（queued 排队不受上限限制、看板可见）----
      // 同时读 existing.state：awaiting-human/processing 是"人工兜底中 / runner 在跑"，本轮不重派
      let existingState = null;
      if (!dryRun) {
        ctx.mkdirp(taskDir);
        const wmf = join(taskDir, 'watermark');
        if (!ctx.exists(wmf)) ctx.writeText(wmf, c.start);
        ctx.writeJson(join(taskDir, 'task.json'), {
          taskKey: `chat:${c.key}`, source: 'chat', kind: c.kind, rawId: c.id, title: c.title,
          mode: 'drain', metaMode: 'accumulate', createdAt: ts,
        });
        // state.json：保留 processing/awaiting-human/plan；done 来新消息重开新生命周期
        const sf = join(taskDir, 'state.json');
        let writeState = true;
        const existing = ctx.exists(sf) ? ctx.readJson(sf) : null;
        if (existing) {
          existingState = String(existing.state || '');
          if (['processing', 'awaiting-human', 'plan'].includes(existingState)) writeState = false;
        }
        if (writeState) {
          const initState = ctx.planRequired('chat') ? 'plan' : 'queued';
          ctx.writeJson(sf, {
            state: initState, enteredAt: ts, outcome: null, resolvedAt: null,
            outcomeDetail: { quotaResetAt: null, failureReason: null, checkerExhausted: false },
            history: [{ state: initState, at: ts, by: 'dispatcher' }],
          });
          existingState = initState;
        }
      }

      // ---- spawn 判据 ----
      if (existingState === 'plan') { plan.push(`hold ${c.key}（state=plan 待看板确认、不 spawn）`); continue; }
      if (existingState === 'awaiting-human') { plan.push(`skip ${c.key}（state=awaiting-human 人工兜底中、不重派）`); continue; }
      if (existingState === 'processing') { plan.push(`skip ${c.key}（state=processing 但 lease 已过期、等 checker 3min 兜底）`); continue; }
      if (pauseInvestigation) { plan.push(`queued ${c.key}（pauseInvestigation=true 全局暂停派发，任务包已建）`); continue; }
      if (liveLeases >= maxConcurrent) { plan.push(`queued ${c.key}（全局 processing=${liveLeases} ≥ ${maxConcurrent} 上限，任务包已建）`); continue; }
      if (ctx.spawnLoop(taskDir)) {
        plan.push(`BLOCK ${c.key}（5min 内 spawn ≥4 次，疑似重派循环，本轮拦截）`);
        if (!dryRun) await ctx.spawnLoopAlert(taskDir, `chat:${c.key}`);
        continue;
      }
      plan.push(`认领+spawn ${c.key}（kind=${c.kind}）`);
      liveLeases++;
      if (dryRun) continue;
      ctx.addSpawnRecord(taskDir);

      // lease.json 占位（pid=0，外壳/runner 起来自补 pid + heartbeat）
      ctx.writeText(lf, JSON.stringify({ taskKey: `chat:${c.key}`, claimedAt: ts, pid: 0, heartbeatAt: ts }));

      const stderrLog = `runtime\\watch-worker-${c.key}.stderr.log`;
      const r = await ctx.spawnWorker({
        script: 'scripts\\watch-worker.ps1',
        args: ['-TaskKey', `chat:${c.key}`, '-InitMinutes', String(INIT_MINUTES)],
        stdoutLog: `runtime\\watch-worker-${c.key}.stdout.log`,
        stderrLog,
      });
      if (!r.ok && r.error) log(`spawn ${c.key} 失败：${r.error}`);
      else if (!r.ok && r.exitedEarly) log(`spawn ${c.key} 起飞就退：pid=${r.pid} exit=${r.exitCode} → 查 ${stderrLog}`);
      else plan.push(`spawn ${c.key} ok pid=${r.pid}`);
    } catch (e) {
      plan.push(`ERROR ${c.key}（kind=${c.kind}）：${e.message}`);
    }
  }

  log(`${dryRun ? '[DryRun] 将派发' : '派发'}：热会话 ${hot.length} 个；` + plan.join('；'));
  if (dryRun) {
    out(`=== DRY RUN（quick check 已真跑；initFloor ${initFloorStr}）===`);
    out('热会话：'); hot.forEach((h) => out(`  - ${h.key}  kind=${h.kind}  start=${h.start}  title=${h.title}`));
    out('派发计划（未执行）：'); plan.forEach((p) => out(`  - ${p}`));
  }
}
