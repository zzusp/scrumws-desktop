# Round 1 · 详情页归一真浏览器 E2E

- 环境：macOS · claude 2.1.207（真登录）· Electron 43 真 Chromium offscreen 驱动真 index.html+app.js。
- 脚本：`scripts/browser-e2e-merge.cjs`（沙箱 `~/.merge-detail-e2e-sandbox`，PORT 8797，server.js 进程内起）。
- 模型：haiku-4-5（无工具 prompt，避免权限卡阻塞收敛）。

## 结果：15/15 PASS

```
==== 详情归一 E2E：15/15 PASS ====
PASS  view-session 已删（getElementById 为 null）
PASS  详情 composer 打断按钮 #modalReplyInterrupt 存在
PASS  未知会话链接重定向到 #/board
PASS  提交后路由到任务详情 #/task/<key>
PASS  未跳独立会话面 #/session/
PASS  view-task 可见
PASS  逐字 #mbLive 流式增长（进 #modalBody）  — seq=[18,44,57]
PASS  assistant 文本(mango) 已渲染进 #modalBody
PASS  右侧 taskSide 含任务信息(manual:)
PASS  composer #modalReplyText 存在
PASS  打断按钮 live 模式可见
PASS  composer 续一轮 assistant(mango2) 已渲染
PASS  拿到当前活会话 id  — sid=ee071221-22c3-42cd-b1e6-571e9b34dfe2
PASS  旧会话链接重定向回 #/task/<key>  — #/task/manual%3A20260712211426-985
PASS  看板点卡片进 #/task/（openTaskModal 归一）
```

## 关键证据

- **归一**：新建任务提交后 `location.hash` 落 `#/task/<key>`，且 `#/session/` 前缀判否（C4/C5）；
  `#view-session` DOM 不存在（C1）。看板点卡片同样落 `#/task/`（C15）。
- **live 折进详情**：逐字 `#mbLive` 长度序列 18→44→57（流式增长，C7），mango/mango2 两轮
  assistant 文本渲染进 `#modalBody`（C8/C12）——续轮验证"处理中插话"路径（D-c）。
- **侧栏 + 打断**：`#taskSide` 含 `manual:` 任务信息（C9）；`#modalReplyInterrupt` live 模式可见（C11）。
- **旧链接重定向**：拿到活会话 id `ee071221…`，`#/session/<id>` 自动跳回 `#/task/manual%3A…`（C14，D-d）；
  未知会话 id → `#/board`（C3）。

## 未覆盖 / 盲点

- CLI watchlist「收养」→ `#/task/<cliTaskKey>` live 的真机流程 → **已在 Round 2 补测（10/10 PASS）**，
  并借此发现修复 collect.js 未给 cli 卡塞 mbSessionId 的真缺口。
- Windows 侧未跑（沿用上游 Mode B 结论：跨平台，Windows 抽查非阻塞）。
