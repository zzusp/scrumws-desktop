# round-1 · 2026-07-16

环境：Edge headless（puppeteer-core 25.3.0，复用主检出 node_modules）+ verify server `SCRUMWS_PORT=8931`（避开桌面应用 8799）。

## C1 间距收紧（`scripts/shot-prompt-modal.mjs`）

照搬 `editTaskDesc()` 的入参调 `customPrompt`，量真实 `getBoundingClientRect` 差值：

| 间距 | before | after |
| --- | --- | --- |
| 标题 ↓ 小字 | 53px | **10px** |
| 小字 ↓ textarea | 53px | **8px** |
| textarea ↓ 提示行 | 34px | **13px** |
| 提示行 ↓ 按钮 | 18px | **14px** |
| 卡片总高 | 350px | **238px** |
| body white-space | pre-wrap | **normal** |

截图：`round-1/before.png` / `round-1/after.png`（对照可见空行消失、卡片收紧）。

## C2–C8 回归（`scripts/check-confirm-regression.mjs`）

```
PASS  prompt 打开时 white-space=normal  (got=normal want=normal)
PASS  prompt 关闭后 className 还原  (got=confirm-body want=confirm-body)
PASS  confirm 拿回 pre-wrap  (got=pre-wrap want=pre-wrap)
PASS  confirm 纯文本 \n 仍断成两行(高度>30)  (got=true want=true)
PASS  重命名任务 标题↓小字 < 20px  (got=true want=true)
PASS  rewind 标题↓小字 < 20px  (got=true want=true)
PASS  长文本 autoGrow 撑高且封顶 320  (got=true want=true)

ALL PASS
```

## 踩坑记录

- **puppeteer 的 `page.evaluate` 会 await 回调返回的 Promise**。写成简写箭头体
  `page.evaluate(() => window.customPrompt({...}))` 会把弹窗 Promise 返回出去，
  而它只在用户交互后 resolve → 脚本直接挂死（无输出、120s 超时）。
  必须用块体 `() => { window.customPrompt({...}); }` 丢弃返回值。脚本里已加 stage 日志 + 90s watchdog 定位这类卡点。
- puppeteer-core 25.3.0 的 ESM 入口是 `lib/puppeteer/puppeteer-core.js`（**没有** `lib/esm/...` 这层）。
- 看板首页有轮询，`goto` 用 `domcontentloaded` 而非 `networkidle2`。
