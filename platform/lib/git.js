import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// git 辅助：工作目录探测（是否 git 项目 = 是否支持 worktree）+ 任务级 worktree 生命周期。
// 全部同步调用（startTask 是同步）；git 是原生 exe（非 .cmd），Windows 下 execFileSync 无需 shell。
// worktree 布局对齐官方 `claude --worktree`：<gitRoot>/.claude/worktrees/<name>，分支 worktree-<name>。

function git(cwd, args) {
  // 返回 { ok, out } / { ok:false, error }；stderr 合并进 error 供排障
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    const msg = (e.stderr ? String(e.stderr) : '') || e.message || 'git 执行失败';
    return { ok: false, error: msg.trim() };
  }
}

// 探测目录是否 git 工作树；是则回当前分支 + 本地分支列表。worktree 能力等价于「是 git 工作树」。
export function detectGit(dir) {
  const d = String(dir || '').trim();
  if (!d) return { ok: true, isGit: false };
  let st = null;
  try { st = fs.statSync(d); } catch { return { ok: false, error: `目录不存在：${d}` }; }
  if (!st.isDirectory()) return { ok: false, error: `不是文件夹：${d}` };

  const inside = git(d, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') return { ok: true, isGit: false };

  const root = git(d, ['rev-parse', '--show-toplevel']);
  const cur = git(d, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const brs = git(d, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const branches = brs.ok ? brs.out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const currentBranch = cur.ok && cur.out !== 'HEAD' ? cur.out : null;   // detached HEAD → null
  return {
    ok: true,
    isGit: true,
    root: root.ok ? root.out : d,
    currentBranch,
    branches,
  };
}

function branchExists(repoDir, branch) {
  return git(repoDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

// 为任务建/复用 worktree。幂等：worktreeDir 已存在则直接复用。
// 分支 worktree-<name>：不存在则基于 baseBranch(缺省 HEAD) 新建；已存在则直接签出（rerun/复用）。
export function ensureWorktree({ repoDir, name, baseBranch }) {
  const info = detectGit(repoDir);
  if (!info.ok) return info;
  if (!info.isGit) return { ok: false, error: `工作目录不是 git 项目，无法建 worktree：${repoDir}` };

  const branch = `worktree-${name}`;
  const worktreeDir = path.join(info.root, '.claude', 'worktrees', name);

  if (fs.existsSync(worktreeDir)) {
    // 已在 worktree 列表里 = 复用；否则残留脏目录，报错让用户处理（不静默删用户数据）
    const list = git(repoDir, ['worktree', 'list', '--porcelain']);
    if (list.ok && list.out.includes(worktreeDir.replace(/\\/g, '/'))) return { ok: true, worktreeDir, branch, reused: true };
    if (list.ok && list.out.includes(worktreeDir)) return { ok: true, worktreeDir, branch, reused: true };
    return { ok: false, error: `worktree 目录已存在但未登记（残留？）：${worktreeDir}` };
  }

  try { fs.mkdirSync(path.dirname(worktreeDir), { recursive: true }); } catch { /* 交给 git 报错 */ }

  const base = String(baseBranch || '').trim();
  let r;
  if (branchExists(repoDir, branch)) {
    r = git(repoDir, ['worktree', 'add', worktreeDir, branch]);
  } else if (base) {
    r = git(repoDir, ['worktree', 'add', worktreeDir, '-b', branch, base]);
  } else {
    r = git(repoDir, ['worktree', 'add', worktreeDir, '-b', branch]);
  }
  if (!r.ok) return { ok: false, error: `git worktree add 失败：${r.error}` };
  return { ok: true, worktreeDir, branch, reused: false };
}

// 移除 worktree（收尾/清理用，best-effort）；--force 连未提交改动一起丢，仅在任务终态调用方决定时用。
export function removeWorktree({ repoDir, worktreeDir }) {
  if (!worktreeDir || !fs.existsSync(worktreeDir)) return { ok: true, skipped: true };
  const r = git(repoDir, ['worktree', 'remove', worktreeDir, '--force']);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
