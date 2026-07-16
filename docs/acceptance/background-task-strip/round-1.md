# round-1（2026-07-16）全绿

环境：worktree `worktree-20260716151718-599`，**CC v2.1.211**（协议须对该版本实测，leak 是 3 月快照），
Node v22.13.0，系统 Edge。沙箱数据根 `%TEMP%\scrumws-strip-e2e`，端口 8893；用户真实 `~/.scrumws` 未写入。

## R1 CC 协议实测（leak 只是线索，以实跑为准）

leak（3 月快照）里**没有** `background_tasks_changed` / `task_updated`；实跑 2.1.211 的事件流才看到。
故协议以下述实测为准：

**① `stop_task` 控制请求成立**（探针：真会话起 `sleep 300` → 发 stop_task）：
```
【task_started】task_id=b2ib17sek task_type=local_bash
→ 发 control_request stop_task task_id=b2ib17sek
【task_notification】task_id=b2ib17sek status=stopped
【control_response】{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{}}}
```
实跑收到的 system 事件全集：`status, thinking_tokens, background_tasks_changed, task_started,
task_updated, task_notification`。

**② `background_tasks_changed` 是全量表**：
```json
{"subtype":"background_tasks_changed","tasks":[
 {"task_id":"bnlx28u2a","task_type":"local_bash","description":"Sleep for 301 seconds"},
 {"task_id":"bj61xsmaj","task_type":"local_bash","description":"Sleep for 300 seconds"}]}
```

**③ 增删都推**（起 `sleep 8` 后静候）：
```
+6.4s   background_tasks_changed → tasks=[bvj7z2lbo]  (1 条)
+6.4s   task_started → bvj7z2lbo
+14.6s  background_tasks_changed → tasks=[空]  (0 条)
+14.6s  task_notification → bvj7z2lbo status=completed
```
→ 结束会推空列表，可直接当数据源，**不需要自行摘除、不需要死线兜底**。

## R2 API 端到端 7/7 PASS（真 Mode B 会话 + 真 CC）

`node docs/acceptance/background-task-strip/scripts/e2e-api.mjs`

```
backgroundTasks = [ {b83iee8rv, local_bash, "Sleep for 240 seconds"},
                    {butduy0s7, local_bash, "Sleep for 241 seconds"} ]
PASS  会话 info 暴露 backgroundTasks 全表（2 条）
PASS  每条带 task_id / task_type / description  — ["local_bash","local_bash"]
PASS  查看输出：能定位到 CC 的 .output 文件  — size=0 path=b83iee8rv.output
PASS  stop-task 接口返回 ok  — {"ok":true}
PASS  停掉后 CC 推移除、栏数据自动收敛为 1 条  — 实际 1 条
PASS  被停的正是指定那条（另一条仍在）  — 剩 butduy0s7
PASS  已停任务查看输出：不崩，给出可读结果
合计 PASS=7 FAIL=0
```
**「被停的正是指定那条」是本方案的核心主张**（零猜测）的直接实证。

## R3 UI 11/11 PASS（真浏览器 · 系统 Edge · 1440×900）

`node docs/acceptance/background-task-strip/scripts/ui-strip.mjs`

```
PASS  栏可见
PASS  基线非退化（栏有真实尺寸，非 0×0）  — 1184×88
PASS  位置：在内容展示区下方  — strip.top=939 body.bottom=939
PASS  位置：在消息发送区上方  — strip.bottom=1027 reply.top=1029
PASS  与发送区同宽居中（左边缘对齐）  — strip.left=242 reply.left=242
PASS  两条任务各一行
PASS  类型标签按 task_type 映射  — ["后台命令","subagent"]
PASS  描述取自 CC 的 description
PASS  每行都有「查看」「停止」
PASS  栏头显示条数  — 后台任务 2
PASS  负对照：无后台任务时整条隐藏  — display=none htmlLen=0
合计 PASS=11 FAIL=0
```
位置断言先验「基线非退化」再比坐标——`display:none` 下 rect 全 0 会让等值断言假 PASS。
截图人工确认：栏夹在消息流与发送区之间，三行任务各带「查看/停止」，类型标签区分后台命令 / subagent。

## 清理
- 沙箱数据根与测试看板进程（PID 35104）已按具体 PID 停 + 删除；用户 8799 桌面应用未波及。
- 探针会话全部 closeSession；核验无遗留 `sleep 240/241/300` 进程、无孤儿 `claude -p` 会话。
- `puppeteer-core` 经 `npm install --no-save` 装入 worktree（不入库）。

## 过程中修正的两处错误结论（留痕）
1. 「PID 34980 是 subagent 的**前台** sleep」——错。查 subagent transcript 后确认那是它起的**后台任务**
   `breel4sjq`；由此才发现 subagent 起的后台任务不进主 jsonl（成为否掉 jsonl 方案的关键证据）。
2. 「用户看到的 task-notification 是 CC 自己 UI 渲染的」——错。核验进程后发现本会话自身即
   `claude -p --resume` 的 Mode B（PID 7036），用户看的就是**看板**的任务详情；即看板把
   task-notification 渲染成了用户气泡（`app.js` 已有 `CC_SYNTHETIC_RE`/`INTERRUPT_RE` 同类先例，
   task-notification 是漏网的一类）。此项未在本轮修复，待定。
