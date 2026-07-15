# 任务工作目录 / worktree 目录分离 + 数据维护

## 需求
有些任务的「工作目录（cwd）」记录的其实是 **worktree 目录**。要求：cwd 只存真实工作目录，worktree 目录单独用一个字段维护；
现有任务数据重新检查并修正。（经确认：复用已有的 `meta.worktreeDir` 作为 worktree 目录字段，不新增字段。）

## 根因
1. **物化 CLI 会话**：`task-actions.js:216` 直接 `taskJson.cwd = hist.cwd`，而 `hist.cwd` 是会话 jsonl 里的**实际运行 cwd**，
   会话跑在 worktree 里时它就是 worktree 目录 → 污染 `task.cwd`。
2. **CLI 会话卡片**：`collect-cli.js` 里 `cwd = att.cwd || lastEnv.cwd || firstEnv.cwd`（会话实际 cwd），卡片 `t.cwd || t.cli.cwd`
   直接展示它 → worktree 会话的卡片工作目录显示成 worktree 路径。

托管（分身）任务本身不受影响：它们 `cwd=base`、`worktree=true`、`meta.worktreeDir=worktree`，本就分开。

## 不变量
`task.cwd` 只存 base 仓库根，永不为 worktree 子目录；worktree 实际运行目录归 `meta.worktreeDir`（复用既有字段，
collect.js 已暴露为 `t.worktreeDir`）。

## 改动
- `git.js`：新增 `detectWorktreeBase(dir)` —— 纯路径判（约定 `<base>/.claude/worktrees/<name>[/...]`），零 git 调用
  （collect 高频调用要快，且目录已删也能判，迁移历史数据用）；worktree → 拆出 `baseCwd`，否则原样。
- `task-actions.js` `materializeCliTask`：`hist.cwd` 是 worktree 时 → `task.cwd=base` + `task.worktree=true` +
  `meta.worktreeDir=实际目录`（确认执行时 resolveRunCwd 据它 `--resume` 回原 worktree，否则跑错目录）。
- `collect-cli.js`：卡片返回对象加 top-level `cwd=base`、`worktreeDir=实际`；`cli.cwd` 保留会话实际运行目录（resume 用）。
- `cli-actions.js` `sessionCwds`：新建任务「选已有工作目录」下拉的 CLI 来源也取 base，不塞 worktree 子目录。
- 迁移脚本 `scripts/migrate-cwd-worktree.mjs`（带 `--check` 零副作用）：扫 runner-state + archive，`cwd` 是 worktree 的
  切成 `base` + `meta.worktreeDir` + `worktree=true`；不覆盖已有正确的 `meta.worktreeDir`；幂等。

## 验证（本地实跑）
- `test-detect.mjs`：`detectWorktreeBase` 单测 6/6 PASS（worktree 拆 base、子目录、普通目录、正反斜杠、空）。
- `seed-migrate.mjs` + `migrate-cwd-worktree.mjs`：合成 3 任务（1 污染 + 1 干净 + 1 已正确 worktree）→ `--check` 只命中污染那个且零写入 → 真跑正确切分（cwd→base、worktree→true、meta.worktreeDir 新增、meta.cwd 历史保留）→ 再 `--check` 幂等 0 命中。
- `verify-cli-card.mjs`：合成「跑在 worktree 里」的 CLI 会话 jsonl + watchlist，直接调 `collectCliSessions()` → 卡片 `cwd=base`、`worktreeDir=worktree`、`cli.cwd=原始(worktree)`。4/4 PASS。
- **真实数据 `--check`（只读）**：扫 14 个 task.json，**0 命中**（当前托管任务 cwd 都已干净）；22 个 CLI 会话 cwd 也**无 worktree**
  （分布：13× scrumws-desktop、7× baibu-agent、1× docs 子目录、1× hiq-project）。即当前数据本就干净，迁移是 no-op；
  代码修复为**防复发** + 修 CLI 卡片展示口径 + 留安全网。

## 复现配方
```
node docs/acceptance/task-cwd-worktree/scripts/test-detect.mjs
SCRUMWS_DATA_ROOT=<tmp> node docs/acceptance/task-cwd-worktree/scripts/seed-migrate.mjs
SCRUMWS_DATA_ROOT=<tmp> node docs/acceptance/task-cwd-worktree/scripts/migrate-cwd-worktree.mjs --check   # dry-run
SCRUMWS_DATA_ROOT=<tmp> node docs/acceptance/task-cwd-worktree/scripts/verify-cli-card.mjs
node docs/acceptance/task-cwd-worktree/scripts/migrate-cwd-worktree.mjs --check                          # 真实数据只读
```
