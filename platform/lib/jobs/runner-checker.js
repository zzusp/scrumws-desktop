// 平台守护 · 孤儿任务收纳器。平台内置 job（不可表单编辑），由看板进程内调度器每 intervalSec 秒 fork 一次
// （去派发器 + 交互会话统一为任务后，是调度器唯一的 job）。
// 流程（纯脚本层，不启 claude、不消耗额度）：
//   ① 扫 runner-state/ 找孤儿（lease 死 + resolvedAt=null + state 不在 awaiting-human/queued/plan 跳过名单）
//   ② 每个孤儿：提 sid（meta.sessionId ?? state.pendingResumeSessionId）→ 标 awaiting-human +
//      outcomeDetail.resumeSessionId，落看板 awaiting-human 分区由人处置（从详情回复即 --resume 续 / 重新发起）
// 覆盖场景：Mode B 会话执行到一半服务重启（内存会话丢失、claude 子进程随 stdin 断退出）→ lease pid 死 →
//   本 job 把卡在 processing 的任务收成 awaiting-human，带 resumeSessionId，用户回复即续。
// 平台组件不外发通知：孤儿可见性靠看板 awaiting-human 分区 + 数据看板红瓦片。

export default async function tick(ctx) {
  const { P, join, log, out, dryRun, fmt } = ctx;
  const now = () => fmt(new Date());

  // ---- ① 扫孤儿 ----
  const dirs = ctx.listDirs(P.runnerRoot);
  const orphans = [];
  for (const name of dirs) {
    const dir = join(P.runnerRoot, name);
    const leaseFile = join(dir, 'lease.json');
    const stateFile = join(dir, 'state.json');
    if (!ctx.exists(leaseFile) && !ctx.exists(stateFile)) continue;   // 完全空任务包
    if (ctx.exists(leaseFile)) {
      const l = ctx.readJson(leaseFile);
      if (l && ctx.leaseAlive(l)) continue;   // 真在跑（含 pid=0 <2min 宽限）
    }
    if (!ctx.exists(stateFile)) continue;
    const s = ctx.readJson(stateFile);
    if (!s) continue;
    // 跳过名单：awaiting-human 人工兜底中；queued 待运行；plan 待确认（从未起会话）
    if (['awaiting-human', 'queued', 'plan'].includes(String(s.state))) continue;
    if (s.resolvedAt) continue;
    orphans.push({ dir, taskKey: s.taskKey || null, stateFile, metaFile: join(dir, 'meta.json'), safeKey: name });
  }

  // 补 TaskKey（task.json 或目录名逆推：<source>__<slug> → <source>:<slug>）
  for (const o of orphans) {
    if (o.taskKey) continue;
    const t = ctx.readJson(join(o.dir, 'task.json'));
    if (t?.taskKey) { o.taskKey = t.taskKey; continue; }
    o.taskKey = o.safeKey.includes('__') ? o.safeKey.replace('__', ':') : `unknown:${o.safeKey}`;
  }

  log(`扫描 ${dirs.length} 个任务包，孤儿 ${orphans.length} 个${dryRun ? ' [DryRun]' : ''}`);
  if (orphans.length === 0) {
    if (dryRun) out('无孤儿任务');
    return;
  }

  // ---- ② helpers ----
  function updateOrphanState(orphan, patch) {
    if (dryRun) return;
    const s = ctx.readJson(orphan.stateFile) || {};
    if (!Array.isArray(s.history)) s.history = [];
    const prevState = s.state;
    Object.assign(s, patch);
    if ('state' in patch && patch.state !== prevState) {
      s.history = [...s.history, { state: patch.state, at: now(), by: 'checker' }];
      s.enteredAt = now();
    }
    ctx.writeJson(orphan.stateFile, s);
  }
  function appendCheckerLog(orphan, line) {
    if (dryRun) return;
    ctx.appendText(join(orphan.dir, 'checker.log'), `[${now()}] ${line}\n`);
  }

  // ---- ③ 收纳：直接标 awaiting-human（看板 awaiting-human 分区即出口，不外发通知）----
  const plan = [];
  for (const o of orphans) {
    try {
      let sid = null;
      const meta = ctx.exists(o.metaFile) ? ctx.readJson(o.metaFile) : null;
      if (meta?.sessionId) sid = String(meta.sessionId);
      if (!sid) {
        const s = ctx.readJson(o.stateFile);
        if (s?.pendingResumeSessionId) sid = String(s.pendingResumeSessionId);
      }
      const sidShort = sid ? sid.slice(0, 8) : null;

      const reason = sid
        ? '会话中断（pid 死 + 未收尾）；sid 已落，可从看板回复续（--resume）'
        : '会话中断（pid 死 + 未收尾）；无 sid 无法续、需从看板重新发起';
      plan.push(sid ? `PROMOTE ${o.taskKey} sid=${sidShort}` : `PROMOTE ${o.taskKey}（无 sid 可续）`);
      appendCheckerLog(o, sid ? `verdict=ORPHAN-PROMOTED sid=${sidShort}` : 'verdict=ORPHAN-PROMOTED no-sid');

      updateOrphanState(o, {
        state: 'awaiting-human',
        outcome: 'failed',
        resolvedAt: now(),
        outcomeDetail: {
          quotaResetAt: null, failureReason: reason, checkerExhausted: false,
          resolvedBy: 'checker', resumeSessionId: sid,
        },
      });
    } catch (e) {
      plan.push(`ERROR ${o.taskKey}：${e.message}`);
      log(`checker 处理 ${o.taskKey} 出错：${e.message}`);
    }
  }

  log(`${dryRun ? '[DryRun] ' : ''}孤儿 ${orphans.length} 个；` + plan.join('；'));
  if (dryRun) {
    out('=== DRY RUN ===');
    out(`扫描目录：${P.runnerRoot}`);
    out(`孤儿数：${orphans.length}`);
    out('计划：'); plan.forEach((p) => out(`  - ${p}`));
  }
}
