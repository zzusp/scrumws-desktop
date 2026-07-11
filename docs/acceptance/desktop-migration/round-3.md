# round-3 · G5 UI 重构验收 + C12 托盘语义（2026-07-11）

## C15 新 UI 与旧版功能对齐 PASS

实现方式：`index.html` 全量重写（642+/443-），**app.js 零改动**（逻辑层未触碰 = 功能天然等价；写端点层已在 round-2 全量回归）。

证据链（三层，互相独立）：
1. **DOM 契约独立复核**（非代理自查，我方脚本重跑）：80 个 `$('id')` 引用 ID 中 74 个静态保留；6 个"缺失"（confirmPromptInput/modalRename*/modalTitle*/promptCount）核对旧版 index.html 同样不存在——**均为 app.js 动态创建，非回归**。app.js 用到的 17 个 CSS 变量全部有定义（旧名 → multica token 别名）。`.topnav a[data-nav]`、`view-*`、data-theme 机制保留。
2. **实跑截图**（`round-3/` 7 张，1440×900，真实 runtime 数据，8801 只读实例）：board/dispatcher/dashboard/task × 暗色 + board/dispatcher/task 亮色。逐张目检：5 状态列 + done 7 卡 + awaiting 1 卡、派发器 2 卡 + 日志流（2180 行渲染）、任务详情 CC-flow/侧栏/composer 全部真实渲染——JS 报错会导致分区空白，全量渲染即无致命错的旁证。
3. **风格对齐**：oklch 双主题 token（style-guide §1 全值）、侧边栏 shell、ring 卡片、胶囊徽章、lucide 图标、6px 滚动条，与 multica 范式逐项对应。

已知妥协（记录在案，不算回归）：详情页 done 徽章绿（app.js STATE_TAG 硬编码）vs 看板列 done 蓝（新语义色），两处各自内部一致；侧边栏折叠态无截图（headless 不可点击）；authBanner 新样式未实景触发（需 dws 熔断 sentinel）。

## C12 托盘常驻 PASS（核心语义自动化 + 菜单项留人工）

- 关窗前：窗口「小小鹏 · 运行看板」pid=32792
- `CloseMainWindow()`（= 用户点 ✕）后：**进程存活=True、API=200、可见窗口数=0** —— 关窗即隐入托盘、平台继续跑
- 托盘图标双击/菜单「退出」为 GUI 交互无法脚本化，留孙鹏首用时顺手确认

## C10 复测 PASS

本轮两次 Electron 实例退出后本项目 electron 进程数均归 0。
