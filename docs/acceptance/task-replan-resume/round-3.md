# round-3：编辑（退回 plan）任务时日期时间控件「选择后无效」

## 症状

退回 plan 桶的任务编辑时，表单里的定时日期时间控件选日期不生效。

## 根因（真实浏览器复现定位，非纯读码猜测）

picker 逻辑本身没问题——jsdom 隔离测 13/13 全过（选日期 / 改时刻 / 确定都正确写 hidden.value），
提交读 `toLocalStamp(hidden.value)` 也对，后端 `editTask` 持久化 `scheduledAt` 也对。

问题在**布局**：退回 plan 的任务（尤其 worktree 任务）编辑态 modal 更高（多出 worktree 行 + round-2 的锁定提示），
而 `.modal-card` **没有 `max-height` / 滚动**，`.overlay` 又是垂直居中——modal 高于视口时，靠下的「定时」字段
落到视口**外**（不可达）；且 `openPop` 只会**向上**弹，按钮在视口下缘外时 `bottom = innerHeight - btnTop + 6`
算出**负偏移**，把整个日历顶到屏幕下方 → 日格 / 「确定」点不到 =「选择后无效」。

真实浏览器（Edge headless）实测（`scripts/repro-dtpicker-browser.mjs`）：
| 视口高 | 修前 | 现象 |
|---|---|---|
| 1000（高屏） | ✅ 10/10 | modal 适配，弹层在视口内、日格可点 |
| 680 / 620（笔记本） | ❌ | 定时按钮 `btnTop≈860` 在视口外，弹层 `bottom≈854 > vh` 溢出屏下，`elementFromPoint` 命中不到日格 |

## 修复

- **CSS（根因）** `index.html`：`.modal-card` 加 `max-height:calc(100vh - 32px);overflow-y:auto`——高 modal 内部可滚动，
  定时等靠下字段一律可达（提交 / 取消按钮也随之滚入可视）。fixed 弹层不受 `overflow` 裁剪（其包含块是带
  `backdrop-filter` 的 `.overlay`，非 modal-card）。
- **JS（稳健定位）** `app.js openPop`：先显示再量高，按上/下可用空间**择向弹出**，再统一**夹进视口**（`top` clamp 到
  `[8, innerHeight-ph-8]`，`left` 同理）——按钮无论贴上缘还是下缘，弹层都完整可见可点。
- **JS `closestScrollable`**：按**计算样式**找最近可滚动祖先（原来只匹配 inline `overflow-y:auto`，匹配不到 class 定义的
  modal-card 滚动容器）——滚动时正确关闭 / 不让弹层与按钮脱锚。

## 验证（全 PASS）

- 真实浏览器 `repro-dtpicker-browser.mjs`：VH=620 / 680 / 900 各 **10/10 PASS**（滚动到字段 → 打开 → 弹层完整在视口内
  → 真实鼠标点 15 号 → hidden.value / 标签更新到 15 号）。
- jsdom 逻辑 `repro-dtpicker.mjs`：**13/13 PASS**（openPop 改动未回归选值逻辑）。
- 后端逻辑 `verify-logic.mjs`：**21/21 PASS**（未触及，回归确认）。

> 复现脚本依赖（仅本地跑验证用，未入 package.json）：`npm i jsdom puppeteer-core`；浏览器用系统 Edge/Chrome
> （`repro-dtpicker-browser.mjs` 里 executablePath 指向 msedge/chrome）。
</content>
