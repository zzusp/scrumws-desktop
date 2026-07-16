# 详情后台任务栏：走 CC 的 SDK 控制通道，不猜进程也不反读 jsonl

前置：`docs/spec/background-task-signals-unification.md`（反读 jsonl 那套，PR #42）。本文的机制**优于**它，
但只对看板自己 spawn 的 Mode B 会话成立；两者互补，不是替代。

## 需求

任务详情里，在**消息流与发送区之间**常驻一条后台任务栏：列出该会话在跑的后台任务，支持**查看输出**与
**停止**。

## 走过的弯路（都被真实数据否掉，记下来免得重走）

| 方案 | 为何否 |
|---|---|
| 反读主会话 jsonl（PR #42 那套） | 看不到 **subagent 起的**后台任务——它只记在 subagent 自己的 transcript（`<sid>/subagents/agent-*.jsonl`），且那里**不落 `toolUseResult`**、只有回执文案；看板只读顶层 `<sid>.jsonl` |
| 枚举会话子进程 + 命令行/时刻匹配 | 是**猜**。且 subagent **根本没有进程**（实测：subagent 在跑时，会话进程下没有任何属于它的进程——它是 CC 进程内的 API 循环），进程列表还混入前台工具调用，分不出前后台 |
| 杀进程实现 stop | 绕过 CC、按特征猜 PID；且对 subagent 无效 |

## 机制（claude-code-leak 读源码 + CC 2.1.211 实测）

### CC 的统一任务模型（`Task.ts`）
三类后台物件同属 `Task`：`TaskType = local_bash | local_agent | remote_agent | in_process_teammate |
local_workflow | monitor_mcp | dream`。**Monitor 与后台命令同为 `local_bash`**（Monitor 是 `kind:'monitor'`
的变体）。task id 首字母编码类型（`b`/`a`/`r`/`t`/`w`/`m`/`d`）。

### 列表：`system/background_tasks_changed`（全量推送）
```json
{"type":"system","subtype":"background_tasks_changed",
 "tasks":[{"task_id":"bnlx28u2a","task_type":"local_bash","description":"Sleep for 301 seconds"}]}
```
**实测增删都推**：起任务推 `[x]`、任务结束推 `[]` → 直接覆盖即可，**无需自行增删、无需死线兜底**。
另有 `task_started` / `task_progress` / `task_notification` / `session_state_changed`（`sdkEventQueue.ts`）。
SDK 事件仅在 headless 模式 drain（`getIsNonInteractiveSession()`）——Mode B 正是 headless。

### 停止：`control_request { subtype:'stop_task', task_id }`
与 **TaskStopTool（LLM 调的那个）共用同一个 `stopTask()`**（`tasks/stopTask.ts` 首行注释明写
"Used by TaskStopTool (LLM-invoked) and SDK stop_task control request"）：按 task_id 查 CC 自己的任务表 →
校验 `status==='running'` → `taskImpl.kill()`。**零猜测，且覆盖 subagent 这类无独立进程的任务。**

顺带解开 PR #42 的一个疑问：**TaskStop 为何不发 task-notification** —— 不是漏，是故意压掉。对 shell 任务
它预置 `notified=true` 以抑制 "exit code 137" 噪音，改为直接 `emitTaskTerminatedSdk(taskId,'stopped')`；
agent 任务不压（AbortError 分支要把部分结果带回来，那是载荷不是噪音）。

### 输出：`<临时目录>/claude/<cwd 折叠>/<CC sessionId>/tasks/<taskId>.output`
折叠规则同 `paths.js`（`:` `\` `/` → `-`）。任务终态后 CC 会 evict 该文件 → 能读到的天然只有在跑的任务。

## 关键前提：看板早就接在这条通道上了
`session-manager.js:166` 起 Mode B 会话即 `claude -p --input-format stream-json --output-format stream-json`，
stdin 常开，且**已在发 control_request**（`interruptSession` 的 `subtype:'interrupt'`）→ 加 `stop_task` 是
照抄一行。

## 方案
- `session-manager.js`：`Session.backgroundTasks`（接 `background_tasks_changed` 全量覆盖）+ 并入 `info()`；
  新增 `stopTaskInSession(id, taskId)`（照 `interruptSession`）、`readTaskOutput(id, taskId)`（尾部 64KB）。
- `server.js`：`POST /api/session/stop-task`、`GET /api/session/task-output`。
- `index.html`：`#modalBgTasks` 夹在 `#modalBody` 与 `#modalReplyBox` 之间（`.detail-main` 是 flex 列，
  `flex:none` → 不参与滚动、常驻可见），padding 对齐 `--chat-col` 居中列。
- `app.js`：`mb.bgTasks` ← SSE `background_tasks_changed`（+ `info.backgroundTasks` 兜 transcript 截断）；
  `mbRenderBgTasks` / `mbStopTask` / `mbToggleTaskOutput`；`mbDetach` 清栏。

## 边界（诚实记录）
- **只对 Mode B（看板 spawn）会话成立**：控制通道 = 那个 claude 进程的 stdin；SDK 事件只在 headless drain。
  用户自己在终端里跑的会话 → 退化为 PR #42 的 jsonl 只读计数，**无法 kill**。
- `background_tasks_changed` 不带 `kind`/`command` → **Monitor 与后台命令都显示为「后台命令」**，不再细分
  （不猜）；`description` 已足够区分。
