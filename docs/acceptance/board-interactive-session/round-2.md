# Round 2 · L1 / S1 块级近实时 SSE

日期：2026-07-12。环境：macOS，claude 2.1.207（本轮不涉及 claude spawn，纯看板读取侧改造）。

## 需求

详情页对 processing 任务从"每 5s 轮询 `/api/worker-log`"（`app.js:MODAL_POLL_MS`）改为
**SSE + `fs.watch` 块级近实时推送**：in-flight 会话 jsonl 一写新 content block 就推，延迟从 ≤5s
降到亚秒级；不改执行模型（仍是被动读磁盘，Mode A）。

## 改动（file:line 语义）

- `platform/lib/logs.js` — `readWorkerLog` return 补 `state`（`state.json` 里的 state，
  上方 `:392` 早已读出）。SSE 判收敛、前端指纹都要用。
- `platform/server.js`
  - 新增路由 `GET /api/worker-log/stream?taskKey=`。
  - 新增 `startWorkerLogStream(req,res,taskKey)`：SSE 头 + `fs.watch(P.ccProjectDir)` &
    `fs.watch(taskDir)`，变更去抖 200ms → 重跑 `readWorkerLog` → 服务端指纹去重 → 只推真变化；
    **2.5s 兜底轮询**应对 `fs.watch` 在网络盘/Windows 漏事件；`state !== 'processing'` 发 `done` 关闭；
    20s 心跳保活；`req.on('close')` 释放 watcher/timer。
  - 新增 `wlFingerprint`：按 **content block 计数** + 末块文本长度（不是消息条数）。
- `platform/public/app.js`
  - `ensureModalLive`：processing 时开 `EventSource`；无 EventSource / `onerror` → 回落 `startModalPoll`
    5s 轮询；`done` 事件收官同步一次。
  - `applyStreamedWorkerLog`：消息流立即用推送数据渲染（不阻塞），侧栏走轻量 `/api/state`。
  - `modalContentFp`：块级指纹（与服务端对齐），替换原"消息条数"指纹；poll 回落路径同步改用。
  - 路由离开详情页 → `closeModalLive()`（SSE + 兜底轮询都清）。

**关键修复点**：旧指纹 `messages.map(x => x.length)` 只数消息**条数**，会漏"CC 流式把 thinking/text/
各 tool_use 拆成同 `message.id` 多块合并进一条消息"时的**块级增长**——正是块级近实时要显示的东西。
新指纹按 content block 计数。

## 验证（进程内 E2E，全绿）

脚本思路见 `scripts/`（本轮临时 E2E 在 scratchpad，未入库；可再生成配方如下）：进程内 `import server.js`
起 8791，造 `manual:ssetest`（state=processing + alive lease + meta.sessionId + in-flight jsonl），
`http.get` 连 SSE，按时序断言。实跑输出：

```
SSE 连接 status=200 ct=text/event-stream; charset=utf-8
首帧: state=processing rounds=2 hasInflight=true 含"first block"=true
→ 已追加第二个 content block（same message.id）
已收到 data 帧数=2，含"second block"=true
→ 已把 state 翻成 done
收到 done 事件=true；总帧序=message,message(2nd),message(2nd),done
=== PASS: 首帧 + 块级推送 + done 关闭 全部通过 ===
```

- ✅ **S1-sse-firstframe**：200 + `text/event-stream`，首帧含 processing + 既有消息。
- ✅ **S1-sse-block-push**：追加"同 message.id 新 content block"（消息条数不变、块数 1→2）后**推了新帧**，
  含 "second block" —— 证明块级指纹 + `fs.watch` 生效。
- ✅ **S1-sse-done-close**：state 翻 done → 收到 `event: done` 并关闭。
- 副作用已清：无残留进程、sandbox 与 CC 项目目录已删、端口释放。

## 盲点 / 未收敛

- ⚠️ **前端浏览器渲染路径未在真 Electron/浏览器实跑**：`EventSource → applyStreamedWorkerLog →
  renderModalBody` 为**按代码走查 + 语法检查**通过（`node --check` 三文件 OK），SSE 协议帧已服务端
  E2E 证实。建议应用启动后手动开一个 processing 任务详情页冒烟一次（看逐块跟随 + 断网回落）。
- ⚠️ Windows 侧 `fs.watch`（尤其 `D:\` 若为网络盘）可靠性——已加 2.5s 兜底轮询兜底，但未在 Windows 实测。
- 备注：Case B 下同一 session 会同时出现"完成轮 + inflight 轮"（帧序里两个 2nd 帧来源之一），
  为既有 `readWorkerLog` 行为、非本次引入；不影响 SSE 正确性。
