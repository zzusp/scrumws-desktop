// 验证 collect-cli 拆分：合成一个「跑在 worktree 目录里」的 CLI 会话 jsonl + watchlist，
// 直接调 collectCliSessions()，断言卡片 cwd=base、worktreeDir=worktree、cli.cwd=原始(worktree)。
// 需在导入 paths.js 前设好 SCRUMWS_DATA_ROOT（命令行 env 注入）。
import fs from 'node:fs';
import path from 'node:path';
import { P } from '../../../../platform/lib/paths.js';
import { collectCliSessions } from '../../../../platform/lib/collect-cli.js';

const BASE = 'D:\\project\\scrumws-desktop';
const WT = BASE + '\\.claude\\worktrees\\sess-wt';
const SID = 'f1e2d3c4-1111-2222-3333-444455556666';

fs.mkdirSync(P.tmpDir, { recursive: true });
const jsonlPath = path.join(P.tmpDir, `${SID}.jsonl`);
const lines = [
  { type: 'user', sessionId: SID, timestamp: '2026-07-15T02:00:00.000Z', cwd: WT, gitBranch: 'worktree-sess-wt', version: '2.1.0', message: { role: 'user', content: '帮我改个 bug' } },
  { type: 'assistant', sessionId: SID, timestamp: '2026-07-15T02:00:05.000Z', cwd: WT, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: '好的' }] } },
];
fs.writeFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

const watchlist = { sessions: { [SID]: { jsonlPath, projectDir: P.tmpDir, addedAt: '2026-07-15 10:00:00', customTitle: null, note: null } } };
fs.writeFileSync(path.join(P.tmpDir, 'cli-watchlist.json'), JSON.stringify(watchlist, null, 2));

const cards = collectCliSessions(new Date('2026-07-15T02:10:00.000Z'));
const card = cards.find((c) => c.meta?.sessionId === SID);
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
ok(!!card, 'CLI 卡片已生成');
ok(card && card.cwd === BASE, `卡片 cwd = base 仓库根（${card?.cwd}）`);
ok(card && card.worktreeDir === WT, `卡片 worktreeDir = worktree 目录（${card?.worktreeDir}）`);
ok(card && card.cli?.cwd === WT, `cli.cwd 保留会话实际运行目录供 resume（${card?.cli?.cwd}）`);
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
