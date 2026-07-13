# round-1 · rewind 迁 Mode B UI E2E

环境：Electron v43 真 Chromium（offscreen headless）+ 真 claude `haiku-4-5`，`SCRUMWS_DATA_ROOT` 临时沙盒，`PORT=8796`，`http_proxy/https_proxy=127.0.0.1:10808`。
脚本：`scripts/browser-e2e-rewind.cjs`
跑法：`http_proxy=http://127.0.0.1:10808 https_proxy=http://127.0.0.1:10808 PORT=8796 node_modules/.bin/electron docs/acceptance/cli-board-reply-fix/scripts/browser-e2e-rewind.cjs`

造数：主进程 session-manager 起两轮真会话（暗号 BANANA42 / 口令 APPLE_Q→APPLE_A）→ 关进程留 jsonl → 回拨 mtime 过 guard ② → 加 CLI watchlist。
流程：浏览器点开 cli 卡 → 观察态点第 2 轮「⑂ 改写重跑」→ customPrompt 改写成 GRAPE_Q → 截断+收养 → 改写消息经 live 会话 stdin 重跑。

## 结果：10/10 PASS

```
==== CLI rewind 迁 Mode B · UI E2E：10/10 PASS ====
PASS  两轮种子会话拿到真 CC sessionId  — sid=1237608b-...
PASS  看板出现 CLI 卡片  — cli:1237608b
PASS  观察态出现 rewind 按钮（≥2）  — count=2
PASS  rewind 前历史含 APPLE_Q
PASS  rewind 编辑框弹出
PASS  rewind 后进入 live 模式（mb.id）  — #/task/cli%3A1237608b
PASS  live 出现改写后新回复 GRAPE_A（消息真经 live 会话处理，非 ps1）
PASS  live 含改写消息 GRAPE_Q（乐观回显可见）
PASS  APPLE 轮已截断（live 不含 APPLE_Q）
PASS  磁盘 jsonl：user 轮含 GRAPE_Q 且不含 APPLE_Q  — ["...BANANA42...","...GRAPE_Q..."]
```

关键断言「live 出现 GRAPE_A（非 ps1）」专抓 mbSend 把 cli:* 误路由到废弃 ps1 的坑——首跑因 mbSend 未修此项会 FAIL；修 `useTaskReply` 后转 PASS。

注：磁盘 jsonl 断言首跑 9/10 FAIL 是测试自身早读（claude 在一轮 result 才 flush，晚于流式 token），改成轮询等落盘后 10/10。脚本 finally 在 Windows 下因 server 句柄占用清不掉沙盒，靠 start-of-run `rmSync` + 手动兜底清理。
