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
| 3 | 剩余 `source==='cli'` 判据复核 | 逐个归类：真执行差异（回复路径/可逆操作/rewind/无 pid-usage）保留，仅判据名可选纯化为语义字段；卡片 statusLine/actionBtn 视情况归一 | 待用户拍板 |

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
- 待决策：sub goal 3。复核结论——第 1/2 步已消除"同一逻辑被按来源做两套"的真特殊处理；剩余 `isCli` 判据经逐条核查**基本都是执行方式差异**
  （observed 会话：收养回复/只读/rewind/取消归档-完成，owned 会话：排队/中断，及 pid/lease/usage 数据可得性），改判据名为 `observed` 只是抽象纯化、非消除特殊处理。
