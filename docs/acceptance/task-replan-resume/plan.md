# 待人工 / 完成任务退回计划 + 再执行续对话

分支 `worktree-20260714212427-166`。

## 需求

看板 `待人工(awaiting-human)` 与 `完成(done)` 两桶的任务应能**退回 `plan` 桶**；退回后可像普通 plan 任务一样编辑配置（模型 / 目录 / effort / 定时 / 动态工作流…）。**再次确认执行时，应「续上任务之前的对话」**（`--resume` 到原会话），而不是从头起一段新对话。

## 现状（读源码结论）

- 桶 = `state.json.state`：`plan / queued / processing / awaiting-human / done / archived`（`collect.js:181`）。
- 只有 `plan` 桶能编辑（`readTaskEdit`/`editTask` gate 在 `state==='plan'`，`task-actions.js:329/358`）与配定时。
- `awaiting-human`→`done` 走 `completeTask`；`done`→`awaiting-human` 走 `uncompleteTask`；无「回 plan」通道。
- `startTask`（`task-runner.js:235`）**永远全新起会话**（`task.prompt` 作首条消息），且当前只会被无 `meta.sessionId` 的任务命中（create/restart(仅 `!hasSid`)/approve(plan 从未跑过)/定时/drain）。
- 续对话的 `--resume` + `seedTranscript` 机制已存在于 `replyTask`（`task-runner.js:250`，reply-resume-ux 特性引入）。
- `awaiting-human` 常残留 idle-but-alive 的 Mode B 会话（`registry`），再执行前须先释放，否则 `startTask` 的「已有活跃会话」guard 会拒绝、且 live 会话改不了编辑过的 model/effort/cwd。

## 方案（复用现有能力，不新增机制）

### 后端

1. **`moveTaskToPlan`（`task-actions.js` 新增）**：`awaiting-human/done → plan`。
   - 先 `parkTaskSession(taskKey)` 关掉空转会话（释放 claude 进程 + 删 lease），**保留 `meta.sessionId`** 供 `--resume`。
   - 落 `state=plan`、清 `outcome/resolvedAt/outcomeDetail`、追 `history`。
   - cli: 键拒绝（CLI 无 state.json / 无 plan 态）。
2. **`parkTaskSession`（`task-runner.js` 新增）**：按 `taskKey` 取活会话，**精准解绑**本任务的 `onEvent`（用新增 `boundHandlers` Map 记引用，不 `removeAllListeners` 以免误伤详情页 SSE 订阅），再 `closeSession` + `removeLease`。精准解绑保证 `closeSession` 触发的 `'closed'` 事件不会把 state 翻回 `awaiting-human`。
3. **`startTask` 改为 resume-aware（`task-runner.js`）**：有 `meta.sessionId` → 走 `--resume`（喂回历史 seed + `task.prompt` 作续轮消息，与 `replyTask` resume 分支同构）；无则维持全新起会话。二者仅差 resume/seed，落盘 `bind/markProcessing` 一致。纯加法：现有 caller 都无 `meta.sessionId`、行为不变。
4. **`deleteTask` 加 guard（`task-actions.js`）**：plan 且有 `meta.sessionId`（= 退回来的、跑过的）拒删 → 改用归档，避免「移除」毁掉可 `--resume` 的执行记录（原 `deleteTask` 假设 plan = 从未跑过的草稿，本特性打破该前提）。
5. **`server.js` 路由 `/api/task/to-plan`**：POST，派发 `moveTaskToPlan`。

### 前端（`app.js`）

6. 卡片「···」菜单（`cardActionButtons`）与详情右栏快捷操作：`awaiting-human` / `done` 段加「↩ 退回计划」（`!isCli`），wire `moveToPlanAction` → `/api/task/to-plan`。
7. plan 详情 composer 提示：有 `meta.sessionId` 时改为「确认排队后会**续上之前的对话**（--resume）」。

改动文件：`platform/lib/task-actions.js`、`platform/lib/task-runner.js`、`platform/server.js`、`platform/public/app.js`。

## 验证（全 PASS，详见 round-1.md）

- `scripts/verify-logic.mjs`：状态机 + guard 纯逻辑，**14/14 PASS**。
- `scripts/verify-resume-e2e.mjs`：真 claude 端到端——第1轮记数字 4271 → 退回 plan → 编辑 prompt → 确认执行走 resume 分支 → 答复含 4271（独立新进程却答出只有原会话知道的数字 = 确实续上对话）。**E2E PASS**。
- 服务冒烟：`/api/task/to-plan` 路由 wiring + 错误分支（不存在键 / cli 键）**PASS**。
</content>
</invoke>
