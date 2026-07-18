# Round 3

## 结果

Codex CLI 详情页显示 rollout 实际使用的模型；同一 session 被其它本机客户端持有时，任务详情不再允许发送或从看板续接。

## 实跑证据

- 对本机真实 Codex rollout 调用 `readCodexCliSessionHistory`，返回 `model: gpt-5.6-terra`、`effort: medium` 和 1214 条执行详情消息；模型取自 `turn_context`，不是配置默认值。
- 启动携带同一 thread id 的模拟外部进程后，`readCodexAttachedSession` 返回 `{ detected: true, status: external }`。
- 使用隔离 `SCRUMWS_DATA_ROOT` 启动服务，向 `POST /api/session/adopt` 提交被该进程占用的 Codex session，实收 HTTP `409`。
- `npm run dist:win` 通过，生成 Windows NSIS 安装包。
