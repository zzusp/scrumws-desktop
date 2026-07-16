# 验收报告：详情后台任务栏（全绿）

round-1 全绿，22 项全 PASS（`matrix.csv` 为状态权威，证据见 `round-1.md`）。

## 结论

任务详情的消息流与发送区之间新增常驻「后台任务」栏：列出该会话在跑的后台任务（后台命令 / Monitor /
subagent），可**查看输出**、可**停止**。数据与控制均走 CC 自己的 SDK 通道：

- 列表 = `system/background_tasks_changed` 全量推送（增删都推，直接覆盖）
- 停止 = `control_request{subtype:'stop_task'}` → CC 的 `stopTask()`，与 TaskStopTool 同一条路

**零猜测**：不枚举进程、不做特征匹配。实证见 A6——两条后台任务中停指定的那条，剩下的正是另一条。
且能停 **subagent**（实测它没有独立进程，杀进程方案对它无效）。

## 为何不是另外两条路（都被真实数据否掉）

| 弯路 | 否掉的实测证据 |
|---|---|
| 反读主会话 jsonl | subagent 起的后台任务只记在 `<sid>/subagents/agent-*.jsonl`，且**不落 `toolUseResult`**；看板只读顶层 jsonl → 看不见 |
| 枚举子进程 + 匹配 | subagent 在跑时会话进程下**没有它的任何进程**（进程内 API 循环）；进程列表混入前台工具调用，前后台不可分；匹配即猜 |

## 已知边界

- **只对 Mode B（看板 spawn）会话成立**——控制通道 = 该 claude 进程的 stdin，SDK 事件只在 headless drain。
  用户在自己终端里跑的会话退化为 PR #42 的 jsonl 只读计数，**不可 kill**。
- `background_tasks_changed` 不带 `kind`/`command` → Monitor 与后台命令都归为「后台命令」，不再细分
  （不猜；`description` 已足够区分）。
- CC 协议随版本会变（leak 3 月快照里根本没有 `background_tasks_changed`）→ `scripts/e2e-api.mjs` 即
  协议回归，CC 升级后重跑。

## 待定（本轮未做）

看板把 CC 注入的 `<task-notification>` 渲染成了**用户气泡**（还会误带「改写重跑」按钮）。`app.js` 已有
同类先例（`CC_SYNTHETIC_RE` / `INTERRUPT_RE` 按内容识别 CC 注入的伪用户消息），task-notification 属漏网
一类，修法有现成范式。等确认后另做。
