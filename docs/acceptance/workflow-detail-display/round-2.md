# round-2 — 拿现场在跑的 workflow 实测，round-1 被证伪

round-1 的盲点是「没起服务点真详情页」。这一轮补上，结果**当场翻车**：round-1 全绿，但现场
`cli:66b52133` 正在跑 workflow，详情页什么都不显示。

## 一、证伪：现场 backgroundTaskCount=0

只读看板实例（不碰用户在跑的 8799）：

```
SCRUMWS_PORT=8815 DASHBOARD_NO_SCHEDULER=1 node platform/standalone.js
→ 调度器未启动（DASHBOARD_NO_SCHEDULER=1，仅看板只读实例）
```

> 双保险：① `DASHBOARD_NO_SCHEDULER=1`（server.js:625 起调度器前先看这个）；
> ② 就算不给这个 env，`scheduler.lock` 也被 8799 的 electron（pid 31824，实测存活）持着 → 第二实例只会
> `disabled-lock`。两条都是项目原有机制，非本次新增。

```
/api/state → cli:66b52133  state=processing  backgroundTaskCount: 0   ← 但 workflow 明明在跑
```

现场取证（`transcriptDir` 的写入时刻 vs 当前时间）：

```
subagents/workflows/wf_1f12246e-337/agent-a236f57da2971cd72.jsonl   00:15:24
当前时间                                                              00:15:33
```

**9 秒前还在写** —— 那条 22:36 启动、已跑 101 分钟的 workflow 确实活着。

## 二、根因：15min 死线 vs 跑 108.9min 的工作流

round-1 让 `bgLaunchTtlMs` 对 workflow 返回 `0`（= 无自带死线）→ 落 `BG_STALE_MS`，**按「启动至今」**比 15min。
而 workflow 是编排器，实测时长（全库 16 次）：

| 现场那次 | 前几次（D--baibu-agent 语料） |
| --- | --- |
| **108.9min**（本轮全程盯着它跑完） | 30.8min / 17.5min / 13.2min / 11.2min / 3.3min |

15min 死线 → 它干到第 15 分钟就从看板消失，之后 **94 分钟**一直显示"无后台任务"。
**而 round-1 的 BG-6 把这个错误行为写成了期望值**（`过 15min 死线 → 归 0 → PASS`）——用例自证自洽，
所以 19/19 全绿也没拦住。这是本轮最该记住的教训：**期望值是自己写的，全绿不等于对**。

心跳信号找过，都是死路（故不能靠"续命"）：

| 候选 | 实测 | 结论 |
| --- | --- | --- |
| 主 jsonl 里的进度通知 | 在跑的 `w302v3gbz` 全文件仅 **1** 次命中（就是启动那条） | 无 |
| `tasks/<taskId>.output` | 恒 **0 字节**，mtime 停在启动时刻 | 无 |
| `transcriptDir` 内文件 mtime | 每几秒在写 | **可用** |

## 三、修法：锚点从「启动至今」换成「多久没动静」

`anchor = max(启动时刻, transcriptDir 内最新文件 mtime)`，仍套同一个 15min 窗口。
不加新魔法数；长工作流不误杀；会话崩了 → dir 不再被写 → 15min 静默后自然收敛（`BG_STALE_MS` 的原意保住）。
取不到 dir → 退回按启动时刻比，与改动前同语义。

> 只看目录内文件 mtime，不看目录自身：NTFS 目录 mtime 只在增删条目时更新，文件内容追加不刷新。

## 四、A1–A7 单测（重写）

round-1 的 BG-1..6 是「真语料 + 时间旅行」，改动后**不再适用**：死线锚点成了实时文件系统状态，那个
`transcriptDir` 现在还在被真会话写 → 时间旅行不可复现。改成「真实启动行做骨架，只重写 timestamp 与
transcriptDir 两个字段，dir 的 mtime 由测试用 `fs.utimesSync` 设定」→ 判据可控可复现，结构仍是 CC 真实落盘那一行。

```
[A] countRunningBackgroundTasks 认 Workflow（死线锚点 = transcriptDir 最后活动）
  PASS  A1 刚启动 1min、dir 刚写过 → 计入 1
  PASS  A2 启动 98min 前、dir 1min 前仍在写 → 计入 1（长工作流不误杀）
  PASS  A3 启动 98min 前、dir 静默 30min → 剔除归 0（会话崩溃后自然收敛）
  PASS  A4 dir 取不到（字段坏 / 目录没了）→ 退回按启动时刻比死线，98min 前 → 0
  PASS  A5 dir 取不到但刚启动 1min → 仍计入 1（不因取不到就误杀）
  PASS  A6 终态通知已到 → 归 0（配平优先，哪怕 dir 还在被写）
==== ALL PASS : 14 passed, 0 failed ====
```

**A7 负对照**（`git stash push platform/lib/collect-cli.js` 撤掉本轮改动后重跑）——精确隔离本轮：
round-1 的判据已 commit，stash 只撤掉 `lastActivityMs`，故 A1（1min）仍过、**A2（98min 长工作流）FAIL**：

```
  PASS  A1 刚启动 1min、dir 刚写过 → 计入 1
  FAIL  A2 启动 98min 前、dir 1min 前仍在写 → 计入 1（长工作流不误杀）
        应为 1 —— 这条正是现场 cli:66b52133 的形态
```

## 五、E2E-1..4 沙箱重放（可复现证据）

现场那次 workflow 在我验证途中**跑完了**（终态 `completed @ +108.9min`），"在跑"这个状态自然不再复现——
而它恰是本次改动的核心形态。故用一次性沙箱重放，靠项目**原有**的两个 env 隔离
（`SCRUMWS_DATA_ROOT` + `SCRUMWS_CC_PROJECTS`），全程不碰 `~/.scrumws` 与 8799：

```
node docs/acceptance/workflow-detail-display/scripts/verify-detail-sandbox.mjs
[重放] 截断到 22:37:24（末次 workflow 启动 +1min）：留 546/656 行；该次启动的 transcriptDir 重指沙箱新目录 1 处
[后端] cli:66b52133 state=processing backgroundTaskCount=1
  PASS  后端把在跑的 workflow 计入 backgroundTaskCount
  PASS  侧栏显示「后台任务 1 个运行中」
        侧栏实得：后台任务 | 1 个运行中（主进程已让出，等后台完成）
  PASS  消息流出 3 条 Workflow 行且都带工作流名
  PASS  ⏺ 行不再是脚本源码 JSON
```

截图 `round-2/sandbox-detail-workflow-running.png`：一张里同时有侧栏「后台任务 1 个运行中」+
`⏺ Workflow(cloud-p0p1 · P0+P1：机器注册/心跳 + 任务状态上行只读大盘) · 140ms` + 展开的可读脚本源码。

### 踩坑：重放不能删中间行（删了详情只剩 3 个工具）

第一版重放去**删**该 workflow 的终态通知行 → 详情页只渲出 3 个工具（`Bash,Bash,Agent`），Workflow 一条不剩。
根因：删中间行会让后续消息的 `parentUuid` 指空，`logs.js` 的死分支过滤把它们整片当撤回丢掉（同 PR#47 修过的
compact 断链坑）。改成**截断**到「末次启动 +1min」——jsonl 是 append-only，前缀天然是某一时刻的合法快照，
链完整；且终态通知（+108min）自然落在窗口外，无需伪造。留 546/656 行，三条 Workflow 行全在。

另一坑：第一版把三次启动**全部**掰成"在跑"（全砍通知 + 全重指 dir）→ `backgroundTaskCount=3`。
截断后只有末次是在跑，前两次保持真实结局（failed / 静默超时）→ 恰好 1，与语义相符。

## 六、LIVE-1..4 打真实看板

```
node docs/acceptance/workflow-detail-display/scripts/verify-live-detail.mjs --task cli:66b52133
[侧栏] 后端 backgroundTaskCount=1；页面：后台任务 | 1 个运行中（主进程已让出，等后台完成）
  PASS  侧栏与后端一致（1 个在跑 → 显示 N 个运行中）
[消息流] Workflow 工具行 3 条：
   ⏺ Workflow(cloud-p0p1 · P0+P1：机器注册/心跳 + 任务状态上行只读大盘)· 140ms
   ⏺ Workflow(cloud-p0p1)· 41ms
   ⏺ Workflow(cloud-p0p1 · 续跑 wf_1f12246e-337)· 139ms
  PASS ×4
==== ALL PASS : 6 passed, 0 failed ====
```

侧栏这条断言写成**「页面 == 后端真值」**而不是硬写"必须有 workflow 在跑"：真实会话里 workflow 随时收尾
（本轮就眼看着它收了），硬断言会变成必然失败的测试。"在跑那一刻"的确定性覆盖交给沙箱。

截图 `round-2/live-detail.png`（落地页 + 侧栏）、`round-2/live-detail-workflow-line.png`（⏺ 行 + 源码区）。

### GRP：`launched N workflows` 在这页测不了，别假装能测

页面上 24 个折叠组的汇总句里没有 `launched N workflow`。查证：`renderCcFlow` 对 `tools.length < 2` 的组
**平铺不折叠**，而这三次 Workflow 前后都紧挨正文、各自单独成组（实测组内工具数 `1,1,1`）→ 本页根本不出
该汇总句，符合预期。故把这条从 e2e 拿掉，改到单测里覆盖（GRP-1/2，`[Workflow, Bash] → Launched 1 workflow,
ran 1 shell command`）。—— 顺带修了个**空列表假通过**：`!wf.some(...)` 在 `wf=[]` 时恒真，0 条也报 PASS。

## 七、意外收获：完整看到一次「超长 workflow 生命周期」

| 时刻 | 事件 | 侧栏 |
| --- | --- | --- |
| 22:36:24 | workflow 启动 | 1 个运行中 |
| 22:51 | 过 15min —— **round-1 那版会在此把它抹掉** | round-1: 0 ／ 本版: 1 个运行中 |
| 00:24:55 | 已跑 108min，实测 API `backgroundTaskCount=1`、页面显示「1 个运行中」 | 1 个运行中 |
| ~00:25:18 | 终态 `completed @ +108.9min` | 配平 → 该行消失 |

本版全程 108.9 分钟正确显示，收尾即消失。round-1 那版会在第 15 分钟消失、错报 94 分钟。

## 未覆盖 / 盲点

- **Mode B live 会话**下的 Workflow 仍未实测：stream-json 不带 `toolUseResult` envelope，后台任务栏走 CC 推的
  `background_tasks_changed`（`MB_TASK_KIND.local_workflow` 早已存在），与本次 collect-cli 改动无关；Mode B 消息流
  的 ⏺ 行同样吃 `toolArgSummary` → 一并受益，但未单独取证。
- `lastActivityMs` 每次 collect 对每个在跑 workflow 做一次 `readdir + stat`。全库仅 16 次 workflow 启动、
  目录内文件个位数，成本可忽略；但**未做**大目录（几百个 subagent）下的性能实测。
- 15min 静默窗口对 workflow 是否合适：现场那条每几秒就写，静默 15min 基本等于真死。但**未验证**
  "workflow 长时间等某个慢 subagent、期间 transcriptDir 完全不写"是否存在——若存在会误杀。
