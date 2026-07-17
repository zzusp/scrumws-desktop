# goal：外部任务 API + API 密钥管理 + baibu-agent 派发器对接

## 总目标

桌面端支持**外部系统安全地发起/查询任务**：

1. 新增带 API key 鉴权的外部 HTTP API（发起 + 查询），默认写 **plan 桶**，支持幂等去重键（同一外部事件不重复建任务）。
2. 新增「API 密钥」菜单页面：生成/禁用/删除 key，每个 key 绑定一个 source（来源标签），供不同任务发起端配置。
3. 改造 D:\baibu-agent 旧看板的两个定时派发链（钉钉群消息监听、issue 检查），改为调用桌面端外部 API 建任务（默认 plan 桶、不重复建任务）。

## 重大决策 / 关键信息

- **【关键澄清】用户说的两个 ".ps1" 实际是 Node 派发器**：baibu-agent 的监听/检查/建任务/去重逻辑已于 2026-07-10 Node 化，真身是 `D:\baibu-agent\runtime\dispatchers\chat-watch.mjs`（钉钉，15s，enabled）与 `issue-watch.mjs`（issue，180s，**当前 enabled:false**）。`watch-worker.ps1` / `issue-worker.ps1` 只是执行单任务的 worker 外壳，不做监听建任务。改造落点在 .mjs。
- **鉴权模型**：本地 server（127.0.0.1:8799，原生 node:http）现状零鉴权；外部 API 走 `Authorization: Bearer swak_…`，key 铸造复用 cloud/src/auth.js 的模式（随机 32B、只存 sha256、明文只回一次）。key 绑定 source：外部建的任务 source 一律取 key 的 source（保来源可信），查询也只能查本 source 的任务。
- **去重**：请求可带 `externalKey`（幂等键）；server 在 `runtime/external-ingest.json` 记 `<source>:<externalKey> → taskKey`，命中且任务包还在 → 返回 `existed:true` + 原 taskKey，不新建。
- **默认桶**：外部 API 缺省 `plan:true`（与现有 /api/task/create 缺省 queued 相反）——契合"外部推入的活先人工确认"。
- **生产切换风险**：用户真实桌面端（8799）跑的是旧代码，PR 合入后需重启桌面端才有新 API；baibu-agent 的 chat-watch 每 15s 被旧看板调度器 fork（改 .mjs 立即生效）。切换时序在 Phase B 现场按 ground truth 处理（先停 chat-watch → 改 → 验证 → 配置真实 key → 恢复）。
- 2026-07-17 从 origin/master 4277956 开 worktree `worktree-external-task-api`。

## sub goal matrix

| # | sub goal | 交付物 | 状态 |
|---|---|---|---|
| G1 | 摸底 + 方案落档 | plan.md / goal.md | done |
| G2 | API key 模块 + 管理端点 | platform/lib/api-keys.js + server.js 路由 | done |
| G3 | 外部任务 API（create/status + 去重） | platform/lib/external-ingest.js + server.js 路由 + createTask externalKey 透传 | done |
| G4 | 「API 密钥」菜单页 | index.html + app.js | done |
| G5 | 文档同步 | docs/api/task-ingest.md 增外部 API 契约 | done |
| G6 | 隔离环境实跑验证（matrix 全绿）+ PR | matrix.csv / round-N.md / PR | done（30/30 全绿，PR #59 OPEN） |
| G7 | baibu-agent 派发器对接（chat-watch / issue-watch） | 两个 .mjs 改造 + scrumws-ingest.json 配置 + 实跑验证 | pending |

## sub goal 进展

- 2026-07-17 G1 done：两路探索（桌面端架构 / baibu-agent 派发链）完成，方案落 plan.md。
- 2026-07-17 G2–G5 done：api-keys.js / external-ingest.js / server.js 6 条路由 / createTask externalKey 透传 / UI 页 / 文档全部落码。
- 2026-07-17 G6 done：round-1 全绿（API 24/24 + 看板集成 S1 + UI 冒烟 5/5，见 round-1.md）；PR #59 https://github.com/zzusp/scrumws-desktop/pull/59（gh 确认 OPEN）。
- 2026-07-17 G7 开工：先取 ground truth（旧看板 8788 是否在跑 / chat-watch 调度状态 / 真实桌面端 8799 跑的是哪份代码），再定切换时序。
