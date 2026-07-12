# Round 5 · L2 / S4 双向流骨架（SessionManager）

日期：2026-07-12。环境：macOS，claude 2.1.207。**L2 地基**：看板从"被动读文件"迈向"主动持有可对话的 claude 进程"。

## 需求

Mode B 引擎骨架：看板 spawn 并常驻持有一个 claude 交互进程，双向流（stdin 喂消息 / stdout 解析），
证明逐字 + 多轮打通。权限 UI(S5)、打断(S6)、前端渲染(S5) 不在本轮。

## 改动

- **新增 `platform/lib/session-manager.js`**（Mode B 引擎）：
  - `createSession({cwd, model, resume, prompt})`：spawn
    `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
    --permission-prompt-tool stdio [--model][--resume]`；**spawn 前 `delete ELECTRON_RUN_AS_NODE`**
    （README 宿主适配点 1，防扩散到 claude 后代）；cwd/model 校验。
  - stdout 按 NDJSON 逐行解析：`system/init` 抓 CC `session_id` + 置 running；`result` 置 idle；
    `control_request(can_use_tool)` 暂存 `pendingPermissions`（S5 应答）；全事件经 `EventEmitter` 转发。
  - **transcript**（完整消息，有界 2000，超限记 `truncated` 不静默）；逐字 `stream_event` partial 只实时转发不长存（防 delta 撑爆内存）。
  - stdin 原语：`sendUserMessage`（保持 stdin 打开 = 持久多轮）；`respondPermission`（S5）、`interruptSession`（S6）**已就位待接 UI**；`closeSession`（end stdin + 1.5s 后 kill 兜底）。
- **`platform/server.js`**：`/api/session/{create, stream(SSE), send, close, list}`。
  - `startSessionStream`：连上先回放 transcript（settled 完整消息）→ `event: synced` → 实时转发后续事件（含逐字 partial）；心跳保活；断开解订阅。

## 验证（真 claude，全绿）

**引擎 in-process E2E**（`scratchpad/s4-session-e2e.mjs`）**6/6**：
```
拿到 CC session_id（system/init） — 8fdc1ad0-…
逐字 text_delta（partial 流） — "ping"
第 1 轮 assistant 含 pong
双向多轮：第 2 轮 assistant 含 ping        ← 同进程处理第 2 条 stdin 消息、不重启
收到 ≥2 个 result；close 后 state=closed
```

**HTTP 全栈冒烟**（`scratchpad/s4-http-smoke.mjs`）**8/8**：
```
POST /create 返回 id；SSE 200 event-stream；synced 事件；
SSE 逐字 partial 到达前端；完整 assistant 到达；result 到达；
POST /close ok；GET /list 含该会话
```
副作用已清：无孤儿 claude 进程、无 node 遗留、沙盒删、端口释放（`closeSession` 收敛正确）。

## 盲点 / 未收敛（诚实标注）

- ⚠️ **前端 Mode B 会话视图 + 逐字渲染未做** —— 归 S5（权限 UI 天然需要会话视图，一起做）。
- ⚠️ **权限应答 / 打断未验**：`respondPermission`/`interruptSession` 原语写好但未接 UI、未用触发工具的 prompt 实测（S4 用纯文本 prompt 规避权限）。留 S5/S6 验。
- ⚠️ **Windows 二进制解析未验**：`claude.cmd` + `spawn`（无 shell）在 Windows 能否直接拉起，绑 S11c（本验证在 macOS）。
- ⚠️ **会话仅存内存**：server 重启丢会话（`sessions` Map 无持久化）；崩溃恢复、并发上限未处理——骨架阶段可接受，L2 收尾再议。
- ⚠️ 引擎 E2E 直连引擎，未经调度器/lease/quota 那套（Mode A 基建）——两模式基建调和见 spec §5，属后续。
