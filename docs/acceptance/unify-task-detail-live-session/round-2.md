# Round 2 · CLI 收养归一真浏览器 E2E

补 round-1 遗留的盲点：CLI watchlist 会话「收养」→ `#/task/<cliTaskKey>` live 的真机流程。

- 环境：macOS · claude 2.1.207（真登录）· Electron 43 真 Chromium offscreen。
- 脚本：`scripts/browser-e2e-cli-adopt.cjs`（沙箱 `~/.cli-adopt-e2e-sandbox`，PORT 8798）。
- 造真会话：主进程用 session-manager 起种子会话记暗号 BANANA42 → 关进程留真 jsonl（可 `--resume`）
  → `upsertWatchlist(sid)` 加进看板 → 浏览器走「CLI 详情发消息 → 收养 → live」。

## 结果：10/10 PASS

```
==== CLI 收养归一 E2E：10/10 PASS ====
PASS  种子会话拿到真 CC sessionId  — sid=1a673517-b4f9-45f4-9c6f-26c18d4d1ceb
PASS  看板出现 CLI 卡片 cli:<short>  — cli:1a673517
PASS  点开 CLI 卡进 #/task/<cliKey>  — #/task/cli%3A1a673517
PASS  尚未进 live 模式（mb 为空）
PASS  observe 模式 composer = CLI 可续接对话  — CLI · 可续接对话
PASS  只读历史含种子对话(BANANA42/记住了)
PASS  发消息后进入 live 模式（mb.id 有值）
PASS  收养后仍在 #/task/<cliKey>（未跳 #/session/）  — #/task/cli%3A1a673517
PASS  view-session 视图不存在
PASS  收养会话 --resume 续上上下文（BANANA42 复现 ≥2 次）  — count=3
```

## 关键证据

- **observe → live 无跳视图**：点 CLI 卡进 `#/task/cli%3A1a673517`（observe，`mb` 为空，composer
  「CLI · 可续接对话」）；发消息收养后 `mb.id` 有值（live），`location.hash` **仍是同一
  `#/task/cli%3A1a673517`**（未跳 `#/session/`），`#view-session` 不存在。
- **--resume 续上上下文**：收养会话对新问题"暗号是什么"复述 `BANANA42`，`#modalBody` 内该串出现
  **3 次**（历史种子 + 回放 + 回答），证明 `--resume` 把真终端会话的上下文接上了。

## 本轮发现并修复的真缺口

collect.js 只给 board 任务塞 `mbSessionId`（`getTaskSessionId`），**CLI 任务卡未塞** → 收养会话虽已绑
taskKey，cli 卡的 `t.mbSessionId` 仍 undefined，详情进不了 live。修复：`collect.js` cli 循环加
`cli.mbSessionId = getTaskSessionId(cli.taskKey)`（内含 session-manager 反查兜底）。本轮 C22
「发消息后进入 live」即验证该修复。

## 剩余盲点

- Windows 侧未跑（沿用上游 Mode B 跨平台结论，非阻塞）。
