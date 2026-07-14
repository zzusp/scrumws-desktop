# 统一任务来源特殊处理（unify-task-source）

## 总目标
任务来源（chat / issue / manual / cli）只是"从哪来"，不应决定字段、展示、操作、状态。
唯一合理的差异是**执行方式**：看板实时持有并驱动（owned / Mode B）vs 外部 CLI 会话被只读观测（observed）。
把散落在前后端、以 `source === 'cli'` / `taskKey.startsWith('cli:')` 为判据的**来源特殊处理**收敛掉，
只保留真正源于"执行方式"的差异，且判据改用语义信号（`mbSessionId` / `t.cli` 存在性）而非来源。

## sub goal matrix

| # | sub goal | 关键改动 | 状态 |
|---|----------|----------|------|
| 1 | 详情侧栏字段归一 | 后端 `readCliWorkerLog` round 补 `gitBranch`；前端 `renderTaskSide` 去 `isCli` 取值分叉，共有字段统一取详情 round，CLI 独有字段按 `t.cli` 存在性显 | DONE ✅ 实跑通过 |
| 2 | rename 端点归一 | `renameTask` 内部按来源分派（CLI→watchlist / 分身→task.json，与 archiveTask 同构）；删并行的 `/api/cli/rename` + `renameCliSession`；前端统一调 `/api/task/rename` | DONE ✅ 实跑 7/7 |
| 3 | 取消完成/取消归档 统一（原判为执行差异是**误判**，用户纠正） | 分身补 `uncompleteTask`(done→awaiting-human) + `unarchiveTask`(archive 目录移回)；统一端点 `/api/task/uncomplete`、`/api/unarchive` 内部分派；前端 done/archived 两来源都显、走统一端点 | DONE ✅ 单元 13/13 + HTTP 实跑 |
| 4 | 复扫确认剩余 CLI 独有=真执行差异 | 保留：从看板移除(watchlist 名单概念)、添加/搜索 CLI 会话、rewind、中断/确认排队(owned 特有) | DONE ✅ |

## 保留的合理差异（执行方式，非来源）
- 回复：owned 走 mbSend/sendReply；observed 空闲→收养成 Mode B；observed 终端占用→只读（`app.js` 以 `mbSessionId` 为主判据，已正确）
- 状态集：observed 无 plan/queued（看板不调度被观测会话）
- 改写重跑(rewind)：仅 observed 的 jsonl 可原地截断 fork
- 字段可得性：jsonlBytes / pendingBackgroundAgentCount / attachedPid 仅 observed 有；pid/lease/cost 仅 owned 有

## 进展
- 2026-07-13 round-1：完成 sub goal 1（字段归一）。数据源确认——`readWorkerLog` 对 CLI/分身产出同构 rounds，CLI 原缺 gitBranch 已补齐。
  验证：`scripts/verify-fields.mjs` + 起 web server(8890) curl `/api/worker-log`——CLI round.gitBranch 由 null→`master`，两类 cwd/git/model/workMs 同源可取。
- 2026-07-13 round-2：完成 sub goal 2（rename 归一）。`renameTask` 内部分派，删 `/api/cli/rename` 路由 + `renameCliSession` 函数（grep 零残留），前端统一端点。
  验证：`scripts/verify-rename.mjs` 独立临时数据根 7/7 PASS（CLI 写 watchlist、分身写 task.json、空标题清除、不存在报错）。
- 2026-07-14 round-3：**纠正上轮误判**。用户指出"取消完成只有 CLI 有"不该按执行差异保留——取消完成/取消归档是同一操作，须跨来源统一。
  已补分身 `uncompleteTask`/`unarchiveTask`，统一端点内部分派，前端 done/archived 两来源统一显示并走统一端点。
  验证：`scripts/verify-uncomplete-unarchive.mjs` 单元 13/13 PASS；web server curl 端点分派正确、旧 `/api/cli/uncomplete|unarchive` 已 404。
- 复扫定论：剩余 CLI 独有操作（从看板移除 / 添加·搜索 CLI 会话 / rewind / 中断·确认排队）经核查确为**执行方式差异**（观测名单 vs 本地任务包、observed jsonl 特有、owned 调度特有），保留合理。
