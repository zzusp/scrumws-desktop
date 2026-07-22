# 外部任务查询与续接

## 目标

外部持钥调用方除创建任务外，还能查询自己的任务状态，并在任务收敛后向同一 provider 会话发送下一条指令，触发原生 resume。

## 现状与证据

- `GET /api/external/task/status` 已按 `taskKey` 或 `externalKey` 查询，且在 `external-ingest.js` 中核验 `source + provider`；因此查询不另建重复接口。
- 看板内部 `/api/task/reply` 已通过 `replyToTask()` 调用 `replyTask()`，后者会使用 `meta.sessionId` 由 Claude/Codex adapter 原生 resume。
- 外部 `plan` 任务的既有约定是等待看板确认；任何新的外部续接入口都不能改变这一确认边界。

## 方案

新增 `POST /api/external/task/resume`：

1. Bearer API key 鉴权，复用现有任务解析逻辑，因此跨来源、跨 provider 或不存在均返回统一 `404 task not found`。
2. Body 以 `taskKey` 或 `externalKey` 定位任务，并要求 `message` 作为下一条用户指令。
3. 仅接受 `awaiting-human` / `done`。`plan` 被拒绝以保留人工确认，`processing` 被拒绝以避免并发 resume。
4. 用任务原 model、effort、cwd 为默认值，结合请求可选覆盖项重新校验当前密钥策略；策略收窄后不得继续运行旧的越权任务。
5. 校验通过后调用 `replyToTask()`，不复制 provider 特定命令或会话恢复逻辑。

## 已排除的路径

- 直接暴露 `/api/task/reply`：该端点是看板内部入口，不带外部 API key 的来源隔离。
- 用无消息的 `restartTask()` 作为 resume：会重发原任务 prompt，且对 `plan` 会等同绕过既有的人工确认语义。
- 放开 `plan`：与外部任务“默认先落 plan 桶”的产品约束相冲突。

## 验收边界

在无 Claude CLI 的隔离数据根运行现有 API 验收脚本，使用落盘的收敛会话夹具验证路由、授权和 resume 调度；不运行真实 Agent，因此不消耗账号额度或执行用户任务。
