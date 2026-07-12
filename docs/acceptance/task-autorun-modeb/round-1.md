# round-1 · 后端桥接 + 自动执行 + 残留清理（真 claude on Mac）

环境：`SCRUMWS_DATA_ROOT=<scratch>/dataroot`，`SCRUMWS_PORT=8811`，`node platform/standalone.js`，
claude 2.1.207，model=claude-haiku-4-5-20251001。

## S1/S2/S4 — 交互引擎当执行器，全链路 PASS

**建任务自动跑**（`POST /api/task/create` source=manual，plan 未勾）：
```
{"ok":true,"taskKey":"manual:20260712194959-756","state":"processing","spawned":true,"sessionUiId":"bbe1a633..."}
```
盘上 `runner-state/manual__20260712194959-756/` 有 lease.json + state.json + task.json（无需 .ps1）。

**状态机 + 持久化**（轮询 /api/state → 6s 内收敛）：
- history：`queued(by:create:manual)` → `processing(by:session)` → `awaiting-human(by:session)`。
- meta.json：sessionId=d491fadc、rounds=1、numTurns=1、usage（in/out/cache）、totalCostUsd=0.0254。
- awaiting-human 时 lease.json 已删（桶只认 state.json.state，idle-but-alive 稳在 awaiting-human）。

**reply 复用 live 会话**（`POST /api/task/reply`）：`{"reused":true,"sessionUiId":"bbe1a633..."}` →
processing→awaiting-human，rounds=2，session transcriptLen=19、claudeSessionId 稳定 d491fadc。

**plan gate**：`plan:true` → `{"state":"plan","spawned":false}`（无 claude spawn）。
**approve**：`POST /api/task/approve` → `{"spawned":true,"sessionUiId":"3adc72ee..."}` → processing。
**cancel**：`POST /api/task/cancel` → `{"killedPid":"3adc72ee..."}` → 终态 `state=awaiting-human outcome=cancelled mbSessionId=null`（跨平台关会话，无 taskkill.exe）。
**reply --resume 兜底**：close 会话 → mbSessionId=null → reply → `{"resumed":"d491fadc...","sessionUiId":"6e8f4007..."}` → 新 session 续同一 CC session 到 rounds=3。

## S3 — 残留清理，server 干净启动

- `node --check` 8/8：task-runner / task-actions / collect / paths / ctx / runner-checker / server / collect-cli。
- `/api/state` 顶层 keys=`now,scheduler,checker,lifecycle,runnerConfig`，**无 authBlock**。
- scheduler `mode=running jobs=runner-checker`（去派发器后唯一 job）。
- 删除：paths.quotaBlk/authBlk；collect authBlock + chat/issue 逆推 + source==='chat' humanCc；
  ctx exec/quotaBlockActive/recheckAuthBlock（调 `dws auth status`）；runner-checker 授权复查 + quota-block gate；
  task-actions 全部 `.ps1`/pwsh/taskkill + chat/issue→worker 映射。

## 盲点 / 未覆盖

- 真·服务重启的孤儿收纳（runner-checker 把 processing 收成 awaiting-human）——本轮用 close 会话近似验证了
  下游 --resume 兜底，未跑完整 kill server→重启→checker tick 链路。
- tool-use 权限流（`can_use_tool` 挂起等前端应答）——本轮用无工具 prompt 只验状态机，权限 UI 在 S5 前端验。
- 前端统一（删新建交互会话入口 + 详情接 live）——S5。
</content>
