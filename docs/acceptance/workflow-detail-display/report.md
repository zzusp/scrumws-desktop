# report — 详情里的 workflow 展示

matrix 全绿（19/19，round-1 一轮过）。

## 结论

任务详情对 Claude Code Workflows 的两处盲区补齐，与后台 subagent / 后台命令对齐：

1. **侧栏「后台任务 N 个运行中」**：Workflow 的后台启动此前**从未被计数**——全库 16 次启动恒 0。
   根因是 `bgLaunchTtlMs` 的三条签名判据（`isAsync` / `backgroundTaskId` / Monitor 三元组）都不命中
   `taskType:'local_workflow'`，且行粗筛更早一步就把启动行跳过了。补一条判据 + 粗筛键即可，
   配平侧（`<task-notification>` + 终态 status）本来就是通的，只漏"启动"不漏"结束"。
2. **消息流 ⏺ 行**：`Workflow` 此前走 `default: JSON.stringify(input)`，而入参是整段编排脚本源码
   → 摘要行全是转义 JS。现按 CC 约定的 `export const meta` 取工作流名，展开区原样出源码。

## 证据强度

- 全部断言跑在真实落盘 jsonl 上（`cli:66b52133` 三次真实 Workflow 调用 + 全库 1682 个 jsonl 扫描）。
- 两条改动各有**负对照**：撤回改动后对应断言确实 FAIL（后台计数实得 0 / 摘要实得脚本源码 JSON），
  证明是本次改动挣来的，不是本来就过。
- 回归：全库各会话 `backgroundTaskCount` 在会话末刻改动前后逐一未变；四类后台签名经 1682 文件实测互斥。

## 已知盲点（见 round-1.md 末节）

未起服务点真详情页（`8799` 是用户在跑的桌面 app，不碰）。渲染证据是真 CSS + 真 app.js + 真数据的
离线渲染，未覆盖 `collect → /api/task → renderDetailTab` 的数据装配链路。

## 可复跑

```
node docs/acceptance/workflow-detail-display/scripts/verify-workflow-display.mjs          # 19 条断言里的 BG/ARG
node docs/acceptance/workflow-detail-display/scripts/preview-workflow-render.mjs          # 渲染预览页 → 无头截图
```

两个脚本都支持 `--check`（零副作用自检）与 `--jsonl` / `--out` 换语料。
