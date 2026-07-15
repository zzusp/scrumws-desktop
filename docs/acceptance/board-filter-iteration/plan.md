# 任务看板迭代：筛选收纳 + 卡片精简 + 文案

## 需求（6 项）
1. 任务来源筛选收进「筛选」按钮，点击弹面板选择；来源选项取自**真实任务的来源**（不写死）。
2. 卡片上半部分只保留：任务标题 + 工作目录 + 最后一次活动时间；其余（状态/耗时/心跳/描述/意图/失败原因）全去掉。底部来源标签 + 操作保留。
3. 加「工作目录」筛选，选项取自真实任务的 cwd。
4. 支持「关键字」「sessionId」筛选。
5. `manual` 来源标签首字母大写为 `Manual`。
6. plan 桶提示「待确认后排队」→「待定」；processing 桶「在跑」→「处理中」。

## 方案与改动

### 后端 `platform/lib/collect.js`
- 新增统一「最近活动」字段：在 `collectAll` 里复用既有 `taskUpdatedMs`（与各桶排序同源）给每个任务打
  `lastActivityMs` / `lastActivityAt` / `lastActivityAgo`（runner 分身与 CLI 会话同字段，跨来源一致）。
  排序改用已算好的 `lastActivityMs`，避免重复计算。

### 前端 `platform/public/app.js`
- `sourceLabel(source)`：来源展示名单一实现（chat→dws、cli→CLI、manual→**Manual**、issue→issue，其余原样）；
  `sourceTagHtml` 兜底分支改用它（req5）。
- `taskCardHtml` 重写：上半部分只渲染 标题 / 工作目录（`.card-sub`）/「最后活动 {lastActivityAgo}」（`.card-status`），
  底部 `.card-foot` 保留来源标签 + 「···」操作（req2）。去掉按 section 分叉的状态行 / 描述行 / 意图 / 失败原因。
- 看板筛选（视图层）：`boardFilter = {source,cwd,keyword,sessionId}` + `matchesBoardFilter(t)`；`renderLifecycle`
  渲染前按谓词过滤各桶（计数随之显可见数）。`updateBoardFilterOptions(lifecycle)` 依真实数据重建来源 chip /
  工作目录 option（选项集不变则不重建 DOM，不打断用户输入），并回落已失效的选择。`initBoardFilter` 绑定
  按钮开合 / chip / select / 输入 / 清除 / 点外关闭。关键字匹配 title+taskKey+description，sessionId 匹配
  meta.sessionId+mbSessionId+taskKey（子串，忽略大小写）。

### 前端 `platform/public/index.html`
- 工具行：5 个写死来源 chip → 「筛选」按钮 + 下拉面板（来源 chips 容器 / 工作目录 select / 关键字 input /
  sessionId input / 清除按钮）+ 激活数徽章。
- CSS：删除旧的 `#view-board[data-filter]` + `.filter-chip` 规则（改 JS 过滤）；新增 `.filter-btn/.filter-panel/
  .fp-*` 面板样式 + `.card-title` 两行截断。
- col-hint 文案：plan「待定」、processing「处理中」（req6）。
- 删除底部内联的旧来源筛选脚本（逻辑迁 app.js）。

## 验证（本地实跑）
- 无第三方依赖，`SCRUMWS_DATA_ROOT` 指向临时数据根，`scripts/seed-tasks.mjs` 塞 4 个合成任务
  （manual/chat/issue × 2 个 cwd × 各自 sessionId），`node platform/standalone.js` 起服务（8790）。
- 后端：`/api/state` 各桶任务带正确 `lastActivityAgo`（4min/3min/1.5h/4h 前），lease 死时正确回退 meta.lastRoundAt。
- 前端：`scripts/verify-ui.mjs`（真实 Chrome）20/20 断言全 PASS——覆盖 req1-6：卡片仅 3 项信息 + 底部保留、
  Manual 大写、桶文案、筛选面板选项取自真实数据、来源/工作目录/关键字/sessionId 各自筛选、计数与徽章联动、清除复位、无 JS 错误。
- 截图见 `round-1/board-cards.png`、`round-1/filter-panel.png`。

## 复现配方
```
SCRUMWS_DATA_ROOT=<tmp> node docs/acceptance/board-filter-iteration/scripts/seed-tasks.mjs
SCRUMWS_DATA_ROOT=<tmp> SCRUMWS_PORT=8790 node platform/standalone.js &
npm install puppeteer-core --no-save --prefer-offline
node docs/acceptance/board-filter-iteration/scripts/verify-ui.mjs   # 24/24 PASS
```

---

## 迭代 2（round-2）：来源 / 工作目录改自定义下拉

### 需求
1. 工作目录筛选的选项面板 UI 优化，参考新建任务表单的工作目录选项处理（自定义下拉，非原生 select）。
2. 来源筛选由 chip 改为下拉框，选项面板与工作目录一致，不用浏览器原生 select。

### 改动
- `index.html`：删 `.fp-chips/.fp-chip` 样式，新增 `.fp-dd*`（触发按钮 + `.fp-dd-menu` 选项面板，对齐新建任务
  `.cwd-menu` 范式：popover / mono 路径 / 截断省略 / hover-accent / 选中 ✓）。HTML 把 `#fpSourceChips`（chips）与
  `#fpCwd`（原生 `<select>`）替换为两个 `.fp-dd`（`fpSourceBtn/fpSourceMenu`、`fpCwdBtn/fpCwdMenu`）。
- `app.js`：新增 `makeFilterDropdown({btnId,menuId,items,getValue,onPick})` 工厂（来源 / 工作目录共用；菜单打开时按
  `items()` 现取、选项永远最新，触发按钮标签随选择更新，点外关闭）。`updateBoardFilterOptions` 只维护
  `boardSources/boardCwds` 数据源 + 回落失效选择；`syncBoardFilterUi` 改走 `srcDD/cwdDD.syncLabel()`；`initBoardFilter`
  建两个下拉、删除旧 chip/select 事件。收筛选面板时一并 `srcDD/cwdDD.close()`。

### 验证
`scripts/verify-ui.mjs` 更新为下拉断言，真实 Chrome **24/24 PASS**（见 `round-2.md`）——含「无原生 select、
选项面板同款 `.fp-dd-menu`」「来源下拉展开/选项取真实数据/触发按钮标签更新」「工作目录下拉选项取真实 cwd」。
截图：`round-1/filter-source-dropdown.png`、`round-1/filter-cwd-dropdown.png`、`round-1/filter-panel.png`。

---

## 迭代 3（round-3）：工作目录筛选纳入 worktree 实际运行目录

### 需求
worktree 任务真正运行在 worktree 目录（`meta.worktreeDir`，如 `<cwd>\.claude\worktrees\<branch>`），不是配置的
工作目录。原筛选/卡片只认配置 `cwd`、漏了 worktree 目录 → 记录两个目录：一个工作目录、一个 worktree 目录。

### 改动（纯前端；后端 `t.worktreeDir` 早已由 collect.js 暴露）
- `app.js`：
  - 卡片 `taskCardHtml`：新增 `cardDirLine(val, tag)`；worktree 任务同时渲染 工作目录 + worktree 两行，各带
    `.card-dir-tag` 标签区分；无 worktree 时工作目录单行不带标签（沿用旧观感）。
  - 筛选：新增 `dirsOf(t)=[cwd, worktreeDir]`；`matchesBoardFilter` 的工作目录命中改为 `dirsOf(t).includes(f.cwd)`
    （配置目录或 worktree 目录任一命中）。`updateBoardFilterOptions` 目录全集改用 `dirMap`（cwd→kind=cwd、
    worktreeDir→kind=worktree），`boardCwds=[{dir,kind}]`；`cwdDropItems` 给 worktree 目录打「worktree」标签。
  - `makeFilterDropdown` render 支持可选 `badge`（`.fp-dd-src`）。
- `index.html`：新增 `.card-dir-tag` 小徽章样式（`.fp-dd-src` 上一轮已加）。

### 验证
`scripts/verify-ui.mjs` 真实 Chrome **28/28 PASS**（见 `round-3.md`）——新增：worktree 卡片同显两目录且带标签、
工作目录下拉含 worktree 目录且带「worktree」标签、**按 worktree 目录可筛出该任务**、按配置目录亦命中。
截图：`round-1/board-cards.png`（worktree 卡片双目录）、`round-1/filter-cwd-dropdown.png`（含 worktree 选项）。
