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
| G7 | baibu-agent 派发器对接（chat-watch / issue-watch） | 两个 .mjs 改造 + scrumws-ingest.json 配置 + 实跑验证 | done（8 场景全绿；round-2 增量：chat→queued、issue→plan、opus-4.8/xhigh、心跳） |
| G7b | per-key 策略 + 心跳（round-2 增量需求） | api-keys/external-ingest/UI/心跳端点 + 派发器打点 | done（32/32 + UI 5/5 + 派发器 e2e 全绿） |
| G8 | 旧看板退役：计划任务直调派发器 + 移除 baibu-dashboard | 注册脚本 + loop 脚本 + schtask 落地 + 实跑验证 | done（chat 15s 节拍 / issue 3min 均实跑开火；8788 与 baibu-dashboard 已删停） |

## sub goal 进展

- 2026-07-17 G1 done：两路探索（桌面端架构 / baibu-agent 派发链）完成，方案落 plan.md。
- 2026-07-17 G2–G5 done：api-keys.js / external-ingest.js / server.js 6 条路由 / createTask externalKey 透传 / UI 页 / 文档全部落码。
- 2026-07-17 G6 done：round-1 全绿（API 24/24 + 看板集成 S1 + UI 冒烟 5/5，见 round-1.md）；PR #59 https://github.com/zzusp/scrumws-desktop/pull/59（gh 确认 OPEN）。
- 2026-07-17 G7 开工：先取 ground truth（旧看板 8788 是否在跑 / chat-watch 调度状态 / 真实桌面端 8799 跑的是哪份代码），再定切换时序。
- 2026-07-17 G7 done：chat-watch / issue-watch 改为 POST 桌面端外部 API（检测判据不变；chat 链带 pending 补投投递保证、issue 链带 legacy seed 防跨系统重复）；隔离环境 8 场景全绿（issue：dry-run/派发/去重/缺席，chat：派发/幂等/宕机捕获/恢复补投）；生产密钥已铸入 ~/.scrumws/runtime/api-keys.json、真实配置 D:\baibu-agent\runtime\scrumws-ingest.json 指向 8799；chat-watch 已恢复 15s 调度（新代码实时 tick 正常）。证据与切换记录：D:\baibu-agent\docs\acceptance\scrumws-ingest-cutover\。
- **待用户动作**：① 合并 PR #59 并让桌面端跑上新代码（重启桌面 app；在此之前 chat 链新 cc: 安全堆在 pending、不丢不重）；② 决定是否启用 issue-watch（`POST http://127.0.0.1:8788/api/dispatcher/start?id=issue-watch` 或旧看板 UI，切换前它就是停的）。
- 2026-07-17 用户增量决策（round-2 落实，全绿）：① 两链默认 model=claude-opus-4-8 + effort=xhigh、cwd=D:\baibu-agent；**chat 直进 queued 自动执行**（cc: 是直接指令）、**issue 保持 plan 确认**；② 密钥支持 per-key 策略白名单（可用模型/effort/可访问目录，空=不限、省略取首项、越界 400）——两把生产钥已补策略（仅 opus-4.8/xhigh/D:\baibu-agent）；③ 来源活跃观测采用**心跳**而非长连接（发起端 fork-per-tick 无宿主持连）：`POST /api/external/heartbeat` 每 tick 打点，「API 密钥」页 lastUsedAt<5min 亮绿点。
- 2026-07-17 用户决策：**旧看板（8788）整体退役**——派发调度改 Windows 计划任务直调 `dashboard/lib/jobs/run-job.js`（dashboard 目录保留作库），删 `baibu-dashboard` 计划任务、停 8788 进程（G8）。
- 2026-07-17 G7b done（PR #60 OPEN https://github.com/zzusp/scrumws-desktop/pull/60；#59 已被用户合并，round-2 提交曾误推已合分支、按硬线另开 #60 续修订）+ G8 done：`baibu-scrumws-chat`（1min，wrapper 4×15s，实测 22:37:47→22:39:02 六连 tick 精准 15s 节拍）/`baibu-scrumws-issue`（3min，22:39:02 正点开火，POST 对旧版桌面端 404 fail-soft 指纹不落）落地；`baibu-dashboard` schtask 删除 + 8788 进程杀停（query 复核 cannot find / 端口无监听）。baibu 侧证据：docs/acceptance/scrumws-ingest-cutover/round-2.md。
- **桌面端 app 现状**：`electron .` 直跑 D:\project\scrumws-desktop 主检出（18:02 启动，代码早于 #59 合并）——**用户需在主仓 `git pull` + 重启 app**，/api/external 才生效，届时 pending 的 chat 批次自动补投、issue 自动重派。
- 2026-07-17 用户修正策略语义（round-3，全绿）：**三项白名单必选，全不选 = 没有权限**——缺项拒建钥、旧格式无策略钥建任务一律 400（须重新生成）；UI 标必选 + 前端拦截 + 旧钥「未配置（无权限）」标识。顺带修出真实 UI bug（.form-err 类 display:none，原 style.display='' 显示失败，三处改 'block'）。生产两把钥带全策略不受影响。
