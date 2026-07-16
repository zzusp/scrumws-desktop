# round-1

> ⚠️ **本轮的 BG-6 已被 round-2 证伪并作废**（`过 15min 死线 → 兜底剔除归 0 → PASS`）：workflow 实测能跑
> 108.9min，15min 死线会把在跑的长工作流误杀，而本轮把这个错误行为写成了期望值 → 19/19 全绿也没拦住。
> BG-1..6 已重写为 A1..A7，见 `round-2.md`。本文其余取证（签名互斥 / 摘要 / 渲染）仍有效。

语料：`cli:66b52133` = `~/.claude/projects/D--project-scrumws-desktop--claude-worktrees-cloud-control-plane/66b52133-bae7-4f2c-bdcf-34fe03a01cc4.jsonl`
（真实跑过 3 次 Workflow，三种入参形态各一）。全部断言跑在**真实落盘字节**上，不手搓 fixture。

## 前置：四类后台任务签名互斥（全库 1682 个 jsonl）

```
468  ('backgroundTaskId',)                                    后台命令
 50  ('isAsync','status')                                     后台 subagent   status=async_launched
 16  ('runId','status','taskId','taskType','workflowName')    local_workflow  status=async_launched
```

`local_workflow` 与其余两类**零重叠**，且不含 `timeoutMs`/`persistent`（Monitor 判据）→
在 `bgLaunchTtlMs` 里加一条独立分支不会串到别的类别。16 次 workflow 启动分布在 6 个会话。

## BG-1..7 后台任务计数

`node docs/acceptance/workflow-detail-display/scripts/verify-workflow-display.mjs`

```
[语料] Workflow 启动 3 次：
   2026-07-16T13:51:06.666Z  toolu_01XBsZaRre4XhoKjJCQgDLcb  runId=wf_f71ed4ad-d19  入参键=[script]
   2026-07-16T14:14:47.304Z  toolu_01FDGvZ5aS9XQN3MTAv3cVEo  runId=wf_1f12246e-337  入参键=[scriptPath]
   2026-07-16T14:36:24.178Z  toolu_01C3s45FJnx7xMZGLwpwJMGP  runId=wf_1f12246e-337  入参键=[scriptPath,resumeFromRunId]

[A] countRunningBackgroundTasks 认 Workflow 后台启动
  PASS  L1 启动后 1min → 计入 1
  PASS  L1 前一刻 → 0（启动才计，不凭空冒出）
  PASS  L2 启动后 1min → 计入 1（L1 已过 15min 死线剔除）
  PASS  L2 终态 failed 通知后 → 配平归 0
  PASS  L3 启动后 1min → 计入 1
  PASS  L3 过 15min 死线 → 兜底剔除归 0
==== ALL PASS : 12 passed, 0 failed ====
```

**BG-7 负对照**（`git stash push platform/lib/collect-cli.js` 后重跑）——证明这三条是本次改动挣来的，
不是本来就过：

```
  FAIL  L1 启动后 1min → 计入 1        实得 0
  FAIL  L2 启动后 1min → 计入 1        实得 0
  FAIL  L3 启动后 1min → 计入 1        实得 0
  PASS  L1 前一刻 → 0                  ← 这两条「应为 0」的改动前后都过，符合预期
  PASS  L2 终态 failed 通知后 → 归 0
```

### 踩坑记录（写给下次改这块的人）

1. **回放必须按 timestamp 截断**。jsonl 是 append-only，"T 时刻的文件"= 只含 `timestamp ≤ T` 的行。
   第一版直接把整份文件喂给 `countRunningBackgroundTasks(file, T)`，**未来才发生的启动行也在文件里**、
   被算成"当前在跑"（L1 时刻实得 2）。误报不是代码的锅，是回放姿势不对。
2. **`git stash` 做负对照有风险**：探针超时被 kill 时 stash 仍是弹出状态 → 仓库停在"改动被撤回"。
   本轮真撞到一次（全库回放 2min 超时），靠 `git stash list` + `grep local_workflow` 核对才发现。
   每次 pop 后都显式断言判据还在。

## BG-8/9/10 全库

- **BG-8/9**：6 个含 workflow 的会话、共 16 次启动，取 `launch+1s` 时刻回放，改动前后对比：

  ```
  在跑的 workflow 启动 : 15 次，改动后由 0 变为计入 15 次
  启动即终态(秒级失败) : 1 次，改动前后计数一致 1 次（本就不该计入）
  结论：PASS — 在跑的全部变可见；已终态的不误计
  ```

  那 1 次是 `D--baibu-agent/5bc5af94…` 的 `wl3ovyy5a`，终态 `failed` 通知落在启动 **+0.0s**，
  按语义本就不该计入。（第一版探针取 `launch+1min` 且只看"该时刻共几个在跑"，把另一次秒级失败的
  `wpxwuj8cu`（+7.4s failed）判成"漏"——是指标错，不是代码漏，查了 notification 时间线才定性。）

- **BG-10**：以各会话最后一条时间戳为 now 全库回放，25 个非零会话计数改动前后**逐一未变** → 只加不改。

## ARG-1..6 消息流摘要

同一脚本 `[B]` 段，把仓库里那份 `app.js` 整个丢进 `vm` 跑（函数声明提升 → 顶层摸 DOM 抛错也不影响取函数），
再喂真实入参：

```
   L1 {script}                     → cloud-p0p1 · P0+P1：机器注册/心跳 + 任务状态上行只读大盘
   L2 {scriptPath}                 → cloud-p0p1
   L3 {scriptPath,resumeFromRunId} → cloud-p0p1 · 续跑 wf_1f12246e-337
  PASS  L1 首发 {script} → 取 meta.name
  PASS  L1 带上 meta.description
  PASS  L2 仅 {scriptPath} → 从文件名还原名、剥掉 -wf_ 后缀与 .js
  PASS  L3 续跑 → 标出 resumeFromRunId
  PASS  负对照：改动前摘要确实是脚本源码 JSON（证明本条改动有效）
  PASS  摘要长度受控（≤90，不夹带源码）
```

负对照实得（改动前 90 字）：`{"script":"export const meta = {\n  name: 'cloud-p0p1',\n  descript…`

> 起初想按花括号配对从 app.js 里切出单个函数——被正则里的 `\{` 和模板串 `${}` 骗到，报"花括号不配对"。
> 改成整份进 vm + 宽容 Proxy stub，既不切片也不复制粘贴，被测的就是仓库里那份源码。

## RENDER-1..3 真 CSS 渲染

```
node docs/acceptance/workflow-detail-display/scripts/preview-workflow-render.mjs
# 产物写 %TEMP%\workflow-detail-render.html（内联整份 CSS + 脚本源码 80K+，可再生成 → 不入库）
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --no-sandbox `
  --hide-scrollbars --user-data-dir="$env:TEMP\wf-shot-profile" --window-size=980,1200 `
  --virtual-time-budget=5000 --screenshot="round-1\workflow-detail-render.png" "file:///$env:TEMP/workflow-detail-render.html"
```

截图：`round-1/workflow-detail-render.png`（真 `index.html` 的 `<style>` + 真 `app.js` 的 `renderCcTool` + 真数据）。

三种形态的 ⏺ 行实测：

| 入参 | ⏺ 行 |
| --- | --- |
| `{script}` | `Workflow(cloud-p0p1 · P0+P1：机器注册/心跳 + 任务状态上行只读大盘) · 140ms` |
| `{scriptPath}` | `Workflow(cloud-p0p1) · 41ms` |
| `{scriptPath+resumeFromRunId}` | `Workflow(cloud-p0p1 · 续跑 wf_1f12246e-337) · 139ms` |

入参展开区出可读多行 JS（截图可见 `export const meta = {` 起整段缩进源码）。

> **RENDER-2 的假 FAIL**：先前断言写成"入参区不得含字面 `\n`"，实测 FAIL。查证：该脚本源码本身
> **真实换行 335 处、字面 `\n` 3 处**，那 3 处是脚本自己的代码（`.join('\n')`）——断言错，不是渲染错。
> 另：查证过程中 Bash heredoc 把 `\\n` 吃成真换行，导致 python/node 探针连着给出两次错误结论，
> 最后写成 `.mjs` 文件、用 `String.fromCharCode(92)` 绕开转义才拿到 ground-truth。**这类反斜杠判定别走 heredoc。**

## 未覆盖 / 盲点

- 未起服务、未开浏览器点真详情页（`8799` 是用户在跑的桌面 app，不碰；另起 server 会与其共用 `~/.scrumws`
  数据根、可能双跑调度器）。渲染证据取自真 CSS + 真 app.js + 真数据的离线渲染，等价于详情页那段 DOM，
  但**未覆盖**详情页的数据装配链路（`collect` → `/api/task` → `renderDetailTab`）。
- Mode B live 会话下的 Workflow 未实测：stream-json 不带 `toolUseResult` envelope，后台任务栏走
  CC 推的 `background_tasks_changed`（`MB_TASK_KIND.local_workflow` 早已存在），与本次改动无关；
  但 Mode B 消息流的 ⏺ 行同样吃 `toolArgSummary` → 本次一并受益，未单独取证。
