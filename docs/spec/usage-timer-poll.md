# 账号用量改定时拉取（usage timer poll）

## 需求
把所有打 `api.anthropic.com` 的调用改为「后端主动定时、每 5min 一次、间隔可配」，并在运行时面板展示这个定时任务（5h/7d 用量 + 刷新时间）。参考 `docs/tmp/usage.png`（CC CLI 的 Plan usage limits 横条）。

## 现状（改前）
`platform/lib/claude-usage.js` 打两个端点：
- **usage** `GET /api/oauth/usage`：账号 5h/7d 滚动窗。懒加载——前端详情页 5s 轮询 `/api/claude-usage` 触发，后端 60s TTL 缓存节流。
- **models** `GET /v1/models/{id}`：某 model 上下文上限。per-model 按需 + 6h 缓存。

## 决策
- **只把 usage 改定时**；models 是模型静态属性、几乎不变，保持按需 + 6h 缓存（改定时反增打点，且无固定 model 列表可拉）。用户已确认。
- **展示**：运行时面板复用现成 `ccUsageBarHtml`（5h/7d 条 + 距刷新 + 百分比）+ plan 徽章 + 「上次刷新 HH:MM · 每 N min 自动刷新」。
- **配置**：间隔存 `runner-config.json.usagePollSec`（秒，默认 300，夹 [60,3600]），配置入口放设置页（对齐 proxyUrl / 并发 / checker interval）。运行时面板只展示。
- **定时器机制**：进程内轻量 `setInterval`（usage 拉取是幂等 GET async，无需 scheduler 的 fork 子进程重型 job）。仅在 scheduler mode==='running' 的主实例启动（对齐单实例语义，副实例只看不打端点）。

## 改动
1. **claude-usage.js**：
   - 定时器成为**唯一**真打 usage 端点的路径（`tickUsage`）。`getClaudeUsage()` 改纯读缓存 → 打点频率严格 = 间隔。
   - 新增 `startUsageTimer()`（立即拉一次 + 每 N 秒拉）、`reloadUsageTimer()`（间隔热更）、`usageSnapshot()`（供 collectState 拿账号用量 + 定时器实况）、`usagePollSec()`（读配置）。
   - `invalidateClaudeUsage()` 改为：清缓存 + 立即重拉（代理变更立即用新代理）。
2. **collect.js `buildRuntime`**：runtime 增 `claudeUsage`（账号 5h/7d）+ `usagePoll`（间隔/上次/下次/结果）。原 `usage`（任务聚合）语义不同，保留。
3. **server.js**：启动 `scheduler.start()` 后按 mode 启 `startUsageTimer()`；新增 `POST /api/usage-poll/interval`（夹 [60,3600] 秒 → 写配置 + `reloadUsageTimer()`）。`/api/claude-usage` 保留（现返回纯缓存，详情页不改）。
4. **app.js `renderRuntime`**：运行时面板加账号用量块（复用 `ccUsageBarHtml`）+ 上次刷新时间。
5. **index.html**：运行时视图加账号用量 section；设置页加「账号用量刷新」间隔配置卡。

## 验证
- `npm run start:web` 起服务；`curl /api/state` 看 `runtime.claudeUsage` + `runtime.usagePoll`（intervalSec=300、有 lastRunAt/lastOk）。
- 观察日志：端点打点频率 = 5min 一次（前端轮询不再触发额外打点）。
- `POST /api/usage-poll/interval {intervalSec:60}` → 间隔热更、下次 tick 按新值。
- 运行时面板显示 5h/7d 条 + 上次刷新时间。

---

# v2：账号用量卡左右两栏 + 7 天用量柱状图

## 需求
账号用量卡改左右布局：左侧现有 5h/7d 滚动窗条；右侧加 7 天用量柱状图，显示 **CC 全局** 与 **scrumws 平台** 每天用量对比。

## 决策（用户确认）
- **度量**：每天总 token（input+output+cache_creation+cache_read 全算）。
- **形态**：子集覆盖——每天一根全局柱（浅色），scrumws 平台部分深色段叠在柱内（scrumws ⊂ 全局）。

## 数据源
- **CC 全局**：扫 `~/.claude/projects/**/*.jsonl`（131 项目 / 1680 文件 / 530MB）。只读近 7 天 mtime 的文件（实测 90 文件 /109MB / 3.3 万行 / Node 亚秒级）；逐行取 assistant 行的 `timestamp`(按本地日分桶) + `message.usage`(token 合计)。
- **scrumws 平台**：同一次扫描，`sessionId ∈ scrumws 任务 sessionId 集合`（分身任务 meta.sessionId，不含 cli watchlist）的行归入 platform（天然是全局子集）。CC jsonl 无 costUSD，故用 token 不用 cost。

## 改动
- 新增 `platform/lib/daily-usage.js`：`getDailyUsage(sessionIds)` → 近 7 天 `[{date, totalTokens, platformTokens}]`。60s TTL + **后台异步重扫**（对齐 detectClaudeRuntime：读缓存返回、TTL 到点后台扫，绝不阻塞 /api/state 事件循环）。
- `collect.js buildRuntime`：收集所有分身任务 sessionId → `dailyUsage` 字段。
- `app.js`：`ccAccountUsageHtml` 改左右两栏；新增 `dailyUsageChartHtml`（CSS 柱状图，子集覆盖）。
- `index.html`：`.du-*` 柱状图样式。

## 验证
- `curl /api/state` 看 `runtime.dailyUsage`（7 条、totalTokens≥platformTokens）。
- 前端同源验证 `dailyUsageChartHtml` 输出（柱高归一、platform 段占比、图例）。

---

# v3：Chart.js 柱状图 + 全局每日用量表格（7/15/30 切换）

## 需求（用户反馈）
- 账号用量卡：左右两栏**均分**宽度；右侧柱状图**改用第三方图表库**（手绘间距丑）。
- 「用量汇总」卡：从 scrumws 任务聚合的四个 stat 卡片，改为 **CC 全局每日用量表格**（每天一行 + 末行汇总），支持 **最近 7/15/30 天**切换。

## 决策
- **图表库**：Chart.js v4 UMD 单文件（205KB），下载到 `platform/public/chart.umd.min.js`，`<script>` 本地引入（对齐现有 marked.min.js；随 platform 打包，零 npm 依赖不变）。受限网络用 curl 走系统代理下载成功。
- **数据**：daily-usage 扩到 **30 天** + 细分 `{date, input, output, cache, total, platform}`。柱状图取后 7 天（total+platform，子集覆盖）；表格按 tab 取后 7/15/30 天。一次扫描两处复用，前端 tab 切换只 slice 不重新请求。
- **表格**：CC 全局（非 scrumws 子集），列 日期/输入/输出/缓存/总计（token，compact），末行合计。
- **性能**：30 天=1680 文件/530MB，TTL 提到 5min + 后台异步（逐文件 await 让出），首次几秒后走缓存。

## 改动
- `daily-usage.js`：DAYS 7→30、细分列、TTL 60s→5min。
- `collect.js`：dailyUsage 结构随之变（注释）。
- `index.html`：引入 chart.umd.min.js；账号卡左右均分；用量汇总标题改；表格/tab CSS。
- `app.js`：柱状图改 Chart.js（`renderDailyChart` new/destroy 管理实例）；`renderUsageTable` + 7/15/30 tab；移除四个 stat tile 展示。

## 验证
- `curl /api/state` 看 dailyUsage 30 条、细分列、total=input+output+cache。
- Chart.js 在 Electron/Chromium 渲染（截图确认柱状图 + 表格 + tab 切换）。
