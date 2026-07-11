# round-6 · 看板列对齐 multica board 范式（2026-07-11）

孙鹏提供参考截图 `docs/screenshots/landing-hero.avif`（multica 官网 landing hero 的 Issues 看板实拍），要求按其 UI 风格样式颜色修改。

## C18 看板列 multica board 范式 PASS

### 参考基准（双源交叉）

1. **截图像素采样**（ffmpeg 转 PNG 后 System.Drawing 网格采样取众数）：In Progress 胶囊 `#DBA401`、In Review `#1A802C`、Done `#0371D0`、Backlog/Todo 胶囊底 `#F4F4F6`、In Progress 列底 `#FDFAF1`、Todo 列底 `#FBFBFB`、计数白底小胶囊
2. **multica 源码**（`packages/core/issues/config/status.ts` + `packages/views/issues/components/board-column.tsx`）：列底 = 状态色 5%（backlog/todo = muted 40%）、列容器 rounded-xl p-2 无边框、计数 = `rounded-full bg-background` 白胶囊 + muted 数字；blocked = destructive 系
3. 两源互证：截图采样值恰为 token 原色（--warning ≈ #D9A404 / --success ≈ #1F8A3D / --info ≈ #1570CE），确认实心胶囊 = token 色 + 白字。截图中优先级徽章的橙（#E78431/hue 45）是营销图独立色系、与 token --warning（hue 85）无对应，本看板无优先级语义，不引入

### 改动（仅 index.html，app.js 零改动）

- `.col-card`：去 inset 边框，改状态色浅底——plan/queued = muted 40%，processing = warning 5%，awaiting-human = destructive 5%（multica blocked 同款），done = info 5%
- 列头重构：`col-dot + h3 + tag计数` → **状态胶囊 `.col-pill`**（lucide 风格 12px 内联 SVG 图标 + 状态名；processing/awaiting-human/done 实心状态色白字，plan/queued muted 底描边风）+ **计数白底小胶囊 `.col-count`**（保留 `count-*` ID，app.js 只写 textContent 已核实 `app.js:360`）；去列头底部分隔线
- 图标映射：plan=虚线圈（Backlog 同款）、queued=空心圈（Todo 同款）、processing=时钟、awaiting-human=感叹圈、done=对勾圈

### 验证证据（standalone 8797 实跑 + 渲染像素回采）

- 渲染截图 `round-6/board-multica-columns.png`：5 列浅底 + 胶囊列头全部生效，卡片浮于色底上，计数白胶囊正常显示（done=7）
- **像素级对拍**（对我方渲染截图网格采样 vs 参考图）：
  | 项 | 我方渲染 | 参考图 | 结论 |
  |---|---|---|---|
  | processing 胶囊 | #DCA400 | #DBA401 | ✓ |
  | done 胶囊 | #0072D5 | #0371D0 | ✓ |
  | processing 列底 | #FDFAF2 | #FDFAF1 | ✓ |
  | plan/queued 列底 | #FBFBFB | #FBFBFB | ✓ |
  | 计数胶囊底 | #FFFFFF | 白 | ✓ |
  | awaiting 胶囊 | #E7000B | （参考图无此列，= --destructive，multica blocked 规范） | ✓ |
- 服务日志确认只读实例（scheduler.lock 由旧看板持有），旧 8788 未受影响
