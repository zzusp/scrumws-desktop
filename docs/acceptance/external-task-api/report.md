# report：外部任务 API + API 密钥管理（桌面端侧）

**结论：matrix 30/30 全绿（round-1 一轮通过；唯一首跑 FAIL 是用例断言 bug，产品代码零返工）。**

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

- 外部通道任务 **source 强制取密钥绑定值**、**缺省落 plan 桶**、`externalKey` 同 source 幂等（任务删除后同键可重建）。
- 鉴权失败（缺头/错钥/禁用/已删）统一 401，不泄露密钥状态；跨 source 查询统一 404，不泄露他源任务存在性。
- 管理端点沿用「只听 127.0.0.1」安全模型；密钥明文只在创建响应出现一次。

## 后续（Phase B，见 goal.md G7）

baibu-agent 的 chat-watch.mjs / issue-watch.mjs 改为调本 API；**用户真实桌面端需更新到含本 PR 的版本后才有 /api/external/***。
