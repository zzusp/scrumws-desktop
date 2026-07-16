# 后台任务信号统一：Monitor / 后台命令纳入 + 完成通知载体补全

前置：`docs/spec/background-agent-task-state.md`（上一版，只覆盖 Agent subagent）。本文推翻其中两条结论。

## 症状

用户报告：会话起了后台 **Monitor**（`ToolSearch(select:Monitor)`）仍在跑、任务实际 processing，看板却把卡片挪进
了 awaiting 桶。追问范围还包括后台 Bash（`run_in_background`）。

## 上一版的两条结论被真实数据推翻

| 上一版结论 | 真实数据 | 结论 |
|---|---|---|
| Bash `run_in_background` "无自动完成通知，靠 BashOutput 轮询，不可靠 → 不纳入" | 后台命令结束会发终态 `<task-notification>`（带 `<tool-use-id>` + `<status>`），实测 `completed` 98 / `failed` 16 / `killed` 4 条 | **可靠可纳入**（信号与 Agent 同构） |
| 完成通知 = "CC 注入的独立 **user** 消息，content 为纯 `<task-notification>` 字符串" | user/string 只占终态通知约 4 成；`queue-operation/enqueue`(506) 与 `attachment/queued_command`(298) 才是大头 | **旧实现漏读大多数完成通知** |

第 2 条是本轮的关键：`countRunningSubagents` 只认 `type==='user'` + 纯字符串载体，launched 长期配不平 →
看板永久误报。PR#37 的 15min 时间兜底遮的正是这个缺口（其注释归因为"harness 安全中和导致通知不落
jsonl"，实测通知**落了**，只是落在另外两种载体上）。

**全库反证（485 个 jsonl）**：未配平的 launched 条数 —— 只读 user/string(旧口径) **421** → 读全三种载体(新口径)
**124**（消掉 70%）。残余 124 集中在少数历史会话（会话被中断，后台任务随进程死，本就无终态通知），由
`sessionAlive` 短路兜底。

## 关键发现（claude-code-leak + 真实 jsonl 取证）

### 1. 后台任务的启动信号：用 CC 原生落盘的 `toolUseResult`，不抠回执文案

`tool_result` 行的兄弟字段 `toolUseResult` 由 CC 侧写入，命令 stdout 污染不到。三类后台任务签名互斥：

| 工具 | `toolUseResult` 签名 | 样本 |
|---|---|---|
| Agent 后台 subagent | `isAsync: true`（`status: 'async_launched'`） | 41 |
| Bash / PowerShell `run_in_background`（含超预算自动转后台） | `backgroundTaskId: '<id>'` | 485 |
| Monitor（恒后台） | `{ taskId, timeoutMs, persistent }` | 78 |

**为什么不匹配回执文案**（`Command running in background with ID` / `Async agent launched successfully`）：

- 命令自身 stdout 可能原样含该串 → 实测 **10 条误命中**，全是打印过该字符串的脚本输出（本轮探针脚本即
  其一）。旧实现为此专门加了 `agentUseIds` 防污染，用结构化字段后这层防护整个不需要。
- 反向：实测 1 条真后台命令回执文案不匹配（变体文案）但 `backgroundTaskId` 在 → 文案匹配会漏。
- 判据纯净度实测：前台 Bash/PowerShell **13355 条全部无** `backgroundTaskId`；Agent 的
  `isAsync` 与锚定字符串 **41/41 完全一致、零分歧**。

已知边界：subagent transcript（`<sid>/subagents/**/agent-*.jsonl`）不落 `toolUseResult`（实测 9 条只有回执
文案）。本项目不受影响——`locateJsonlBySid`（collect-cli.js:89）只找顶层 `<sid>.jsonl`，从不读 subagents/。

### 2. 完成信号：三种载体 + 必须是终态 status

```
type=user            → message.content（纯字符串）
type=attachment      → attachment.prompt      （attachment.commandMode === 'task-notification'）
type=queue-operation → content                （operation = enqueue / remove）
```

终态 `<status>`：`completed` / `failed` / `killed` / `stopped`（`stopped` = CC 在会话 resume 时对上轮遗留后台
命令的对账补发）。

**必须校验 status 存在且为终态**，只匹配 `<tool-use-id>` 会误配平两类非终态通知：

- Monitor 的**每条事件**都发 `<task-notification>`（`<task-id>` + `<event>`，无 tool-use-id/无 status）——实测
  434+314+119 条，占通知总量近半。
- 后台命令卡交互输入时的"疑似阻塞"提醒：**带 tool-use-id 但无 status**（leak `LocalShellTask.tsx:74-88`
  明写"No `<status>` tag — print.ts treats `<status>` as a terminal signal"）。

### 3. Monitor 自带硬死线，比统一阈值精确

Monitor 回执结构化字段带 `timeoutMs`（默认 300000，最大 3600000）与 `persistent`。到点 CC 必杀该进程
（leak `spawnShellTask` → `shellCommand.result` → `enqueueShellNotification(killed)`）。

→ 用它做该任务的兜底死线：统一 15min 阈值会把 timeout=1h 的 Monitor 提前 45min 误剔，也会把
timeout=5min 的多留 10min。`persistent: true`（无死线）与 agent / 后台命令一样落统一阈值。

实测回执两种形态（persistent 那条为本轮实跑取证）：
```
Monitor started (task bgl7qdlab, timeout 180000ms).
Monitor started (task bb3ly701z, persistent — runs until TaskStop or session end).
```

## 方案

### 数据层（`collect-cli.js`）
`countRunningSubagents` → `countRunningBackgroundTasks`，口径从"后台 subagent"扩到"后台任务"：

- 启动：`bgLaunchTtlMs(o.toolUseResult)` 命中即 `launched.set(tool_use_id, { at, ttl })`；`ttl` 仅 Monitor 非
  persistent 时 >0。**删掉** `agentUseIds` 防污染层（结构化字段无需）。
- 完成：`taskNotificationText(o)` 覆盖三载体 + `TERMINAL_STATUS` 校验 → `done`。
- 在跑 = `launched − done − 过死线`；死线 = `at + (ttl > 0 ? ttl + 宽限 : BG_STALE_MS)`。
- `SUBAGENT_STALE_MS` → `BG_STALE_MS`（15min，保留：会话崩溃 / 通知真丢的兜底，不再是主要缺口）。

### 字段/渲染层
语义从"后台 agent"扩为"后台任务"，字段与文案同步改名（否则 Monitor/命令被显示成 "后台 agent"）：

- `backgroundAgentCountBySid` → `backgroundTaskCountBySid`；卡片字段 `backgroundAgentCount` →
  `backgroundTaskCount`（`collect.js` `deriveBackgroundState` + `collect-cli.js` 两处卡片 + `app.js`）。
- `app.js` 详情：「后台 agent」→「后台任务」。

覆盖规则不变：`state==awaiting-human && sessionAlive && backgroundTaskCount>0 → processing`。

## 改动清单
- `collect-cli.js`：`bgLaunchTtlMs` + `taskNotificationText` + `countRunningBackgroundTasks`（重写）+ 改名。
- `collect.js`：`deriveBackgroundState` 字段改名。
- `app.js`：字段改名 + 文案。
- 不改 `task-runner.js` / `runner-checker.js`。

## 已知局限（诚实记录）
- **fire-and-forget 后台命令会被算成"在跑"**：`npm run dev` 这类 run_in_background 常驻进程永不结束、无终
  态通知，主 agent 其实在等人 → 卡片会误显 processing，最长 15min（`BG_STALE_MS` 封顶）后消失。信号层
  无法区分"等后台完成"与"起了个常驻服务就不管了"；取"宁可少报不永久误报"的既定原则封顶。
- 同理 `persistent: true` Monitor 只计 15min（真在跑也会被剔），换取通知丢失时不永久钉死。
- subagent transcript 不落 `toolUseResult`（本项目不读，见上）。
