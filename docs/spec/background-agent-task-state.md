# 后台 subagent 识别与任务状态统一

## 症状

用户报告 manual 任务"没结束、主进程让出等后台 subagent、应为 processing"。收集完整信息后厘清两层：

1. **具体任务(373)当前其实没有后台在跑**：其 session(`737089c7`）全程 `Agent`/`Task` 工具调用=0、进程 idle(CPU 不动)、jsonl 静止 → `awaiting-human` 正确，"主进程退出后台在跑"是表象（27900 是 idle 的 `claude -p --resume` Mode B 进程）。
2. **但通用能力缺失且第一版方案用错了信号** —— 见下。

## 关键发现（真实数据 + claude-code-leak）

### CC 后台任务/subagent 的信号（headless 与交互不同）

| 后台类型 | 启动信号 | 完成信号 | 可靠性 |
|---|---|---|---|
| **Agent subagent** | 后台 Agent 的 tool_result 含 `"Async agent launched successfully"` + agentId | 注入的 **user** 消息 `<task-notification>` 带匹配的 `<tool-use-id>` + `<status>completed</status>` | 高：launched−notified 配平 |
| Bash run_in_background | tool_result `"Command running in background with ID: <id>"` | 无自动通知，靠 BashOutput 轮询 `<retrieval_status>`（success≠命令结束） | 低，**不纳入**（纳入会因永不减而永久误报） |

证据：`1076925d`（sdk-cli）启动 3 个 subagent、2 个 task-notification，`JYagVyK3` 未完成=在跑 1 个，与实际吻合；`toolu id === <tool-use-id>` 精确匹配。

### 第一版 pbg 方案为何失效（已推翻）

- `pendingBackgroundAgentCount` 只挂在 `system/turn_duration` 事件上。
- `turn_duration` **只有交互式会话(`entrypoint=cli`)写；headless `claude -p`(`entrypoint=sdk-cli`)不写**（实测 262 个 sdk-cli 会话该事件全为 0）。
- 所有 manual/file/issue/chat 任务都走 task-runner 的 headless Mode B(sdk-cli) → pbg 恒 0，方案对它们完全失效。
- 另：活性判据只认看板 Mode B(`mbSessionId`)也不够——task-runner 的 `claude -p --resume` 会话登记在 CC 注册表 `~/.claude/sessions`，看板重启后 mbSessionId 丢失。

## 方案（在采集/展示层统一叠加"后台 subagent 维度"）

### 数据层（`collect-cli.js`）
`countRunningSubagents(jsonlPath)`：读会话 jsonl，统计当前在跑的后台 subagent 数，对 headless(sdk-cli)+交互(cli) 统一：
- 记录 assistant 真正发起的 `Agent`/`Task` tool_use 的 id（`agentUseIds`）——用于排除本会话在 tool_result 里恰好读到 `"Async agent launched"` 字符串（如读别的 jsonl / 调试打印）的误配。
- 启动：`tool_result`（tool_use_id ∈ agentUseIds）含 `"Async agent launched successfully"` → `launched`。
- 完成：CC 注入的独立 **user** 消息（`content` 为纯 `<task-notification>` 字符串）的 `<tool-use-id>` → `done`（排除 assistant 复述 / tool_result 里读到的通知文本）。
- 在跑 = `launched − done`（去重集合）。
- **不含** Bash run_in_background（完成信号不可靠）。

### 状态判定（`collect.js` `deriveBackgroundState`）
- 卡片统一字段 `backgroundAgentCount`（runner + cli）。
- 覆盖规则：`state==awaiting-human && sessionAlive && backgroundAgentCount>0 → processing`。
- `sessionAlive = mbSessionId(看板 Mode B 活会话) ∪ attachedSids(CC 注册表 ~/.claude/sessions 活进程，含 task-runner 的 claude -p --resume)`。
- 会话进程死 → 短路（后台 subagent 是该进程子进程，进程死则必随之结束；避免用陈旧的未配平 launched 误判）。
- `collectOne` 只对"疑似空闲的活会话"读一次 jsonl。

### 渲染层（`app.js`）
- 卡片琥珀「后台×N」徽章（runner/cli 同源 `t.backgroundAgentCount`），cli 分支 + processing 分支。
- 详情「后台 agent: N 个运行中（主进程已让出，等后台完成）」。

## 改动清单
- `collect-cli.js`：`countRunningSubagents`（替换旧 `readBackgroundAgentCount` 的 pbg 逻辑）+ `backgroundAgentCountBySid` + `collectOneCli` 用它。
- `collect.js`：`deriveBackgroundState`（签名 `mbSessionId`→`sessionAlive`）+ `collectOne`/`collectAll` 计算并传 `attachedSids`。
- `app.js`：徽章 / 详情字段（同上版，未变）。
- 不改 `task-runner.js` / `runner-checker.js`。

## 验证（真实数据，全 PASS）
- `countRunningSubagents`：`1076925d`→1（未完成 subagent JYagVyK3）、`737089c7`(373)→0（从无 Agent 调用）。
- 误报修复：`559e848e`（本会话读过别的 jsonl）2→0（agentUseIds 匹配排除字符串污染）。
- 全库反误报：485 个 jsonl 仅 4 个 >0，均为真调 Agent 且中断的会话（抽查 c6c3bdfd：4 启动 0 完成、末事件 last-prompt=中断）；死会话由 sessionAlive 守护兜底不误报。
- `deriveBackgroundState` 6 态：会话活+在跑→processing(bg=1)、373 真无后台→awaiting、会话死短路→awaiting、非 awaiting 不探测。
- 全链路 collectState 19 卡片字段统一；前端徽章渲染。

## 已知局限
- 373 当前无后台在跑 → 仍 awaiting-human（正确）；能力在"headless 任务真启动后台 subagent 且会话活"时生效。
- Bash run_in_background 不纳入（完成信号不可靠）。
- 完整"活会话 + 后台在跑 → processing"的视觉端到端需真实场景触发；已用真函数 + 真实 sid 验证逻辑。
