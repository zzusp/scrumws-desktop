# scrumws-desktop

**ScrumWS 任务看板** · 桌面端（Electron）。本机 Claude Code / Codex 任务的一站式看板：任务从计划（plan）、排队（queued）、执行到人机回环（awaiting-human）/ 完成 / 归档的全状态管理；详情统一只读轮询 provider 官方 JSONL，原 session 空闲时可直接回复续接。外加本机 CLI 会话总览、外部系统 API 接入（API 密钥）与云端控制面上报。托盘常驻，UI 按 [multica](https://github.com/multica-ai/multica) 风格构建。

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
npm start                 # 桌面 app（默认端口 8799、dataRoot=~/.scrumws、调度器开启）
npm run start:web         # 无壳 standalone（开发对拍）
npm run dist:win          # 本地打包 Windows 安装包（electron-builder）
npm run dist:mac          # 打包 macOS dmg/zip（仅在 macOS 上可用）
```

## 发版

多平台安装包（Windows nsis + macOS dmg/zip）走 GitHub Actions 打包发布，本地只 bump 版本 + 打 tag：

```powershell
# 1. 把本次变更写进 CHANGELOG.md 的 [Unreleased] 段落
# 2. 一键发版：finalize changelog + bump 版本 + commit + tag + push（push tag 即触发 CI）
npm run release 0.1.1            # 发版；--dry-run 可先零副作用自检
```

CI 会校验 tag 版本 == package.json 版本、抽 `CHANGELOG.md` 对应段落作 Release 正文、并行打 Win/Mac、draft→正式发布。
完整流程与 macOS 未签名包的运行说明见 [`docs/ops/release.md`](docs/ops/release.md)，版本历史见 [`CHANGELOG.md`](CHANGELOG.md)。

配置优先级：env（`SCRUMWS_PORT` / `SCRUMWS_DATA_ROOT` / `SCRUMWS_SCHEDULER=1`）> `%APPDATA%\scrumws-desktop\config.json` > 默认值。
进程内调度器只跑守护 **Runner Checker**（收孤儿任务）；`runtime/scheduler.lock` 跨进程互斥，多实例只有一个真调度。
任务执行 = **统一会话引擎**：`session-manager` 通过 provider adapter 分别连接 Claude Code stream-json 或 Codex `app-server` JSON-RPC；queued 任务即自动起会话，一轮收敛后释放 provider 进程。新任务在桌面端显式选择 provider，旧任务缺少 `provider` 时按 Claude Code 解释。Codex 使用本机 CLI 登录态，模型可留空以继承 CLI 默认值。

任务详情在 processing / awaiting-human / done 下都从 Claude session JSONL 或 Codex rollout JSONL 还原完整执行记录，不使用 SSE 逐字流。检测到 session 正在 App 外终端中运行时，ScrumWS 保持只读；外部进程退出后，详情回复会由对应 provider adapter 启动一次原生 resume，收敛后释放子进程。执行语义详见 [`docs/api/external-api-guide.md`](docs/api/external-api-guide.md)「提交之后会发生什么」章。

## 外部接入（API 密钥）

外部系统（钉钉派发器、issue 检查器、任意脚本/机器人）可凭 **API 密钥**向桌面端发起/查询任务：在「API 密钥」菜单页生成密钥（绑定 provider + 来源 + 模型/effort/目录白名单 + 直执权限，可编辑/复制），调用方经 `/api/external/*` 接入——支持 `whoami` 自省权限范围、`externalKey` 幂等去重（重试不重复建任务）、来源心跳（页面显示活跃状态）；任务默认落 plan 桶（看板确认后执行），「直执」密钥可 `plan:false` 直接排队执行。

**接入指导（契约 / 步骤 / 多语言示例 / 排错）：[`docs/api/external-api-guide.md`](docs/api/external-api-guide.md)**

## 任务来源不变量（改任务处理逻辑前先读）

**`source`（cli / manual / api / …）只是来源元数据，不是行为开关。所有来源的任务共享同一套状态机与处理逻辑——分支按「状态」走，绝不按 source 特判。**

- **为什么**：任务执行的本质是一个可恢复的 provider 会话（Claude session 或 Codex thread）。来源不改变「它是一个能 plan / 排队 / 处理中 / 待人工 / 完成 / 退回计划 / 编辑 / 归档的任务」——这些能力对所有来源一视同仁。
- **怎么落地**：改 `lib/task-actions.js`（任务动作）、`public/app.js` 的 `cardActionButtons`（按钮门控）、`lib/collect*.js`（聚合出卡）时，按 `state` 分支，不写 `startsWith('cli:')` / `source === 'cli'` / `isCli` 这类来源判断。`source` 只用于展示（角标 / 图标）与入库归类。
- **现状偏差（待收敛，非目标态）**：历史代码仍有多处按来源特判——`moveTaskToPlan` / `completeTask` / `uncompleteTask` 拒绝 `cli:`、`replyToTask` 把 cli 路由到另一条 runner、`app.js` 用 `isCli` 抹掉退回计划 / 中断按钮、`collect-cli.js` 从 watchlist 单独出卡等。这些与本不变量冲突，后续应逐步统一到「按状态、不按来源」。

## Electron 宿主适配（迁移时踩的点，改平台核前先读）

1. **凡 `process.execPath` 的 spawn/execFile 必须带 `ELECTRON_RUN_AS_NODE=1`**（scheduler fork、validateScript --check 已处理）；`run-job.js` 入口会 delete 该变量防扩散到 pwsh/claude 后代
2. **代码资产（run-job/runner-checker）用 `import.meta.dirname` 解析**；`ROOT`（`SCRUMWS_DATA_ROOT`）是数据根，只用于 runtime/ 等数据路径
3. Electron 二进制下载走 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

## 验收与切换

- 验收证据链：`docs/acceptance/desktop-migration/`（goal.md 为进度锚，matrix.csv 为状态总表）
- 上线切换：`docs/ops/cutover.md`（停 schtasks → 桌面 app 接管调度，含回滚路径）
