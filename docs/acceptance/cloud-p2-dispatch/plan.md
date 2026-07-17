# cloud P2 · 云端下发队列 / 意图下行 —— 需求 / 改动 / 验证

> 设计权威见 `docs/spec/cloud-control-plane.md` §9；实现契约见 `docs/spec/cloud-p2-dispatch-contract.md`。本文只做「改了什么 + 怎么验」的索引，不复述设计。

## 需求（本期范围）
人在云端建任务（title/prompt/model/effort/cwd/worktree/baseBranch/autoRun + machineId）→ 落到该机器 →
意图队列下发 → 本地 connector 拉取 → cwd 白名单 → 自动执行闸门 → `createTask(source:'cloud', plan)` → 写 link → ack。
外加决策 15（agent 显式声明完成）。取消未下发的意图。**不做**：流程/命令下行/transcript 拉流/cron/WS；决策 14 对账过滤（#67）。

## 改动（对最新 master 的增量）
- **迁移** `cloud/migrations/002_p2_intent_dispatch.sql`：task 加 `auto_run/dispatch/dispatched_at/reject_reason` + 取件偏索引；**不删 origin、不删行**。
- **云端 A 块**：`cloud/src/routes/user.js`（建意图 `POST /api/tasks`、取消 `:id/cancel`、`GET /api/tasks` 改 LEFT JOIN）、
  `cloud/src/routes/machine.js`（取件 `GET /api/machine/intents`、`ack`、`reject`、enroll 响应加 `ownerUserId`、heartbeat 加 `pendingIntents`）；
  绊线 `requireDispatchAllowed` 复用 `dispatch-gate.js`（未改），只挂建意图/取件两处。
- **本地 B 块**：新增 `platform/lib/cloud/{cwd-allow,gate,completion-protocol}.js`；`connector.js` tick 末加意图下行（拉取→白名单→闸门→占位→createTask→link→ack）；
  `identity.js` 加 `ownerUserId`；`runner-config` 复用 `cloudAllowedCwds` + 新 `acceptAutoRun`；`links.js`（§7.3 与 #67 共享格式，见 round-1.md §5）。
- **C 块（决策 15 本地侧）**：`session-manager.js`（bypass 会话加 `--disallowedTools AskUserQuestion` + 注入 `SCRUMWS_TASK_KEY/API_BASE`）、
  `task-actions.js`（`completeTask` 收 `resolvedBy`）、`server.js`（`/api/task/complete` 透传 `resolvedBy` + `/api/cloud/dispatch-config` 读写档位）。
- 根 `package.json` 零新增依赖（只 node: 内置）；`cloud/` 依赖仍 fastify+pg+@fastify/static。

## 验证（round-1）
- 真云端(8791)+真 DB(一次性 001+002)+真沙箱(8797) 端到端：`scripts/e2e-real.mjs --run` → **18/19 PASS**（`matrix.csv`）。
- 唯一 FAIL：**C13b 决策 15 真 agent 单轮自我声明完成**——`completeTask` 卫语句只认 awaiting-human、agent 调用时任务仍 processing → 被拒 → 卡 awaiting-human。
  真 claude 实跑取到铁证，根因 + 3 候选修复见 `round-1.md` §4。非本期引入、触承重墙 `task-runner.js` + 违契约 §8.2「状态机不改」→ 交主 session 定夺。
- 补充：`../cloud-p2/scripts/verify-local-dispatch.mjs`（假云端+stub）15/15，覆盖 ack 丢包幂等 / off·on 闸门 / 门铃。
- 收尾独立只读复核：一次性库已删、生产 `scrumws` 未碰（app_user=1/machine=1、无 P2 列）、8799 仍 200、零残留进程。
