# round-7（2026-07-17）：whoami 自省端点 + 外部接入指导文档 + README 链接 · 全绿

用户需求：持钥方可凭密钥获取自己的权限范围与信息（调用方据此自适应）；整理一份使用 apikey 外部接入桌面端的指导文档并挂到 README（GitHub 可点击跳转）。

## 改动

- **`GET /api/external/whoami`**（platform/server.js）：Bearer 鉴权 → 返回 `{label, source, prefix, createdAt, allowedModels, allowedEfforts, allowedCwds, allowQueued}`；不带 id/plaintext/hash；无副作用（也刷活跃）。调用方建议启动时先自省再定参数（各白名单首项即默认值），密钥被编辑后无需改代码。
- **`docs/api/external-api-guide.md`（新）**：外部接入唯一指导——快速开始 4 步、鉴权、权限模型表、四端点完整契约（whoami/create/status/heartbeat）、错误对照表、可靠性建议（幂等/fail-soft/pending 模式）、curl+PowerShell+Node 示例、参考实现指针。
- **`docs/api/task-ingest.md`**：原「外部 API」章缩为指针段落，端点明细单一事实源移至 guide（消除双处维护漂移）。
- **`README.md`**：新增「外部接入（API 密钥）」小节 + 相对路径链接 `docs/api/external-api-guide.md`（GitHub 可点击）。

## 证据（r10 隔离实例）

- API **40/40 PASS**：新增 W1（whoami 回显 source/三白名单/allowQueued 与建钥入参一致，且响应不含 id/plaintext/hash）、W2（无鉴权 401）；其余全量回归。
- 文档链接均为相对路径（README→docs/api/external-api-guide.md、guide↔task-ingest 互链），GitHub 渲染可跳转。
