# round-1 · G3 壳 + G4 平台核迁移首轮验证（2026-07-11）

前提：旧看板 8788 正常在跑（全程未受影响）；新实例一律 `DASHBOARD_NO_SCHEDULER=1` 或 config 默认 scheduler 关闭。

| case | 证据 |
|---|---|
| C01 | `node platform/standalone.js` 起 8799；日志「调度器未启动（DASHBOARD_NO_SCHEDULER=1…)」 |
| C02 | new/old keys 完全一致：`authBlock,checker,dispatchers,dispatcherTypes,lifecycle,now,runnerConfig,scheduler`；dispatchers 2/2 |
| C03 | plan 0/0 · processing 0/0 · queued 0/0 · done 7/7 · awaitingHuman 1/1 · archived 9/9 |
| C04 | `/api/logs?hours=2` entries new=549 old=549 |
| C05 | `/api/worker-log?taskKey=chat:self` rounds=8 正常返回 |
| C06 | `GET /api/insights` → 404（已按 D6 去除） |
| C07 | `GET /` → 200，48420 bytes |
| C08 | `npm start`（补装 electron.exe 后）server 0.9s 内 200 |
| C09 | Electron 下 `/api/state.scheduler.mode = disabled-env`；旧看板同期 `running` 不受影响 |
| C10 | Stop-Process 主进程后本项目 electron 进程数=0 |
| C11 | 主窗口 MainWindowTitle=「claude 活儿总览 · 分身 + 本机 CLI」（真实页面已加载） |

## 本轮发现并修复的迁移适配点
1. `scheduler.js` fork 用 `process.execPath`——Electron 宿主下是 electron.exe：spawn env 加 `ELECTRON_RUN_AS_NODE=1`，`run-job.js` 入口即 delete 防扩散到 pwsh/claude 后代
2. `scheduler.js` RUN_JOB、`dispatchers.js` TEMPLATES_DIR/CHECKER.script 原用 `ROOT/dashboard/...` 拼——ROOT 语义已改为数据根，改 `import.meta.dirname` 相对解析（否则会加载**旧看板**的代码）
3. Electron 二进制 npm install 时未真正落盘，首跑触发现场下载卡死——用 `ELECTRON_MIRROR=npmmirror` 跑 `node_modules/electron/install.js` 补装

## 待后续轮
C12 托盘交互（人工）、C13 写端点回归、C14 调度器 sandbox 实跑、C15 新 UI、C16 打包。
