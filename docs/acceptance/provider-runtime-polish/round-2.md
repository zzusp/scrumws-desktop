# Round 2

## 结果

Codex CLI 会话已从仅观察调整为可查看执行详情、可从看板续接/回复。

## 实跑证据

- registry 返回 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini` 以及完整 Codex effort 列表。
- 使用隔离 `SCRUMWS_DATA_ROOT` 启动服务，添加历史 Codex rollout 后，`/api/worker-log` 返回 8 条执行详情消息，其中包含工具调用。
- 对同一历史 thread 调用 `/api/session/adopt` 返回成功；session list 显示 `provider: codex` 且 session id 等于原 thread id。随后立即关闭测试 app-server，未发送测试消息。
