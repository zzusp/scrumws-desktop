# plan · 详情页归一：Mode B 实时会话折进 #/task/（退掉 #/session/）

设计快照见 `docs/spec/unify-task-detail-live-session.md`。用户拍板决策 D-a/D-b/D-c/D-d 见 spec §4。

## 需求

看板发起任务在 processing 时点卡片会跳独立满宽视图 `#/session/<id>`，不符合"任务详情"设计。
根因：Mode B 会话面是先做的独立视图，`task-autorun-modeb` 拍板"会话并入任务"只做成了路由跳转，
没把 live 能力搬进任务详情壳。目标：**一个详情路由 `#/task/<key>`、一个壳子**，内部按任务有无活
Mode B 会话分派 live / 只读；退掉 `#/session/` 独立视图。

## 方案（决策落地）

- **D-a** live 状态并入右侧 `renderTaskSide`（无独立会话头部）。
- **D-b** 去掉「结束会话」按钮，会话生命周期纯由任务态驱动。
- **D-c** 有活会话时处理中可插话 + 打断（去掉旧"处理中禁发"）。
- **D-d** 旧 `#/session/<id>` 重定向到归属任务 `#/task/<taskKey>`。

## 改动（file:line 级）

前端 `platform/public/app.js`：
- `openTaskModal` 恒跳 `#/task/`（去 mbSessionId 分流）。
- `router`：`ROUTE_VIEWS` 去 `session`；`#/session/<id>` → `findTaskKeyBySession` 反查 → 重定向
  `#/task/`（找不到回 `#/board`）；离开详情 detach live SSE。
- `loadTaskDetail`：有 `mbSessionId` → `loadSession`（live）；无 → 原磁盘 jsonl 只读路径（互斥）。
- `loadSession`/`mbRenderBody`/`mbUpdateLive`/`mbSend` 的 DOM 从 `#session*` 重指 `#modalBody`/
  `#modalReplyText`；`mbRenderHead` → `mbSyncLiveHead`（并入 `renderTaskSide` + 同步打断/回复态）。
- `mbRenderBody` 设 `currentModalData`（供侧栏读 live 轮次/token/● 实时）；`mbToRounds` 补 `ccSummary.model`。
- `updateReplyBoxAvailability` 加 live 分支：常开输入 + `#modalReplyInterrupt` 打断 + 发送走 `mbSend`。
- 删 `mbCloseSession` + 旧 `#session*` 持久事件监听；加 `window.mbInterrupt`。
- `sendCliContinue` 透传 taskKey + 收养后 `refreshState` → 落 `#/task/`；新建任务跳 `#/task/<taskKey>`。

前端 `platform/public/index.html`：删 `view-session` 整块 DOM + 死 CSS（sessionBody/session-head/sh-k/sh-v）；
`#modalReplyBody` 工具条加 `#modalReplyInterrupt` 打断按钮（默认隐藏）。

后端（为让收养会话也归 task，退掉最后一个无主会话场景）：
- `session-manager.js` 加 `getSessionIdByTaskKey`（按 taskKey 反查活会话）。
- `task-runner.js` `getTaskSessionId` 加该反查兜底（收养会话未经 bind 注册 registry）。
- `server.js` `/api/session/adopt` 透传 `taskKey` 进 `createSession`。
- `collect.js` cli 循环加 `cli.mbSessionId = getTaskSessionId(cli.taskKey)`（Round 2 发现：原来只有 board
  任务塞 mbSessionId，cli 卡没塞 → 收养后详情进不了 live）。

## 验证

真浏览器 E2E（Electron 真 Chromium + 真 claude haiku）：`scripts/browser-e2e-merge.cjs`，**15/15 PASS**
（见 `round-1.md` / `matrix.csv`）。node --check 全过。改动 5 文件 +118/-94。
