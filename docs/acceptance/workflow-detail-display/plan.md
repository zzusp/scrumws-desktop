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

- `collect-cli.js`：`bgLaunchTtlMs` 增 `if (r.taskType === 'local_workflow') return 0;`；行粗筛同步加 `"local_workflow"`。
  整条工作流按**一个**后台任务计——它的 subagent 落在自己的 `transcriptDir`、不进主 jsonl。
- `collect-cli.js`（round-2 补）：workflow 的死线**锚点换成「最后活动时刻」**（`lastActivityMs` 读 `transcriptDir`
  里最新文件 mtime），不再用「启动至今」。**round-1 那版是错的**，详见下面「round-2 修正」。
- `app.js`：
  - 新增 `workflowArgSummary(input)`：首发 `{script}` → 按 CC 约定的 `export const meta = {name, description}` 取名；
    迭代 `{scriptPath}` → 从文件名还原（CC 落盘名 `<name>-<runId>.js`）；`{resumeFromRunId}` → 标「续跑 <runId>」。
  - `toolArgSummary` 增 `case 'Workflow'`；`renderCcTool` 入参区对 `{script}` 原样出源码（不 JSON 转义）；
    `catOf`/`phrase` 增 `workflow` → `launched N workflows`。

## round-2 修正：15min 死线会把在跑的长工作流误杀

round-1 全绿后拿现场任务实测，`cli:66b52133` **正在跑 workflow**，详情页却什么都不显示（`backgroundTaskCount=0`）。

根因是 round-1 的 TTL 选错：workflow 返回 `0` = 无自带死线 → 落 `BG_STALE_MS`（15min，按**启动至今**算）。
但 workflow 编排多个 subagent，实测单次跑 3～31min，现场这条跑了 **108.9min**——15min 死线会在它干活干到
第 15 分钟时把它从看板抹掉，之后 94 分钟一直显示"没有后台任务"。**round-1 的用例还把这个错误行为写成了
期望值**（`BG-6: 过 15min 死线 → 兜底剔除归 0 → PASS`），是自证自洽的假绿。

workflow 又没有心跳可借：
- 主 jsonl 从启动到终态只有一条记录（实测在跑的 `w302v3gbz` 全文件仅 1 次命中）；
- `tasks/<taskId>.output` 恒 **0 字节**、mtime 停在启动时刻。

唯一的活信号是 CC 在 `toolUseResult` 给出的 `transcriptDir`（该工作流的 subagent 全落那，实测每几秒就在写）。
故把死线锚点从「启动时刻」换成「最后活动时刻」= `max(启动, transcriptDir 内最新文件 mtime)`，仍套同一个
15min 窗口：判据从"跑了多久"变成"多久没动静"——长工作流不误杀，会话崩了也照样在 15min 静默后自然收敛，
不引入新的魔法数。取不到 dir（字段坏/目录没了）→ 退回按启动时刻比，与改动前同语义。

> 只看目录内文件的 mtime，不看目录自身：NTFS 的目录 mtime 只在增删条目时更新，文件内容追加不刷新。

## 验证

见 `matrix.csv` / `round-1.md`（离线取证）/ `round-2.md`（真起看板 + 真浏览器）。全部脚本带 `--check` 零副作用自检：

```
node docs/acceptance/workflow-detail-display/scripts/verify-workflow-display.mjs    # 单测：计数判据 + 摘要 + 分组汇总
node docs/acceptance/workflow-detail-display/scripts/preview-workflow-render.mjs    # 离线渲染预览页 → 无头截图
node docs/acceptance/workflow-detail-display/scripts/verify-detail-sandbox.mjs      # 沙箱重放「workflow 在跑」→ 端到端断言 + 截图
node docs/acceptance/workflow-detail-display/scripts/verify-live-detail.mjs         # 打真实在跑的看板实例核对（需先起只读实例）
```
