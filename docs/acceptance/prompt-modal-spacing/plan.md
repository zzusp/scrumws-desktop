# 仅一个 textarea 的弹窗（customPrompt）间距过大

## 症状

「编辑任务描述」弹窗里标题、小标题、textarea、提示行、按钮之间的间距明显过大，整卡被撑空。

实测（`scripts/shot-prompt-modal.mjs`，Edge headless @2x）：标题↓小字 **53px**、小字↓textarea **53px**、卡片总高 **350px**。

## 根因

不是"间距值设大了"，是**渲染出了真空行**。

`.confirm-body` 带 `white-space:pre-wrap`（`platform/public/index.html:636`），
而 `customPrompt` 用缩进过的模板字面量拼 innerHTML（`platform/public/app.js:677`）。
pre-wrap 下模板里的 `\n      ` 是**真空白**：换行本身撑一个行盒（12.5px × 1.7 ≈ 21px），
剩下的缩进空格因为下一个元素是块级、又单独形成一个匿名块行盒（≈21px）。
叠上 margin 10px → `21 + 21 + 10 ≈ 52px`，与实测 53px 吻合。

**再往下一层，源头是 `.confirm-body` 被塞了两个互相矛盾的职责：**

| 职责 | 内容来源 | 需要的 white-space |
| --- | --- | --- |
| (a) 渲染 HTML 结构 | 作者在 js 里写的模板 | `normal`（源码换行/缩进必须被忽略） |
| (b) 渲染动态纯文本 | `escapeHtml(e.message)`，后端错误可能带真 `\n` | `pre-wrap`（靠 `\n` 断行） |

`pre-wrap` 是为 (b) 加的，却连坐了 (a)。

## 同根因

`customPrompt` 是共用模板，3 个调用点全中：
`editTaskDesc`(app.js:719) / `renameTaskPrompt`(app.js:990) / rewind 改写(app.js:2122)。

## 修复：把 pre-wrap 下沉，而不是让 customPrompt 逃逸

**方案 A（否决，补丁）**：给 customPrompt 挂 `prompt-body` 类关掉 pre-wrap。
—— 只让一个调用点逃出来，body 仍带 pre-wrap，下一个往里塞 HTML 的人照样踩；
且"挂类 + cleanup 还原"本身是新隐患（忘还原就污染下一个 customConfirm）。

**方案 B（采用，源头）**：让 (a)(b) 各归各位。
- `index.html:636` —— `.confirm-body` **去掉** `white-space:pre-wrap`（它只渲染 HTML 结构）
- `index.html:638` —— 新增 `.confirm-text{white-space:pre-wrap}`（唯一需要它的地方）
- `app.js:618` / `app.js:648` —— `customConfirm` / `customAlert` 把 message 包进 `.confirm-text`

**调用点零改动**：30+ 个 `customAlert`/`customConfirm` 一个都不用动，`\n` 断行能力原样保留。
（先前评估"要改 30+ 调用点"是错的——那是按"全局删 pre-wrap、改用 `<br>`"算的，
 而下沉方案根本不需要动文案。）

副产品：`customPrompt` 里的 `prompt-body` 挂类 + `cleanup()` 还原 className **全部删除**，
模板字面量恢复原来的缩进写法（源头治好了，原写法本就该正常）；
只保留 `.prompt-msg` / `.prompt-hint` / `.prompt-count`（原先散在 js 里的行内样式收进 CSS）。

## 验证

- `scripts/shot-prompt-modal.mjs <out.png>` — 截图 + 量间距
- `scripts/check-confirm-regression.mjs` — 13 条断言，含：
  - **源头证明**：往 body 塞缩进 HTML，与紧凑 HTML **等高**（缩进不再变空行）
  - **负对照**：把 pre-wrap 加回 body，上面那条立刻差 +127px —— 证明断言真能抓到这个 bug，不是碰巧通过
  - **能力没丢**：customConfirm / customAlert 的纯文本 `\n` 仍断行

两个脚本都要求先起 verify server：
`SCRUMWS_PORT=8931 node platform/standalone.js`（避开桌面应用默认的 8799）
