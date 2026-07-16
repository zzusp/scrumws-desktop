# 仅一个 textarea 的弹窗（customPrompt）间距过大

## 症状

「编辑任务描述」弹窗里标题、小标题、textarea、提示行、按钮之间的间距明显过大，整卡被撑得很空。

实测（`scripts/shot-prompt-modal.mjs`，Edge headless @2x）：

| 间距 | 修复前 | 期望量级 |
| --- | --- | --- |
| 标题 ↓ 小字 | 53px | ~10px |
| 小字 ↓ textarea | 53px | ~8px |
| textarea ↓ 提示行 | 34px | ~7px |
| 提示行 ↓ 按钮 | 18px | ~14px |
| 卡片总高 | 350px | — |

## 根因

`.confirm-body` 带 `white-space:pre-wrap`（`platform/public/index.html:636`），
而 `customPrompt` 用**缩进过的模板字面量**拼 innerHTML（`platform/public/app.js:677`）。
pre-wrap 下模板里的 `\n      ` 是**真空白**：换行本身撑一个行盒（12.5px × 1.7 ≈ 21px），
剩下的缩进空格因为下一个元素是块级、又单独形成一个匿名块行盒（≈21px）。

于是 `21 + 21 + margin 10 ≈ 52px` —— 与实测 53px 吻合，算术对得上，不是估计。

`pre-wrap` 本身是 `customConfirm` 的纯文本 message 要靠它断 `\n`，**不能全局删**。

## 同根因

`customPrompt` 是共用模板，3 个调用点全中：
- `editTaskDesc`（app.js:719）— 用户报的这个
- `renameTaskPrompt`（app.js:990）
- rewind 改写（app.js:2122）

`customConfirm` / `customAlert` 的 message 是单行文本，不受影响。

## 修复

只动 `customPrompt` 这一条路径，不碰 `confirm-body` 基类：

1. `index.html` 加 `.confirm-body.prompt-body{white-space:normal;margin-bottom:14px}`
   + `.prompt-msg` / `.prompt-hint` / `.prompt-count`（原先散在 app.js 里的行内样式）。
2. `app.js` 的 `customPrompt` 给 body 挂 `prompt-body` 类，innerHTML 改用**数组 `join('')`** 拼 ——
   元素间不留空白文本节点，即使将来 `pre-wrap` 回来也不会再渲染空行（两道保险）。
3. `cleanup()` 里把 `body.className` 还原成 `confirm-body`，
   否则 `prompt-body` 会残留、污染下一个 `customConfirm`（与既有的 `card.style.maxWidth` 还原对称）。

## 验证

- `scripts/shot-prompt-modal.mjs <out.png>` — 截图 + 量间距（before/after 见 `round-1/`）
- `scripts/check-confirm-regression.mjs` — 7 条断言，覆盖类还原 / confirm 拿回 pre-wrap / 另两个调用点 / autoGrow

两个脚本都要求先起 verify server：
`SCRUMWS_PORT=8931 node platform/standalone.js`（避开桌面应用默认的 8799）
