# round-2 · 2026-07-16 · 源头治理（pre-wrap 下沉）

round-1 的做法（给 customPrompt 挂 `prompt-body` 类逃出 pre-wrap）被判定为**补丁**：
body 仍带 pre-wrap，下一个往里塞 HTML 的人照样踩。本轮改为把 pre-wrap 下沉到 `.confirm-text`。

环境同 round-1：Edge headless + verify server `SCRUMWS_PORT=8931`。

## 间距（`scripts/shot-prompt-modal.mjs`）

| 间距 | before | round-1(补丁) | round-2(根治) |
| --- | --- | --- | --- |
| 标题 ↓ 小字 | 53px | 10px | **10px** |
| 小字 ↓ textarea | 53px | 8px | **8px** |
| textarea ↓ 提示行 | 34px | 13px | **13px** |
| 提示行 ↓ 按钮 | 18px | 14px | **18px** |
| 卡片总高 | 350px | 238px | **242px** |
| body white-space | pre-wrap | normal(靠挂类) | **normal(基类)** |

round-2 比 round-1 高 4px：删掉了 `prompt-body` 的 `margin-bottom:14px` 微调，
用回 `.confirm-body` 默认的 18px —— 那 4px 是 round-1 顺手加的审美加工，非用户诉求，去掉以减少无谓改动。
截图 `round-2/after-root-fix.png`。

## 13 条断言（`scripts/check-confirm-regression.mjs`）

```
PASS  confirmBody white-space=normal（基类就不带 pre-wrap）  (got=normal want=normal)
PASS  customPrompt 不再改 className（无需 cleanup 还原）  (got=confirm-body want=confirm-body)
PASS  标题↓小字 < 20px（模板缩进不再渲染成空行）  (got=true want=true)
PASS  confirm 的 .confirm-text 带 pre-wrap  (got=pre-wrap want=pre-wrap)
PASS  confirm 纯文本 \n 仍断成两行(高度>30)  (got=true want=true)
PASS  alert 的 .confirm-text 带 pre-wrap  (got=pre-wrap want=pre-wrap)
PASS  alert 纯文本 \n 仍断成两行(高度>30)  (got=true want=true)
PASS  缩进对照基线非 0（modal 可见，断言没退化成永真）  (got=true want=true)
PASS  缩进 HTML 与紧凑 HTML 等高（缩进不再变空行，tight=43px）  (got=43 want=43)
PASS  负对照：pre-wrap 一加回来缩进就变空行（+127px，证明断言有效）  (got=true want=true)
PASS  重命名任务 标题↓小字 < 20px  (got=true want=true)
PASS  rewind 标题↓小字 < 20px  (got=true want=true)
PASS  长文本 autoGrow 撑高且封顶 320  (got=true want=true)

ALL PASS
```

**C11 + C12 是本轮的核心证据**：往 body 塞缩进过的多行 HTML 与紧凑写法等高（43px = 43px），
且把 pre-wrap 加回去立刻差 +127px —— 前者证明源头治好，后者证明这条断言真能抓到 bug、不是碰巧通过。

**customPrompt 的模板字面量本轮故意恢复成原来的缩进写法**（round-1 曾改成数组 `join('')` 规避）。
原写法照样正常 = 根因确实在 CSS 而非拼接方式，也说明不需要为此约束将来的写法。

## 踩坑记录

- **C11 初版是假 PASS**：`(got=0 want=0)`。因为在 `Esc` 关掉 modal 之后量，
  `display:none` 下 `getBoundingClientRect().height` 恒为 0，`0 === 0` 永真。
  修法：先开一个 modal 让 body 可见再量，并加 `tight > 0` 基线断言防止再退化成永真。
  教训：等值断言要顺带确认**两边都不是退化值**。
- **puppeteer 的 `page.evaluate` 会 await 回调返回的 Promise**。简写箭头体
  `page.evaluate(() => window.customPrompt({...}))` 会把「用户交互才 resolve」的弹窗 Promise 返回出去
  → 永久挂死（无输出、120s 超时）。必须用块体 `() => { window.customPrompt({...}); }` 丢弃返回值。
  脚本已加 stage 日志 + 90s watchdog 定位这类卡点。
- puppeteer-core 25.3.0 的 ESM 入口是 `lib/puppeteer/puppeteer-core.js`（**没有** `lib/esm/...` 这层）。
- 看板首页有轮询，`goto` 用 `domcontentloaded` 而非 `networkidle2`。
