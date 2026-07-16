# 后台任务信号统一：Monitor / 后台命令纳入 + 完成通知载体补全

前置分析见 `docs/spec/background-task-signals-unification.md`（取证过程与被推翻的旧结论）。

## 症状

1. 会话起了后台 **Monitor** 仍在跑、任务实际 processing，看板却把卡片挪进 awaiting 桶（用户报）。
2. 后台 **Bash/PowerShell**（`run_in_background`）同样不计入。
3. 反向误报：`countRunningSubagents` 对**已完成**的后台 subagent 仍报"在跑"，最长 15min。

## 根因

`countRunningSubagents` 只认两种信号，都与 CC 真实落盘形态对不上：

1. **只数 Agent**：Monitor / 后台命令根本不在口径内 → 症状 1、2。
   旧结论"Bash 后台无完成通知不可靠"已被推翻：后台命令结束会发终态 `<task-notification>`，与 Agent 同构。
2. **完成通知只认 `type:'user'` + 纯字符串载体**：实测终态通知大头落在 `queue-operation/enqueue`(506)
   与 `attachment/queued_command`(298)，user/string 仅 195 → 大多数完成通知漏读、launched 永远配不平
   → 症状 3。PR#37 的 15min 时间兜底遮的正是这个缺口（其注释把根因归为"harness 安全中和导致通知不
   落 jsonl"，实测通知**落了**，只是落在另外两种载体）。

**同根因**：PR#37 `bgagent-count-stale-notification-loss` 描述的"永久误报 N 个后台 agent"是本缺口的表现，
非"通知丢失"。时间兜底保留为真丢失/会话崩溃的兜底，不再是主要手段。

## 修复

`collect-cli.js`：

- `bgLaunchTtlMs(toolUseResult)`：用 CC 原生落盘的结构化字段判后台启动，三签名互斥
  （`isAsync` / `backgroundTaskId` / `taskId+timeoutMs+persistent`）。**不匹配回执文案**——命令 stdout 可能原样
  含该串（实测 10 条误命中）；改用结构化字段后旧的 `agentUseIds` 防污染层整个删除。
- `taskNotificationText(o)`：覆盖 user / attachment / queue-operation 三载体。
- 配平须 `<tool-use-id>` + **终态 `<status>`**（completed/failed/killed/stopped）——Monitor 每条事件也发
  task-notification（无 id/status）、后台命令"疑似阻塞"提醒带 id 但无 status，都不是结束。
- **TaskStop 回执配平**：`TaskStopTool.call()` 只 stopTask、不发通知（leak 取证），只能读其成功回执
  `{message, task_id, task_type, command}`；persistent Monitor 只能靠 TaskStop 结束，不认这条必然误报。
- 死线：Monitor 用自带 `timeoutMs`（CC 到点必杀）+ 60s 宽限；其余落 `BG_STALE_MS`(15min)。
- 改名 `countRunningSubagents`→`countRunningBackgroundTasks`、`backgroundAgentCountBySid`→
  `backgroundTaskCountBySid`；卡片字段 `backgroundAgentCount`→`backgroundTaskCount`（`collect.js` /
  `app.js` 同步，文案「后台 agent」→「后台任务」）。

## 验证

- `scripts/verify-bg-count.mjs`：24 条合成用例（三类后台 × 三载体 × 终态/非终态 × TaskStop × 反污染 × 死线）。
- `scripts/scan-corpus.mjs`：全库 1662 个 jsonl 反误报。
- 真实 A/B + 看板 A/B/A 端到端：见 `round-1.md`。
