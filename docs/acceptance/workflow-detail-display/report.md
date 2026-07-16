# report — 详情里的 workflow 展示

matrix 全绿（round-1 离线取证 → round-2 现场证伪 + 修正 + 真浏览器端到端；BG-6 作废，见下）。

## 结论

任务详情对 Claude Code Workflows 的两处盲区补齐，与后台 subagent / 后台命令对齐：

1. **侧栏「后台任务 N 个运行中」**：Workflow 的后台启动此前**从未被计数**（全库 16 次启动恒 0）。
   `bgLaunchTtlMs` 的三条签名判据（`isAsync` / `backgroundTaskId` / Monitor 三元组）都不命中
   `taskType:'local_workflow'`，且行粗筛更早一步就把启动行跳过了。补判据 + 粗筛键；配平侧
   （`<task-notification>` + 终态 status）本来就是通的，只漏"启动"不漏"结束"。
   **并且**：死线锚点必须是「最后活动时刻」（`transcriptDir` 内最新文件 mtime）而非「启动至今」——
   否则 15min `BG_STALE_MS` 会把在跑的长工作流误杀（现场那条跑了 108.9min）。
2. **消息流 ⏺ 行**：`Workflow` 此前走 `default: JSON.stringify(input)`，而入参是整段编排脚本源码
   → 摘要行全是转义 JS。现按 CC 约定的 `export const meta` 取工作流名，展开区原样出源码。

## round-1 是假绿，round-2 才落地

round-1 报 19/19 全绿，但**盲点（没点真详情页）恰好盖住了真 bug**：现场 `cli:66b52133` 正在跑 workflow，
详情页 `backgroundTaskCount=0` 什么都不显示。更糟的是 round-1 的 `BG-6` 把错误行为写成了期望值
（`过 15min 死线 → 归 0 → PASS`），用例自证自洽 —— **期望值是自己写的，全绿不等于对**。
该用例已作废，重写为 A1–A7（见 `round-2.md`）。

## 证据强度

- **端到端**：真起看板实例 + 真无头浏览器点开详情页，DOM 取证 + 截图。沙箱重放「workflow 在跑」那一刻
  （E2E-1..4）+ 打真实在跑任务（LIVE-1..4）。
- **真实字节**：单测语料是 `cli:66b52133` 的真实 Workflow 调用 + 全库 1682 个 jsonl 扫描；沙箱是真实
  jsonl 截断而来（546/656 行），非手搓 fixture。
- **负对照**：三条改动各有 —— 撤回后对应断言确实 FAIL（计数实得 0 / 摘要实得脚本源码 JSON /
  长工作流被误杀）。A7 精确隔离 round-2 的 `lastActivityMs`。
- **回归**：全库各会话 `backgroundTaskCount` 在会话末刻改动前后逐一未变；四类后台签名经 1682 文件实测互斥。
- **生命周期实测**：完整盯完一次 108.9min 的 workflow —— 本版全程正确显示、收尾即消失；
  round-1 那版会在第 15 分钟消失、错报 94 分钟。

## 已知盲点（`round-2.md` 末节有详述）

- Mode B live 会话下的 Workflow 未单独取证（走 CC 推的 `background_tasks_changed`，与本次 collect-cli 改动无关）。
- `lastActivityMs` 在超大 transcriptDir 下的性能未实测（全库仅 16 次启动、目录内文件个位数，成本可忽略）。
- 「workflow 长时间等慢 subagent、期间 transcriptDir 完全不写」是否存在未验证；若存在，15min 静默窗口会误杀。

## 可复跑

```
node docs/acceptance/workflow-detail-display/scripts/verify-workflow-display.mjs    # 单测：计数判据 + 摘要 + 分组汇总
node docs/acceptance/workflow-detail-display/scripts/verify-detail-sandbox.mjs      # 沙箱重放「workflow 在跑」→ 端到端 + 截图
node docs/acceptance/workflow-detail-display/scripts/preview-workflow-render.mjs    # 离线渲染预览页 → 无头截图
# 打真实看板（先起只读实例，不碰 8799）：
SCRUMWS_PORT=8815 DASHBOARD_NO_SCHEDULER=1 node platform/standalone.js
node docs/acceptance/workflow-detail-display/scripts/verify-live-detail.mjs --task cli:66b52133
```

全部脚本带 `--check` 零副作用自检。沙箱脚本跑完即拆（`--keep` 可保留排查）。
