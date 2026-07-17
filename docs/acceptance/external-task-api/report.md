# report：外部任务 API + API 密钥管理（桌面端侧）

**结论：matrix 全绿——round-1 30/30；round-2（per-key 策略 + 心跳增量）32/32 API + 5/5 UI + 派发器 e2e；round-3（策略改必选：全不选=无权限）33/33 API + 6/6 UI。明细见 round-N.md。**

## 交付

| 项 | 位置 |
|---|---|
| API key 模块（swak_ 铸造/校验/禁用/删除，只存 sha256） | `platform/lib/api-keys.js` |
| 外部任务模块（幂等台账 + 状态查询 + source 隔离） | `platform/lib/external-ingest.js` |
| 6 条路由（/api/apikeys* ×4 + /api/external/task/create|status） | `platform/server.js` |
| createTask externalKey 透传（写 task.json 供追溯） | `platform/lib/task-actions.js` |
| 「API 密钥」菜单页（生成/一次性明文/禁用/删除/curl 示例） | `platform/public/index.html` + `app.js` |
| 对接文档「外部 API（带鉴权）」章 | `docs/api/task-ingest.md` |

## 语义要点

- 外部通道任务 **source 强制取密钥绑定值**、**缺省落 plan 桶**（调用方可显式 `plan:false` 直进 queued）、`externalKey` 同 source 幂等（任务删除后同键可重建）。
- **per-key 策略白名单**（round-2 引入，round-3 改**必选**）：密钥必须配全 `allowedModels/allowedEfforts/allowedCwds`（全不选=没有权限：缺项拒建钥，旧格式无策略钥建任务一律 400）；请求省略取首项为默认；越界 400；cwd 允许白名单目录及其子目录。
- **来源心跳**（round-2）：`POST /api/external/heartbeat` 每 tick 打点，「API 密钥」页 lastUsedAt<5min 亮活跃绿点；不用长连接（发起端为 fork-per-tick 短命进程）。
- 鉴权失败（缺头/错钥/禁用/已删）统一 401，不泄露密钥状态；跨 source 查询统一 404，不泄露他源任务存在性。
- 管理端点沿用「只听 127.0.0.1」安全模型；密钥明文只在创建响应出现一次。

## 后续（Phase B，见 goal.md G7）

baibu-agent 的 chat-watch.mjs / issue-watch.mjs 改为调本 API；**用户真实桌面端需更新到含本 PR 的版本后才有 /api/external/***。
