# round-5 · R5 验收反馈三条 UI 修订（2026-07-11）

孙鹏实际使用后的反馈（菜单没问题）：① 去暗色只留亮色；② 按钮 / 悬浮选中配色按 multica；③ 整体色系去 claude 橙对齐 multica。本轮放开 app.js **颜色字面量**修改权限，逻辑仍零改动。

## C17 亮色单主题 + multica 配色对齐 PASS

### 改动清单

**index.html**（token 层 + 交互态样式）：
- head 内联脚本 `data-theme` 硬编码 `'light'`（原按 URL/localStorage 取，默认 dark）
- 删除整个 dark token 块（`:root[data-theme="dark"]`），亮色块收敛为唯一 `:root`；token 值与 multica 源 `packages/ui/styles/tokens.css` light 段逐项一致（--primary 0.21 近黑 / --accent 0.967 浅灰 / --brand 0.55 0.16 255 蓝 / --ring 0.705 / --destructive 0.577 0.245 27.3）
- 新增 `--accent`/`--accent-foreground`（multica ghost/outline 悬浮范式）+ `--brandS`（brand 13% 底）
- 悬浮/选中态统一换 multica 范式：`.topnav a:hover/.active`、`.sb-toggle:hover`、`.btn:hover`、`.cardbtns .btn:hover`、`.reply-model-item:hover/.active` → `background:var(--accent);color:var(--accent-foreground)`；`.btn-primary:hover` → primary/90（对应 multica button `hover:bg-primary/90`）
- 主题按钮隐藏：`.btn.theme-btn{display:none}`（元素保留防 app.js `#themeBtn` addEventListener TypeError；**双类提特异性**——首版单类 `.theme-btn` 被后文同特异性 `.btn{display:inline-flex}` 按顺序反超，按钮实际没藏住，截图抓出后修正）

**app.js**（仅颜色字面量，7 处，逻辑零改动）：
- claude 橙清零：CLI 徽章 ×2、CLI 候选行 `var(--accent)` → `var(--brand)`/`var(--brandS)`（`--accent` 语义已让位 multica 悬浮灰）
- 时间线彩点 TL_DOT 重映射：queued 灰 / processing 琥珀 / done 蓝（原 done=claude 橙）
- 模型菜单 icon/check `--accent`/`--jade` → `--brand`
- 旧暗色系 rgba 字面量 token 化 ×3：失败框 rgba(239,106,106) → `color-mix(--destructive)`、确认排队按钮边 + cc: 高亮 mark rgba(67,201,138) → `color-mix(--success)`

### 验证证据（standalone 8797 只读实例实跑，真实 runtime 数据）

- 服务实跑：`node platform/standalone.js`（SCRUMWS_PORT=8797），输出确认调度器未启动（scheduler.lock 由旧看板 pid=35012 持有，无双派发风险）；`curl /` 200
- 残留扫描：`--soft/--glass/--mask` 等别名在亮色块均有定义（无悬空 var）；`grep 217,119,87 / d97757` 两文件 0 命中；index.html 非中性色字面量 0 命中；app.js 彩色 rgba 字面量清零
- 截图 4 张（`round-5/`，1440×900）逐张目检：
  - `board-light.png`：5 状态列 + 卡片渲染正常；新建任务按钮黑色 primary；CLI 徽章 brand 蓝；侧栏底部主题按钮已隐藏（仅剩派发中/自动刷新两开关）
  - `dispatcher-light.png`：派发器双卡 + 2176 行日志流渲染；chat 徽章蓝、Disabled 徽章红、编辑/删除按钮 outline 范式
  - `dashboard-light.png`：Runner Checker 卡 + Ready 徽章绿
  - `task-detail-light.png`（issue#71 详情）：CC-flow 全量渲染、时间线彩点新映射（queued 灰圈/processing 琥珀/done 蓝）、发送按钮黑色 primary、链接 brand 蓝，全页无橙

已知注记：`applyTheme` 仍会写 `localStorage['dash-theme']='light'`（app.js 逻辑零改动的代价，无害——head 脚本已硬编码不再读它）。
