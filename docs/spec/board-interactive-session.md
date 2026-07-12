# 把终端交互搬进看板：Board-Owned 交互式 Claude 会话（两模式并存）

> 状态：开工前设计快照（spec，不回头维护）。落地进度与轮次见
> `docs/acceptance/board-interactive-session/goal.md`。

## 0. TL;DR

- **目标**：尽可能把"在终端里对 claude 的操作"搬进看板。采用**两模式并存**：
  - **Mode A 被动观察**（沿用今天）：读 `~/.claude/projects/*.jsonl`，看你在真终端另起的会话。
  - **Mode B 看板持有的交互进程**（新增）：看板 spawn 并常驻持有一个可对话的 claude 进程。
- **关键结论（已在本机 claude 2.1.207 实测，非泄漏源码推断）**：一条**裸 `claude` CLI**
  调用即可让看板拿到全部交互能力，**无需引入任何 npm SDK**——SDK 只是这套 stdio 协议的类型封装。

  ```bash
  claude -p \
    --input-format stream-json --output-format stream-json --verbose \
    --include-partial-messages \
    --permission-prompt-tool stdio \
    [--resume <sessionId>] [--model <m>]
  ```

  权限确认、打断、逐字+实时 token、进行中插话、模型切换、交互式确认，全部经这条
  stdio 上的 stream-json + control 协议实现，且复用你现有的 claude 二进制与鉴权。

## 1. 现状与根因

看板是**被动观察者 + fire-and-forget worker**，这是被迫回终端的根因：

- claude 由外部 pwsh worker 拉起（`platform/lib/task-actions.js:246-249`），看板只读
  `~/.claude/projects/<cwd>/<sid>.jsonl`（`platform/lib/logs.js:346`、`platform/lib/paths.js:22`）。
- 回复 = **重新 spawn 一个 worker 把 claude 跑到收敛**（`reply-runner.ps1`，
  `task-actions.js:186-200`），且 `processing` 中直接拒绝回复（`task-actions.js:154`）。
- 详情页对 processing 任务每 5s 轮询一次（`platform/public/app.js:38` `MODAL_POLL_MS=5000`）。

→ 没有一个"活的、可对话的 claude 进程"，就没有权限回路、没有打断、没有插话、没有逐字。

## 2. 关键技术验证（ground truth）

### 2.1 磁盘 JSONL 的天花板（Mode A 上限）

- 写入按 **content block 整块**，不是逐 token：一条 assistant 消息拆成多行
  （thinking / text / 各 tool_use 各一行），177 字的 text 块**一次整行写入**。
  源码佐证 `claude-code-leak/src/utils/conversationRecovery.ts:192`
  "these occur when streaming yields separate messages per content block"。
- `usage.output_tokens` 在同一消息各行**完全相同**——消息结束才盖的最终总数。
- ⇒ Mode A **做不到逐字、做不到生成中 token 增长**；能做块级近实时 + 每轮 token 总量
  + 靠 `tool_use.ts → tool_result.ts` 时间戳差算每步时长。

### 2.2 stream-json + control 协议（Mode B 能力，实测）

命令（macOS，claude 2.1.207）：

```bash
MSG='{"type":"user","message":{"role":"user","content":"Use the Write tool to create <path> with content: hi"}}'
{ printf '%s\n' "$MSG"; sleep 30; } | claude -p \
  --input-format stream-json --output-format stream-json --verbose \
  --permission-prompt-tool stdio --model claude-haiku-4-5-20251001
```

实测 stdout 事件序列：

```
system/init → assistant(thinking) → assistant(tool_use:Write) → control_request | can_use_tool
```

且目标文件**未被创建**——claude 吐出 `can_use_tool` 后**停下等看板回 `control_response`**。
即：**工具在看板答复授权前不执行**。

配套 ground truth：

- control 协议在 stream-json 的 stdin/stdout 上以 NDJSON 多路复用收发
  （`claude-code-leak/src/cli/structuredIO.ts:442/476/276`）。
- `--permission-prompt-tool stdio` → `structuredIO.createCanUseTool(...)`
  （`src/cli/print.ts:4273-4274`），把每个权限决策抛给 stdin 对端。
- control_request 子类型齐全：`can_use_tool` / `interrupt` / `set_permission_mode` /
  `set_model` / `get_context_usage` / `mcp_status` / `initialize`
  （`src/entrypoints/sdk/controlSchemas.ts:97-183`）。
- 逐字/实时 token：`--include-partial-messages` → `stream_event` 透传
  `content_block_delta`(text_delta) 与 `message_delta`(usage.output_tokens 累加)
  （`src/QueryEngine.ts:788-826`、`src/services/api/claude.ts:1982/2213`）。

### 2.3 本机安装版 flag 核对（claude 2.1.207）

`--include-partial-messages` / `--input-format` / `--output-format` / `--replay-user-messages`
/ `-r,--resume` / `--verbose` 均可见。`--permission-prompt-tool` 不在可见 help（hidden），
但**实测被接受且生效**（见 2.2）。

## 3. 目标架构

```
┌── Electron main（常驻宿主）────────────────────────────────┐
│  SessionManager：进程注册表，管理 N 个 board-owned claude 子进程 │
│    child_process.spawn('claude', [stream-json flags], {cwd})  │
│    ├ stdout(NDJSON) → 解析 → SSE/IPC 推 renderer（逐字渲染）    │
│    └ stdin  ← renderer 动作：user message / control_request /  │
│                              control_response                  │
└───────────────────────────────────────────────────────────┘
        │ 会话历史仍写 ~/.claude/projects/<sid>.jsonl
        ▼
   与 Mode A 完全兼容：同一会话可在两模式间迁移
   （--resume 收养已有会话 / detach 后退回被动观察）
```

- **进程归属**：Electron main 持有并常驻，owner = app 本身（不再 detached fire-and-forget）。
- **传输**：现有 `/api/state`、`/api/worker-log` 轮询保留给 Mode A；Mode B 新增
  SSE 端点（`/api/session/stream?sid=`）推事件，配 `POST /api/session/{send,permit,interrupt}`。
- **会话统一**：Mode B 的 claude 同样落 `~/.claude/projects/*.jsonl`，因此现有 resume /
  rewind（`platform/lib/cli-actions.js`）/ humanCc 提取全部继续可用。

## 4. 终端操作 → 实现映射（逐条）

| 终端操作 | 机制 | 通道 | 验证 |
|---|---|---|---|
| 逐字输出 + 实时 token | `--include-partial-messages` → `stream_event` | stdout | ✅ 实测 |
| 进行中插话（不重启进程） | 往 stdin 写 `{"type":"user",...}` | stdin | ✅ 实测（喂消息） |
| 工具权限确认（允许/拒绝） | `--permission-prompt-tool stdio` → `can_use_tool` ↔ `control_response` | 双向 | ✅ 实测 |
| 打断 / 转向（Esc） | `control_request{subtype:"interrupt"}` + 追加 user message | stdin | 🟡 源码确认，实现时测 |
| 切模型 /model | `control_request{subtype:"set_model"}` | stdin | 🟡 源码确认 |
| 权限模式切换 | `control_request{subtype:"set_permission_mode"}` | stdin | 🟡 源码确认 |
| 交互式选项（AskUserQuestion 等） | 作为 `tool_use` 出现 → 看板渲染选项 → 写 `tool_result` 回 stdin | 双向 | ⚠️ 待验证 host 履约 |
| resume 续接 | `--resume <sid>` | flag | ✅ 实测存在 |
| 每步执行时长 | `tool_use.ts→tool_result.ts` 差 / Hooks PreToolUse-PostToolUse 掐表 | 旁路 | ✅ 实测（时间戳差） |
| 每轮上/下行 token | stdout usage（下行随 `message_delta` 增长；上行 `message_start` 定死） | stdout | ✅ 实测 |

## 5. 与现有基建的调和

- **lease/heartbeat**（`platform/lib/lease.js`）：Mode B 进程由 main 常驻持有，owner 是
  app 本身；lease 语义从"detached pid + 心跳"改为"main 内进程注册表 + 崩溃回收"。Mode A 不变。
- **quota/auth-block**（`platform/lib/jobs/ctx.js`）：claude 会在流里吐 `rate_limit_event` /
  `result` error → 看板据此弹告警并复用现有 quota-block 落盘。**dws 分身鉴权与 claude CLI 的
  交互需确认**（Mode B 是否要 dws auth 前置）。
- **scheduler / pwsh worker**：Mode A 的 push-task 仍走 scheduler + worker；Mode B 是用户即时
  交互、不经 scheduler。二者共存。远期可让 Mode B 取代 pwsh worker（去 Windows 依赖），非本期目标。
- **平台**：Mode B = Node `spawn('claude')`，跨平台。本验证在 macOS；**Windows 待实测**。

## 6. 分层落地路线（按选定优先级）

- **L1 增强（不改执行模型，先落、低风险）**
  - 块级近实时：详情页 5s 轮询 → SSE + `fs.watch` 监听 in-flight jsonl。
  - Hooks 每步精确计时：`PreToolUse`/`PostToolUse` HTTP hook 打到 app 本地端口掐表。
  - 每轮上/下行 token（已有 usage 解析，补展示）。
- **L2 交互化（Mode B 核心，按你的优先级排序）**
  1. 双向流骨架：SessionManager + spawn + stdout NDJSON 解析 + renderer 逐字渲染。
  2. **工具权限确认**（`can_use_tool` ↔ 允许/拒绝 UI）— #1
  3. **进行中打断/转向**（interrupt + 插话）— #2
  4. **逐字 + 实时 token**（partial 渲染 + 输出 token 计数器）— #3
  5. **交互式确认 + AskUserQuestion 类工具履约**（tool_use → 选项 UI → tool_result）— #4/#5
  6. /model 切换、set_permission_mode。
- **L3 统一**：Mode A/B 会话迁移（--resume 收养、detach 退回观察），同一看板视图整合。

## 7. 风险与盲点（诚实标注，不强凑收敛）

- ⚠️ **AskUserQuestion / ExitPlanMode 等交互工具**在 stream-json host 模式下的履约细节**未验证**：
  "tool_use → host 提供 tool_result" 机制成立，但每个工具的具体行为需逐个实测。
- ⚠️ **并发多 board-owned 会话**：stdout 背压、崩溃恢复、孤儿进程回收策略未定。
- ⚠️ **鉴权**：本机 claude 直接跑通 haiku，但生产是 dws 分身鉴权——Mode B 与 dws auth 的
  前置关系需确认。
- ⚠️ **Windows 实测缺失**：全部验证在 macOS 完成。
- ⚠️ **看不到现网 worker 的真实 claude flags**（Windows 数据根 `D:\baibu-agent\scripts\*.ps1`
  本机不可见）——影响 L1 对现状权限姿态的假设，需在 Windows 侧核一次现有调用。

## 8. 开放问题（待你拍板）

- Mode B 交互会话纳入现有 task 卡片列，还是独立"交互会话"视图？
- 权限决策要不要记忆（allow-always 落 settings，减少反复弹窗）？
- L1 与 L2 并行还是串行？（L1 不阻塞 L2，可并行）
