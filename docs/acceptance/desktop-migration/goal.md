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
- **D5 UI 实现策略**：不换前端技术栈（multica 是 React19+Tailwind4，但其设计 token 集中在单个 tokens.css）——保留 vanilla 零依赖架构，把 multica 的 oklch token / 侧边栏布局 / 组件视觉逐项移植（详见 `docs/spec/multica-style-guide.md`）。理由：目标 3（功能正常）优先，1880 行前端逻辑重写成 React 回归风险不可控；目标 2 的"风格"在 token/布局/组件层实现即忠实。
- **D6 运营洞察去除范围**（G1 盘点确认）：`lib/aggregate.js` 整文件 + `server.js` 路由/import + `index.html:459-471` + `app.js` refreshInsights/router 触发，共 5 处；`lib/psexec.js` 为零引用死代码一并不迁移。

## sub goal matrix

> 初版框架，G1/G2 盘点结果回来后回填细化，之后按轮推进。

| # | 子目标 | 验证标准 | 状态 |
|---|--------|----------|------|
| G1 | 现状盘点：现有看板 功能/API/UI 分区/外部依赖/调度机制 全景 | `docs/spec/dashboard-inventory.md` 落档，运营洞察范围圈定 | ✅ 完成 |
| G2 | multica 风格研究：设计 token / 布局 / 组件风格 / 桌面集成模式 | `docs/spec/multica-style-guide.md` 落档 | ✅ 完成 |
| G3 | Electron 骨架：窗口/托盘/单实例/配置体系/独立端口起占位 server | `npm start` 实跑，窗口+托盘出现，占位页可见 | ✅ 完成（托盘交互项留 C12） |
| G4 | 平台核迁移：server + 进程内调度器 + runner-checker + 全部 API，路径配置化 | 新 app 独立端口实跑，API 逐条与旧版 8788 对拍一致 | ✅ 读端点全对拍通过（写端点/调度实跑留 C13/C14） |
| G5 | UI 重构：multica 风格实现全部页面，去掉运营洞察 | 各功能分区与旧版对齐（运营洞察除外），实操可用 | 待启动 |
| G6 | 功能验收：全用例过 matrix | `matrix.csv` 全绿（调度链用 sandbox runtime 验证，不碰生产 runner-state） | 待启动 |
| G7 | 打包：electron-builder Windows 安装包 + 自启 + 托盘实测 | 安装包在本机实装实跑 | 待启动 |
| G8 | 切换 runbook：停旧起新步骤 + 回滚路径 | `docs/ops/cutover.md`；实际切换由孙鹏拍板执行 | 待启动 |

## 进展记录

- **2026-07-11 R1**：任务启动。multica 已克隆到 `D:\baibu-agent\repos\multica`（3201 files）；两个探索代理并行盘点（现有看板全景 + multica 风格）；项目目录已建 + git init；工具链确认 Node v22.13.0 / npm 10.9.2 / claude CLI 就绪。
- **2026-07-11 R1（续）**：G1/G2 完成并落档 spec 两份；electron 43.1.0 + electron-builder 26.15.3 装毕；G3 壳代码就绪（commit 89750f7）；看板源码已复制到 `platform/`（去 aggregate.js/psexec.js，21 文件）。定下 D5（UI 不换栈移植风格）/ D6（洞察去除范围）。进入 G4 平台核配置化改造。
- **2026-07-11 R2**：G4 迁移完成并首轮实跑验证通过（matrix C01–C11 全 PASS，见 round-1.md）。关键适配：ELECTRON_RUN_AS_NODE fork 修正、代码资产路径与数据根解耦（否则会加载旧看板代码）、Electron 二进制镜像补装。旧看板 8788 全程未受影响。进入 G5 UI 重构（multica 风格）。
