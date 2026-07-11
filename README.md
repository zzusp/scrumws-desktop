# scrumws-desktop

小小鹏分身运行看板的**桌面端**（Electron）。由 `D:\baibu-agent\dashboard\`（零依赖 node:http web 看板 + 进程内调度平台）迁移而来：平台核逻辑与磁盘契约不变，宿主从「schtasks 拉起的 node 进程 + 浏览器」换成「托盘常驻桌面 app」，UI 按 [multica](https://github.com/multica-ai/multica) 风格重构。

## 结构

```
electron/    # 壳：main（单实例/窗口/托盘/退出语义）、config（userData/config.json + SCRUMWS_* env）、server-host
platform/    # 平台核（自 dashboard/ 迁移）：server.js（导出 start()）、lib/（调度器/聚合/任务与派发器操作）、
             # templates/（派发器场景模板）、public/（前端）
docs/        # spec/（盘点+风格指南）、acceptance/desktop-migration/（goal.md + matrix + round-N）、ops/（切换 runbook）
.sandbox/    # 验证用一次性数据根（gitignore）
```

## 运行

```powershell
npm start                 # 桌面 app（默认端口 8799、dataRoot=D:\baibu-agent、调度器关闭）
npm run start:web         # 无壳 standalone（开发对拍）
npm run dist              # 打包 Windows 安装包（electron-builder）
```

配置优先级：env（`SCRUMWS_PORT` / `SCRUMWS_DATA_ROOT` / `SCRUMWS_SCHEDULER=1`）> `%APPDATA%\scrumws-desktop\config.json` > 默认值。
调度器默认关闭（防与旧 web 看板双派发）；即便开启，`runtime/scheduler.lock` 跨进程互斥兜底。

## Electron 宿主适配（迁移时踩的点，改平台核前先读）

1. **凡 `process.execPath` 的 spawn/execFile 必须带 `ELECTRON_RUN_AS_NODE=1`**（scheduler fork、validateScript --check 已处理）；`run-job.js` 入口会 delete 该变量防扩散到 pwsh/claude 后代
2. **代码资产（run-job/templates/runner-checker）用 `import.meta.dirname` 解析**；`ROOT`（`SCRUMWS_DATA_ROOT`）是数据根，只用于 runtime/、scripts/ 等数据路径
3. Electron 二进制下载走 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

## 验收与切换

- 验收证据链：`docs/acceptance/desktop-migration/`（goal.md 为进度锚，matrix.csv 为状态总表）
- 上线切换：`docs/ops/cutover.md`（停 schtasks → 桌面 app 接管调度，含回滚路径）
