# 统一任务来源特殊处理（unify-task-source）

## 总目标
任务来源（chat / issue / manual / cli）只是"从哪来"，不应决定字段、展示、操作、状态。
唯一合理的差异是**执行方式**：看板实时持有并驱动（owned / Mode B）vs 外部 CLI 会话被只读观测（observed）。
把散落在前后端、以 `source === 'cli'` / `taskKey.startsWith('cli:')` 为判据的**来源特殊处理**收敛掉，
只保留真正源于"执行方式"的差异，且判据改用语义信号（`mbSessionId` / `t.cli` 存在性）而非来源。

## sub goal matrix

| # | sub goal | 关键改动 | 状态 |
|---|----------|----------|------|
| 1 | 详情侧栏字段归一 | 后端 `readCliWorkerLog` round 补 `gitBranch`；前端 `renderTaskSide` 去 `isCli` 取值分叉，共有字段统一取详情 round，CLI 独有字段按 `t.cli` 存在性显 | DONE（待实跑复核） |
| 2 | 操作/端点归一 | `/api/cli/rename`→并入 `/api/task/rename` 内部分派；补齐分身 unarchive/uncomplete 或明确语义；前端去 `startsWith('cli:')` 选端点 | TODO |
| 3 | 语义字段替代来源判据 | 引入 `observed`（或复用 `t.cli`/`mbSessionId`）替换散落的 `source==='cli'`；卡片 statusLine/actionBtn 归一 | TODO |

## 保留的合理差异（执行方式，非来源）
- 回复：owned 走 mbSend/sendReply；observed 空闲→收养成 Mode B；observed 终端占用→只读（`app.js` 以 `mbSessionId` 为主判据，已正确）
- 状态集：observed 无 plan/queued（看板不调度被观测会话）
- 改写重跑(rewind)：仅 observed 的 jsonl 可原地截断 fork
- 字段可得性：jsonlBytes / pendingBackgroundAgentCount / attachedPid 仅 observed 有；pid/lease/cost 仅 owned 有

## 进展
- 2026-07-13 round-1：完成 sub goal 1（字段归一）。数据源确认——`readWorkerLog` 对 CLI/分身产出同构 rounds，CLI 原缺 gitBranch 已补齐。
