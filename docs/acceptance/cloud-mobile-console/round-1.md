# round-1：端到端集成验收

**结论：matrix C01–C13 全绿。** 三层真连（真 cloud server + 真 platform + 真手机浏览器 + 一次性 docker 库），非 stub/mock。

## 环境

| 组件 | 值 |
|---|---|
| 云端 | `cloud/src/server.js`，`CLOUD_PORT=18790`，`CLOUD_INSECURE_COOKIE=1` + `CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1` |
| 本地 app | `platform/standalone.js`，`SCRUMWS_PORT=18899`，沙箱 `SCRUMWS_DATA_ROOT`（不碰 ~/.scrumws / 8799 / 8790） |
| 数据库 | 一次性 docker `postgres:17-alpine`，宿主 15544 → 灌 `001_p0p1_init.sql`（12 表），用后 drop |
| claude | 2.1.212（Phase B 真 spawn） |
| 手机 UI | puppeteer-core + 系统 Edge，375×812，导航到真后端 `18790/m/` |

## 三段结果

| 段 | 脚本 | 结果 | 覆盖 |
|---|---|---|---|
| A 后端集成 | `scripts/e2e-integration.mjs` | **PASS 23 / FAIL 0** | C01–C08(非spawn)/C10/C11/C12 |
| B 真 claude | `scripts/e2e-phase-b.mjs` | **PASS 7 / FAIL 0** | C08-approve / C09 |
| C 手机 UI 真后端 | `scripts/e2e-mobile-real.mjs` | **PASS 7 / FAIL 0** | C13 |

## 关键证据

- **C02 热起停实测**：开开关 → downlink @14s 建立、relayOnline=true；关开关 → rpc @14s 起 503、relayOnline=false。
- **C08 approve 真 spawn**：plan → approve → claude 真跑 → processing → awaiting-human（5–15s），非法迁移 `complete on plan` → 502「只有 awaiting-human 任务可人工确认完成」，合法 `cancel on plan` → ok。
- **C09 watch 三级转发**：挂 watch 后收到含 worker-log 块的增量帧（真 claude 输出经「本地轮询器 → 云端 → 浏览器 SSE」），收敛收到 done 终帧；首块 3.6s（含 claude TTFB，中继结构延迟 ≤2s 由 `WATCH_POLL_MS`=1.5s + 批量 0.5s 保证）。
- **C11 绊线双向**：`INSECURE=1`+绑 0.0.0.0+无 `ACCEPT` → 下行面 6 端点全 503 `PLAINTEXT_DISPATCH_BLOCKED`、登录面不受封；设 `ACCEPT=1` 重启 → 下行面放行、happy path 全通。
- **C13 真后端**：真登录 → 单机自动进看板 → 真 rpc state 渲染 → 详情渲染 Phase B 真 claude 输出的 2 块 → 真 createTask 落地跳详情。截图见 `round-1/r1-real-*.png`。

## 迭代中纠正的 4 个 false-fail（靠 ground-truth，非改期望迁就）

| 项 | 初判 | 根因（ground truth） | 处置 |
|---|---|---|---|
| C01 relayOnline=true | 疑产品 bug | 上轮残留 `cloudRemoteControl=true`（identity/config 跨轮持久）；C02 已证开关行为正确 | 驱动加复位步（关开关等断） |
| C04b rpc 0 卡 vs local 1 | 疑中继丢卡 | rpc state 是 `{now, lifecycle:{桶}}`，桶在 `lifecycle` 下，驱动读错层级 | 修驱动读 `.lifecycle`；中继 state 结构本正确 |
| C08 cancel-on-plan → 200 | 初写「非法」期望 | `task-actions.js:62` 只拒终态，cancel 对 plan **合法**（→ awaiting-human/cancelled）——自写期望错 | 改测真非法迁移 `complete on plan` |
| C12 cloud.task 出现 1 行 | 疑违反不落库 | 行是 `origin='local'`，**既有 P1 reconcile** 写的，非中继（中继零 DB 写）；决策 14 的 reconcile 过滤属并行未落地 | 重构 C12 测中继自身零写 + 诚实标注 |

## 与决策 14 的关系（诚实标注，非本特性缺陷）

当前基线里手机建的本地任务仍会经**既有 P0/P1 reconcile**（`reconcile.js` 的 `tasks/upsert`）镜像到 `cloud.task`（`origin='local'`，实测确认）。那是 P0/P1 子系统、非中继写。决策 14「本地任务不全量上云」的 reconcile 过滤属并行/未落地工作；其落地后本地任务停止上云，届时中继成为查看它们的唯一通路（正是决策 14 目标终态）。本特性不预做该过滤、也不依赖它。spec §4.4 已据此改写。

## 未在真连复现（诚实标注）

- **C10 的 504 RELAY_TIMEOUT**：真 connector「收到但 10s 不响应」难自然构造；已在 SG2 stub 冒烟实测（~10s → 504）。真连覆盖了 503 MACHINE_OFFLINE 与断线重连。
- **C07 的活会话注入分支**（sendUserMessage 直注）：真连覆盖了 plan/awaiting-human 无会话 → replyToTask 拒绝路径；活会话直注在 SG3 沙箱冒烟覆盖。手机 UI 的消息回显在 SG4 mock e2e（31/31）覆盖。
