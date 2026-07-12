# 看板运行时视图（Claude Code 运行时）

> 参考 https://multica.ai/ 的 **Runtime Panel**（本地/云 runtime 的在线状态 + token 用量 + 活跃 runtime）。
> 我方为单机本地场景，落地为**一个 Claude Code 运行时**：在线状态 + 活跃会话 + 跨任务用量汇总。

## 需求

侧边栏「平台」组新增独立菜单「运行时」，展示本机 Claude Code 执行环境。用户选定内容范围：
**运行时卡片 + 用量汇总指标**（不含活跃会话列表 / 近期活动流）。数据一律真实可采集，不造假。

## 方案

单机只有一个 runtime（Claude Code）。忠实 multica Runtime Panel 的子集：

- **运行时卡片**：工具名（Claude Code）· 主机名 · 平台 · claude 版本 · claude 路径 · 在线状态 · 活跃会话数。
- **用量汇总**：跨任务聚合 `meta`，4 个 stat tile（总成本$ / 输入 tokens / 输出 tokens / 缓存读命中）+ 一行覆盖统计。

### 数据来源（真实链路）

| 字段 | 来源 |
|---|---|
| 在线 / 版本 / 路径 | 后台 `execFile('claude','--version')` + `which/where claude`，缓存 5min（模块加载即首探，TTL 到点重探） |
| 主机 / 平台 | `os.hostname()` / `process.platform` |
| 活跃会话 | 看板 Mode B 会话 `listSessions()`（未收敛）+ 终端 CLI 活进程 `readAttachedSessions()`（`~/.claude/sessions/<pid>.json`），按 sessionId 去重 |
| 用量 tokens | 各任务 `meta.usage`（CC result 事件 usage，单轮快照口径）跨任务求和 —— 真实记录值 |
| 总成本 / 轮次 / turns | `meta.totalCostUsd`（result 累计值）/ `rounds` / `numTurns` 跨任务求和 |

> CLI 会话 v1 不计 token（`usage=null`），单独计数并在覆盖行标注「M 个 CLI 会话无 token 计量」，不混入 token 汇总。
> token 口径说明：CC `result.usage` 为单轮值、逐轮覆盖式写盘，跨任务求和是「各任务末轮记录用量」之和（真实记录，非估算）；总成本为累计口径，求和即总量。

## 改动

- `platform/lib/collect.js`
  - 新增 imports：`os`、`execFile`、`readAttachedSessions`、`listSessions`。
  - 新增 claude 运行时探测块（`detectClaudeRuntime`，缓存 + TTL + 模块加载首探）。
  - 新增 `computeRuntimeUsage(buckets)` 跨任务聚合用量；`buildRuntime(buckets)` 组装运行时对象。
  - `collectState()` 返回新增 `runtime` 字段。
- `platform/public/index.html`
  - 侧边栏「平台」组新增 `#/runtime` 菜单（cpu 图标，置数据看板之前）。
  - 新增 `#view-runtime` 视图（运行时卡片容器 `#runtimeCard` + 用量容器 `#usageGrid`）。
  - 新增运行时卡片 / stat tile CSS（复用 multica oklch token）。
  - 底部内联脚本 `crumbTrail()` 名称解析新增 `#/runtime → 运行时`。
- `platform/public/app.js`
  - `ROUTE_VIEWS` + `router()` hash 分支新增 `runtime`。
  - `refreshState()` 新增 `renderRuntime(stateData.runtime)`。
  - 新增 `renderRuntime(rt)` 渲染函数。

### 附带修正（一句话反馈）

面包屑标题由 `index.html` 底部内联脚本 `crumbTrail()/syncTop()` 按 hash 设置（非 app.js router）；
app.js:1108 的 `crumbLast` 是任务详情末级 id（内联脚本按 trail 生成），非静态 bug。新视图仅在 `crumbTrail()` 加一分支，未改既有机制。

## 验证

真浏览器 E2E（Electron 真 Chromium 驱动真实 index.html+app.js）：
`node_modules/.bin/electron docs/acceptance/runtime-panel/scripts/browser-e2e-runtime.cjs`

18/18 通过（见 round-1.md）。后端 `/api/state.runtime` 另经 curl + node 轮询核验（online/version/path/usage 与 fixture 精确一致）。
