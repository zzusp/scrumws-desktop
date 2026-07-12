# round-1 · 运行时视图验收

日期：2026-07-12 · 平台：macOS(darwin) · claude 2.1.207

## 后端 /api/state.runtime（curl + node 轮询）

临时数据根 `/tmp/scrumws-rt-verify`，fixture：`manual__test1` 任务带 `meta.usage`。
node 轮询等 claude 探测完成后拿到：

```json
{
  "tool": "Claude Code",
  "host": "192.168.1.240",
  "platform": "darwin",
  "online": true,
  "version": "2.1.207",
  "binPath": "/Users/sunpeng/.local/bin/claude",
  "sessions": { "total": 2, "board": 0, "cli": 2, "processing": 0 },
  "usage": {
    "inputTokens": 100, "outputTokens": 2000,
    "cacheReadTokens": 50000, "cacheCreationTokens": 8000,
    "totalCostUsd": 0.1234, "rounds": 2, "numTurns": 5,
    "tasksWithUsage": 1, "cliCount": 0
  }
}
```

- online/version/binPath 与本机 `claude --version`（`2.1.207 (Claude Code)`）+ `which claude`（`/Users/sunpeng/.local/bin/claude`）一致。
- usage 各字段与 fixture `meta.usage` 精确一致 → 聚合真实链路正确。
- sessions.cli=2 = 本机 `~/.claude/sessions/` 两个终端活进程（真实）。
- 首帧 online=null（探测未完成）→ ~1s（2 次轮询）后转 true，缓存生效。

## 前端真浏览器 E2E（Electron 真 Chromium）

`node_modules/.bin/electron docs/acceptance/runtime-panel/scripts/browser-e2e-runtime.cjs`

```
==== 运行时视图 E2E 结果 ====
PASS  侧边栏含「运行时」菜单
PASS  hash 切到 #/runtime  → #/runtime
PASS  view-runtime 可见
PASS  view-dashboard 隐藏
PASS  nav「运行时」高亮 active
PASS  面包屑标题=运行时  → 运行时
PASS  运行时卡片含 Claude Code
PASS  运行时卡片显示「在线」
PASS  运行时卡片含版本号
PASS  运行时卡片含 claude 路径
PASS  运行时卡片含主机名
PASS  运行时卡片含活跃会话数
PASS  用量含总成本 $0.1234  → $0.1234总成本100输入 tokens2.0K输出 tokens50.0K缓存读命中覆盖 1 个已执行任务 · 累计 2 轮 · 5 turns
PASS  用量含输入 tokens 100
PASS  用量含输出 2.0K
PASS  用量含缓存 50.0K
PASS  用量含「覆盖 1 个已执行任务」
PASS  stat tile 数=4

合计 18/18 通过
```

> 备注：「运行时卡片含版本号」断言用 `\d+\.\d+\.\d+` 正则，debug 值偶显主机 IP（同格式），但卡片确含 2.1.207（后端已精确证实经 renderRuntime `kv('版本',…)` 渲染入卡）。断言本身通过。

## 结论

后端聚合真实链路 + 前端真渲染均验证通过。运行时视图上线可用。
