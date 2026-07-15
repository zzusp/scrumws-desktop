# 统一任务来源处理（拆掉 source 特判，按状态走）

> 落实 README「任务来源不变量」：`source`（cli / manual / api …）只是来源元数据，所有来源的任务共享同一套
> 状态机与处理逻辑。本文是收敛工作的前置分析 + 设计 + 子目标拆解（开工快照，不回头维护）。

## 现状根因

CLI 会话与其它来源任务的**唯一物理差别**：CLI 会话是「被旁观」的——数据源是 CC 官方 jsonl，靠 `cli-watchlist.json`
里一条 sid 元数据出卡（`collect-cli.js`），**没有 `runner-state/<key>/` 任务包**；而 manual/api 任务有任务包
（task.json + state.json + meta.json）。所有任务动作（complete/uncomplete/toPlan/archive/rename/edit）都读写任务包的
`state.json`，CLI 没有包 → 于是历史代码到处按 `startsWith('cli:')` 分叉到「watchlist 平行管理面」或直接拒绝。

## 设计：物化（materialize）

给 CLI 会话补上任务包，让平行管理面收敛成同一条路径：

- **`materializeCliTask(taskKey, {state})`**（task-actions.js）：从 watchlist 找全量 sid → `readCcSessionForAdopt` 取
  会话 cwd/model/gitBranch/messages → 写 `runner-state/cli__<sid8>/`（task.json `source:'cli'` 仅元数据、title 取首条
  用户消息、prompt 取末条用户消息作续跑起点；meta.json `sessionId=全量 sid` 供 `--resume`；state.json 给定 state）→
  **从 watchlist 摘除该 sid**（去重：collect-cli 不再出卡，改由 collect.js 按包出卡）。终端仍占用该会话时拒绝
  （复用 `/api/session/adopt` 的 guard：两个 claude 抢同一 session 会撞车 → [[modeb-adopt-terminal-collision]]）。
- **package-first 路由**：所有原本 `startsWith('cli:')` 的分叉改判「**有没有任务包**」——`hasTaskPackage(taskKey)`
  （logs.js）/ `!fs.existsSync(taskDir)`（task-actions）：有包走统一路径、无包才回落 watchlist。未物化的 CLI 行为不变、
  非 CLI 不受影响、物化后的 CLI 走统一路径。

## 特判点清单（grep `startsWith('cli:')` / `isCli` / `source==='cli'`）

| 位置 | 类别 | 处置 |
|---|---|---|
| task-actions moveTaskToPlan | 行为·拒绝 | ✅ 物化落 plan |
| task-actions complete/uncomplete | 行为·拒绝 | ✅ package-first + 无包回落 watchlist |
| server complete/uncomplete 路由 | 行为·分派 | ✅ 直接调 completeTask/uncompleteTask（内部分派）|
| logs rename/archive/unarchive | 行为·分派 | ✅ package-first（`hasTaskPackage`）|
| app.js toPlanBtn（卡片 + 详情）| 展示·门控 | ✅ 去掉 isCli 门控 |
| collect-cli CC_PROJECTS / cli-actions | 环境 | ✅ 加 `SCRUMWS_CC_PROJECTS` 覆盖（验证隔离）|
| task-actions replyToTask → replyCliSession | 行为·分派 | ✅ package-first：有包走 Mode B `--resume`，无包 CLI 才走观察侧 |
| app.js canReply/reply UI/cancel/archived-remove（reply 弹窗 + 卡片 + 详情）| 展示·门控 | ✅ 全改 `isObservedCli=!!t.cli`（不按 source）；`mbSend.useTaskReply` 改 `!findTaskInState(tk)?.cli` |
| app.js rewind canRewind | 行为·门控 | ✅ 改 `!!findTaskInState(tk)?.cli`（观察侧操作；物化任务不给会报错的按钮）|
| logs worker-log 路由（388）| 行为·分派 | ✅ package-first：物化 CLI 按 meta.sessionId 读同一 jsonl |
| task-actions deleteTask cli guard（79）| 行为·拒绝 | ✅ 删除；物化 CLI 有 sessionId → 落「已执行过→改归档」guard |
| collect.js cliCount(273)/platformSids(305) | 聚合 | ✅ `source==='cli'` → `t.cli`：物化 CLI 并入平台聚合与 platformSids |

## 子目标矩阵

| # | 子目标 | 状态 |
|---|---|---|
| 0 | `SCRUMWS_CC_PROJECTS` 覆盖（验证隔离） | ✅ done |
| 1 | 终态动作统一：materialize + toPlan/complete/uncomplete/archive/unarchive/rename/edit 按包统一 | ✅ done |
| 2 | reply 统一 + reply/cancel/archived-remove UI 门控改「按 t.cli」不按 source | ✅ done |
| 3 | worker-log 按包统一；rewind 门控改「按 t.cli」 | ✅ done |
| 4 | deleteTask guard 清理 + cliCount/platformSids 改「按 t.cli」 | ✅ done（20/20）|

**收敛完成**：动作 / UI 门控 / 聚合三层的 source 行为特判已全部改为按状态 / `hasTaskPackage` / `t.cli`。`source` 回归纯展示。

## 风险 / 盲点

- **去重**：物化必须摘 watchlist，否则 collect.js（包）+ collect-cli（watchlist）出两张卡。已验证：摘除后 collect 只出 1 张（source cli）。
- **--resume 定位**：task.cwd 取会话原 cwd，approve 时 startTask 在该 cwd `--resume`，claude 才能在对应项目目录找到 session。cwd 已失效的会话续跑会失败（属既有 --resume 局限，非本次引入）。
- **终端占用**：物化 guard 复用 adopt 的 att 判据；终端没关就拒绝。
- **验证局限**：`readAttachedSessions` 读真实 CC sessions 注册表，沙箱里假 sid 恒未占用——「终端占用拒绝」分支未单测（逻辑与 adopt 同源，adopt 已线上验证）。
</content>
