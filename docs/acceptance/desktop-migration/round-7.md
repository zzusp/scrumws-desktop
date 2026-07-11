# round-7 · R7 四项 UI/功能修订（2026-07-11）

孙鹏验收反馈四条：① 顶部导航也按参考图；② 应用名改 ScrumWS；③ 看板页加筛选 + 左上角新建按钮颜色按参考图；④ 归档从看板拆出、独立菜单。本轮 app.js 允许必要功能改动（归档路由），实际仅 3 处小改。

## C19 四项修订 PASS

### 改动清单

1. **应用名 ScrumWS**：`<title>`、侧边栏品牌名、`electron/tray.js` 托盘 tooltip、`electron/main.js` 报错弹窗标题、`package.json` productName（影响 NSIS 安装包名，切换时注意）
2. **顶部导航**：参考图 breadcrumb 范式——`ScrumWS ›（muted）+ 页面名（ink）`；`viewTitle` ID 保留，壳层脚本继续写页面名
3. **看板筛选**：参考图 toolbar outline 按钮风的来源筛选行（全部/dws/issue/manual/CLI）。机制：筛选态挂 `#view-board[data-filter]` 属性 + 卡片 `data-source`（app.js 模板加一个属性）+ CSS 属性选择器隐藏不匹配卡——app.js 15s 周期重渲染不会冲掉筛选态；点击处理在壳层内嵌脚本（视图层，与 app.js 数据流解耦）
4. **新建任务按钮**：去 `btn-primary` 黑底 → 白底描边（参考图左上角 compose 按钮范式）；侧边栏操作按钮补 `background:var(--background)`
5. **归档独立菜单**：侧边栏"运行"组新增"归档"项（lucide archive 图标）；`#archivedSection` 从 `#view-board` 迁至新 `#view-archive`（默认展开 ▾）；app.js `ROUTE_VIEWS` + router 增 `archive` 路由（`count-archived`/`list-archived`/`archivedHeader` ID 全保留，渲染与折叠逻辑零改动）；壳层标题映射增"归档"

### 验证证据（standalone 8797 实跑 + CDP 真实点击驱动）

Edge headless `--remote-debugging-port` + Node 22 内置 WebSocket 走 CDP `Runtime.evaluate` 实点（脚本 `cdp-verify.mjs`），非静态截图：

| 项 | 结果 |
|---|---|
| 面包屑 / 应用名 | crumb-app=ScrumWS、docTitle=ScrumWS、brand=ScrumWS ✓ |
| 新建按钮 | 无 btn-primary，computed bg=oklch(1 0 0) 白底 + input 描边 ✓ |
| 筛选（点击 issue chip） | 7 卡（chat/issue/manual 三源）→ 可见 5、全部 data-source=issue、view 属性/active chip 同步 ✓ |
| 筛选复位（点击全部） | data-filter 移除、7 卡复现 ✓ |
| 归档页（点击菜单） | hash=#/archive、标题=归档、nav 高亮=archive、看板隐藏、列表渲染 10 条且默认展开、#view-board 内不再含 archivedSection ✓ |
| 回看板 | hash/显示恢复 ✓ |

截图：`round-7/board-toolbar.png`（筛选行 + 面包屑 + 白底新建钮 + 归档菜单）、`board-filter-issue.png`（issue 筛选生效）、`archive-page.png`（归档独立页）。

注记：CDP 截图视口 1409px 时 done 列换行（grid auto-fit minmax(215px) 临界），1440+ 正常 5 列，非回归。
