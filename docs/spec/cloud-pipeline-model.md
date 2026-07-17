# 云端流水线模型 · 设计

> # ⚠ 本期不做（2026-07-17 用户决策）
>
> **本期方案：任务直接指派给一个人，落到他 online 的机器上。没有流程、没有站、没有 agent 人格。**
>
> 本文留档的价值在于两条已查证的结论——将来真要做流程时不必重查：
> 1. **会话从不移动**（`handler/daemon.go:2002-2012`：按 `(agent, issue)` 取 prior session，
>    且 `prior.RuntimeID == task.RuntimeID` 守卫换机器即弃）。协作在 Issue 层，不在会话层。
> 2. **完成判据 = agent 显式声明**，且我们应改**本地**状态而非云端
>    （避免 agent 持云端凭据 → 避开 multica 被迫建的整套 agent 遏制）。这条**本期就该用**，见 §5。
>
> 仍然生效的需求（不随流程延后）：
> - **本地任务不全量上云，只同步云端下发的**（§7）
> - 看板参考 multica（§8）——但没有 Issue 层，看板就是任务列表，不是 issue 看板
>
> 已作废的 §10 待决：「agent 没绑机器时怎么选机器」——**不是问题**。能用才能选、不能用不能选：
> UI 只列 online 机器，人直接指。原设计（`cloud-control-plane.md` §5.3）本来就是「显式指定机器、
> 不做能力匹配」，是我自己绕回去把它当成了路由难题。

---


> 本文是 [`cloud-control-plane.md`](cloud-control-plane.md) 的模型增补。三条新需求（2026-07-17）：
> ① 看板参考 multica ② 同一个任务在多个 agent 之间协作 ③ 本地任务不全上云，只同步云端下发的。
> 三条收敛成**一个改动**：引入 Issue / Stage / Run 三层。

---

## 1. 需求的真实形状：通用流水线

用户的原始例子是研发场景（分析边界 → 开发 → code review → 功能验证 → 发版上线），但**明确要求不要局限在研发**。对照几个场景：

| 场景 | 站 1 | 站 2 | 站 3 | 站 4 |
|---|---|---|---|---|
| 研发 | 分析边界 | 开发 | code review | 发版上线 |
| 内容 | 选题 | 撰稿 | 编辑校对 | 发布 |
| 数据 | 取数 | 清洗 | 建模 | 出报告 |
| 运营 | 策划 | 素材 | 投放 | 复盘 |

**共性只有三件**：有序的站、每站一个 agent、站间要交接东西。

**因此模型里不得出现领域概念**——没有 `branch_name` / `pr_url` / `code_review` 这类字段。`worktree` / `baseBranch` 属于**本地执行参数**（`task.json` 本来就有的「怎么跑」），不是流程定义的一部分。

---

## 2. 为什么现在做不到：任务把两件事混成了一个

现有的「任务」既是**要做的事**（工单），又是**一次执行**（绑着 `meta.sessionId` 的 claude 会话）。所以「多 agent 协作」无从谈起——两个 agent 没法共享一个 `sessionId`，而会话是某台机器的私有物（`session-manager.js:25` 的 Map + 那台机器的 `~/.claude`）。

### multica 的答案：会话从不移动

我一开始把问题框成「会话怎么在 agent 之间移过去」，**这个框架是错的**。multica 的答案是：会话一次都不移动。

决定性证据，`handler/daemon.go:2002-2012`：

```go
// Non-rerun follow-up on the same issue: resume the most recent
// (agent, issue) session so the agent keeps the issue's conversation context.
if prior, err := h.Queries.GetLastTaskSession(ctx, db.GetLastTaskSessionParams{
    AgentID: task.AgentID,        // ← 按 (agent, issue) 找，不是按 issue
    IssueID: task.IssueID,
}); err == nil && prior.SessionID.Valid {
    if prior.RuntimeID == task.RuntimeID {   // ← 换了机器就不续会话
        resp.PriorSessionID = prior.SessionID.String
    }
```

两条硬事实：

1. 作用域是 **(agent, issue)** → agent B **永远**拿不到 agent A 的会话，哪怕同 issue、同机器
2. `prior.RuntimeID == task.RuntimeID` 是**明写的守卫** → agent 换机器就从头开新会话

**连 multica 都不跨机器续会话。** 那个「跨机器会话没法迁移」的死结，它根本没试图解——**协作发生在 Issue 层，不在会话层**。我们照抄这一点。

### multica 已有流水线的一半

`123_issue_stage.up.sql` 加的不是新表，是 `issue.stage` 序号：

> Per-issue `stage` ordinal: groups sub-issues sharing the same parent into ordered barrier groups. …
> The child-done → parent notification + assignee wake fires only when a **stage barrier closes** — i.e. every child in the lowest unfinished stage has reached a terminal status.

即：**父 issue = 需求，子 issue = 一站，`stage` 序号 = 第几站，同 stage 的子 issue 全部 terminal → 屏障关闭 → 唤醒下一站**。

顺带解了一个我没想到的问题：**同一站可以有多个并行子任务**（例：验证站同时跑三个平台），全部完成才过屏障。所以模型天然支持「串行的站 + 站内并行」。

**屏障判据是 `status IN (done, cancelled)`，即 agent 显式声明完成即过闸。** 这条我们采纳，但落点不同——agent 改**本地**状态而非云端，见 §5。

---

## 3. 模型：Issue / Stage / Run 三层

```
Issue（父，云端权威）—— 需求。人 / 产品 / 外部来源创建
  │
  ├─ 子 Issue  stage=1  assignee=agent A     ← 一站
  │    └─ Run #1   agent A @ 机器甲   自己的 sessionId   ← 本地权威
  │
  ├─ 子 Issue  stage=2  assignee=agent B
  │    ├─ Run #2   agent B @ 机器乙   自己的 sessionId   ← 与 Run#1 无任何会话关系
  │    └─ Run #3   agent B @ 机器乙   续 Run#2 的 session（同 agent+issue+机器）
  │
  └─ 子 Issue  stage=3  assignee=agent C
       └─ …（stage=2 的屏障关闭后才派发）
```

| 层 | 是什么 | 权威 | 类比 |
|---|---|---|---|
| **Issue（父）** | 要做的事，人的视角 | **云端** | multica 的 issue |
| **子 Issue + stage** | 一站的工作，有自己的 assignee / 评论 / 状态 | **云端** | multica 的 `issue.stage` |
| **Run** | 某 agent 在某机器上的**一次执行**，绑一个 claude 会话 | **本地** | multica 的 `agent_task_queue` |

**这一层拆分把 §3 的 spec/status 不变式又用了一次**：Issue 状态是人的视角（云端权威），Run 状态是机器的视角（本地权威，仍是现有 5 态）。两者不是一回事，别互相覆盖。

### 会话作用域（照抄 multica）

**(agent, 子 Issue, 机器) 三元组**。跨任一维度都不续会话：

- 同三元组的第 2 个 Run → `--resume` 续会话 ✔（现有能力）
- 换 agent → 新会话
- 换机器 → 新会话（`prior.RuntimeID == task.RuntimeID` 的同款守卫）

### 交接货币：结论 + 产物 + 评论，**不是会话**

下一站的 agent 看到的是云端组装进 prompt 的：

| 内容 | 说明 |
|---|---|
| 上一站的**结论** | Run 的最终输出文本（有界，`meta.json` 里就有） |
| 上一站的**产物** | `artifact jsonb` —— **通用**：分支名 / 文档路径 / URL / 任意结构化数据。**模型不解释它，只传递** |
| Issue 上的**评论** | 人和 agent 都能写；这是异步协作的媒介（multica 的 `trigger_comment_id` 同款） |

**不传 transcript。** 它是机器私有、体量无界、且反读 CC jsonl 本就脆弱（§6.5）。强迫显式交接不是妥协，是更健康——下一站读的是结论，不是上一站的意识流。

---

## 4. Agent = 工位

从用户的例子倒推（分析 / 开发 / review / 验证 / 发版是**五个角色**，不是五个人也不是五台机器）：

```sql
create table agent (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  name text not null,                    -- '边界分析' / '撰稿' / '投放'——用户自定义，非枚举
  instructions text,                     -- 这个工位干什么。领域无关，全靠它表达
  model text, effort text,               -- 默认执行参数
  machine_id uuid references machine(id),-- 默认落在哪台机器；可为空 = 派发时再选
  archived_at timestamptz
);
```

- 五个角色**可以都落在同一台机器上**（都是 claude，靠 instructions 区分），也可以分散到不同人的机器
- 与 multica 的差别：它的 `agent.runtime_id` 是 `NOT NULL` 死绑；我们允许为空、派发时再选，因为我们机器少、且同一角色可能在谁空闲就在谁那儿跑

---

## 5. 一站「算完」的判据：agent 显式声明，改**本地**状态

**已收敛**（原为本设计唯一的真问题）。

### multica 的机制（查证过，三层配合）

1. **禁掉提问** —— `claude.go:618` `--disallowedTools AskUserQuestion`。理由原文：daemon 跑非交互 stream-json，没有 UI 渲染问题，该工具返回空答案，**agent 于是"默默地自己猜"，用户永远看不到那个问题**（引 GitHub #2588）。
2. **要澄清就写评论** —— `claude.go:613`："User-facing clarification belongs in an issue comment instead"。评论触发新 task（`trigger_comment_id`），形成异步问答回路。
3. **状态由 agent 显式声明** —— 注入的 workflow 说明书教它调 `multica issue status`。`daemon.go:4309` 的注释暴露了失败模式：漏了这段，agent "never call `multica issue status` / `multica issue comment add`, leaving issues stuck in `todo`"。

**关键洞察**：「停下来」和「做完了」被彻底解耦。停下来永远只意味着"这一轮结束"；做完了是一个**独立的显式动作**。我原先担心的「分不清完成与提问」，在禁掉提问后不存在——**提问不再是一种结束方式**。

并且它是 **fail-safe** 的：漏了声明不会误判成完成，只会卡在 todo 等人。

### 我们的做法：agent 改**本地**状态，不碰云端

**与 multica 的关键差异，且我们这样更好。**

multica 让 agent 直接改云端 issue 状态 → **agent 必须持云端凭据**（`task_token` `mat_`，认领时签发）→ 于是它被迫建了一整套 agent 遏制：`X-Actor-Source` 在两个中间件顶部强制剥离、task-token 把 workspace 钉死、`RequireHumanActor`（MUL-2600：*"a running agent cannot widen its blast radius by passing a different slug"*）。

**这一整类问题是「agent 手里有云端凭据」造出来的。** 我们的 agent 是带 `--dangerously-skip-permissions` 跑的，给它云端凭据是最不该做的事。

改为：**agent 调本地 `127.0.0.1` 的现有端点声明完成，状态经 reconcile 流上云端。**

| | 理由 |
|---|---|
| **零新增攻击面** | `server.js:19` 绑 `127.0.0.1` 且无鉴权。agent 就在这台机器上，**现在就能**调 `/api/task/complete`。我们不是给它新权限，只是告诉它该这么用 |
| **字段本就为此设计** | `task-actions.js:120` 原注释：「与 **worker 自动 done** 区分：`resolvedBy='user'`」。`resolvedBy` 存在的理由就是区分「人判定 vs 自动判定」。加 `'agent'` 是补全，不是破坏 |
| **符合不变式** | 本地是执行真相的权威，「这站做完了」就是执行真相，就该从本地流上去。agent 绕过本地直接改云端 = 造出第二个真相源 |
| **人是最后一道闸** | agent 误判声明完成 → 人在本地看板看得见、能 `/api/task/uncomplete` 撤回（现有能力）。multica 没有这一层 |
| **云端从不信任 agent** | 云端只信任机器令牌（connector 持有），agent 碰不到它 |

### 落地要点

- 本地加 `--disallowedTools AskUserQuestion`（`session-manager.js` 的 args，一行）——否则 agent 会默默自己猜
- `completeTask` 允许 `resolvedBy='agent'`；本地 Run 仍走 `awaiting-human → done` 的现有流转，**状态机一个字节不改**
- **Run done ≠ 一轮收敛**：`result` → `awaiting-human` 照旧（agent 没声明 = 没完，等人）；**agent 显式声明才 → done**。这个区分正是屏障要的
- agent 需要知道自己的 taskKey → 云端下发 intent 时注入（env 或 prompt 尾），本地 `createTask` 生成时带上
- 澄清走评论（同 multica）：agent 调本地端点写评论 → 上行 → 云端 Issue 评论流 → 人回复 → 新 intent

### 代价

- **站间流转有 ~15s reconcile 延迟**（multica 即时）。流水线场景可接受；嫌慢可在状态变化时立即触发一次推送，不等 tick
- **agent 仍可能错误声明完成**（同 multica，无法根治）。缓解：本地人可撤回；高风险站（发版上线）额外要求人工复核——**不是因为分不清完成与提问，是因为那一站误判代价高**

### 仍保留：按站配置 gate

`stage.gate: auto | manual`，默认 **auto**（agent 声明即过闸）。`manual` 用于误判代价高的站。**风险不均匀，判据就不该统一。**

## 6. 打回与失败

流水线必须能倒着走（review 不通过 → 退回开发）：

- 子 Issue 加 `rejected_to_stage int` —— 打回到第几站
- 打回 = 把目标站的子 Issue 重开一个新 Run（**不是** resume 旧会话——那个会话的上下文是上一轮的，带着它重来会污染）
- 打回原因进评论，作为下一个 Run 的交接内容

**Run 失败 ≠ 站失败**：本地 `outcome=failed` 的 Run，人可以在本地「重新发起」（现有能力）。站的成败由 §5 的判据定，不由单个 Run 定。

---

## 7. 需求③自动成立

「本地任务不全上云，只同步云端下发的」——**Run 都源于 Stage，Stage 都源于云端 Issue**，所以本地自己敲的任务压根没有 Issue、也就没有 Run 行、自然不上云。

连带作废（都是为「全量上云」设计的）：

- 决策 5（`origin='local'` 的 prompt 上行）
- `task.origin` 的 `local` 分支
- `mirror='local_missing'` 对本地任务的语义（对云端派的任务仍有意义：派下去的活被本地删了）

**代价（必须知道）**：P1 单独交付的价值没了。当初把 P1 排前面、说它「已交付查看执行情况的全部价值」，前提是「所有任务都上云」。这条一改，**P1 必须和 P2 一起才有意义**，云端在下行落地前是空的。

---

## 8. 看板 = multica 的 issue 看板

有了 Issue 层，看板自然就是 multica 那个形状，而不是现在这个按 state 分桶的镜像面：

- 列 = Issue 状态（人的视角），不是 Run 的 5 态
- 卡 = Issue，显示当前在第几站 / 谁在做 / 卡了多久
- 点进去 = 站的时间线 + 每站的 Run（哪台机器、什么结论、什么产物）+ 评论流
- Run 的 5 态（processing / awaiting-human / …）降级为**详情里的执行细节**，不再是看板主轴

视觉基准仍是 `multica-style-guide.md`（oklch token / 圆角阶梯 / mono 字体 / lucide 图标），组件继续用 `cloud/public/ui.js` 那套自研的（禁原生 select / alert，见 round-2）。

---

## 9. 对现有代码的冲击

| 位置 | 冲击 |
|---|---|
| `cloud/migrations/` | 新增 `agent` / Issue 层；`task` 表更名/改造为 `run`。**当前生产库无真实数据**（51 条全是本地任务，按需求③本就不该在云端），清库重来成本 ≈ 0 |
| `cloud/public/` | 看板重写（issue 中心）。`ui.js` 组件层可复用 |
| `cloud/src/routes/` | 新增 Issue / Stage / Agent 端点；`/api/tasks` → `/api/runs` |
| **`platform/`（本地）** | **几乎不动**——本地不需要知道 Issue 的存在。它只是收 intent（prompt + cwd + model）、跑、上报 Run 状态。Issue/Stage/屏障全在云端。connector 只需加一条：**只上报有云端 link 的任务** |

**本地保持无知是这个设计最好的性质**：流水线的复杂度全在云端，本地那套已验证的状态机 / 会话引擎 / 磁盘契约一行不改。

---

## 10. 未收敛

2. **流程模板**：每建一个需求都手敲五站不现实。要 `pipeline_template`（研发流程 / 内容流程 / …）实例化成 stages。对「各种场景」是刚需，但可以二期
3. **同站并行的产物怎么合并**：三个平台的验证结论怎么组装给下一站？简单拼接还是要结构化？没想清楚
4. **Issue 状态由谁定**：人设 vs 从 stage 进度派生。倾向人设（云端权威），但屏障关闭时要不要自动推进 Issue 状态，没定
5. **agent.machine_id 为空时怎么选机器**：轮询 / 挑负载最低 / 报错要人指定？P2 的路由问题被这个模型放大了
6. **外部来源建 Issue**（用户说的「需求、产品或外部来源」）：webhook？API？没设计
