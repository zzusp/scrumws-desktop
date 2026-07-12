# spec — 去派发器 · 改推送式任务新增（CLI / API）

> 孙鹏 2026-07-12 拍板：去掉轮询派发器，改由不同来源主动调 **CLI / API** 把任务推进来。
> 关键澄清：**新增端点只负责「收到任务 → 按任务信息落到对应桶（plan / queued）」，不 spawn 任何 worker**。
> `.ps1` worker 是 Windows 专属，跨平台目标下新增路径不得再拉起它（见 goal.md D3 —— 执行侧仍为
> `.ps1`，属独立的后续跨平台化，不在本次范围）。

## 需求

1. 删除派发器子系统（轮询 `dws chat` / `gh issue` → 建包 → spawn worker 的那套）。
2. 提供推送式新增任务的 **API + CLI**，供任意来源（chat / issue / feishu / webhook / manual …）新建任务。
3. 新增 = 纯入队：写 `task.json` + `state.json`（state=`plan` 或 `queued`，由任务信息决定），不 spawn、不占 lease。
4. 保留 **Runner Checker**（平台守护，代码明确「不是派发器」）+ 其依赖的进程内 scheduler（此后只剩 checker 一个 job）。

## 现状（poll-based）与改动映射

| 现状组件 | 处置 |
|---|---|
| `lib/dispatchers.js`（注册表 + DISPATCHER_TYPES + create/update/delete） | **删** |
| `templates/chat-watch.mjs` `issue-watch.mjs` | **删**（整个 templates/） |
| `lib/scheduler.js` 的 dispatcher 分支 | **改**：`reload()` 只保留 checker job；措辞去派发器 |
| `lib/jobs/ctx.js` 派发专用件（spawnWorker / dwsAuthGate / spawnLoop / addSpawnRecord / spawnLoopAlert / notifyOwner / stopZombieWorker） | **删这些函数**；保留 checker 用到的（exec / readJson / writeJson / quotaBlockActive / recheckAuthBlock / listDirs 等） |
| `lib/jobs/run-job.js` | **留**（checker 仍经它 fork）；注释去派发器 |
| `server.js` `/api/dispatcher/*` `/api/twin/*` | **删**；`/api/checker/*` 保留 |
| `server.js` `/api/task/create` | **改**：接受 `source` 字段，转调新的 `createTask`（入队式） |
| `lib/collect.js` `dispatchers` / `dispatcherTypes` 字段 | **删**；`checker` 卡 + `scheduler.mode` 保留 |
| `lib/paths.js` `dispatchChatLog` / `dispatchIssueLog` | **删**（仅派发器 + readLogs 用）；`authBlk` / `quotaBlk` 保留（checker 用） |
| `lib/logs.js` `readLogs` 读 dispatch-chat/issue 日志 | **改**：只留 runner-checker 日志（dispatch 日志此后不再产出） |
| `lib/runner-config.js` `setPauseInvestigation` + `/api/runner/pause|resume` | **删**（pause 只 gate 派发/spawn，入队式下无意义） |
| UI：派发器页 `#view-dispatcher` + 导航 + 新建/编辑 modal + 运行日志面板 + 全体启停 + 暂停派发开关 | **删** |
| UI：新建任务 modal（已 POST `/api/task/create`） | **留**，behavior 变为入队式（source=manual） |
| `lib/task-actions.js` `createManualTask`（当前 spawn manual-worker.ps1） | **改** → `createTask`：任意 source、入队式、不 spawn、不占 lease |
| `lib/task-actions.js` `restartTask` / `replyToTask`（run 侧 spawn `.ps1`） | **不动**（执行侧 = 用户从看板触发；跨平台化属后续，不在本次范围） |

## 新增契约

### API `POST /api/task/create`

body（JSON）：
```
{ "source": "chat|issue|manual|<任意>", "title": "...", "prompt": "...",
  "model": "claude-opus-4-8", "cwd": "/abs/path", "description": "备注",
  "plan": true }
```
- `source` 缺省 `manual`；`slug` = `<yyyyMMddHHmmss>-<rnd>`，`taskKey` = `<source>:<slug>`。
- `title` / `prompt` 必填；`model` 校验白名单，缺省取 `runner-config.defaultModel`。
- `cwd` 可选，给了必须存在且是目录。
- `state` = `plan`（当 `plan:true` 或 `runner-config.planSources` 含该 source）否则 `queued`。
- 返回 `{ ok, taskKey, state }`；**不 spawn、不写 lease**。

### CLI `platform/cli.js`（HTTP 瘦客户端，走运行中的 app）

```
node platform/cli.js create --source chat --title "标题" --prompt "内容" \
  [--model claude-opus-4-8] [--cwd /abs] [--desc 备注] [--plan]
```
- `--prompt -` 从 stdin 读（长文本）；`--json`（或 `--json -`）整体从 stdin 读 JSON body。
- 读 `SCRUMWS_PORT`（缺省 8799）→ POST `http://127.0.0.1:PORT/api/task/create`。
- 打印结果，exit 0=ok / 1=失败。npm 脚本 `npm run task -- create ...` + package.json `bin`。

## 执行侧边界（明确不在本次范围）

- 入队后 `queued` / `plan` 任务如何真正跑起来 = 现有 run 侧（用户在看板点「重新发起 / 确认排队」→ spawn `.ps1` worker），本次**不动**。
- 因此本次交付后：经 CLI/API 或看板新建的任务只会**入队**，不会自动执行；跑起来仍靠人工触发（Windows `.ps1`）。跨平台执行 runner 属独立后续任务。

## 验证

- `node platform/standalone.js` 起服务（scheduler=running 且 jobs 只剩 `runner-checker`）。
- `curl` / CLI 各建一个 chat / manual 任务 → `/api/state` 的 lifecycle.queued（或 plan）出现该卡、无 lease、无 worker 进程。
- 看板新建任务按钮建的任务落 queued、不自动跑。
- 页面无派发器入口、无残留 `/api/dispatcher` 调用报错。

## 已实施 + 验证结果（2026-07-12）

**改动文件**：删 `lib/dispatchers.js` + `templates/`（3 文件）；新增 `lib/jobs/checker-meta.js`（CHECKER 元信息从 dispatchers.js 拆出）+ `platform/cli.js`（CLI）；改 `server.js` / `lib/task-actions.js`(`createManualTask`→`createTask`) / `lib/collect.js` / `lib/scheduler.js` / `lib/jobs/{ctx,run-job,runner-checker}.js` / `lib/{logs,paths,runner-config}.js` / `public/{index.html,app.js}` / `electron/{config,main,tray}.js` / `package.json`。

**沙盒实跑（SCRUMWS_DATA_ROOT=临时根）证据**：
- `node --check` 全部改动文件通过。
- scheduler 起动日志 `jobs=runner-checker`（仅此一个 job）；checker tick 实跑 `扫描 0 个任务包，孤儿 0 个`，`/api/state` 的 `checker.ticks=1 / lastOutcome=ok / lastError=null`。
- CLI `create --source chat …` → `✓ 已入队 chat:<slug>（state=queued）`；`--source feishu --plan` → `state=plan`。磁盘任务包仅 `task.json`+`state.json`，**无 lease.json**，history `by:create:<source>`。
- `/api/state` 无 `dispatchers` / `dispatcherTypes` 字段；有 `checker` / `scheduler` / `lifecycle`。
- 已删端点 `/api/logs`、`/api/dispatcher/create`、`/api/twin/start`、`/api/runner/pause` 均 404 `unknown api`；保留端点 `/api/state`、`/api/task/cwds` 200；静态 `index.html`/`app.js` 200。
- 前端静态核对：app.js 55 处 `$(id)` 仅 `confirmPromptInput`/`promptCount` 无静态元素（既有动态创建项，非本次回归），派发器/日志/暂停相关 id 与引用两侧均已清零。

**未覆盖 / 盲点**：① Windows 上 `.ps1` run 侧（restart/approve/reply spawn）与 `dws` 授权复查未在 mac 实跑（依赖本机工具链，属既有 D3 范围）；② 未做浏览器内 UI 交互实跑（仅静态 id 核对 + 端点对拍）——建议在 Windows app 内点一次新建任务 + 看板渲染确认。
</content>
