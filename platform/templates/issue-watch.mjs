// Issue 派发器（issue-watch）—— scripts/issue-watch.ps1 的 Node 移植（2026-07-10 派发链 Node 化）
// 由看板调度器每 intervalSec 秒 fork 一次（上一轮未结束自动跳过 = 原 IgnoreNew 语义）。
// 派发器只做「gh list → 指纹比对 → 判该派 → 建任务包 → spawn issue-worker.ps1 外壳」。
// 判据"已有人处理"（任一命中即 skipped、不 spawn）：① assignees ② 团队评论（MEMBER/OWNER/COLLABORATOR，
// 历史有过就永久 skip）③ linked PR。指纹 sha1(assignees+最新评论+labels+updatedAt+PR) 防重复处理。
// 指令模式：dispatch-issue/instructions/<n>.json pending 优先派（绕过自动判据）。
// 缺席检查：本地非归档、open 列表不见的 → gh view 确认 CLOSED 落 business.json。
// ⚠️ 指纹算法与 .ps1 版存在已知无害差异（PS 把 updatedAt 反序列化成 DateTime 再字符串化）：
//   切换后首轮所有存量指纹视为"变了"→ 重分类一轮即收敛；done/awaiting-human/processing 有终态保护不会误 spawn。

const REPO = 'HiQ-AI/feedback';
const LABELS = ['line:editor', 'type:bug'];

import { createHash } from 'node:crypto';

export default async function tick(ctx) {
  const { P, join, log, out, dryRun, ts, fmt, parse } = ctx;
  const repoSlug = REPO.replace(/\//g, '-');
  const instrDir = join(P.dispatchIssueDir, 'instructions');
  const skippedDir = join(P.dispatchIssueDir, 'skipped');
  const closedDir = join(P.dispatchIssueDir, 'closed');
  for (const d of [P.runnerRoot, P.dispatchIssueDir, instrDir, skippedDir, closedDir]) ctx.mkdirp(d);
  const taskDirOf = (n) => join(P.runnerRoot, `issue__${repoSlug}_${n}`);
  const taskKeyOf = (n) => `issue:${repoSlug}#${n}`;

  const cfg = ctx.runnerConfig();
  const maxConcurrent = Number(cfg.maxConcurrentRunners) > 0 ? Number(cfg.maxConcurrentRunners) : 5;
  const pauseInvestigation = cfg.pauseInvestigation === true;

  // ---- ① gh CLI 登录检查 ----
  const auth = await ctx.exec('gh', ['auth', 'status'], { timeout: 30000 });
  if (auth.code !== 0) {
    log(`gh auth status 未登录/不可用（exit=${auth.code}）：${auth.all.replace(/\s+/g, ' ').trim().slice(0, 200)}；本轮退出，不影响 chat 链`);
    if (dryRun) out(`gh 未登录，无法拉 issue：${auth.all}`);
    return;
  }

  // ---- ①b dws 授权闸门（issue-worker 内 claude 会调 dws 发钉钉，链条起点熔断）----
  if (!(await ctx.dwsAuthGate('dispatch-issue'))) return;

  // ---- ② 额度闸门（与 chat 链共用 quota-block）----
  const blockUntil = ctx.quotaBlockActive();
  if (blockUntil) {
    log(`额度受限至 ${fmt(blockUntil)}，本轮不 spawn`);
    if (dryRun) out(`=== 额度受限至 ${fmt(blockUntil)}，本轮跳过 spawn ===`);
    return;
  }

  // ---- ③ 当前活 lease 数（全局：跨 chat/issue）----
  let liveLeases = ctx.countLiveLeases();

  // 公共 spawn 外壳
  async function spawnIssueWorker(n, planArr, tag) {
    const stderrLog = `runtime\\issue-worker-${n}.stderr.log`;
    const r = await ctx.spawnWorker({
      script: 'scripts\\issue-worker.ps1',
      args: ['-TaskKey', taskKeyOf(n)],
      stdoutLog: `runtime\\issue-worker-${n}.stdout.log`,
      stderrLog,
    });
    if (!r.ok && r.error) log(`spawn ${tag}#${n} 失败：${r.error}`);
    else if (!r.ok && r.exitedEarly) log(`spawn ${tag}#${n} 起飞就退：pid=${r.pid} exit=${r.exitCode} → 查 ${stderrLog}`);
    else planArr.push(`spawn ${tag}#${n} ok pid=${r.pid}`);
  }

  // ---- ③a 指令模式优先派（绕过自动判据）----
  const instrPlan = [];
  const instrFiles = ctx.listFiles(instrDir, '.json');
  for (const f of instrFiles) {
    try {
      const instr = ctx.readJson(f);
      if (!instr) { instrPlan.push(`ERROR 指令 ${f}：JSON 解析失败`); continue; }
      const n = Number(instr.issueNumber);
      const taskDir = taskDirOf(n);
      const leaseFile = join(taskDir, 'lease.json');

      if (instr.status === 'done') { instrPlan.push(`skip 指令 #${n}（done）`); continue; }
      if (instr.status === 'running') {
        const l = ctx.exists(leaseFile) ? ctx.readJson(leaseFile) : null;
        if (l && ctx.leaseAlive(l)) { instrPlan.push(`skip 指令 #${n}（running, worker 在跑）`); continue; }
        instr.status = 'pending'; instr.startedAt = null;
        if (!dryRun) ctx.writeJson(f, instr);
        instrPlan.push(`running 但 lease 死，#${n} 翻 pending 重抢`);
      }
      if (liveLeases >= maxConcurrent) { instrPlan.push(`defer 指令 #${n}（活 worker=${liveLeases} ≥ ${maxConcurrent}）`); continue; }
      if (ctx.spawnLoop(taskDir)) {
        instrPlan.push(`BLOCK 指令 #${n}（5min 内 spawn ≥4 次，疑似重派循环，本轮拦截）`);
        if (!dryRun) await ctx.spawnLoopAlert(taskDir, taskKeyOf(n));
        continue;
      }
      let preview = String(instr.instruction || '').replace(/\s+/g, ' ');
      if (preview.length > 40) preview = preview.slice(0, 40) + '…';
      instrPlan.push(`认领+spawn 指令 #${n}（${preview}）`);
      liveLeases++;
      if (dryRun) continue;

      instr.status = 'running'; instr.startedAt = ts;
      ctx.writeJson(f, instr);

      ctx.mkdirp(taskDir);
      ctx.addSpawnRecord(taskDir);
      ctx.writeJson(join(taskDir, 'task.json'), {
        taskKey: taskKeyOf(n), source: 'issue', repo: REPO, issueNumber: n,
        title: String(instr.title || ''), url: `https://github.com/${REPO}/issues/${n}`,
        mode: 'single', metaMode: 'overwrite', instruction: String(instr.instruction || ''), createdAt: ts,
      });
      // state.json：保留 processing/awaiting-human；done 重置 queued（指令重下发=新生命周期）；pendingResumeSessionId 保留
      const sf = join(taskDir, 'state.json');
      let writeState = true; let pendingSid = null;
      const ex = ctx.exists(sf) ? ctx.readJson(sf) : null;
      if (ex) {
        if (['processing', 'awaiting-human'].includes(String(ex.state))) writeState = false;
        if (ex.pendingResumeSessionId) pendingSid = String(ex.pendingResumeSessionId);
      }
      if (writeState) {
        const newState = {
          state: 'queued', enteredAt: ts, outcome: null, resolvedAt: null,
          outcomeDetail: { quotaResetAt: null, failureReason: null, checkerExhausted: false },
          history: [{ state: 'queued', at: ts, by: 'dispatcher' }],
        };
        if (pendingSid) newState.pendingResumeSessionId = pendingSid;
        ctx.writeJson(sf, newState);
      }
      ctx.writeText(leaseFile, JSON.stringify({ taskKey: taskKeyOf(n), issueNumber: n, repo: REPO, claimedAt: ts, pid: 0, heartbeatAt: ts }));
      await spawnIssueWorker(n, instrPlan, '指令 ');
    } catch (e) { instrPlan.push(`ERROR 指令 ${f}：${e.message}`); }
  }

  // ---- ④ 拉 open issue 列表 ----
  const ghArgs = ['issue', 'list', '--repo', REPO, '--state', 'open',
    '--json', 'number,title,assignees,labels,comments,closedByPullRequestsReferences,author,updatedAt,url', '--limit', '50'];
  for (const l of LABELS) ghArgs.push('--label', l);
  const listRes = await ctx.exec('gh', ghArgs, { timeout: 60000 });
  if (listRes.code !== 0) {
    log(`gh issue list 失败（${listRes.code}）：${listRes.all.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    if (dryRun) out(`gh issue list 失败：${listRes.all}`);
    return;
  }
  let issues;
  try { issues = JSON.parse(listRes.stdout); } catch (e) {
    log(`gh 输出解析失败：${e.message}；本轮退出`);
    if (dryRun) out(`解析失败：${listRes.stdout}`);
    return;
  }

  // ---- ⑤ 指纹（sha1；排序贴近 PS Sort-Object 大小写不敏感语义）----
  const ciSort = (arr) => [...arr].sort((a, b) => String(a).toLowerCase().localeCompare(String(b).toLowerCase()));
  function fingerprint(issue) {
    const ass = ciSort((issue.assignees || []).map((a) => a.login)).join(',');
    const lbl = ciSort((issue.labels || []).map((l) => l.name)).join(',');
    const cmts = issue.comments || [];
    const lastCmt = cmts.length ? String(cmts[cmts.length - 1].id) : '';
    const prs = (issue.closedByPullRequestsReferences || []).map((p) => Number(p.number)).sort((a, b) => a - b).join(',');
    const src = `ass=${ass}|labels=${lbl}|lastCmt=${lastCmt}|prs=${prs}|updated=${issue.updatedAt}`;
    return createHash('sha1').update(src, 'utf8').digest('hex');
  }

  // ---- ⑥ 分类判据 ----
  function classify(issue) {
    if ((issue.assignees || []).length > 0) {
      return { state: 'skipped-handled', reason: `有 assignees=${(issue.assignees).map((a) => a.login).join(',')}` };
    }
    if ((issue.closedByPullRequestsReferences || []).length > 0) {
      return { state: 'skipped-handled', reason: `有 linked PR=${(issue.closedByPullRequestsReferences).map((p) => p.number).join(',')}` };
    }
    const team = (issue.comments || []).filter((c) => ['MEMBER', 'OWNER', 'COLLABORATOR'].includes(c.authorAssociation));
    if (team.length > 0) {
      const who = ciSort([...new Set(team.map((c) => c.author?.login))]).join(',');
      return { state: 'skipped-handled', reason: `有团队评论 by ${who}` };
    }
    return { state: 'queued', reason: null };
  }

  // ---- ⑦ 处理每个 open issue ----
  const plan = [];
  for (const issue of issues) {
    const n = Number(issue.number);
    const taskDir = taskDirOf(n);
    const stateFile = join(taskDir, 'state.json');
    const leaseFile = join(taskDir, 'lease.json');
    const fp = fingerprint(issue);

    let prev = ctx.exists(stateFile) ? ctx.readJson(stateFile) : null;
    const prevFp = prev?.outcomeDetail?.fingerprint ? String(prev.outcomeDetail.fingerprint) : null;

    // 指纹未变 skip；state=queued 例外（quota 后回排队 / spawn 失败排队中要重派）
    if (prevFp === fp && prev && String(prev.state) !== 'queued') {
      plan.push(`skip #${n}（指纹未变，state=${prev.state}）`);
      continue;
    }

    // ★ worker 终态保护：done/awaiting-human/processing 不被判据覆盖，仅更新指纹
    if (prev && ['done', 'awaiting-human', 'processing'].includes(String(prev.state))) {
      if (!dryRun) {
        prev.outcomeDetail = prev.outcomeDetail || {};
        prev.outcomeDetail.fingerprint = fp;
        prev.lastCheckedAt = ts;
        ctx.writeJson(stateFile, prev);
      }
      plan.push(`skip #${n}（worker 终态 state=${prev.state}，仅更新指纹）`);
      continue;
    }

    // 新发现 / 指纹变了 → 重新分类
    const cls = classify(issue);
    if (cls.state === 'skipped-handled') {
      if (!dryRun) {
        ctx.writeJson(join(skippedDir, `${n}.json`), {
          issueNumber: n, repo: REPO, title: String(issue.title), url: String(issue.url),
          skipReason: cls.reason, fingerprint: fp, lastCheckedAt: ts,
          assignees: (issue.assignees || []).map((a) => a.login),
          labels: (issue.labels || []).map((l) => l.name),
        });
      }
      plan.push(`skip #${n}（${cls.reason}）`);
      continue;
    }

    // queued 分支
    if (ctx.exists(leaseFile)) {
      const l = ctx.readJson(leaseFile);
      if (l && ctx.leaseAlive(l)) { plan.push(`queued #${n} 但 worker 正在处理（pid=${l.pid}）`); continue; }
      if (!dryRun) {
        await ctx.stopZombieWorker(l);
        ctx.rm(leaseFile);
      }
      plan.push(`回收陈旧租约 #${n}（pid=${l?.pid ?? '?'}）`);
    }
    // 无论是否 spawn 都建/更新任务包
    let effectiveState = null;
    if (!dryRun) {
      ctx.mkdirp(taskDir);
      ctx.writeJson(join(taskDir, 'task.json'), {
        taskKey: taskKeyOf(n), source: 'issue', repo: REPO, issueNumber: n,
        title: String(issue.title), url: String(issue.url), mode: 'single', metaMode: 'overwrite', createdAt: ts,
      });
      let writeState = true; let pendingSid = null;
      const existing = ctx.exists(stateFile) ? ctx.readJson(stateFile) : null;
      if (existing) {
        effectiveState = String(existing.state || '');
        if (['processing', 'awaiting-human', 'plan'].includes(effectiveState)) writeState = false;
        if (existing.pendingResumeSessionId) pendingSid = String(existing.pendingResumeSessionId);
      }
      if (writeState) {
        const initState = ctx.planRequired('issue') ? 'plan' : 'queued';
        const newState = {
          state: initState, enteredAt: ts, outcome: null, resolvedAt: null,
          outcomeDetail: { fingerprint: fp, quotaResetAt: null, failureReason: null, checkerExhausted: false },
          history: [{ state: initState, at: ts, by: 'dispatcher' }],
        };
        if (pendingSid) newState.pendingResumeSessionId = pendingSid;
        ctx.writeJson(stateFile, newState);
        effectiveState = initState;
      }
    }

    // plan = 待用户看板确认，不 spawn、不建占位 lease（DryRun 不写 state，只在真跑时判）
    if (!dryRun && effectiveState === 'plan') { plan.push(`hold #${n}（state=plan 待看板确认、不 spawn）`); continue; }

    if (pauseInvestigation) { plan.push(`queued #${n}（pauseInvestigation=true 全局暂停派发，任务包已建）`); continue; }
    if (liveLeases >= maxConcurrent) { plan.push(`queued #${n}（全局 processing=${liveLeases} ≥ ${maxConcurrent} 上限，任务包已建）`); continue; }
    if (ctx.spawnLoop(taskDir)) {
      plan.push(`BLOCK #${n}（5min 内 spawn ≥4 次，疑似重派循环，本轮拦截）`);
      if (!dryRun) await ctx.spawnLoopAlert(taskDir, taskKeyOf(n));
      continue;
    }
    plan.push(`认领+spawn #${n}（${issue.title})`);
    liveLeases++;
    if (dryRun) continue;
    ctx.addSpawnRecord(taskDir);
    ctx.writeText(leaseFile, JSON.stringify({ taskKey: taskKeyOf(n), issueNumber: n, repo: REPO, claimedAt: ts, pid: 0, heartbeatAt: ts }));
    await spawnIssueWorker(n, plan, '');
  }

  // ---- ⑧ 缺席检查：本地非归档、这轮 open 不见的 → gh view 单独确认 ----
  const openNums = new Set(issues.map((i) => String(i.number)));
  const absentPlan = []; let absentClosed = 0;
  const dirRe = new RegExp(`^issue__${repoSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)$`);
  for (const name of ctx.listDirs(P.runnerRoot, dirRe)) {
    const lsn = dirRe.exec(name)[1];
    if (openNums.has(lsn)) continue;
    const dir = join(P.runnerRoot, name);
    const sf = join(dir, 'state.json');
    if (!ctx.exists(sf)) continue;
    const ls = ctx.readJson(sf);
    if (!ls) continue;
    const bf = join(dir, 'business.json');
    const bs0 = ctx.exists(bf) ? ctx.readJson(bf) : null;
    if (bs0?.closedAt) continue;   // 已归档跳

    const viewRes = await ctx.exec('gh', ['issue', 'view', lsn, '--repo', REPO, '--json', 'state,closedAt'], { timeout: 30000 });
    if (viewRes.code !== 0) { absentPlan.push(`ERROR view #${lsn} 失败`); continue; }
    let view;
    try { view = JSON.parse(viewRes.stdout); } catch { absentPlan.push(`ERROR view #${lsn} JSON 解析失败`); continue; }
    if (String(view.state) !== 'CLOSED') { absentPlan.push(`skip #${lsn}（缺席但仍 OPEN，可能 label 变化）`); continue; }

    let closedAtStr = null;
    if (view.closedAt) {
      const d = new Date(view.closedAt);
      closedAtStr = isNaN(d) ? String(view.closedAt) : fmt(d);
    }
    // closedReason：worker 发过评论（business.commentUrl）→ resolved；state=done+completed 也倾向 resolved
    let closedReason = 'preempted';
    if (bs0?.commentUrl) closedReason = 'resolved';
    else if (!bs0 && ls.outcome === 'completed') closedReason = 'resolved';
    if (!dryRun) {
      const newBs = bs0 || {};
      newBs.closedAt = closedAtStr;
      newBs.closedReason = closedReason;
      ctx.writeJson(bf, newBs);
    }
    absentPlan.push(`closed #${lsn}（缺席确认 CLOSED, reason=${closedReason}）`);
    absentClosed++;
  }

  // ---- 汇总日志（skip 项按原因分组压缩）----
  const summary = `${REPO} · ${issues.length} open · 缺席 ${absentPlan.length}（新归档 ${absentClosed}） · 指令 ${instrFiles.length} · worker=${liveLeases}`;
  function compressPlanLog(items) {
    const groups = new Map(); const rest = [];
    for (const item of items) {
      const m = /^skip\s+(?:指令\s+)?(#\d+)（(.+?)）/.exec(item);
      if (m) {
        const reason = /指纹未变/.test(m[2]) ? '指纹未变'
          : /^done/.test(m[2]) ? 'done'
          : /worker 终态/.test(m[2]) ? 'worker 终态保护'
          : m[2];
        const key = `skip:${reason}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m[1]);
      } else rest.push(item);
    }
    const result = [];
    for (const [k, nums] of groups) result.push(`skip ${nums.join(',')}（${k.replace(/^skip:/, '')}）`);
    return result.concat(rest);
  }
  const allPlan = [];
  if (instrPlan.length > 0) allPlan.push('[指令] ' + compressPlanLog(instrPlan).join('；'));
  if (plan.length > 0) allPlan.push('[自动] ' + compressPlanLog(plan).join('；'));
  if (absentPlan.length > 0) allPlan.push('[缺席] ' + compressPlanLog(absentPlan).join('；'));
  log(`${dryRun ? '[DryRun] ' : ''}${summary}；` + allPlan.join('；'));
  if (dryRun) {
    out('=== DRY RUN（gh list 已真跑）===');
    out(`标签：${LABELS.join(' + ')}；${summary}`);
    if (instrPlan.length > 0) { out('手工指令计划：'); instrPlan.forEach((p) => out(`  - ${p}`)); }
    out('自动巡检计划：'); plan.forEach((p) => out(`  - ${p}`));
    if (absentPlan.length > 0) { out('缺席检查：'); absentPlan.forEach((p) => out(`  - ${p}`)); }
  }
}
