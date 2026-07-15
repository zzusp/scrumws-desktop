# round-2：退回来的 plan 任务锁定「工作目录 / worktree」

追加需求：worktree 任务（更广义：任何有会话记录、退回 plan 的任务）编辑时**不允许修改工作目录及 worktree**。

## 根因

确认执行走 `startTask` 的 resume 分支时，`--resume <sid>` 由 `createSession` 的 `cwd` 决定去哪个「项目目录」（CC 按 cwd 编码分目录存 session jsonl）找原会话。若编辑时改了 `cwd`（或关掉 worktree / 改基分支 → 实际运行目录变了），`--resume` 在新目录里找不到原会话 jsonl，续接失效、历史全丢。所以这些字段对「已跑过、要续对话」的任务必须锁定。

> 范围说明：需求点名 worktree，但改 `cwd` 破坏 `--resume` 对**非 worktree 的退回任务同样成立**，故按「有 `meta.sessionId`」统一锁定 cwd + worktree + baseBranch（worktree 任务是其中一类）。

## 改动

- **`task-actions.readTaskEdit`**：读 meta，返回 `resumeLocked = !!meta.sessionId`（前端据此禁用字段）。
- **`task-actions.editTask`**：`locked = !!meta.sessionId` 时**跳过 cwd 校验、保留 `task.cwd/worktree/baseBranch` 原值**（忽略提交里的这三个字段）——后端硬兜底，旧客户端/直连 API 也改不动。title/prompt/model/effort/scheduledAt/description/dynamicWorkflow 仍可改。
- **`index.html`**：cwd 字段下加锁定说明 `#newTaskDirLockHint`（默认隐藏）。
- **`app.js`**：`setDirWorktreeLocked(locked)` 禁用/启用 `newTaskCwd/Caret/Browse` + `newTaskWorktree` + `newTaskBaseBranch/BranchCaret` 并切说明；`openEditTask` 按 `r.resumeLocked` 调用，新建（`resetNewTaskExtras`）恒解锁。

## 验证（全 PASS）

- `scripts/verify-logic.mjs` 扩到 **21/21 PASS**，新增：
  - [7] `readTaskEdit.resumeLocked`：有 sessionId→true / 无→false。
  - [8] `editTask` 锁定：改 cwd/worktree/baseBranch 被忽略、保原值（`D:/orig-repo` / `true` / `main`），且不因传入的不存在目录报错；title/prompt 仍改成功。
- 服务冒烟（真 HTTP）：
  ```
  GET /api/task/detail?taskKey=manual:lockdemo(有sid)  → resumeLocked=true, cwd=D:/orig-repo, worktree=true, baseBranch=main
  GET /api/task/detail?taskKey=manual:draftdemo(无sid) → resumeLocked=false
  POST /api/task/edit  {cwd:D:/hacked, worktree:false, baseBranch:dev, title:lockdemo2, prompt:p2}
    → ok；detail 复查：cwd=D:/orig-repo worktree=true baseBranch=main（锁定字段未变）· title=lockdemo2 prompt=p2（可改）
  ```
</content>
