# scrumws-desktop

小小鹏分身运行看板的**桌面端**（Electron）。由 `D:\baibu-agent\dashboard\`（零依赖 node:http web 看板 + 进程内调度平台）迁移而来：平台核逻辑与磁盘契约不变，宿主从「schtasks 拉起的 node 进程 + 浏览器」换成「托盘常驻桌面 app」，UI 按 [multica](https://github.com/multica-ai/multica) 风格重构。

## 结构

```
electron/    # 壳：main（单实例/窗口/托盘/退出语义）、config（userData/config.json + SCRUMWS_* env）、server-host
platform/    # 平台核：server.js（导出 start()）、lib/（聚合/任务动作/交互会话引擎 session-manager + 桥接 task-runner/
             # 守护 Runner Checker）、cli.js（推送式新增瘦客户端）、public/（前端）
docs/        # spec/（盘点+风格指南）、acceptance/（desktop-migration + task-autorun-modeb 等特性验收链）、ops/（切换 runbook）
.sandbox/    # 验证用一次性数据根（gitignore）
```

## 运行

```powershell
npm start                 # 桌面 app（默认端口 8799、dataRoot=D:\baibu-agent、调度器关闭）
npm run start:web         # 无壳 standalone（开发对拍）
npm run dist              # 打包 Windows 安装包（electron-builder）
```

配置优先级：env（`SCRUMWS_PORT` / `SCRUMWS_DATA_ROOT` / `SCRUMWS_SCHEDULER=1`）> `%APPDATA%\scrumws-desktop\config.json` > 默认值。
进程内调度器只跑守护 **Runner Checker**（收孤儿任务）；`runtime/scheduler.lock` 跨进程互斥，多实例只有一个真调度。
任务执行 = **Mode B 交互会话引擎**（`session-manager` 直起 claude stream-json，跨平台）：新建任务进 queued 即自动起会话（详见 `docs/api/task-ingest.md`）。

## 任务来源不变量（改任务处理逻辑前先读）

**`source`（cli / manual / api / …）只是来源元数据，不是行为开关。所有来源的任务共享同一套状态机与处理逻辑——分支按「状态」走，绝不按 source 特判。**

- **为什么**：任务执行的本质是一个可 `--resume` 续接的 claude 会话；哪怕看板手动新建的任务，用户也可能自己开终端 `claude --resume <sid>` 接着跑。来源不改变「它是一个能 plan / 排队 / 处理中 / 待人工 / 完成 / 退回计划 / 编辑 / 归档的任务」——这些能力对所有来源一视同仁。
- **怎么落地**：改 `lib/task-actions.js`（任务动作）、`public/app.js` 的 `cardActionButtons`（按钮门控）、`lib/collect*.js`（聚合出卡）时，按 `state` 分支，不写 `startsWith('cli:')` / `source === 'cli'` / `isCli` 这类来源判断。`source` 只用于展示（角标 / 图标）与入库归类。
- **现状偏差（待收敛，非目标态）**：历史代码仍有多处按来源特判——`moveTaskToPlan` / `completeTask` / `uncompleteTask` 拒绝 `cli:`、`replyToTask` 把 cli 路由到另一条 runner、`app.js` 用 `isCli` 抹掉退回计划 / 中断按钮、`collect-cli.js` 从 watchlist 单独出卡等。这些与本不变量冲突，后续应逐步统一到「按状态、不按来源」。

## Electron 宿主适配（迁移时踩的点，改平台核前先读）

1. **凡 `process.execPath` 的 spawn/execFile 必须带 `ELECTRON_RUN_AS_NODE=1`**（scheduler fork、validateScript --check 已处理）；`run-job.js` 入口会 delete 该变量防扩散到 pwsh/claude 后代
2. **代码资产（run-job/runner-checker）用 `import.meta.dirname` 解析**；`ROOT`（`SCRUMWS_DATA_ROOT`）是数据根，只用于 runtime/ 等数据路径
3. Electron 二进制下载走 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

## 验收与切换

- 验收证据链：`docs/acceptance/desktop-migration/`（goal.md 为进度锚，matrix.csv 为状态总表）
- 上线切换：`docs/ops/cutover.md`（停 schtasks → 桌面 app 接管调度，含回滚路径）
