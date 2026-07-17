# report — 详情里的 workflow 展示 → 后台任务计数根治

matrix 见 `matrix.csv`（round-1 离线取证 → round-2 现场证伪 → **round-3 根治**；round-1 的 BG-6 与
round-2 的 A1–A7 均已作废，见各自 round 文档顶部）。

## 最终结论

两件事，第二件被返工了两轮才找到根：

1. **消息流 ⏺ 行**（round-1，已合入 #48）：`Workflow` 走 `default: JSON.stringify(input)`，而入参是整段
   编排脚本源码 → 摘要行全是转义 JS。现按 CC 约定的 `export const meta` 取工作流名，展开区原样出源码。
   这条从头到尾没被推翻。

2. **侧栏「后台任务 N 个运行中」**（round-1 → #48 / round-2 → #49 / round-3 根治）：
   - #48：Workflow 的后台启动**从未被计数**（`bgLaunchTtlMs` 三条签名都不命中 `local_workflow`）→ 补判据。**对，但不够。**
   - #49：发现 15min 死线会误杀跑 108.9min 的 workflow → 给 workflow 加 `transcriptDir` 活动锚点。
     **是在通用 bug 上打单类补丁 —— 错的方向。**
   - **round-3（本次）**：15min 死线在误杀**全部四类**（bgcmd 17%/141 个、workflow 36%、subagent 4%、
     monitor 22%），而它守的理由（防通知丢）实测只值 1.3%，且其真根因（通知三载体只认 user）早已修好。
     → **删掉死线**，回到语义本身：后台任务是会话进程的子进程，**会话活着才可能有在跑的后台任务**，
     由 pid 实测的 `sessionAlive` 短路。cli 路本就该这样 —— runner 路（`collect.js:60`）一直是这么做的。

净改动 **−9 行**（删的比加的多），且连带删掉了 #49 加的 `lastActivityMs` 特判。

## 为什么前两轮没抓到

- **#48 假绿**：19/19 全绿，但用例 `BG-6` 把错误行为写成了期望值（`过 15min → 归 0 → PASS`），自证自洽；
  盲点（没点真详情页）恰好盖住真 bug。
- **#49 修错方向**：撞见的是 workflow，就以为是 workflow 的问题，给它做了专属锚点 —— 没先问
  "别的类型是不是也这样"。一条 `probe-durations` 就能证伪，但直到用户回怼才去跑。

两轮教训同源：**期望值是自己写的，全绿不等于对**；**撞见哪类就修哪类 = 补丁，先找作用域下沉的根治**。

## 证据强度

- **量化根因**：全库时长分布 + 真丢率两张表（round-3.md 二/三节），死线的两个立论前提逐条证伪。
- **端到端**：沙箱两场景（活会话计入 / 真进程真杀后归 0）+ 真浏览器点真实详情页 + 真进程判活。
- **负对照**：同一现场，PR#49 那版算 0、本轮算 1。
- **全量回归**：真看板 51 个任务，仅 `cli:66b52133` 由 0→1，其余逐一未变 —— 无误报扩散。

## 已知盲点（round-3.md 末节详述）

- 真丢的 1.3%（6/471 bgcmd）会在会话存活期间多报 1 个，会话退出即归 0（有界，非永久）。
- `sessionAlive` 依赖 CC 注册表 + pid 实测；若 CC 改注册表格式/位置，这条防线会**静默失效**，当前无告警。
- Mode B live 会话未单独取证（走 CC 推的 `background_tasks_changed`，与 collect-cli 无关）。

## 可复跑

```
node docs/acceptance/workflow-detail-display/scripts/verify-workflow-display.mjs   # 单测：四类计数 + 摘要 + 分组汇总
node docs/acceptance/workflow-detail-display/scripts/verify-detail-sandbox.mjs     # 沙箱两场景 e2e + 截图
node docs/acceptance/workflow-detail-display/scripts/preview-workflow-render.mjs   # 离线渲染预览页 → 无头截图
# 打真实看板（先起只读实例，不碰用户的 8799）：
SCRUMWS_PORT=8815 DASHBOARD_NO_SCHEDULER=1 node platform/standalone.js
node docs/acceptance/workflow-detail-display/scripts/verify-live-detail.mjs --task cli:66b52133
```

全部脚本带 `--check` 零副作用自检；沙箱脚本跑完即拆（`--keep` 可留）。
