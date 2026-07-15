# goal：统一任务来源处理（拆掉 source 特判）

## 总目标

落实 README「任务来源不变量」：任何来源（cli / manual / api …）的任务共享同一套状态机与处理逻辑，分支按**状态**走、
不按 source 特判。核心手段 = 把被旁观的 CLI 会话**物化**成一等托管任务包（`runner-state/`），令平行的 watchlist
管理面收敛到统一路径。设计详见 `docs/spec/unify-task-source-handling.md`。

## sub goal matrix

| # | sub goal | 状态 | 证据 |
|---|---|---|---|
| 0 | `SCRUMWS_CC_PROJECTS` 覆盖（沙箱验证隔离） | ✅ | collect-cli.js / cli-actions.js |
| 1 | 终态动作统一：materialize + toPlan/complete/uncomplete/archive/unarchive/rename/edit 按包统一；CLI 退回计划可用 | ✅ | scripts/verify-cli-unify.mjs；replan-resume 回归 21/21；collector smoke 单卡 |
| 2 | reply 统一：物化 CLI 走 Mode B `--resume`；reply/cancel/archived-remove UI 门控改「按 t.cli（被旁观）」不按 source | ✅ | verify-cli-unify（含 reply package-first）；collector smoke 物化卡无 t.cli |
| 3 | worker-log 按包统一；rewind 门控改「按 t.cli」（观察侧操作，去掉物化卡上会报错的按钮） | ✅ | verify-cli-unify 19/19（含 [7] worker-log package-first）；replan 回归 21/21 |
| 4 | 清扫 deleteTask cli guard + collect.js cliCount(273)/platformSids(305) 改「按 t.cli」 | ✅ | verify-cli-unify 20/20（含 [8] deleteTask）；smoke：物化卡 usage 0.5 聚合进平台、cliCount=0 |

## sub goal 进展

### round-1（sub goal 0 + 1）— ✅

- **改动**：
  - `collect-cli.js` / `cli-actions.js`：`CC_PROJECTS` 支持 `SCRUMWS_CC_PROJECTS` 覆盖。
  - `task-actions.js`：新增 `materializeCliTask`（物化 + 去重 watchlist + 终端占用 guard）；`moveTaskToPlan` cli 无包→物化落 plan（删 cli 拒绝 guard）；`completeTask`/`uncompleteTask` 改 package-first + 无包回落 watchlist（删 cli 拒绝 guard）。
  - `logs.js`：新增 `hasTaskPackage`；`renameTask`/`archiveTask`/`unarchiveTask` 改 package-first。
  - `server.js`：complete/uncomplete 直接调 `completeTask`/`uncompleteTask`（去掉按前缀分派）。
  - `app.js`：退回计划按钮（卡片 + 详情）去掉 `isCli` 门控。
- **验证**（本地实跑，全绿）：
  - `scripts/verify-cli-unify.mjs` **17/17**：物化落 plan（source cli / title / cwd / meta.sessionId）+ watchlist 摘除去重；物化后 edit(resumeLocked) / archive-unarchive(按包搬迁) / complete-uncomplete(按包)；未物化 CLI 完成/取消完成仍回落 watchlist.doneAt。
  - `docs/acceptance/task-replan-resume/scripts/verify-logic.mjs` **21/21**（回归；[4] 旧「cli 一律拒绝」用例改写为新语义「未跟踪→报错」）。
  - 服务冒烟：物化后的 CLI 包在 `/api/state` 只出 **1 张卡、source=cli、plan 桶**（去重生效，无双卡）。
- **决策/信息**：
  - 物化保留 `source:'cli'`（仅元数据），taskKey 仍 `cli:<sid8>`；不新造 manual 键——身份不变、只是补了任务包。
  - package-first 判据统一为「有无任务包」，保证未物化 CLI 行为不变、非 CLI 不受影响。
  - round-1 未触及 reply/rewind/cancel/worker-log 的源特判——物化 CLI 在这些路径**是限制而非 broken**（reply/cancel UI 对 cli 隐藏、rewind/worker-log jsonl 仍在），留 sub goal 2/3。

### round-2（sub goal 2）— ✅

- **关键洞见**：物化后的 CLI 任务 `source` 仍是 `'cli'`，无法据此区分「被旁观 CLI」与「托管任务」。真正的区分是
  **`t.cli` 对象**——只有 `collect-cli.js`（watchlist 出卡）才带；`collect.js`（runner-state 包出卡）不带。故前端行为门控
  一律改判 `isObservedCli = !!t.cli`（不再按 source）。已冒烟验证：物化卡 `t.cli` 缺失。
- **改动**：
  - `task-actions.js replyToTask`：改 package-first——有包（含物化 CLI）走 Mode B `--resume`；未物化 CLI（无包）才走 `replyCliSession`。
  - `app.js`：回复弹窗（`canReply` / 观察态三态分支）、卡片 + 详情的「中断」「从看板移除」门控，全部 `isCli`→`isObservedCli(!!t.cli)`；`mbSend` 的 `useTaskReply` 由 `!tk.startsWith('cli:')` 改为 `!findTaskInState(tk)?.cli`（物化 CLI 走 `/api/task/reply`，收养未物化 CLI 仍走 `/api/session/send`）。
- **验证**（本地实跑全绿）：`verify-cli-unify.mjs` **18/18**（新增 [6] 物化后回复走包路径 processing guard，证明未落 replyCliSession）；`replan-resume` 回归 **21/21**；collector 冒烟：物化卡 source=cli 但**无 t.cli** → 前端 `isObservedCli=false` → 走托管统一路径（可回复/可中断）。
- **边界**：未物化的「被旁观 / 收养」CLI 会话行为不变（仍走观察侧续接 / session/send）。rewind、worker-log 源特判留 round-3。

### round-3（sub goal 3）— ✅

- **worker-log**（`logs.js readWorkerLog`）：改 package-first——未物化 CLI（无包）走 `readCliWorkerLog`（watchlist 定位 sid）；有包（含物化 CLI）走统一路径（按 `meta.sessionId` → `locateJsonlBySid` 读同一 jsonl）。修的是：`readCliWorkerLog` 靠 watchlist 定位 sid，物化后 watchlist 已摘 → 会「not in watchlist」；package 路径按 meta.sessionId 读，正确。
- **rewind**（`app.js canRewind`）：`startsWith('cli:')` → `!!findTaskInState(taskKey)?.cli`。理由：rewind = jsonl 截断 + 收养重跑，是**观察侧会话**的操作；`rewindCliSession` 也靠 watchlist 定位 sid，物化任务点它必「not in watchlist」——故按 `t.cli` 门控，物化/托管任务不再显示这个会报错的按钮（托管任务改历史应走托管重跑，另属特性，非本次范围）。
- **验证**：`verify-cli-unify.mjs` **19/19**（新增 [7]：物化后 `readWorkerLog` 走包路径读到历史，证明未落 watchlist 侧）；`replan-resume` 回归 **21/21**。
- **边界**：观察侧 CLI 的 rewind / worker-log 行为不变。托管任务的「改历史重跑」是潜在新特性，不在收敛范围。

### round-4（sub goal 4）— ✅（收敛链闭合）

- **`task-actions.js deleteTask`**：删掉 `startsWith('cli:')` 拒绝 guard。物化 CLI 有 `meta.sessionId` → 落到「已执行过→改归档」guard（正确语义，非误导性的「用从看板移除」）；未物化 CLI 无包 → 落「task not found」。删除只对「plan 且无 sessionId」纯草稿放行。
- **`collect.js` `computeRuntimeUsage`(273) + `platformSids`(305)**：`t.source === 'cli'` → `t.cli`。被旁观 CLI（`t.cli`，meta 无真实 usage）仍单独计数 / 排除；物化 CLI（无 `t.cli`、有真实 usage meta）并入平台聚合与 platformSids。**修正**：round-3 spec 曾把 273 标「展示保留」，实测其 `continue` 会把物化 CLI 的真实 usage 也跳过——应一并按 `t.cli` 判。
- **验证**：`verify-cli-unify.mjs` **20/20**（新增 [8]：物化 CLI deleteTask 落 sessionId guard）；`replan-resume` 回归 **21/21**；`/api/state` 冒烟：物化卡 `meta.totalCostUsd=0.5` 聚合进 `runtime.usage.totalCostUsd`、`cliCount=0`（证明按平台任务聚合，非当 cli 跳过）。

## 收敛完成

任务动作 / UI 门控 / 聚合三层的 `source==='cli'` / `isCli` / `startsWith('cli:')` 行为特判已全部改为「按状态 / 按有无任务包(`hasTaskPackage`) / 按有无 `t.cli`」。`source` 回归纯展示元数据。剩余 `source` 引用仅用于展示（来源角标 `sourceTagHtml`、`cli` 详情对象）与入库归类，符合 README「任务来源不变量」。潜在**新特性**（非特判清理）：托管任务的「改历史重跑」（managed rewind）。
</content>
