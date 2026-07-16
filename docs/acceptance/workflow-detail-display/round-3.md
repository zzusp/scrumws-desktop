# round-3 — round-2 也没修好：这从来不是 workflow 的问题

用户拿现场任务回怼「没修好」。查 `cli:66b52133` 当场坐实：**PR#49（round-2）只修了 workflow 一类，
而 15min 死线在误杀全部四类后台任务**。

## 一、证伪：subagent 跑了 27min，看板说"没有后台任务"

```
agent-a3b665d7488eb0c16.jsonl   最后写入 00:53:53   （查的时候 00:54:04 —— 12 秒前，1.1MB 且还在涨）
该 subagent 启动                00:27:06            （27min 前，无终态通知）
countRunningBackgroundTasks     0                   ← 看板说没有后台任务
```

会话自己也在说话（jsonl 00:34:48）：「指令已经送进**正在跑的 agent**」。它确实在跑，看板看不见。

round-2 我把锚点做成了 workflow 专属（`taskType==='local_workflow'` 才读 `transcriptDir`），
subagent / 后台命令照旧按「启动至今」比 15min。——**在通用 bug 上打了个单类补丁**，
正是 `patch-vs-root-scope-narrowing` 记过的坑：判"只能打补丁"前先找作用域下沉的根治。

## 二、量化：15min 死线对四类全在误杀

全库真实「启动 → 终态通知」时长（只统计能算出真实时长的样本）：

| 类型 | 样本 | 中位 | P90 | 最长 | **>15min（被现行死线误杀）** |
| --- | --- | --- | --- | --- | --- |
| subagent | 109 | 4.9min | 8.8min | 32.3min | 4 个 (4%) |
| **bgcmd** | 844 | 1.8min | 27.0min | **1085min（18 小时）** | **141 个 (17%)** |
| monitor | 63 | 0.7min | 109.4min | 2455min | 14 个 (22%) |
| workflow | 28 | 13.2min | 30.8min | 108.9min | 10 个 (36%) |

死线注释里写的「真卡死超此阈值的极少」是错的。绝对数量上 **bgcmd 才是大头（141 个）**，workflow 只是我碰巧撞见的那类。

## 三、反向验：死线守的那个理由已经不存在

死线的立身之本是「防会话崩 / 通知丢时永久误报」。测真丢率（会话在该任务启动后**还活跃 >30min**
却始终没等到终态通知 = 真丢，排除"会话跟着没了"）：

| 类型 | 启动总数 | 无终态通知 | **真·通知丢失** |
| --- | --- | --- | --- |
| subagent | 51 | 4% | **0%** |
| workflow | 16 | 0% | **0%** |
| bgcmd | 471 | 8% | **1.3%**（6 个） |
| monitor | 71 | 28% | 14%（但 persistent Monitor 本就"跑到 TaskStop / 会话结束"，无终态＝真还在跑，不算丢） |

**为 1.3% 的误报，换来 17~36% 的漏报。** 且据 `bgagent-count-stale-notification-loss`：这 15min 是 PR#37
加的兜底，当时真根因是「终态通知有三种落盘载体、旧代码只认 user」→ 配不平；三载体已在
`taskNotificationText` 修好，兜底就成了只剩副作用的遗留。

## 四、根治：回到语义本身 —— 会话活着才可能有在跑的后台任务

代码里**早就写着**正确判据，只是没这么实现（`collect-cli.js` 原 388 行）：

```js
// 会话进程活着才算数——后台任务是该进程的子进程，进程死则后台必随之结束，
// 历史 jsonl 里未配平的 launched 便是陈旧值。
const backgroundTaskCount = countRunningBackgroundTasks(jsonlPath);   // ← 无条件调用，注释落空
const sessionAlive = !!(boardState || att || replyRunnerPid);          // ← 只用于 state 提升
```

而 runner 那条路（`collect.js:60` `deriveBackgroundState`）**本来就是对的**：第一行就 `!sessionAlive → return 0`。
cli 路漏了这个 gate，改用 15min 死线当代理 —— 这才是病根。

改动（净 **−9 行**，删的比加的多）：
1. `collect-cli.js`：`const backgroundTaskCount = sessionAlive ? countRunningBackgroundTasks(jsonlPath) : 0;`
   —— 与 runner 路同语义。`att` 经 `pidAlive`（`process.kill(pid,0)`）**实测**，不是文件残留就算活 → 精确。
2. 删掉 `BG_STALE_MS` 及其"启动至今"剔除逻辑；**连带删掉 round-2 加的 `lastActivityMs` + `transcriptDir` 特判**
   （根治后不需要了）。
3. 保留 Monitor 的自带硬死线（`timeoutMs`，CC 到点真杀进程 → 过点必已结束，是真信息不是猜）。
4. `CC_SESSIONS` 补 `SCRUMWS_CC_SESSIONS` 覆盖口（对齐同文件既有的 `SCRUMWS_CC_PROJECTS` 约定）：
   sessionAlive 现在是唯一防线，沙箱里必须能造活/死会话才验得了它。

代价：真丢的那 1.3% 会在会话存活期间多显示一个，会话一退即归 0（有界，非永久）。换掉 17~36% 的漏报，划算。

## 五、A1–A8 单测（覆盖四类，全部取自真实语料）

启动行按签名从全库捞真行、只重写 timestamp，其余原样：

```
[A] countRunningBackgroundTasks：在跑就算，不按「启动至今」猜死活
  PASS  A1 subagent 启动 36min 前、无终态通知 → 计入 1（现场 cli:66b52133 的形态）
  PASS  A2 workflow 启动 109min 前、无终态通知 → 计入 1
  PASS  A3 后台命令启动 18h 前、无终态通知 → 计入 1（全库最长实测 1085min）
  PASS  A4 收到终态通知 → 归 0
  PASS  A5 TaskStop 回执 → 归 0（TaskStop 不发终态通知，只能读它自己的回执）
  PASS  A6 非 persistent Monitor 过自带硬死线(3min)+宽限 → 归 0（CC 到点真杀进程）
  PASS  A7 非 persistent Monitor 未到自带死线 → 计入 1
  PASS  A8 persistent Monitor 启动 40h 前、无终态 → 计入 1（本就跑到 TaskStop / 会话结束）
```

## 六、E2E：沙箱两场景（新判据的两面都验）

```
node docs/acceptance/workflow-detail-display/scripts/verify-detail-sandbox.mjs
[重放] 截断到 00:28:06（末个后台启动 +1min）：留 663/688 行
[活会话] 傀儡进程 pid=1880 已登记进沙箱注册表

[场景① 活会话] cli:66b52133 state=processing backgroundTaskCount=1
  PASS  ① 活会话 + 未配平后台任务 → 计入（不按启动时长误杀）
  PASS  ① 侧栏显示「后台任务 N 个运行中」   实得：后台任务 | 1 个运行中（主进程已让出，等后台完成）
  PASS  ① 消息流出 3 条 Workflow ⏺ 行且都带工作流名
  PASS  ① ⏺ 行不再是脚本源码 JSON

[场景② 死会话] 傀儡 pid=1880 已杀，注册表文件故意保留（模拟 CC 残留）
  PASS  ② 死会话 → 后台任务计数归 0（陈旧未配平值被 sessionAlive 短路，不永久误报）
  PASS  ② 死会话 → 侧栏不显示「后台任务 N 个运行中」
==== ALL PASS : 6 passed, 0 failed ====
```

场景②是关键：删掉死线后，若 sessionAlive 失灵就会永久误报。用**真进程 + 真杀**验证（注册表文件故意留着，
模拟 CC 残留 → 证明判活靠的是 `pidAlive` 而不是文件在不在）。

## 七、LIVE + 全量回归

现场（改前/改后同一份数据）：

```
负对照（撤回本轮改动 = PR#49 那版）: countRunningBackgroundTasks(now) = 0
本轮改动后                          : countRunningBackgroundTasks(now) = 1
```

真浏览器点开真实详情页（`verify-live-detail.mjs`）：

```
[侧栏] 后端 backgroundTaskCount=1；页面：后台任务 | 1 个运行中（主进程已让出，等后台完成）
  PASS ×6（侧栏与后端一致 / 3 条 Workflow ⏺ 行 / 无脚本源码 / 续跑标 runId / 单独成组平铺）
```

**全量回归**（真看板 51 个任务，改动前后逐一对比）：

```
=== 计数变化的任务 ===
  cli:66b52133  0 → 1   (state processing → processing)

任务总数 51；计数变化 1 个；其余全部未变
```

只有用户指的那个任务变了，无误报扩散。

## 未覆盖 / 盲点

- **真丢的 1.3%（6/471 bgcmd）会在会话存活期间多报 1 个**，会话退出即归 0。有界但存在；
  若将来 bgcmd 的丢失率上升，需要给它单独找活信号（`tasks/<backgroundTaskId>.output` 实测会随输出增长，
  可用；但当前 1.3% 不值得为它加特判 —— 有证据再加）。
- Mode B live 会话未单独取证（后台任务栏走 CC 推的 `background_tasks_changed`，与本次 collect-cli 改动无关）。
- `sessionAlive` 依赖 CC 注册表 + pid 实测。若 CC 改注册表格式/位置，这条防线会静默失效 → 计数变成
  "只由通知收敛"，陈旧值会挂到会话记录消失为止。**当前无自动告警**。
