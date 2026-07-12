# 取消态任务「继续」续接体验修复

分支 `feature/reply-resume-ux`。任务被用户取消（`awaiting-human`/`outcome=cancelled`）后，在详情页发「继续」重发，暴露两个体验问题。

## 症状

1. 发送的消息不显示；且发送后要过几秒页面才刷新。
2. 有新返回数据后，历史消息不显示了。

## 根因

取消 → `cancelTaskSession`（`task-runner.js:165`）杀 Mode B 会话进程、置 `awaiting-human/cancelled`、删 lease；任务仍留 `meta.sessionId`。
详情无 `mbSessionId` → 读盘 jsonl 只读渲染历史（正常）。composer 走 `canReply` → `sendReply`。

- **症状1** — `sendReply`（`app.js:961`）成功后既不乐观回显用户消息（对比 `mbSend` `app.js:2173` 有回显），又用 `setTimeout(refreshState+loadTaskDetail, 10000)`（旧 `app.js:979`）死等 **10 秒** 才刷新。10 秒内页面冻在旧只读历史、「继续」这条不可见。
- **症状2** — 10 秒后 `loadTaskDetail` 见 `mbSessionId`（reply 已 `--resume` 重挂新 Mode B 会话）→ 进 live 模式。但 `replyTask` 的 resume 分支（旧 `task-runner.js:157`）`createSession({resume, prompt})` **未传 `seedTranscript`**，会话 transcript 只有新一轮；SSE 只回放这一轮 → `mbToRounds`（`app.js:2001`）只渲染新一轮 → **历史全丢**。对比：收养(adopt) 路径 `server.js` 传了 seed 所以历史在，reply 的 resume 路径从没喂过。

## 修复

复用现成 `seedTranscript` 机制（与 adopt 同款），一处根因 + 一处时效：

- **A（后端·根因）** `logs.js` 抽 `ccMessagesToModeBSeed(messages)`（CC 历史消息→Mode B 事件形状），adopt 与 reply 共用避免走样。`task-runner.js` `replyTask` resume 分支：`readCcSessionForAdopt(sid)` 读回历史 → `ccMessagesToModeBSeed` + 追一条 reply 回显作 `seedTranscript`。惠及所有 caller（前端 reply / 会话已死时的 mbSend）。
- **B（前端·时效）** `sendReply`（`app.js`）去掉 10s `setTimeout`，成功后立即 `await refreshState()`（让 `mbSessionId` 现身）+ `loadTaskDetail`（重载进 live），对齐 `sendCliContinue` 即时续接。

改动文件：`platform/lib/logs.js`、`platform/lib/task-runner.js`、`platform/server.js`、`platform/public/app.js`。

## 验证

- **症状2（根因）**：真实驱动 `scripts/verify-resume-seed.mjs`（真 claude 跑一轮→关会话模拟取消→`readCcSessionForAdopt` 读回真 jsonl→seed→resume）。断言 resume 会话 transcript 立即 = 完整历史 + reply 回显（3 条），即 SSE 一连上回放给详情的内容。**PASS**：
  ```
  claudeSessionId: a5909df0-… | round1 消息数: 2
  readCcSessionForAdopt.ok: true | 历史消息数: 2
  resume 会话 transcript 长度: 3 | 含历史 assistant: true | 末条=reply回显"继续": true
  ✅ PASS
  ```
- **症状1（时效）**：纯前端 wiring 改动，未做浏览器 E2E；机制核验——reply 后 `refreshState` 经 `collect.js:105` `getTaskSessionId` 立即暴露 `mbSessionId`（`bind()` 已注册），`loadTaskDetail` 即进 live，用户消息由 A 的后端 seed 保证可见；逻辑与已跑通的 `sendCliContinue` 一致。
