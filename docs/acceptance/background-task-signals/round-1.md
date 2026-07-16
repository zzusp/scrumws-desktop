# round-1（2026-07-16）全绿

环境：worktree `worktree-20260716151718-599`，CC v2.1.210，Node v22.13.0。

## R1 合成用例 24/24 PASS

```
node docs/acceptance/background-task-signals/scripts/verify-bg-count.mjs
→ 合计 PASS=24 FAIL=0
```
覆盖 C01–C24：三类后台任务都计入 / 三种通知载体都配平 / 四种终态 status / 非终态不误配平 /
TaskStop 配平 / 反污染 / 死线（Monitor 自带 timeout vs 统一阈值）/ 空文件与缺失文件。

## R2 全库反误报（真实数据 1662 个 jsonl）

```
node docs/acceptance/background-task-signals/scripts/scan-corpus.mjs
→ 扫描 1662 个 jsonl：报"有后台在跑"的 1 个；耗时 3005ms（均 1.8ms/文件）
   1 个在跑  af219f66  最后活动 -0.0 分钟前
```
唯一命中经核实是**真阳性**：`D--baibu-agent/af219f66` 为当时正在写入的活会话，10:33:56 / 10:34:12 起了
2 个后台 subagent；扫描时刻(10:41:24) 第 2 个的完成通知尚未落盘 —— 它确实还在跑，数十秒后完成，
快照复算即为 0。其余 1661 个历史会话全 0。

## R3 新旧口径 A/B（真实第三方会话，非本轮构造）

取 `af219f66` 在两个 subagent 均已收到 `completed` 终态通知后的快照，固定 `now=10:42:00`
（距启动 ~8min，未触发旧实现的 15min 时间兜底）：

| 口径 | 结果 | 真值 |
|---|---|---|
| 旧 `countRunningSubagents`（HEAD 版本，`git show` 取得） | **2** ← 误报 | 0 |
| 新 `countRunningBackgroundTasks` | **0** ✔ | 0 |

根因实证：该会话两条 `completed` 通知的落盘载体**全部**是 `queue-operation/enqueue`+`remove` 与
`attachment/queued_command`，**`user/string` 一条都没有** → 旧实现看不见任何一条，只能等 15min 时间
兜底。此即 PR#37「永久误报 N 个后台 agent」的真身。

## R4 看板端到端 A/B/A（真实活会话 + 真实 Monitor）

隔离方式：`SCRUMWS_DATA_ROOT` 指向沙箱数据根（watchlist 只含本会话 sid），CC projects 用真实目录读活
jsonl；用户真实 `~/.scrumws` 全程只读——事后核验其 watchlist 无本会话 sid（`grep -c` = 0）。
看板服务脱离本 CC 会话独立起（PowerShell `Start-Process`，PID 28000），避免服务自身被算作本会话的
后台命令污染基线（此现象本身即"已知局限：fire-and-forget 后台命令"的真实样例）。

| 步骤 | 桶 | backgroundTaskCount |
|---|---|---|
| ① 基线（无后台任务） | `awaitingHuman` | 0 |
| ② 起真实 Monitor `bl3p94gf4`（timeout 600000ms） | **`processing`** | **1** |
| ③ TaskStop 停掉该 Monitor | `awaitingHuman` | 0 |

② 即用户所报症状的修复实证（旧实现此处仍为 `awaitingHuman`/0）。

## R5 字段贯通（真实看板 API）

`GET /api/state`（47 张卡片，跨 plan/processing/done/awaitingHuman/archived 五桶）：
- 带新字段 `backgroundTaskCount` = **47/47**
- 仍带旧字段 `backgroundAgentCount` = **0**

## R6 本会话真实后台任务实跑（三条配平路径）

本会话真起过后台 Bash 与 Monitor，实测计数随真实事件收敛：

- 起后台 Bash `bpupsfnw1` + Monitor `bunamm21a` → 计数 **2**（旧实现为 0：本会话一个 Agent 都没起）
- Bash 完成（`completed` 通知）+ Monitor 被 TaskStop → 计数 **0**
- 另：Monitor `bb3ly701z`(persistent) 自然结束（stream ended）→ 配平
- 期间真实收到一条 `status=stopped` 的 resume 对账通知（`bih5kcq6e`），印证 `stopped` 须计为终态

## 清理

- 沙箱数据根 `%TEMP%\scrumws-bg-e2e` 已删除；测试服务按具体 PID 定点停（未波及用户 8799 桌面应用）。
- `docs/tmp/` 本轮草稿（探针脚本 / state dump / 快照）已清理，可复用的两个脚本转入 `scripts/`。
