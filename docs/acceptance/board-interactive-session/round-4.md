# Round 4 · L1 / S2 每步计时（时间戳差）

日期：2026-07-12。环境：macOS。决策 D5：S2 走**时间戳差**落 L1（非 hooks；hooks 挪 L2）。

## 需求

详情流每个工具行显示**本步耗时**；进行中的轮里未完成的工具显示 **live 跳秒**（"当前执行中步骤时长"）。
不改执行模型、不改用户配置、覆盖所有会话（含真终端起的）。

## 改动

- `platform/lib/logs.js` — `parseCcSession` 给每个 content block 补 `_ts`（所在 jsonl 行的 `timestamp`）。
  CC 把 thinking/text/各 tool_use/tool_result 各写一行，合并同 `message.id` 时按块保留各自时刻，
  这样 `tool_use._ts → tool_result._ts` 可算每步墙钟。
- `platform/public/app.js`
  - `fmtStepDur(ms)`：亚秒精度（`fmtDuration` 到秒会把 20ms 工具显示 0s）→ `20ms / 112ms / 1.4s / 1m 5s`。
  - `tickLiveTimers()`：每秒扫 `.cc-live-timer[data-since]` 刷新（挂到既有 1s tick；跨 SSE 重画存活）。
  - `renderCcTool(c, result, inflight)`：完成 → `· <fmtStepDur>`（dim）；进行中轮未完成 → `· <fmtDuration>`
    live 跳秒（amber）。`inflight` 从 `renderDetailTab`→`renderCcFlow`→`renderCcTool` 透传，
    保证 live 跳秒只在进行中的轮出现（避免历史/截断轮里空转）。

## 验证（8/8 PASS）

`scratchpad/s2-step-test.mjs`：
- **Part A · _ts 端到端**（走真实 `readWorkerLog`，造 tool_use@T0 / tool_result@T1）：
  `tool_use._ts=T0` ✓、`tool_result._ts=T1` ✓、每步耗时 `T1−T0=1430ms` 可算 ✓。
- **Part B · fmtStepDur**（抽 app.js 真实函数 eval）：`20ms / 112ms / 1.4s / 1m 5s / 空` ✓。

**回归**：`_ts` 改到 `parseCcSession`，重跑 S1 SSE E2E → 仍全绿（块级指纹只数块数、块 dedupe 按
type+text+name+input，均不受 `_ts` 影响）。沙盒/进程已清。

## 盲点

- ⚠️ 每步耗时口径 = `tool_use 落盘时刻 → tool_result 落盘时刻`，含"模型等待 + 工具执行"，非纯工具执行时间
  （若要纯执行时间需 hooks，属 L2）。对"看每步花了多久"够用。
- ⚠️ 渲染 + live 跳秒的**视觉**未在真 Electron 目测（HTML 串走查 + node --check 过）；随 S1/S3 一起手动冒烟。
- ⚠️ 一条 assistant 消息含多个 tool_use（并行工具）时各块 `_ts` 为各自行的时刻，正确；但若某并行工具无
  tool_result（异常），进行中轮会对它也挂跳秒——符合"它确实在跑"语义。
