# goal.md — 看板 web → 桌面端 app（scrumws-desktop）

## 总目标（孙鹏 2026-07-11 拍板）

1. 完成看板从 web 到桌面端 app 的整体改造（Electron 方案已获认可）
2. 桌面端 UI 风格按示例项目 [multica-ai/multica](https://github.com/multica-ai/multica) 实现
3. 现有看板功能全部保留（仅「运营洞察」去掉），迁移后功能正常
4. goal.md 为长线任务唯一进度锚，确保不偏离总目标
5. 代码全部落 `D:\project\scrumws-desktop`（孙鹏明确授权的落位）；**不改动** `D:\baibu-agent\dashboard\` 现有代码

## 重大决策

- **D1 桌面壳选型**：Electron + 套壳既有 http server 模式（主进程起 server 只 bind 127.0.0.1，`BrowserWindow.loadURL` 指过去）；托盘常驻（关窗≠退出）、单实例锁、开机自启走 `app.setLoginItemSettings`。2026-07-11 方案孙鹏认可。
- **D2 运行时数据不搬家**：`runtime/`、`scripts/`（worker 链 .ps1）留在 `D:\baibu-agent`，app 通过配置指向；scrumws-desktop 只承载「平台进程宿主 + 平台核 + UI」。理由：目标 3 功能正常优先，worker 链业务逻辑（chat drain / issue verify / quota-block / 单飞租约）久经实战，不动。
- **D3 worker 链保持 .ps1**（功能目标 = Windows 本机）；桌面壳与调度核天然跨平台，spawn 层隔离成 platform adapter，mac 打包留作后续（业务本就绑定本机 dws/pwsh 工具链）。
- **D4 双开防护**：开发/验证期新 app 用**独立端口 + scheduler 默认关闭**（避免与在跑的 8788 旧看板双派发）；正式切换（停旧 schtasks `baibu-dashboard` → 桌面 app 接管）由孙鹏定时机，切换 runbook 单独出（G8）。
- （待定）运营洞察的确切范围以 G1 盘点结果为准，去除清单回填到此处。

## sub goal matrix

> 初版框架，G1/G2 盘点结果回来后回填细化，之后按轮推进。

| # | 子目标 | 验证标准 | 状态 |
|---|--------|----------|------|
| G1 | 现状盘点：现有看板 功能/API/UI 分区/外部依赖/调度机制 全景 | `docs/spec/dashboard-inventory.md` 落档，运营洞察范围圈定 | 进行中 |
| G2 | multica 风格研究：设计 token / 布局 / 组件风格 / 桌面集成模式 | `docs/spec/multica-style-guide.md` 落档 | 进行中 |
| G3 | Electron 骨架：窗口/托盘/单实例/配置体系/独立端口起占位 server | `npm start` 实跑，窗口+托盘出现，占位页可见 | 待启动 |
| G4 | 平台核迁移：server + 进程内调度器 + runner-checker + 全部 API，路径配置化 | 新 app 独立端口实跑，API 逐条与旧版 8788 对拍一致 | 待启动 |
| G5 | UI 重构：multica 风格实现全部页面，去掉运营洞察 | 各功能分区与旧版对齐（运营洞察除外），实操可用 | 待启动 |
| G6 | 功能验收：全用例过 matrix | `matrix.csv` 全绿（调度链用 sandbox runtime 验证，不碰生产 runner-state） | 待启动 |
| G7 | 打包：electron-builder Windows 安装包 + 自启 + 托盘实测 | 安装包在本机实装实跑 | 待启动 |
| G8 | 切换 runbook：停旧起新步骤 + 回滚路径 | `docs/ops/cutover.md`；实际切换由孙鹏拍板执行 | 待启动 |

## 进展记录

- **2026-07-11 R1**：任务启动。multica 已克隆到 `D:\baibu-agent\repos\multica`（3201 files）；两个探索代理并行盘点（现有看板全景 + multica 风格）；项目目录已建 + git init；工具链确认 Node v22.13.0 / npm 10.9.2 / claude CLI 就绪。
