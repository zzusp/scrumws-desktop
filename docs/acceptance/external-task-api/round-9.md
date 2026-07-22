# round-9（2026-07-22）：外部任务查询确认与原生续接 · 全绿

## 交付

- 确认既有 `GET /api/external/task/status` 已支持按 `taskKey` 或 `externalKey` 查询，保留原有来源 + provider 隔离语义。
- 新增 `POST /api/external/task/resume`：要求下一条 `message`，仅接收 `awaiting-human` / `done`，复用任务动作层的 provider 原生 resume。
- `plan` 任务不可通过该接口绕过看板确认；续接时重新按当前密钥的 model、effort、cwd 策略复核。

## 证据

隔离数据根 `D:\project\scrumws-desktop\.sandbox\api-resume-20260722-1`、端口 `19876`、子进程 PATH 不含 Claude CLI：

```powershell
node docs/acceptance/external-task-api/scripts/api-tests.mjs http://127.0.0.1:19876 D:\project\scrumws-desktop\.sandbox\api-resume-20260722-1
```

结果：`50/50 PASS`。新增用例均通过：

- C6：plan 任务调用 resume 返回 400，不绕过确认；
- C7：issue 密钥续接 chat 任务返回 404；
- C8：无鉴权续接返回 401；
- C9：按 `externalKey` 续接带 `resume-fixture-session` 的 awaiting-human 任务，返回 `200`、`state=processing`、`resumed=resume-fixture-session`。

该实例未发现 CLI 可执行文件，续接只验证 native resume 调度，不产生真实 Agent 副作用；验证完成后服务进程已停止。
