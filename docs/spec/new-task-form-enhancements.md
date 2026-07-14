# 新建任务表单增强（6 项）

开工前分析快照。目标：增强看板「新建任务」表单及任务详情页 model 选择，落地 6 项需求。

## 需求 → 实现映射

1. **表单标题「新建 manual 任务」→「新建任务」**
   - `index.html:815` `<h2>` + `app.js:1912` `NEWTASK_HEAD`。

2. **去掉「先计划」勾选，新建任务默认进 plan 桶**
   - 删 `index.html:865-869` 的 `newTaskPlanFirst` checkbox + 提示；`app.js` 提交固定 `plan:true`，删 planFirst 相关分支。

3. **model 同时选 effort，执行按 effort；详情页 model 框同步加 effort**
   - 后端全链路已支持 effort（task-actions.createTask / session-manager `--effort` / task-runner）。缺口：
     - `editTask`/`readTaskEdit` 未含 effort → 补。
     - 前端无 effort 选择器 UI → 新建表单 + 详情回复条各加一个 effort 下拉（复用 `initModelDropdown` 同款组件）。
     - 回复链路 `replyToTask`/`replyTask` 支持 per-reply effort 覆盖。
   - effort 白名单：low/medium/high/xhigh/max；默认 high。

4. **日期时间选择器：定时把任务从 plan → 执行**
   - 表单加 `datetime-local`（可选）；存 `task.json.scheduledAt`（本地串 `yyyy-MM-dd HH:mm:ss`）。
   - 主进程调度器（`scheduler.js`，持锁实例）加 in-process 定时扫描（每 30s + 启动即扫一次做补偿）：
     plan 态且 `scheduledAt<=now` → `startTask()`（= 到点自动执行），清 `scheduledAt`。
   - 语义说明：本看板 `queued` 即刻转 `processing`（无独立消费 queued 的 loop），故「定时转 queued」= 到点起会话执行。

5. **判断工作目录是否 git（支持 worktree）→ 显示 worktree 开关（默认开）+ 签出分支**
   - 新增 `lib/git.js`：`detectGit(dir)`（isGit/root/currentBranch/branches）、`ensureWorktree({repoDir,name,baseBranch})`、`removeWorktree`。
   - 新增 `POST /api/git/detect` `{cwd}` → 检测结果。
   - 前端：cwd 变更/浏览后探测；git → 显示 worktree toggle（默认勾）+ 分支下拉（默认 currentBranch）。
   - 执行：`startTask` 若 `task.worktree && cwd 是 git` → `ensureWorktree` 建 `<gitRoot>/.claude/worktrees/<slug>`（分支 `worktree-<slug>` 基于 baseBranch），以 worktreeDir 为运行 cwd；worktreeDir/branch 落 `meta.json` 复用；reply 复用同目录。
   - 自管理而非原生 `--worktree`：与应用 cwd 追踪一致，且 `--settings/--worktree` 在 Windows shell:true spawn 下有引号/组合风险。

6. **「动态工作流」开关（Claude Code Workflows 能力）**
   - 二进制实测开关：env `CLAUDE_CODE_WORKFLOWS` truthy=可用、falsy=禁用；`CLAUDE_CODE_DISABLE_WORKFLOWS` truthy=禁用；settings `enableWorkflows`/`disableWorkflows`。
   - 走**环境变量**（规避 Windows shell:true 下 `--settings <json>` 引号坑）：
     - ON → `env.CLAUDE_CODE_WORKFLOWS='1'`；OFF → `env.CLAUDE_CODE_DISABLE_WORKFLOWS='1'`。
   - 存 `task.json.dynamicWorkflow` 布尔；`createSession` 按值注入 env。默认 OFF（workflows 开销大、opt-in 更安全）。

## 数据形状（task.json 新增字段）
`effort?`, `scheduledAt?`, `worktree?:bool`, `baseBranch?`, `dynamicWorkflow?:bool`（`worktreeDir`/`worktreeBranch` 落 meta.json 运行态）。

## 涉及文件
- 后端：`lib/git.js`(新), `lib/task-actions.js`, `lib/session-manager.js`, `lib/task-runner.js`, `lib/scheduler.js`, `server.js`
- 前端：`public/index.html`, `public/app.js`

## 验证
- git detect 端点对真实 git 目录返回正确分支/列表。
- createTask/editTask 落 task.json 含新字段（API 实调 + 读盘）。
- worktree：`ensureWorktree` 真建 worktree（git 层可完整验，不需 spawn claude）。
- 调度扫描：造 plan+过期 scheduledAt 任务，验扫描命中（startTask 会 spawn claude，验到「命中并调用」为止，避免烧额度）。
- UI：起服务加载表单，新字段渲染 + git 目录联动显示 worktree/分支。
