// 单测 detectWorktreeBase：worktree 目录拆 base、普通目录原样、正反斜杠 + 子目录。
import { detectWorktreeBase } from '../../../../platform/lib/git.js';

const B = 'D:\\project\\scrumws-desktop';
const cases = [
  [B + '\\.claude\\worktrees\\20260715135813-626', true, B],
  [B + '\\.claude\\worktrees\\wt-x\\sub\\dir', true, B],           // worktree 下的子目录也拆到 base
  [B, false, B],
  ['D:\\baibu-agent', false, 'D:\\baibu-agent'],
  ['/home/u/repo/.claude/worktrees/foo', true, '/home/u/repo'],    // 正斜杠
  ['', false, ''],
];
let bad = 0;
for (const [inp, isWt, base] of cases) {
  const r = detectWorktreeBase(inp);
  const ok = r.isWorktree === isWt && r.baseCwd === base;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  in=${JSON.stringify(inp)} → isWorktree=${r.isWorktree} base=${JSON.stringify(r.baseCwd)}`);
}
console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad ? 1 : 0);
