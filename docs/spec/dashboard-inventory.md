# 现有看板功能盘点（迁移基线）

> 来源：2026-07-11 对 `D:\baibu-agent\dashboard\` 的全量只读扫描。本文是 G4 平台核迁移与 G6 功能验收的 checklist 基线。
> 架构：零依赖 `node:http` 看板 + 进程内调度平台，纯 ESM，`node server.js` 起 8788。

## 1. 文件地图（→ 迁移去向）

| 源文件 | 行数 | 职责 | 迁移处置 |
|---|---|---|---|
| `server.js` | 313 | 路由分发/静态服务/日志镜像/scheduler.start | → `platform/server.js`，改导出 `start(config)` |
| `lib/paths.js` | 22 | 单一路径事实源 `P`（ROOT=上两级） | ROOT 改读 `SCRUMWS_DATA_ROOT` env（默认 `D:\baibu-agent`） |
| `lib/timeutil.js` | 26 | 时间工具 | 原样 |
| `lib/lease.js` | 25 | lease 判活（pid + HardTTL 240min） | 原样 |
| `lib/runner-config.js` | 24 | 读写 runner-config.json | 原样 |
| `lib/psexec.js` | 32 | pwsh/python 封装 | **不迁移**（零引用死代码） |
| `lib/collect.js` | 281 | /api/state 主聚合 | 原样 |
| `lib/collect-cli.js` | 319 | CLI 会话卡（反读 CC jsonl） | 原样 |
| `lib/cli-watchlist.js` | 84 | CLI 白名单 CRUD | 原样 |
| `lib/cli-actions.js` | 311 | /api/cli/*（search/add/rewind/reply） | pwsh 路径/硬编码 cwd 配置化 |
| `lib/aggregate.js` | 123 | **运营洞察聚合** | **不迁移**（功能去除） |
| `lib/dispatchers.js` | 231 | 派发器注册表 CRUD + 模板 + CHECKER 定义 | 原样 |
| `lib/logs.js` | 628 | 日志合并 + CC jsonl 解析 | 原样 |
| `lib/task-actions.js` | 366 | manual 任务 create/cancel/reply/restart + spawn worker | pwsh 路径/硬编码 cwd 配置化 |
| `lib/scheduler.js` | 178 | 进程内调度器（interval + fork run-job + 锁） | 原样 |
| `lib/jobs/ctx.js` | 260 | 派发脚本 ctx 判据库 | 原样 |
| `lib/jobs/run-job.js` | 26 | fork 子进程入口 | 原样 |
| `lib/jobs/runner-checker.js` | 120 | 孤儿收纳 job | 原样 |
| `public/index.html` | 670 | 单页 4 视图 + 4 modal + 内联设计系统 | G5 按 multica 风格重构，去运营洞察分区 |
| `public/app.js` | 1880 | 全部前端交互 | G5 保逻辑重样式，去 insights 相关 |
| `public/marked.min.js` | — | markdown 渲染 | 原样 |
| `templates/chat-watch.mjs` | 168 | 盯群派发器模板 | 原样 |
| `templates/issue-watch.mjs` | 348 | issue 派发器模板 | 原样 |

## 2. HTTP API 清单（G4 对拍 + G6 验收基线）

读：`GET /api/state`、`GET /api/logs?hours=`、`GET /api/worker-log?taskKey=`、`GET /api/dispatcher/script?id=`、`GET /api/dispatcher/template?type=`。
~~`GET /api/insights`~~ → **去除**。

写（POST）：
- 派发器：`/api/dispatcher/create|update|delete|start|stop`
- 平台：`/api/checker/start|stop`、`/api/twin/start|stop`、`/api/runner/pause|resume`
- 任务：`/api/task/create|cancel|reply|restart|approve|describe|rename`、`/api/archive`
- CLI 会话：`/api/cli/search|add|rewind|unarchive|remove`

## 3. UI 视图清单（G5 重构范围）

hash 路由 4 视图（`ROUTE_VIEWS=['dispatcher','board','dashboard','task']`）：

1. **顶栏全局**：品牌 + 3 tab + 时钟 + 主题切换 + 「+ CLI 会话」+「+ 新建任务」+ 派发暂停开关 + 自动刷新开关 + dws 授权失效红条（authBlock）
2. **派发器视图**：派发器卡片网格（启停/编辑/删除/新建，脚本表单编辑带模板预填）+ 运行日志（8h，"仅有动作"过滤）
3. **任务看板视图**：5 状态列（plan/queued/processing/awaiting-human/done）+ 已归档折叠区 + 卡片操作（描述/确认排队/中断/归档/CLI 移除）
4. **数据看板视图**：平台守护（Runner Checker 卡，保留）+ ~~运营洞察~~（**去除**）
5. **任务详情视图**：消息时间线 + 三态回复条（reply/restart/rewind）+ 右侧信息栏与状态流转
6. **4 个 modal**：新建任务 / 派发器编辑 / 添加 CLI 会话 / 自定义 confirm

### 运营洞察去除点（5 处）
- `index.html:459-471` insights section；`app.js:1850-1881` refreshInsights + 轮询；`app.js:811` router 触发；`server.js:71` 路由 + `:5` import；`lib/aggregate.js` 整文件。

## 4. 外部依赖点（配置化清单）

- **runtime/**（全部经 `lib/paths.js` 的 `P`）：runner-state、runner-archive、dispatch-chat[.log]、dispatch-issue[.log]、runner-checker.log、quota-block、auth-block、dispatchers.json、dispatchers/、runner-config.json、scheduler.lock、job-*.out.log、cli-watchlist.json、cli-reply-active/、manual-spawn.log、cli-reply-spawn.log、dashboard-server.log、send-verify-failed/
- **scripts/**（pwsh spawn）：reply-runner.ps1、watch-worker.ps1、issue-worker.ps1、manual-worker.ps1、cli-reply-runner.ps1、twin-send.ps1（notifyOwner）
- **~/.claude/**：`projects/D--baibu-agent`（paths.js:21 唯一硬编码编码点）、`projects/*` 动态扫、`sessions/<pid>.json` 判活
- **外部 CLI**：dws（auth status / chat message list）、gh（auth status / issue list/view）、taskkill、pwsh（`C:\Program Files\PowerShell\7[-preview]\pwsh.exe` 硬编码探测）
- **spawn 链**：ctx.js spawnWorker 走 pwsh 中介 `Start-Process -PassThru`（脱 job object）；task-actions/cli-actions 直 spawn .ps1
- **env**：`DASHBOARD_PORT`（默认 8788）、`DASHBOARD_NO_SCHEDULER`（只读实例不抢锁）

## 5. 调度器机制（迁移时不动语义）

- 端口拿到后才 `scheduler.start()`（撞端口的第二实例不碰锁）
- 单实例锁 `runtime/scheduler.lock`（pid 判活抢锁；抢不到 → `disabled-lock` 只读模式）——**跨进程有效，新旧看板天然互斥**
- 每 job 一个 `setInterval`（unref），tick fork `run-job.js`，上一 tick 未退则 skip（IgnoreNew）
- tick 超时 240s `taskkill /PID /F`（不 /T，避免陪葬 detached worker）
- Runner Checker 为内置 job（不进注册表），`runner-config.json.checkerEnabled/checkerIntervalSec`（默认 180s），孤儿 → awaiting-human，不外发通知

## 6. 模型白名单（前后端两处，迁移后保持同步）

`task-actions.js:26-32` ALLOWED_MODELS 与 `app.js` BASE_MODELS / index.html 两个下拉：claude-opus-4-7/4-8、claude-sonnet-5、claude-haiku-4-5-20251001、claude-fable-5。
