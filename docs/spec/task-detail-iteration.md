# 任务详情页迭代（4 项）

一批任务详情页的问题，四项独立。下面每项：症状 → 根因（附 `file:line` 证据）→ 方案。

## 1. 部分任务无法「改写重跑」历史用户消息

**症状**：有的任务详情页历史用户消息能选「⑂ 改写重跑」，有的不能。期望：所有任务都能。

**根因**：
- 按钮门控 `canRewind = !!findTaskInState(modalPollTaskKey)?.cli && m.uuid`（`app.js` renderUserTurn）——只有「被旁观的 CLI 会话」(`t.cli`) 才给按钮。托管任务（manual: / 物化 cli 等，无 `t.cli`）不给。
- 后端 `rewindCliSession`（`cli-actions.js:250`）只从 **watchlist** 按 sid 前缀找会话；托管任务的 sid 在任务包 `meta.sessionId`、不在 watchlist → 会返回 `cli session not in watchlist`。故门控刻意排除了托管任务。
- 另一层障碍：awaiting-human 的托管任务通常仍有存活的 idle Mode B 会话（`getTaskSessionId` 返回它）→ 详情走 **live 模式**（`mbToRounds` 读 `mb.transcript`），而 live 消息不带 `uuid`（stream-json 事件无 uuid）→ 即便放开门控也没 uuid 可截断。

**方案**（统一，不按 source 特判，只按「有无任务包 / 是否观察态会话」这一真实能力差异分支，与现有 reply 的 `isObservedCli` 分支一致）：
1. 种子里保留 uuid：`ccMessagesToModeBSeed`（`logs.js`）给 user 事件补 `uuid: m.uuid`；`mbToRounds`（`app.js`）把 `ev.uuid` 透到消息 → live 模式下**历史(seed)消息**也带 uuid，按钮可现身、可截断。
2. 统一 rewind：新增 `rewindTaskMessage({taskKey,uuid,message})`（`task-actions.js`）：
   - 观察态 CLI（`cli:` 且无任务包）→ 委托 `rewindCliSession`（截断），返回 `hosted:false`，前端走 `adoptCliToLive`。
   - 托管任务（有包）→ 校验非 processing；从 `meta.sessionId` 取 sid；`parkTaskSession`（关掉可能存活的 idle 会话，否则 --resume 复用旧进程、内存里还是**截断前**的全量上下文，rewind 不生效）；按 uuid 截断 jsonl；`replyTask(taskKey, message)` 从截断处 --resume 重跑；返回 `hosted:true`，前端刷 state + 重载详情进 live。
3. `parkTaskSession` 补 `s.taskKey=null`，避免 park 后 `getSessionIdByTaskKey` 仍找到正在关闭的会话、被 `replyTask` 误复用（竞态）。
4. 前端：门控放开为 `m.uuid && (t.cli || t.meta?.sessionId) && !t.isArchive`；`rewindCliMessage`→`rewindMessage`，改打 `/api/task/rewind` 并按 `hosted` 分派重跑。

## 2. 动态时间线改倒叙

**症状**：右侧「动态」state 流转时间线是正序（最早在上）。期望倒叙（最新在上）。

**根因**：`renderTaskSide` 的 `history.map(...)`（`app.js:1669`）按 history 原序（时间升序）渲染。

**方案**：先按时间序算好每条的 `+delta`（=距上一条更早状态的间隔，语义不变），再把渲染项 `reverse()` 后 join → 最新在上。

## 3. CC 返回内容里的超链接应用系统默认浏览器打开

**症状**：详情里 claude 输出的 markdown 超链接点击后在 app 内部打开（把整个窗口导航走 / 开内嵌窗口），而非系统默认浏览器。

**根因**：`electron/main.js` 的 BrowserWindow 没装 `setWindowOpenHandler` / `will-navigate` 拦截。marked 渲染的 `<a href>` 无 target → 点击直接把窗口导航到外链；带 `target="_blank"` 的（如 issue commentUrl）→ 开新 BrowserWindow。都是「app 内部浏览器」。

**方案**：`electron/main.js` 装两处标准拦截 + `shell.openExternal`：
- `setWindowOpenHandler`：http/https/mailto → `shell.openExternal` + `return {action:'deny'}`（拦 target=_blank / window.open）。
- `will-navigate`：目标 origin ≠ 本地 app origin → `preventDefault` + `openExternal`（拦无 target 的整窗导航；hash 路由同源不触发、不受影响）。

## 4. 重开任务丢失部分用户消息（processing 任务 manual:20260715135813-626）

**症状**：用户发的部分消息，重新打开详情时丢失。

**根因**（证据链）：
- 后端 `readWorkerLog('manual:20260715135813-626')` 实跑返回单轮、含**全部 6 条**真人消息（磁盘 jsonl 全在活跃链、无死分支）——静态路径不丢。
- 但 processing / awaiting-idle 任务详情走 **live 模式**（`t.mbSessionId` 存在 → `loadSession` → `mbToRounds` 读 `mb.transcript`），`mb.transcript` 来自后端会话 `s.transcript` 的 SSE 回放。
- `sendUserMessage`（`session-manager.js:199`）把用户消息写进 stdin 但 **不记入 `s.transcript`**——claude stdout stream-json 不回显用户输入。`createSession` 只给**首条** prompt 补了 transcript（`session-manager.js:181-185` 注释明说这个坑），但 `replyTask` 复用 live 会话续轮走 `sendUserMessage`（`task-runner.js:271`）时**没补** → 第 2..N 条用户回复从不进 backend transcript → 重开(SSE 回放)时全丢；只有前端 `mbSend` 乐观回显能瞬时看到，一刷新即消失。

**方案**：`sendUserMessage` 成功写 stdin 后把该 user 消息记入 `s.transcript`（不 emit，避免与前端乐观回显重复；对齐 createSession 首条 push 的做法 + 尊重 TRANSCRIPT_CAP）。随之移除已冗余的补 push：`createSession` 的 `else if(prompt)` push、`task-runner` startTask/replyTask 两处 `seed.push(尾条消息)`——否则首条/续轮消息会重复。所有 sendUserMessage 调用点（首条 prompt / 续轮 reply / leak-retry / session/send）统一记录一次。
