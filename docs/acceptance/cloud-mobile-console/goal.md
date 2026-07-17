# 手机端个人控制台 · goal

## 总目标

机器主人用手机浏览器访问云端 `/m/` 页面，经**云端实时中继**操作自己的本地 app：查看全部任务（含本地手敲的）、新建任务、回复 / 发消息、看准实时输出。数据不落云库；本地闸门默认关。设计与契约见 [`../../spec/cloud-mobile-console.md`](../../spec/cloud-mobile-console.md)。

## 重大决策记录

| 日期 | 决策 | 依据 |
|---|---|---|
| 2026-07-17 | 数据通路 = 云端实时中继（不落云库），排除全量镜像 / VPN 直连 | 用户 AskUserQuestion 确认；与决策 14 一致 |
| 2026-07-17 | `cloudRemoteControl` 默认关，须桌面设置页手动开启 | 用户 AskUserQuestion 确认；fail-closed |
| 2026-07-17 | 下行面沿用绊线修订：公网裸 HTTP 须 `CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1` | 已有用户决策（PR #55） |
| 2026-07-17 | watch v1 = 1.5s 轮询 worker-log 尾巴，逐字流留升级路径 | 简单可靠优先，不碰 server.js SSE 实现 |
| 2026-07-17 | 中继新建任务 `source:'mobile'`，`'cloud'` 前缀留给并行 P2 派活 | 来源只是元数据；避免与并行开发混淆 |

## sub goal matrix

| SG | 内容 | 依赖 | 状态 |
|---|---|---|---|
| SG1 | 契约落档（spec + goal + matrix 骨架） | — | ✅ 本轮完成 |
| SG2 | 云端中继服务端：downlink SSE + rpc pending 表 + `/api/my/*` + watch 转发 + 绊线（新文件 `routes/my.js` / `routes/machine-relay.js` / `relay-registry.js` / `dispatch-gate.js`） | SG1 | ⬜ |
| SG3 | 本地下行：SSE 客户端 + verb 执行器 + 闸门 + watch 轮询器（新文件 `platform/lib/cloud/downlink.js` / `relay-verbs.js`；connector 挂钩 ≤15 行）+ `/api/cloud/remote-config` + 桌面设置页开关/白名单 UI | SG1 | ⬜ |
| SG4 | 手机端页面 `cloud/public/m/`：登录 / 机器 / 看板 / 详情（watch + 消息）/ 新建 + PWA manifest | SG2 契约面 | ⬜ |
| SG5 | 端到端验收 round-1：一次性干净库 + 沙箱 dataRoot，跑 matrix 全部用例 | SG2+SG3+SG4 | ⬜ |
| SG6 | 收口：cloud/README + docs/ops/cloud-deploy.md 补充；PR（ship 三硬线） | SG5 全绿 | ⬜ |

## 关键信息

- **并行开发冲突面**：cloud 端团队派活（P2）正在其他 worktree 进行。本特性的隔离边界见 spec §6——`routes/user.js`/`machine.js`/迁移/对账/connector 主体一律不动，新逻辑全走新文件。合并冲突预期仅 `cloud/src/server.js` 路由注册与 `connector.js` 挂钩两处小点。
- **验证环境**：worktree 不带 `.env` / `node_modules`。cloud 端 `npm install`（fastify/pg）；数据库用一次性干净库（docker 起 postgres → 跑 `001_p0p1_init.sql` → bootstrap → 用完 drop），**不碰共享 dev 库**；本地 app 用沙箱 `SCRUMWS_DATA_ROOT`（不碰 `~/.scrumws`）、空闲端口（不撞 8799/8790）。
- 用户正在跑的真实桌面 app（8799）**严禁碰**。

## sub goal 进展

- 2026-07-17 SG1：现状摸底（本地 SSE/消息注入链路、cloud P0+P1 已合并、决策 14/15/16 与绊线修订）→ 两项架构决策经用户确认 → spec 契约落档。
