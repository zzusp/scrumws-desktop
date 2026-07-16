# 详情里的 workflow 展示

## 症状

任务 `cli:66b52133` 用了 Claude Code Workflows（动态工作流），详情页两处都没把它当回事：

1. **消息流**：`Workflow` 工具走 `toolArgSummary` 的 `default` 分支 `JSON.stringify(input)`，
   而它的入参是**整段编排脚本源码**（实测 12KB+）→ ⏺ 摘要行前 90 字全是转义后的 JS：
   `Workflow({"script":"export const meta = {\n  name: 'cloud-p0p1',\n  descript…)`。
   展开入参区同样是 JSON 转义串，换行全成字面 `\n` 挤成一行，没法读。
   工作块折叠汇总也把它算进 `called N tools`，看不出"起了个工作流"。
2. **侧栏「后台任务」**：Workflow 是后台任务（`status:async_launched`，主进程让出、等它跑完），
   但 `countRunningBackgroundTasks` 认不出来 → 恒计 0，侧栏那行根本不出现。

对照后台 subagent / 后台命令：两者在消息流有可读摘要、在侧栏被计入「N 个运行中」，
在 Mode B 后台任务栏还有 `工作流` 这档标签（`MB_TASK_KIND.local_workflow`，早已存在）——
只有 workflow 这两条路都缺，本次对齐。

## 根因

### 1. 后台计数漏 Workflow（platform/lib/collect-cli.js）

`bgLaunchTtlMs(r)` 按 `toolUseResult` 的结构化签名认后台启动，原本只认三类：

| 后台任务 | 签名 |
| --- | --- |
| Agent 后台 subagent | `isAsync:true` |
| Bash/PowerShell 后台命令 | `backgroundTaskId` |
| Monitor | `taskId` + `timeoutMs` + `persistent` |

Workflow 的实际签名是 `{status:'async_launched', taskId, taskType:'local_workflow', runId, workflowName, summary, transcriptDir, scriptPath}`——
**没有** `isAsync` / `backgroundTaskId` / `timeoutMs` → 三条判据全不命中，返回 `null`（= 不是后台启动）。
且行粗筛（只 parse 含 `"isAsync":true` / `"backgroundTaskId":"` / `"timeoutMs":` / `"task_id":"` / `<task-notification>` 的行）
也不含 workflow 的键，**启动行在 JSON.parse 之前就被跳过了**。

配平侧本来就是通的：`<task-notification>` 带 `<tool-use-id>` + 终态 `<status>`，与工具无关 —— 所以只漏"启动"、不漏"结束"。

全库 1682 个 jsonl 实测，四类签名两两不重叠（证据见 round-1.md）：

```
468  ('backgroundTaskId',)                              后台命令
 50  ('isAsync','status')                               后台 subagent
 16  ('runId','status','taskId','taskType','workflowName')   local_workflow  ← 原本无人认领
```

### 2. 消息流摘要走 default（platform/public/app.js）

`toolArgSummary` 无 `Workflow` 分支；`renderCcTool` 的入参展开区无 `Workflow` 分支（`Edit` 有 diff 特例）；
`toolGroupSummary` 的 `catOf` 无 `Workflow` 分支。

## 修复

- `collect-cli.js`：`bgLaunchTtlMs` 增 `if (r.taskType === 'local_workflow') return 0;`（无自带死线 → 落 15min `BG_STALE_MS` 兜底，
  与 subagent 同档）；行粗筛同步加 `"local_workflow"`。整条工作流按**一个**后台任务计——它的 subagent 落在自己的
  `transcriptDir`、不进主 jsonl。
- `app.js`：
  - 新增 `workflowArgSummary(input)`：首发 `{script}` → 按 CC 约定的 `export const meta = {name, description}` 取名；
    迭代 `{scriptPath}` → 从文件名还原（CC 落盘名 `<name>-<runId>.js`）；`{resumeFromRunId}` → 标「续跑 <runId>」。
  - `toolArgSummary` 增 `case 'Workflow'`；`renderCcTool` 入参区对 `{script}` 原样出源码（不 JSON 转义）；
    `catOf`/`phrase` 增 `workflow` → `launched N workflows`。

## 验证

见 `matrix.csv` / `round-1.md`。两个脚本均带 `--check` 零副作用自检：

```
node docs/acceptance/workflow-detail-display/scripts/verify-workflow-display.mjs
node docs/acceptance/workflow-detail-display/scripts/preview-workflow-render.mjs   # 生成预览页，再无头截图
```
