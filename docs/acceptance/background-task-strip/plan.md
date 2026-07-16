# 详情后台任务栏（查看 / 停止）

前置分析：`docs/spec/background-task-strip-sdk-channel.md`（含被否掉的两条弯路与取证）。

## 需求
任务详情里，**消息流与发送区之间**常驻一条后台任务栏：列出该会话在跑的后台任务（后台命令 / Monitor /
subagent），支持**查看输出**与**停止**。

起因：用户报「Monitor 还在跑，卡片却进了 awaiting 桶」（PR #42 修了状态口径），进而要求把"在等什么"
显示出来、并能就地处置 —— 状态对不对之外，**看得见、管得着**。

## 方案（走 CC 的 SDK 控制通道）
- 列表 ← `system/background_tasks_changed`：CC 全量推送 `[{task_id, task_type, description}]`，增删都推 →
  直接覆盖，无自行增删、无死线兜底。
- 停止 ← `control_request { subtype:'stop_task', task_id }`：与 TaskStopTool 共用 CC 的 `stopTask()`，
  按 task_id 查 CC 自己的任务表 —— **零猜测**，且能停 subagent（它没有独立进程，杀进程那条路做不到）。
- 查看 ← 读 `<临时目录>/claude/<cwd 折叠>/<CC sessionId>/tasks/<taskId>.output` 尾部。

不采用「枚举子进程 + 命令行匹配」：那是猜，且 subagent 无进程、前后台混杂（理由与实测见 spec）。

## 改动
- `session-manager.js`：`Session.backgroundTasks` + 并入 `info()`；`stopTaskInSession` / `readTaskOutput` /
  `taskOutputPath`；`handleLine` 接 `background_tasks_changed`。
- `server.js`：`POST /api/session/stop-task`、`GET /api/session/task-output`。
- `index.html`：`#modalBgTasks`（夹在 `#modalBody` 与 `#modalReplyBox` 间，`flex:none` 常驻）+ `.bg-tasks*` 样式。
- `app.js`：`mb.bgTasks`（SSE + info 兜底）、`mbRenderBgTasks` / `mbStopTask` / `mbToggleTaskOutput`、
  `mbDetach` 清栏。

## 验证
- `scripts/e2e-api.mjs`：真 Mode B 会话 + 真 CC，走 HTTP API 验列表/查看/停止/移除收敛（7 例）。
- `scripts/ui-strip.mjs`：真浏览器（系统 Edge）验渲染与位置，含基线非退化 + 空列表负对照（11 例）。
- 证据见 `round-1.md`。

## 边界
只对 Mode B（看板 spawn）会话成立——控制通道 = 该 claude 进程的 stdin。用户终端里自己跑的会话退化为
PR #42 的 jsonl 只读计数，不可 kill。
