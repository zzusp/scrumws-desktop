// 验证：jsonl 被清理掉的 CLI 会话（stub 卡片）能归档 → 落归档区 → 移除，脏卡可清。
// 修复前：stub 卡片恒 state='awaiting-human'（忽略 watchlist.archivedAt），归档写了也不动窝，
// 而「移除」按钮只在归档区渲染（app.js cardActionButtons section==='archived'）→ 脏卡永远清不掉。
// 独立临时数据根 + 独立 CC projects 根，造完即删，零污染真实 ~/.scrumws 与 ~/.claude。
// 跑：node docs/acceptance/cli-jsonl-missing-archive/scripts/verify-stub-archive.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), `scrumws-verify-stub-${process.pid}`);
const CC = path.join(TMP, 'cc-projects');
process.env.SCRUMWS_DATA_ROOT = TMP;
process.env.SCRUMWS_CC_PROJECTS = CC;   // collect-cli 模块加载时读，须在 import 前设
fs.mkdirSync(CC, { recursive: true });

const { P } = await import('../../../../platform/lib/paths.js');
const { collectCliSessions } = await import('../../../../platform/lib/collect-cli.js');
const { collectState } = await import('../../../../platform/lib/collect.js');
const { archiveTask, unarchiveTask } = await import('../../../../platform/lib/logs.js');
const { removeCliSession } = await import('../../../../platform/lib/cli-actions.js');
const wl = await import('../../../../platform/lib/cli-watchlist.js');

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}  (got: ${JSON.stringify(got)})`); }
};
const cardOf = (sid) => collectCliSessions(Date.now()).find((c) => c.meta?.sessionId === sid) || null;

// jsonl 已消失的会话（watchlist 有 sid，CC projects 里没有对应 jsonl）
const GONE = 'cc226607-1111-4222-8333-444444444444';
// 对照：jsonl 还在的正常会话
const LIVE = 'aaaaaaaa-1111-4222-8333-444444444444';

try {
  fs.mkdirSync(P.tmpDir, { recursive: true });
  wl.upsertWatchlist(GONE, {});

  // 对照组 jsonl：一条真人 user 事件即可出正常卡片
  fs.mkdirSync(path.join(CC, 'D--demo'), { recursive: true });
  fs.writeFileSync(path.join(CC, 'D--demo', `${LIVE}.jsonl`), JSON.stringify({
    type: 'user', timestamp: '2026-07-16T10:00:00.000Z', sessionId: LIVE,
    cwd: 'D:\\demo', gitBranch: 'master', version: '2.0.0', message: { content: '你好' },
  }) + '\n', 'utf8');
  wl.upsertWatchlist(LIVE, {});

  // ===== 修复前的症状面：stub 卡片存在且可见 =====
  let c = cardOf(GONE);
  check('jsonl 缺失 → 出 stub 卡片', !!c, c);
  check('stub 未归档时停在 awaiting-human', c?.state === 'awaiting-human', c?.state);
  check('stub 标题提示 jsonl 已消失', /jsonl 已消失/.test(c?.title || ''), c?.title);
  check('stub outcome=jsonl-missing', c?.outcome === 'jsonl-missing', c?.outcome);

  // ===== 核心：归档 stub 卡片 =====
  let r = archiveTask(`cli:${GONE.slice(0, 8)}`);
  check('stub 归档 ok', r.ok === true, r);
  check('watchlist 落 archivedAt', !!wl.readWatchlist().sessions[GONE]?.archivedAt, null);
  c = cardOf(GONE);
  check('★ 归档后 stub 卡片 state=archived（修复点）', c?.state === 'archived', c?.state);

  // ===== 「移除」按钮的三个渲染前提（app.js cardActionButtons / renderTaskSide）=====
  const st = await collectState();
  const inArchived = st.lifecycle.archived.find((t) => t.meta?.sessionId === GONE) || null;
  check('看板归档区含该卡', !!inArchived, st.lifecycle.archived.map((t) => t.taskKey));
  check('不再滞留待人工区', !st.lifecycle.awaitingHuman.some((t) => t.meta?.sessionId === GONE), null);
  check('isArchive=true（详情页给移除按钮）', inArchived?.isArchive === true, inArchived?.isArchive);
  check('isObservedCli：带 t.cli', !!inArchived?.cli, null);
  check('meta.sessionId=完整 sid（移除按钮传参）', inArchived?.meta?.sessionId === GONE, inArchived?.meta?.sessionId);

  // ===== 闭环：移除 → 卡片消失 =====
  r = removeCliSession({ sid: inArchived?.meta?.sessionId });
  check('移除 ok', r.ok === true && r.removed === true, r);
  check('★ 移除后脏卡消失', cardOf(GONE) === null, cardOf(GONE));

  // ===== 取消归档：stub 同样生效（archiveTask 的逆操作对称）=====
  wl.upsertWatchlist(GONE, {});
  archiveTask(`cli:${GONE.slice(0, 8)}`);
  r = unarchiveTask(`cli:${GONE.slice(0, 8)}`);
  check('stub 取消归档 ok', r.ok === true, r);
  check('stub 取消归档后回 awaiting-human', cardOf(GONE)?.state === 'awaiting-human', cardOf(GONE)?.state);

  // ===== 同类：人工完成对 stub 也生效（同一处忽略手动态的孪生 bug）=====
  wl.setDoneWatchlist(GONE, true);
  check('stub 标完成 → state=done', cardOf(GONE)?.state === 'done', cardOf(GONE)?.state);
  wl.setDoneWatchlist(GONE, false);
  check('stub 取消完成 → 回 awaiting-human', cardOf(GONE)?.state === 'awaiting-human', cardOf(GONE)?.state);

  // ===== 回归：jsonl 还在的正常会话不受影响 =====
  let live = cardOf(LIVE);
  check('正常会话未归档 → awaiting-human', live?.state === 'awaiting-human', live?.state);
  check('正常会话标题取真人首条 user', live?.title === '你好', live?.title);
  check('正常会话仍读到 jsonl（cli.jsonlBytes>0）', live?.cli?.jsonlBytes > 0, live?.cli?.jsonlBytes);
  archiveTask(`cli:${LIVE.slice(0, 8)}`);
  check('正常会话归档 → archived', cardOf(LIVE)?.state === 'archived', cardOf(LIVE)?.state);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n== ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
