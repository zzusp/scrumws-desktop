# CLI 看板回复/rewind 修复（stuck 解卡 + adopt guard + init 看门狗 + rewind 迁 Mode B + mbSend 路由）

## 症状
任务 `cli:287cce0d` 卡在 `processing` 但没东西在跑。用户先「改写旧消息」(rewind) 没处理，又在输入框发消息也没处理。

## 根因（均已核验）
1. **卡片钉死 processing**：输入框发消息走 `sendCliContinue`→`/api/session/adopt`→Mode B `createSession(resume)`，但该 session 仍被交互终端 pid 持有，两个 claude 抢同一 session → 收养的 Mode B 拿不到 `system/init` 永久卡 `starting`，`collect-cli` 把 board 的 `starting→processing` → 卡片钉死。（证据：`/api/session/list` 见 zombie 会话 state=starting 13min；`~/.claude/sessions/` 同 sid 两个进程）
2. **rewind 失败**：`cli-actions.js spawnCliReply` 跑 `~/.scrumws/scripts/cli-reply-runner.ps1`，桌面版数据根下无此脚本（脚本只在旧仓库 `D:\baibu-agent\scripts\`；违反 README §宿主适配2「代码资产用 import.meta.dirname」）。证据：`cli-reply-spawn.log` 报 `not recognized as the name of a script file`。
3. **mbSend 误路由**（做 UI e2e 时发现）：CLI 收养的 live 会话 `taskKey=cli:*`，`mbSend` 对「绑定会话」走 `/api/task/reply`→`replyToTask` 的 cli 分支→`replyCliSession`（同款废弃 ps1），且 guard ① 把「本会话自己的 claude」误判成终端占用而拒发 → 收养后第一条（含 rewind 改写消息 / 续接消息）根本发不出去。

## 修复
1. **应急解卡**：`POST /api/session/close?id=<zombie>` 关掉卡 starting 的 Mode B 僵尸会话，卡片回落 `awaiting-human`。
2. **adopt 终端 guard**（`server.js`）：`/api/session/adopt` 前 `readAttachedSessions().get(sessionId)` 命中即 409 拒绝，对齐 replyCli/rewindCli 的 guard ①，从源头堵双 claude 撞车。
3. **init 看门狗**（`session-manager.js`）：`armInitWatchdog`——**发出首条消息后**卡 starting 超 60s 判死 + 杀子进程（`claude -p stream-json` 收到消息前不 emit system/init，空等会话属正常 starting，故只在发消息后武装）。
4. **rewind 迁 Mode B**（`cli-actions.js` + `app.js`）：`rewindCliSession` 只截断 jsonl + 返回 `{sid,cwd}`；前端 `rewindCliMessage` = `/api/cli/rewind`(截断) → `adoptCliToLive`(收养成 live + 改写消息经 live 视图重跑)，去掉 ps1。
5. **mbSend 路由修正**（`app.js`）：`useTaskReply = tk && !tk.startsWith('cli:')`——cli 收养会话直接发 `/api/session/send?id=<mb.id>`（live 会话就是 mb 本身），不再进 replyToTask 的 cli/ps1 分支。

## 验证
- 后端 API e2e（真 claude）：两轮 FIRST/SECOND → rewind SECOND → jsonl 14→11 只剩 FIRST → adopt resume → 发 REWRITTEN → 末条 REWRITTEN、SECOND 消失。
- **前端 UI e2e**（Electron 真 Chromium + 真 claude haiku，`scripts/browser-e2e-rewind.cjs`）：10/10 PASS，见 `round-1.md`。
- adopt guard：held→409、未 held→放行；init 看门狗：发消息卡 starting 60s→error+杀进程，无消息不误杀，正常会话 init 后清除。

## 未做（死代码，留待清理）
`replyCliSession`/`spawnCliReply`（ps1）前端已无路径可达（mbSend 改路由后 `/api/task/reply` 不再收 cli:），是死代码；未来连同 `task-actions.js replyToTask` 的 cli 分支一起删。见 memory `desktop-ps1-runner-broken`。

## 注意
以上代码修复需**重启桌面 app** 生效（解卡是运行期 API 现场做的，已生效）。
