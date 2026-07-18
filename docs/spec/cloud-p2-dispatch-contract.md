# 云端控制面 · P2 实现契约（云端下发队列 / 意图下行）

> 权威设计：[`cloud-control-plane.md`](cloud-control-plane.md)（决策表 §9 的 8/9/10/13/14/15/16 直接约束本期）
> 前一期契约：[`cloud-p0p1-contract.md`](cloud-p0p1-contract.md)（本文只写**增量与改动**，未提及处一律照旧）
> 流程模型：[`cloud-pipeline-model.md`](cloud-pipeline-model.md)（流程本期不做；§5「agent 显式声明完成」本期就用）
> 迁移：[`../../cloud/migrations/002_p2_intent_dispatch.sql`](../../cloud/migrations/002_p2_intent_dispatch.sql)（已在一次性库验证 16/16，见 §11）
>
> 本文是**对着最新 master 重做**的：很多地基已经存在（绊线、machine 鉴权、auth/db/http helper），
> 本文的活是**只补「云端下发队列」这一个 master 尚无的缺口**——`user.js:5` 白纸黑字留的
> 「P1 里也不写 task（P2 才有云端建任务）」那块。**别重复造已有的东西**（见 §0）。

---

## 0. master 已有、本期直接复用（不重建、不改写）

| 地基 | 位置 | 本期怎么用 |
|---|---|---|
| **决策 13 绊线** | `cloud/src/dispatch-gate.js`：`requireDispatchAllowed`(preHandler) / `isDispatchBlocked` / `BIND_HOST` / `logDispatchPosture` | 建意图 / 取件端点**直接挂** `requireDispatchAllowed` preHandler（§6）。**不许**再发明第二个 `dispatchEnabled` 开关 |
| **machine 鉴权** | `cloud/src/auth.js`：`requireMachine`（`req.machine.{machineId,workspaceId}`）；`requireSession`（`req.auth.{user,workspaceId}`） | 机器侧端点 `requireMachine`，人侧端点 `requireSession`，照抄 P0P1 用法 |
| **凭据铸造** | `auth.js`：`mintCredential` / `mintEnrollmentCode` / `verifyRegistrationKey` | 本期不签发新凭据，无需碰 |
| **DB helper** | `cloud/src/db.js`：`q` / `withTx` / `pool` | 所有查询走 `q` / `withTx`，别自己开连接 |
| **HTTP helper** | `cloud/src/http.js`：`sendError` / `rateLimit` | 错误体统一走 `sendError(reply, code, CODE, msg)` |
| **task 表下发列** | `002_*.sql` 已加 `auto_run/dispatch/dispatched_at/reject_reason` + 偏索引 | 见 §4；**已建好，别再改表** |

**明确不碰**（别顺手动）：
- **决策 14 对账过滤**（本地任务不上云）由**另一条 PR（#67）**做，落在 `platform/lib/cloud/{reconcile,links}.js`。
  本文**只管让云端派的任务 `origin='cloud'`**；上行过滤是 #67 的事。§7 的 `links.js` 读写 API 是**与 #67 共享的接口**，本文只钉格式。
- **手机中继**（`routes/{machine-relay,my}.js`、`platform/lib/cloud/{downlink,relay-verbs}.js`）——那是「手机伸进本地 app」，与本期「云端建任务派到机器」是两回事。
- **本地外部 API** `/api/external/task/create`（密钥鉴权）。
- **平台核不变量**（README:43-47）：`source` 只是元数据，**禁止** `startsWith('cloud:')` / `source==='cloud'` 特判，分支按 state 走。

---

## 1. 本期范围

**做**：人在云端建任务（title/prompt/model/effort/cwd/worktree/baseBranch/autoRun + **machineId**）→ 落到该机器
（其 owner 派生自 `machine.owner_user_id`，决策 16 **没有** `assignee_user_id` 列）→ 意图队列下发 →
本地 connector 拉取 → cwd 白名单 → 自动执行闸门 → `createTask({source:'cloud', plan})` → 写 link → ack。
外加决策 15（agent 显式声明完成）。**取消未下发的意图**。

**不做**（决策 16 + 用户明确划线）：流程 / 站 / 屏障 / agent 人格；决策 14 对账过滤（#67）；绊线本体（已有）；
命令下行（回复 / 中断 / 确认执行 = P3）、transcript 拉流（P4）、cron（P5）、WS（下行用 HTTP 轮询即可，
设计 §6.4 的 `cloud:intent_available` 帧是优化不是必需）；路由 / 能力匹配（**能用才能选**：UI 只列 online 机器，人直接指）。

### 1.1 四条不许拆的不变式（沿用 P0P1 §1.1，本期第 4 条吃重）

1. **本地是执行真相的唯一权威**，云端只是镜像。云端**永不写** `task_status` / `task_history`。
2. **`source` 只是来源元数据，不是行为开关**（README:43-47）。connector 与云端一律按 **state** 分支，
   **绝不**写 `startsWith('cloud:')` / `source === 'cloud'` 去改变处理逻辑。
3. **所有本地→云端都是出站**。本地 8799 永远只绑 `127.0.0.1`，云端拿不到入站访问。
4. **闸门判定在本地，云端说了不算**（§7）。cwd 白名单与自动执行闸门的判据都在 `runner-config.json` 与
   `identity.json` 里，云端只提供**输入**（`cwd` / `autoRun` / `createdBy`），不提供**结论**。
   任何把「跑不跑」的决定权挪到云端的补丁（如让云端下发 `plan:false`）**都不许过**。

> ⚠ 第 2 条与「给云端任务的 prompt 追加完成协议」不冲突：那是**创建者在 compose 自己的 prompt**
> （既有先例 `session-manager.js:34 appendAttachments` 往消息尾追加附件清单），不是状态机按来源分支。
> 任务一旦建出来，它与 manual / cli 任务在状态机里**逐字节同权**（§8.3）。

---

## 2. 决策表映射（照着核对，别自作主张改）

| 决策 | 落到本契约哪里 |
|---|---|
| **8/9 自动执行闸门** | `autoExec = intent.autoRun ∧ (local==='on' ∨ (local==='owner-only' ∧ 发起人===机器主人))`，**本地算**。闸门就是 `createTask` 的 `plan` 入参（`task-actions.js:466` 的 `planFirst` 已支持）→ §7.2。**不动 `planSources`**（那是整来源一刀切，我们要逐任务） |
| **10 cwd 白名单** | `runner-config.cloudAllowedCwds`，**默认空 = 拒绝一切云端任务**，本地判定 → §7.1 |
| **13 明文部署绊线** | 直接挂 master 已有的 `requireDispatchAllowed`（`dispatch-gate.js`）→ §6。不新造开关 |
| **14 本地任务不上云** | 对账按 link 过滤由 **#67** 做；本文只保证云端派的任务 `origin='cloud'`（§4）。迁移**不删 origin、不删行** |
| **15 agent 显式声明完成** | `--disallowedTools AskUserQuestion`（仅 bypass 会话）+ `completeTask` 收 `resolvedBy='agent'` + agent 靠 env 知道自己的 taskKey → §8 |
| **16 无流程 / 无 agent 人格** | 任务直接带 model/effort/cwd，指派对象 = **machineId**。**没有** `assignee_user_id` 列：owner = `machine.owner_user_id`，派生即得，多存一份就会漂移 |

---

## 3. 术语

| 词 | 是什么 |
|---|---|
| **intent（意图）** | 云端 `task` 表的一行，`origin='cloud'` 且 `dispatch='pending'`。**没有单独的 intent 表**——`intentId` 就是 `task.id`（uuid） |
| **link（链接）** | 本地 `$DATA_ROOT/runtime/cloud/links.json` 里的一条：`intentId → 本地 taskKey`。下行幂等的锚，也是决策 14 对账过滤的依据（§7.3 / #67） |
| **闸门（gate）** | 「这个云端任务能不能不问人就直接跑」的**本地**判定。结论只有一个去处：`createTask` 的 `plan` 入参 |
| **发起人（creator）** | 在云端点「建任务」的人。`task.creator_user_id`，**只从会话取，绝不从请求体取**（§5.1 红线） |
| **机器主人（owner）** | `machine.owner_user_id`，首次 enroll 时生成配对码的那个人（决策 12：重注册不改） |

---

## 4. 数据库：迁移 `002_p2_intent_dispatch.sql`（已写完，已在一次性库验证，⚠ 未对生产执行）

### 4.1 只做一件事：给 `task` 加下发队列四列 + 取件偏索引（**不删 origin，不删任何行**）

```sql
alter table task
  add column auto_run boolean not null default false,
  add column dispatch text check (dispatch in ('pending','delivered','rejected')),  -- 可空
  add column dispatched_at timestamptz,
  add column reject_reason text;
create index task_pending_intent_idx on task (machine_id) where dispatch = 'pending';
```

**几个刻意的选择（评审照这张卡看）：**

- **`origin` 原样保留（双值 `cloud`|`local`）**。上行过滤（本地任务不上云）由 #67 在**本地 connector** 侧按 link 做，
  不靠删列 / 删行。一列只剩单值才该删；本表 `origin='local'` 仍是 P1 主干在写的镜像行（`machine.js:241`）。
  P1 已导入的 51 条 `origin='local'` **一行不动**（它们是「查看执行情况」的主体，删了看板就空了）。
- **`dispatch` 可空、无默认**：`origin='local'` 行从不经云端下发 → `dispatch=null`
  （`machine.js:241` 的 upsert insert 不写这列 → 落 null，正确）。`origin='cloud'` 行由建意图端点显式写 `'pending'`。
- **`dispatch` 只三值，`cancelled` 不进枚举**：设计 §5.3 就是 `pending|delivered|rejected`。
  「取消未下发意图」用 **DELETE**（§5.2）——pending 行没有任何本地/镜像足迹（无 `task_status`、无 `task_history`、
  `local_task_key` 仍 null），删掉即「这条从未到达机器的意图不复存在」，语义干净，不用第四个枚举值。
- **`auto_run not null default false`**：对 `origin='local'` 无意义但无害（它们本就不经闸门、在本地直接跑）——
  收敛设计 §9b.6 的未决为「local 行 auto_run 恒 false / 被忽略，UI 不显示为可控」。
- **不改 `creator_user_id` 约束**：001 已有 `check(origin<>'cloud' or creator_user_id is not null)`——
  保留 `origin` 就保留了这条条件约束，`origin='cloud'` 天然被强制填发起人（§7.2 闸门判据），无需改成无条件 not null。
- **不建 `audit_log`**：`task` 自己的 `creator_user_id + created_at + dispatch + dispatched_at + reject_reason`
  **就是**意图的完整审计链。P3 命令下行没有自带载体，到那时再建（001 头注也是这么划的线）。

### 4.2 部署顺序（与 P1「删列」草案相反，此版更安全）

纯 `ALTER ADD COLUMN`（常量默认，PG 11+ 元数据变更不重写表）+ `CREATE INDEX`，**不删列 / 不删行 / 不改现有列**
→ 生产上正在跑的 P1 代码（`select t.origin`、`insert origin='local'`）**一个字都不 break**。
可先跑迁移、再上 P2 代码；也可同批。回滚 SQL 在迁移文件尾（结构可整体回退且不丢行）。

### 4.3 生产库现状（2026-07-18 只读核对，实测非估计）

```
app_user: 1 | machine: 1 | task 是否已有 P2 列: 0（未跑过）| origin 列在: 1
```
迁移**未**对生产执行（由主 session 上线时做）。同实例 `claude_center` / `novel_writer` 不碰。

---

## 5. 云端端点（逐字段）

### 5.0 §3.3 写权限矩阵（P1 的表本期扩写，照这张卡评审）

| 表 / 列 | 人类鉴权 handler（`user.js`） | 机器鉴权 handler（`machine.js`） |
|---|---|---|
| `task` **spec 面**（title/prompt/model/effort/cwd/worktree/base_branch/description/`auto_run`/`creator_user_id`/`origin='cloud'`） | **建意图 / 取消**（本期新增） | **无权**（云端撰写、云端权威） |
| `task` **下发面**（`dispatch` / `dispatched_at` / `reject_reason` / `local_task_key`） | 建时置 `pending`；取消删 pending 行 | **ack / reject 写这几列**（下发是机器与云端的握手） |
| `task`（`origin='local'` 导入行） | 无权 | P1 既有 upsert 照旧（`machine.js:238`），本期不动 |
| `task_status` / `task_history` | **永不写**（红线不变） | 唯一写入方（`upsert`），本期不动 |

### 5.1 `POST /api/tasks` — 建意图（新增）

`preHandler: [requireDispatchAllowed, requireSession]`（绊线在鉴权前，§6）。

```jsonc
// body
{
  "machineId": "uuid",          // 必填。UI：先选人 → 再选他名下 online 的机器（前端用已有 GET /api/machines 过滤）
  "title": "string",            // 必填，trim 后 1..200
  "prompt": "string",           // 必填，trim 后 1..100000（与本地 task-actions createTask 同量级）
  "cwd": "string",              // 必填！1..1000，必须绝对路径。见下「为什么 cwd 必填」
  "model": "string|null",       // 可空 → 本地用机器自己的 defaultModel（task-actions.js:430）
  "effort": "string|null",      // 可空。low|medium|high|xhigh|max
  "worktree": false,            // 默认 false
  "baseBranch": "string|null",
  "description": "string|null", // <=2000，纯备注不进 prompt
  "autoRun": false              // 默认 false。只是**意愿**，跑不跑由本地闸门定
}
// 201
{ "id": "uuid", "dispatch": "pending", "createdAt": "ISO" }
```

**校验（顺序即语义）**
1. `machine`：同 workspace + `revoked_at is null` + **`status='online'`** → 否则 `409 MACHINE_UNAVAILABLE`。
   不存在 / 跨 workspace → `404 NOT_FOUND`（§3.4 不泄露「存在但你没权限」）。
   *为什么建时要求 online*：决策 16「**能用才能选**」。建完机器掉线不影响——意图挂 `pending` 等它回来（§5.3）。
   **建时要求在线、下发容忍离线**不矛盾：前者「别对着从没连过的机器许愿」，后者「已许的愿不因掉线作废」。
2. `model` / `effort` 落在**与本地逐字相同**的白名单（§5.6）。云端先挡一道纯为体验；本地 `createTask` 再挡一次才是权威。
3. `title` / `prompt` / `cwd` trim 后非空；`cwd` 必须 `path.isAbsolute`。
4. **`creator_user_id = req.auth.user.id`** ⚠ **红线：绝不从 body 取**。它是 owner-only 闸门判据，
   一旦可由请求体指定，任何登录用户都能自称机器主人 → 闸门当场失效。
5. insert：`origin='cloud'`, `dispatch='pending'`, `auto_run=$autoRun`, `workspace_id=req.auth.workspaceId`, `machine_id`, 上述 spec 列。

**为什么 `cwd` 必填**：`createTask` 的 cwd 可空，空则 claude 跑在**桌面 app 进程自己的 CWD**里
（`session-manager.js:206` 的 `cwd: cwd || process.cwd()`）——那不在任何白名单里，是最不该被云端指到的地方。
云端任务必须显式说清在哪跑；本地白名单才有东西可校验。

**谁能派**：任何登录成员对任何 online 机器（决策 9「都能派」，无 `assign_policy`）。派活不需权限，自动执行才需要。

### 5.2 `POST /api/tasks/:id/cancel` — 取消未下发的意图（新增）

`preHandler: [requireSession]`（**不挂绊线**：取消只**移除**、不造成下发，且运维中途关掉开关也该能收口）。

```sql
delete from task
 where id = $1 and workspace_id = $2 and origin = 'cloud' and dispatch = 'pending'
 returning id;
```
- `rowCount = 1` → `200 { ok:true, cancelled:true }`。pending 意图无 `task_status`/`task_history`/`local_task_key`
  足迹，删行即彻底消失（无级联残留）。
- `rowCount = 0` → 再查该行判分支：
  - 不存在 / 跨 workspace / `origin<>'cloud'` → `404 NOT_FOUND`
  - `dispatch='delivered'` → `409 ALREADY_DISPATCHED`（响应带当前 `dispatch`）。已下发的撤回是 **P3 命令下行**，本期不做
  - `dispatch='rejected'` → `409 ALREADY_REJECTED`
- **谁能取消**：任何登录成员（决策 9「都能派」的对称面）。取消只会**阻止**执行，fail-safe 方向，不设额外权限。
- **竞态（已知、可接受）**：机器已 `GET` 到该意图、尚未 ack 时人点取消 → 云端 DELETE 行 → 机器随后 ack
  命中 0 行 → `404`。此时本地任务确实已建出（本地权威，不变式 1），成了**本地可见的孤儿**：connector 收到 ack 404
  即把该 link 撤掉（§7.4），本地看板照常显示这张卡，主人可在本地中断 / 归档。
  取消的承诺仅限「**还没被取走的**意图不会再下发」。窗口极小（机器 GET→ack 只隔几百 ms～数秒），
  且「未下发」语义本就指「机器还没接手」——赛在这个窗口里，`404`/孤儿是可接受的收口。

### 5.3 `GET /api/machine/intents` — 取件（新增）

`preHandler: [requireDispatchAllowed, requireMachine]`（**造成下发 → 挂绊线**，§6）。

```sql
select id, title, prompt, model, effort, cwd, worktree, base_branch, description, auto_run,
       creator_user_id
  from task
 where machine_id = $1 and dispatch = 'pending'          -- 命中 task_pending_intent_idx
 order by created_at asc limit 50;                        -- FIFO
```
```jsonc
// 200 —— 字段逐字对齐设计 §6.4
{ "intents": [{
    "intentId": "uuid",
    "title": "...", "prompt": "...", "cwd": "D:\\proj",
    "model": "claude-opus-4-8|null", "effort": "xhigh|null",
    "worktree": false, "baseBranch": "master|null", "description": "...|null",
    "autoRun": true,
    "createdBy": { "userId": "uuid", "name": "孙鹏" }      // join app_user 取 name
}] }
```
> 设计原文画的是裸数组；这里包一层 `{intents}`，与 P1 既有的 `{machines}` / `{tasks}` / `{needFull}` 一致。

⚠ **GET 绝不改 `dispatch`**。取件不是下发，**ack 才是**。若 GET 就翻 `delivered`，connector 在建任务前崩一次，
这个意图就永久消失（云端以为发过了，本地什么都没有）。at-least-once 全靠这条：重复下发有 link 兜底（§7.3），
丢失下发无人兜底。

### 5.4 `POST /api/machine/intents/:id/ack` — 回执（新增）

`preHandler: [requireMachine]`（**不挂绊线**，理由同 §5.2：让已在飞的意图落地收口，别制造孤儿）。

```jsonc
{ "localTaskKey": "cloud:20260718153012-482" }   // 1..200
```
```sql
-- 一条语句同时兑现「首次 ack」与「重发 ack」，别写成先 select 再 update（中间有竞态）
update task
   set dispatch       = 'delivered',
       dispatched_at  = coalesce(dispatched_at, now()),   -- 重发不刷新：它是首次 ack 成功的时刻
       local_task_key = $3
 where id = $1 and machine_id = $2 and origin = 'cloud'
   and ( dispatch = 'pending'                                   -- 首次 ack
      or (dispatch = 'delivered' and local_task_key = $3) )     -- 重发 ack → 幂等命中
 returning id, dispatched_at;
```
- `rowCount = 1` → `200 { ok:true, dispatchedAt }`。
- `rowCount = 0` → 再查该行判分支：
  - 行不存在 / 不属本机 → `404 NOT_FOUND`（含 §5.2 竞态：意图被取消删掉了）
  - `dispatch='delivered'` 但 `local_task_key` **不同** → `409 ALREADY_ACKED`（同一意图建出两个本地任务 = 本地幂等破了，必须响）
  - `dispatch='rejected'` → `409 ALREADY_REJECTED`
- **必须幂等**：ack 响应丢包时 connector 下一轮凭 link 直接重 ack（§7.4）。
- **`dispatched_at` 是 ack 成功的时刻，不是 GET 到的时刻**。
- **`local_task_key` 回填后**，机器后续对账（#67 过滤后仍会上报**有 link** 的云端任务）经既有 `upsert` 的
  `on conflict (machine_id, local_task_key)` 命中这行：`do update ... where task.origin='local'`（`machine.js:248`）
  对 `origin='cloud'` 行**不触发 spec 覆盖**（云端权威），落到 `if (!taskId)` 分支（`machine.js:259-268`）SELECT 出 id、
  只写 `task_status`。**这条链 master 已就位（注释 `machine.js:260` 明说「冲突行是 origin='cloud'（P2 才有）」），本期不改 upsert**。
- **设计里 ack body 的 `state` 字段本契约不收**：无处安放（写 `task_status` 需要 rev，rev 只有本地能算），
  且 15s 内对账就把真实 state 带上来（`plan` 卡也在对账桶里）。存不进任何列的字段不进契约。

### 5.5 `POST /api/machine/intents/:id/reject` — 拒收（新增）

`preHandler: [requireMachine]`（不挂绊线，同上）。

```jsonc
{ "reason": "工作目录不在本机白名单：D:\\evil" }   // 1..500，机器给的自由文本
```
```sql
update task
   set dispatch = 'rejected', reject_reason = $3
 where id = $1 and machine_id = $2 and origin = 'cloud'
   and ( dispatch = 'pending'
      or (dispatch = 'rejected' and reject_reason = $3) )   -- 重发 reject → 幂等命中
 returning id;
```
- `rowCount = 1` → `200 { ok:true }`；`0` → 行不存在 `404`；已 `delivered` → `409 ALREADY_ACKED`。
- `reason` 原样存、原样显示。⚠ **机器可写的自由文本 → 云端 UI 渲染必须 `escapeHtml`**（`cloud/public/app.js` 已有该函数）。
- reject **不需要本地记账**：云端置 `rejected` 后就不在 pending 集合，永不再下发；reject 丢包 → 意图仍 pending
  → 下轮重新拉到 → 重新判定 → 再 reject。天然幂等，本地不必落盘。

### 5.6 model / effort 白名单（与本地逐字相同，否则本地 `createTask` 直接拒 → 变 reject）

- `model`：`claude-opus-4-7` / `claude-opus-4-8` / `claude-sonnet-5` / `claude-haiku-4-5-20251001` / `claude-fable-5`（`task-actions.js:23-29`）
- `effort`：`low` / `medium` / `high` / `xhigh` / `max`（`task-actions.js:31`）

### 5.7 P1 既有端点的两处**新增字段**（向后兼容，不改现有行为）

#### a. `POST /api/machine/enroll` 响应加 `ownerUserId`（**owner-only 闸门的前提**）

本地要拿 `identity.ownerUserId` 和 `intent.createdBy.userId` 比对（§7.2），而今天 `identity.json` 里**没有**
这个字段。改法（`machine.js` 第 3 步 upsert）：

```js
// returning 加一列（upsert 之后的值 —— on conflict 更新列里没有 owner_user_id，机器重注册返回的仍是原主人，
// 决策 12「重注册不改归属」自动兑现，不用特殊处理）
returning id, display_name, workspace_id, owner_user_id
// 响应体加一个字段
return { token, machineId, workspaceId, workspaceName, displayName, ownerUserId: out.machine.owner_user_id };
```

#### b. `POST /api/machine/heartbeat` 响应加 `pendingIntents`（取件的廉价提示）

```js
// requireMachine 之后，heartbeat handler 末尾多查一次（read-only，P0 面，不受绊线约束）：
const p = await q(`select count(*)::int n from task where machine_id = $1 and dispatch = 'pending'`,
                  [req.machine.machineId]);
return { serverTime: ..., machineId: req.machine.machineId, pendingIntents: p.rows[0].n };
```
connector 用它当**门铃**：`pendingIntents > 0` 才 `GET /api/machine/intents`，idle 机器每 tick 省一次请求（§7.4）。
设计 §6.2 就是这个模型（P0P1 因无下行把它砍了，`machine.js:188-190` 注释「P2 加回来是新增字段」）。

#### c. 看板读端点 `GET /api/tasks` / `:id` 的接缝（**本文只提要求，实现随云端 UI 那条走**）

`pending` / `rejected` 的意图**没有** `task_status` 行（本地还没建任务，谁也报不上来），而设计 §6.4 要「机器离线 →
UI 显示待下发」。现在 `join task_status`（`user.js:355`）会让这些意图**根本查不出来**。
→ 需把 `task_status` 改 **LEFT JOIN**，`mapTaskRow` 对 `status` 为 null 的行只回 dispatch 面。
**这不在本文的五个下发端点里**，但建意图端点上线后必须同步，否则「建了看不见」。列为 §10 接缝 C。

---

## 6. 接线点①：绊线（决策 13，直接复用 `dispatch-gate.js`，不新造）

master 的 `cloud/src/dispatch-gate.js` 已导出 `requireDispatchAllowed`（fastify preHandler）。判据（`isDispatchBlocked`）：
```
CLOUD_INSECURE_COOKIE=1  且  BIND_HOST 非 localhost  且  CLOUD_ACCEPT_PLAINTEXT_DISPATCH≠1  → 503 PLAINTEXT_DISPATCH_BLOCKED
```
启动姿态日志由 `server.js:86 logDispatchPosture()` 已经在打——**本期不必新增启动日志**。

**挂在哪两个端点**（且**必须排在鉴权 preHandler 之前**，与 `my.js:43` / `machine-relay.js:26` 同款写法）：

| 端点 | preHandler | 为什么 |
|---|---|---|
| `POST /api/tasks`（建意图） | `[requireDispatchAllowed, requireSession]` | **造成**下发 → 明文姿态下必须封 |
| `GET /api/machine/intents`（取件） | `[requireDispatchAllowed, requireMachine]` | **造成**下发 → 明文姿态下必须封 |
| `POST /api/tasks/:id/cancel` | `[requireSession]` | 只**移除** → 不封（封了运维关开关会挡住收口） |
| `POST /api/machine/intents/:id/ack` `/reject` | `[requireMachine]` | 让**已在飞**的意图落地 → 不封，否则制造孤儿 |
| `POST /api/machine/heartbeat` | `[requireMachine]`（原样） | P0 面，`pendingIntents` 只读，不封 |

> **为什么不删这道闸**：决策 13 是在「P1 只读、风险有界」前提下做的；P2 让前提失效（明文泄露 `swuk_` →
> 给所有机器派活 → 全员开发机 RCE）。闸的用途不是拦用户，是**防止有前提的判断被静默继承**——
> 开下行的人必须亲手写下 `CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1`，那一刻他就知道自己在接受什么。

---

## 7. 接线点②：本地下行（connector 拉 intent → 闸门 → createTask → ack）

> 全部只用 `node:` 内置，**禁止**给根 `package.json` 加依赖（硬约束 1）。

### 7.1 配置：`runner-config.json` 新增两个键（`runner-config.js` 的 `readConfig()` 热加载，不改该文件）

```jsonc
{
  // §7.2 / 决策 10：云端任务的 cwd 必须落在其中某条之下。**默认空 = 拒绝一切云端任务**。
  "cloudAllowedCwds": [],
  // §7.2 / 决策 8：本地对「云端说这活可以自动跑」的接受程度。缺省 = 'owner-only'
  "acceptAutoRun": "off" | "owner-only" | "on"
}
```
**`acceptAutoRun` 默认 `'owner-only'`**（收敛设计 §9b.3 未决）：`cloudAllowedCwds` 默认空硬拒一切，所以新 enroll 的机器
在主人手动加白名单之前，`owner-only` 与 `off` 行为完全一样——9b.3 担心的「新机器自动跑东西」被白名单挡死。
等主人主动加了白名单目录，他已在做深思熟虑的决定，此时 `owner-only`（自己派的直接跑、同事派的要确认）正是决策 9 原意。
**真正的遏制从来是 cwd 白名单，不是这个档位**（§7.3 的 ⚠）。

### 7.2 闸门判定的精确伪码（本地算，云端说了不算）

**cwd 白名单**（`platform/lib/cloud/cwd-allow.js`，唯一不依赖云端诚实的防线）：
```js
// 归一化到「可比较」形态：解析 .. / 符号链接 / junction / Windows 8.3 短名，再按平台定大小写。
// 解不开（目录不存在）→ null → 一律拒绝：白名单比对必须在真实路径上做，否则 D:\a\..\b、D:\PROGRA~1 能绕过前缀比较。
function canon(p) {
  const s = String(p || '').trim();
  if (!s || !path.isAbsolute(s)) return null;          // 相对路径不收：resolve 会拿进程 CWD 兜底 → 不可预期
  let r; try { r = fs.realpathSync.native(path.resolve(s)); } catch { return null; }
  return process.platform === 'win32' ? r.toLowerCase() : r;   // Windows 路径大小写不敏感
}
export function isCwdAllowed(cwd, allowList) {
  const c = canon(cwd);
  if (!c) return false;
  if (!Array.isArray(allowList) || allowList.length === 0) return false;   // 空 = 拒绝一切（§7.1 默认）
  for (const entry of allowList) {
    const a = canon(entry); if (!a) continue;
    if (c === a) return true;
    const prefix = a.endsWith(path.sep) ? a : a + path.sep;   // ⚠ 补分隔符：裸 startsWith 会让 D:\proj 放行 D:\projEVIL
    if (c.startsWith(prefix)) return true;
  }
  return false;
}
```

**自动执行闸门**（`platform/lib/cloud/gate.js`）：
```js
const MODES = new Set(['off', 'owner-only', 'on']);
// 缺省 / 脏值 → 'owner-only'（默认档）。脏值退默认档而不是抬到 'on' —— 打错字不该放宽。
export function acceptAutoRunMode(cfg) { const v = cfg?.acceptAutoRun; return MODES.has(v) ? v : 'owner-only'; }

// autoExec = intent.autoRun ∧ ( local==='on' ∨ (local==='owner-only' ∧ 发起人===机器主人) )
// 返回 true = 直接跑（createTask 的 plan=false）；false = 落 plan 等人在看板点确认。
export function computeAutoExec({ intent, cfg, identity }) {
  if (!intent?.autoRun) return false;                  // 云端没勾 → 一票否决
  const mode = acceptAutoRunMode(cfg);
  if (mode === 'on') return true;
  if (mode !== 'owner-only') return false;             // 'off'
  const owner = identity?.ownerUserId, creator = intent?.createdBy?.userId;
  // 两边都必须是非空字符串且严格相等；任一缺失 → 失配 → 落 plan（fail-closed）。
  // 升级路径：老 identity.json 没有 ownerUserId → 恒 false → 一切云端任务落 plan（§7.5）。
  return typeof owner === 'string' && owner.length > 0 && owner === creator;
}
```

### 7.3 link 文件格式（`$DATA_ROOT/runtime/cloud/links.json`）——**与 #67 共享，两侧必须同意这份格式**

```jsonc
// 单文件 map（照抄 synced.js 的形态：一次读、一次 rename 落盘 = 原子）
// { "<intentId>": { "taskKey": "cloud:2026…-482"|null, "reservedAt": "ISO", "createdAt": "ISO"|null, "ackedAt": "ISO"|null } }
```
`links.js` 需导出（**#67 提供该文件；本文只钉 API 与语义**）：
```js
export function readLinks()       // → object；不存在 / 坏 JSON → {}。绝不抛
export function writeLinks(map)    // 整体覆写，先 .tmp 再 rename（原子，照抄 synced.js:19-25）
export function linkedTaskKeys()   // → Set<string>，只收 taskKey 非 null 的。**#67 对账过滤的依据**（决策 14）
```
- **为什么单文件而非设计画的 `links/<intentId>.json` 目录**：决策 14 后对账**每 15s 都要一次反向索引**
  （taskKey 集合）。目录形态每轮 readdir + N 次读；单文件一次读就够，写入一次 rename = 原子。
  设计给命令幂等用的 `applied.json` 本就是单文件——本文把 link 拉到同一形态。
- **`taskKey: null` 是占位态**（§7.4 的 d 步）：intent 已开始处理但本地任务还没建成。`linkedTaskKeys()`
  跳过它 → 不会被 #67 误当「已建成」上报。
- 容量：一条约 120 字节，一 intent 一条，永不修剪（§9 缺口 4）。

### 7.4 单个意图的处理：设计 §6.4 的 a–f，**先占位后建**（`connector.js` 的 `tick()` 末尾加一步）

```js
// tick() 顺序：heartbeat（401 终局在这里判）→ reconcileOnce（P1 主干，#67 已加 link 过滤）→ pullIntents（新增）
// 下行放最后：意图处理抛错不该影响上报；createTask 自己会立刻起会话，不靠本 tick 后续步骤。
if (!(await heartbeat(target, snap))) return;
const r = await reconcileOnce(target, snap, { full: tickN % DIGEST_EVERY === 0 });
...
if ((snap.__lastHeartbeatPendingIntents ?? 1) > 0) await pullIntents(target);   // 门铃：pendingIntents>0 才拉

async function pullIntents(target) {
  let r;
  try { r = await cloudRequest(target, 'GET', '/api/machine/intents'); }
  catch (e) { lastError = `拉取意图失败：${e.message}`; return; }      // 网络错 → 下一 tick 重试
  if (r.status === 401) return onUnauthorized();                       // §7.4 401 是终局（connector.js:42）
  if (r.status === 503) { lastError = '云端未放行下行（CLOUD_ACCEPT_PLAINTEXT_DISPATCH 未设）'; return; }
  if (r.status !== 200) { lastError = `拉取意图失败：HTTP ${r.status}`; return; }
  for (const it of (r.json?.intents || [])) await handleIntent(target, it);
  lastIntentAt = new Date().toISOString();   // connectorStatus() 的穷举字段加它；**不加任何凭据字段**（connector.js:127 红线）
}

async function handleIntent(target, intent) {
  const id = String(intent?.intentId || '');
  if (!id) return;
  const links = readLinks();
  const link = links[id];

  // a. 幂等：已建过 → 直接重 ack（上一轮 ack 响应丢了才走到这）
  if (link?.taskKey) return void await ackIntent(target, id, link.taskKey);
  // a'. 有占位但没 taskKey = 上一轮崩在 createTask 中途 → fail-closed，绝不重建第二个
  if (link) return void await rejectIntent(target, id, '本地上次创建被中断（占位残留），请在云端重新下发');

  // b. cwd 白名单（§7.2）——唯一不依赖云端诚实的防线，放最前
  const cfg = readConfig();
  if (!isCwdAllowed(intent.cwd, cfg.cloudAllowedCwds)) {
    return void await rejectIntent(target, id, `工作目录不在本机白名单：${intent.cwd ?? '(空)'}`);
  }

  // c. 闸门（§7.2）：本地算，云端说了不算
  const autoExec = computeAutoExec({ intent, cfg, identity: readIdentity() });

  // d. 先占位：崩在 d–e 之间时下一轮认得出（走 a'），不会建出第二个任务
  writeLinks({ ...links, [id]: { taskKey: null, reservedAt: new Date().toISOString() } });

  // e. 同一条代码路径（不变式 2）——不新写 runner、不碰 planSources。createTask 真实签名见 task-actions.js:425
  const cr = createTask({
    source: 'cloud',
    title: intent.title,
    prompt: appendCompletionProtocol(intent.prompt),    // §8.3
    cwd: intent.cwd,
    model: intent.model || undefined,                   // 空 → 机器自己的 defaultModel（task-actions.js:430）
    effort: intent.effort || undefined,
    description: intent.description || undefined,
    worktree: !!intent.worktree,
    baseBranch: intent.baseBranch || undefined,
    plan: !autoExec,                                    // ★ 闸门的唯一去处（planFirst，task-actions.js:466）
    // 不传 scheduledAt（本期无 cron，传了会强制 plan、搅混闸门语义）；不传 dynamicWorkflow / attachments（意图无此字段）
  });
  if (!cr.ok) {
    const next = readLinks(); delete next[id]; writeLinks(next);   // 撤占位：这次没建出来，reject 是终局
    return void await rejectIntent(target, id, `本地建任务失败：${cr.error}`);
  }
  // f. 落 link 再 ack
  writeLinks({ ...readLinks(), [id]: { taskKey: cr.taskKey, reservedAt: link?.reservedAt ?? null,
                                       createdAt: new Date().toISOString(), ackedAt: null } });
  await ackIntent(target, id, cr.taskKey);
}
```

**为什么「先占位后建」而不是设计画的「建完再写 link」**：两个系统之间不存在 exactly-once。设计的顺序在 d–e 之间
崩溃会让下一轮**重新建一个任务**（两个都可能自动跑起来）；先占位则下一轮认得「上次崩在半路」→ fail-closed 拒绝，
最坏是**一个**孤儿任务（本地看得见、云端看不见），而不是**两个**都在跑。宁可漏一个要人重发，不可多跑一个没人知道的。

**ack / reject 的本地侧**（失败只记 `lastError`，靠下一轮凭 link 重来）：
```js
async function ackIntent(target, id, localTaskKey) {
  let r;
  try { r = await cloudRequest(target, 'POST', `/api/machine/intents/${id}/ack`, { localTaskKey }); }
  catch (e) { lastError = `ack 失败：${e.message}`; return; }              // 下一轮凭 link 重 ack
  if (r.status === 401) return onUnauthorized();
  if (r.status === 200) { const m = readLinks(); if (m[id]) { m[id].ackedAt = new Date().toISOString(); writeLinks(m); } return; }
  if (r.status === 404) {                                                  // §5.2 竞态：意图被取消删了
    const m = readLinks(); delete m[id]; writeLinks(m);                    // 撤 link → 本地任务成可见孤儿，主人自行处理
    lastError = `意图 ${id} 已被云端取消，本地任务留作孤儿`; return;
  }
  lastError = `ack 失败：HTTP ${r.status}`;   // 409 等 → 本地任务已建，**不回滚**，留给人看
}
// rejectIntent 同构：200 清 lastError；非 200 记 lastError，下一轮重来（reject 天然幂等，§5.5）
```

### 7.5 `identity.json` 新增 `ownerUserId`（owner-only 闸门的前提）

- `identity.js:7` 的「字段是穷举」注释同步加 `ownerUserId`；`connector.enroll()` 的 `saveIdentity({...})`
  加 `ownerUserId: d.ownerUserId ?? null`（`connector.js:191-198`，读 §5.7a 的 enroll 响应）。
- **为什么 enroll 时钉死、而不是每次心跳刷新**：心跳刷新等于给云端一条**随时重指「谁是机器主人」**的通道 →
  闸门判据被云端单方面掌控。enroll 钉死意味着改归属必须走一次配对码（真人动作），决策 12 说重注册也不改归属，
  所以这钉子正常路径上永不动。
- **P1→P2 升级路径（必须写进 `docs/ops/`）**：生产那台已 enroll 的机器 `identity.json` 里**没有** `ownerUserId`
  → `computeAutoExec` 的 owner-only 分支恒 false → 所有云端任务落 `plan`。**fail-closed 不是 fail-open**，
  但用户会觉得「勾了自动执行却没跑」。要用 owner-only 得**重新 enroll 一次**（生成配对码 → 设置页重连），
  或把 `acceptAutoRun` 设成 `'on'`。

---

## 8. 接线点③：决策 15 — agent 显式声明完成

### 8.1 `session-manager.js` 两处改动（`createSession`，`:176-206`）

```js
// ① 禁掉 AskUserQuestion —— 只对 bypass 会话（:180 附近）
if (bypass) {
  args.push('--dangerously-skip-permissions');
  args.push('--disallowedTools', 'AskUserQuestion');
} else {
  args.push('--permission-prompt-tool', 'stdio');
}

// ② 让 agent 知道去哪儿取自己的 taskKey（与 CLAUDE_CODE_WORKFLOWS 同处，:191 附近）
if (taskKey) {
  env.SCRUMWS_TASK_KEY = taskKey;
  // 端口与 platform/server.js:22 同源（同一个 env）；改默认要两处一起改。本机 127.0.0.1、不出网。
  env.SCRUMWS_API_BASE = `http://127.0.0.1:${Number(process.env.SCRUMWS_PORT) || 8799}`;
}
```
> ⚠ **`--disallowedTools` 必须挂在 `bypass` 上，不能无条件加一行**。设计 §5「一行」是照抄 multica daemon 语境
> （它只有非交互一种会话，我们有两种）。**证据**：非 bypass 会话的 AskUserQuestion 走 `can_use_tool` 通道 →
> 看板渲染成交互选项卡、实测可用（`docs/acceptance/board-interactive-session/round-9.md`）。而 `bypass=true` 就是
> `--dangerously-skip-permissions`、没有权限卡 → 问题永远到不了人眼前 = multica 说的「agent 默默自己猜」（GitHub #2588）。
> **禁的正好是坏掉的那一半，留的正好是能用的那一半**。无条件加会把 S8 那个实测能用的交互特性打死。
>
> **所有 task-runner 起的会话都是 `bypass:true`**（`task-runner.js:265/267/300`）→ 云端 / manual / cli adopt 一视同仁，
> **没有按 source 分支**（不变式 2）。

### 8.2 `completeTask` 收 `resolvedBy`（`task-actions.js:122-160`）

```js
export function completeTask({ taskKey, resolvedBy }) {
  ...
  // 'agent' = agent 自己声明做完了；其余一律 'user'。白名单取值，别原样透传调用方的串。
  const by = resolvedBy === 'agent' ? 'agent' : 'user';
  history.push({ state: 'done', at: nowStr, by });          // 原为写死 'user'（:142）
  ... outcomeDetail: { ...(state.outcomeDetail || {}), resolvedBy: by, failureReason: null }   // 原写死 'user'（:151）
}
```
- **状态机一个字节不改**：仍只有 `awaiting-human → done`（`:134` 的 guard 不动）。agent 走的是**和人完全一样**那条转换，
  只是 `by` / `resolvedBy` 记成 `agent`。`task-actions.js:120` 原注释「与 worker 自动 done 区分：`resolvedBy='user'`」——
  `resolvedBy` 存在的理由就是区分「谁判定的」，加 `'agent'` 是补全不是破坏。
- **人仍是最后一道闸**：agent 误判 → 本地看板看得见 → `/api/task/uncomplete` 撤回（现有能力）。
- **透传**：`platform/server.js:562-566` 的 `/api/task/complete` 改 `completeTask({ taskKey, resolvedBy: searchParams.get('resolvedBy') })`。
- **云端怎么看到**：`by='agent'` 随 `task_history` 上行（reconcile 的 `h.by` 原样透传，001 的 `task_history.by` 无 check）。
  `outcomeDetail.resolvedBy` **不上行**（对账 status 面没这个字段）——云端要区分就看 history 最后一条的 `by`。
- ⚠ **未物化 CLI 会话走 `completeCliSession(taskKey)`（`:128`）不受影响**（那条路没有 state.json 可写）。
  这是 README 已列的既存来源特判，**不在本期修**（别顺手改）。

### 8.3 agent 怎么知道自己的 taskKey（**它不需要字面值，只需知道去哪儿取**）

云端下发时不可能带 taskKey——taskKey 是 `createTask` 生成的 `<source>:<slug>`（`task-actions.js:454-455`），此刻还不存在。所以：

1. **值**：`session-manager` spawn 时注入 `SCRUMWS_TASK_KEY` / `SCRUMWS_API_BASE`（§8.1）。
2. **用法**：connector 给云端任务的 prompt 尾部追加固定协议（`platform/lib/cloud/completion-protocol.js`）：

```js
export function appendCompletionProtocol(prompt) {
  return `${String(prompt || '')}

---
[任务完成协议 · 由看板注入]
你在一台开发机上以非交互模式执行本任务，AskUserQuestion 工具已被禁用 —— 需要澄清时**不要猜**：
把问题写在本轮最后的回复里并停下，人会在看板上看到。
做完了要**显式声明**，否则任务只会停在「待人工」等人来判：
  PowerShell:  Invoke-RestMethod -Method Post "$env:SCRUMWS_API_BASE/api/task/complete?taskKey=$env:SCRUMWS_TASK_KEY&resolvedBy=agent"
  bash:        curl -s -X POST "$SCRUMWS_API_BASE/api/task/complete?taskKey=$SCRUMWS_TASK_KEY&resolvedBy=agent"
（两个变量已在你的环境变量里；这是本机 127.0.0.1 的看板端点，不出网。）
判据：确信目标已达成且自查通过才调；没做完别调 —— 漏调只是等人（fail-safe），误调会让人以为做完了。`;
}
```

- **这不是按 source 特判**（不变式 2）：connector 是这个任务的**创建者**，创建者 compose 自己的 prompt 是既有做法
  （`session-manager.js:34 appendAttachments`）。任务建出来之后与其它来源**逐字节同权**。本地手敲的任务不带这段 →
  不会自我声明完成 → **P1 既有行为零回归**。
- **追加发生在本地而非云端**：云端存的 prompt 保持人写的原样（详情页不显示样板文），`task.json.prompt` 里有完整协议
  （agent 看得到）。两者不打架——机器不写 cloud 任务的 spec（云端权威），本地这份改写永远不会推回云端覆盖原文。
- **给 agent 本地端点为什么安全**（设计 §5 已论证，此处复述结论）：`platform/server.js` 绑 `127.0.0.1` 且无鉴权，
  agent 就在这台机器上、带 `--dangerously-skip-permissions`，它**现在就能**调这个端点。我们不给它新权限，只是告诉它该这么用。
  **绝不给 agent 任何云端凭据**（决策 15）——状态经对账流上云端，agent 全程碰不到 `swmt_`。

---

## 9. 三块分工（互不通信也接得上）+ 硬约定

| # | 范围 | 碰哪些文件 | 只认什么接口 |
|---|---|---|---|
| **A · 云端 API** | §5 五个端点 + §5.7 两个新字段 + §6 绊线接线 | `cloud/src/routes/{user,machine}.js` | 本文 §5 的 JSON 形状；迁移已在 `002_*.sql`（别再改表） |
| **B · 本地下行** | §7 配置 + 闸门 + connector 下行；§8 完成协议 | `platform/lib/cloud/{cwd-allow,gate,completion-protocol,connector,identity}.js`、`runner-config.json` | §5.3/5.4/5.5 的 JSON + `createTask` 真实签名（§7.4）+ `links.js` 的 API（§7.3，#67 提供） |
| **C · 云端 UI + 决策 15 本地侧** | 建任务表单（选人→选 online 机器）、任务卡显示 dispatch/reject_reason、§8 的 session-manager / completeTask / server 透传 | `cloud/public/{app.js,index.html}`、`platform/lib/{session-manager,task-actions}.js`、`platform/server.js` | §5.1/5.2 + §5.7c 的响应形状；§8 与 A/B 不耦合 |
| **#67**（另一条 PR，非本任务） | 决策 14 对账过滤 | `platform/lib/cloud/{reconcile,links.js}` | §7.3 的 link 文件格式（**双向共享，两侧必须同意**） |

**接缝上的硬约定**（谁都不许自行改）：`intentId === task.id`；ack body 只有 `localTaskKey`；
`createdBy.userId` 是 owner-only 闸门的唯一判据；`plan:!autoExec` 是闸门的唯一去处；
`requireDispatchAllowed` 只挂建意图 / 取件两处。

---

## 10. 接缝清单（跨块，容易漏）

- **A→B**：`GET /api/machine/intents` 的 `createdBy.userId` 必须是 `task.creator_user_id`（不是别的），否则 B 的 owner-only 闸门恒失配。
- **A→B**：enroll 响应的 `ownerUserId`（§5.7a）——没有它，B 的 owner-only 永远 false。
- **A→C**：`GET /api/tasks` 改 LEFT JOIN（§5.7c），否则建了的 pending 意图在看板查不出来。
- **B↔#67**：`links.json` 格式（§7.3）。B 写 link（含 `taskKey:null` 占位），#67 的 `linkedTaskKeys()` 读。占位态不能被当成「已建成」。
- **C→B**：`SCRUMWS_TASK_KEY` / `SCRUMWS_API_BASE`（§8.1）与 completion-protocol（§8.3）里的变量名必须一致。

---

## 11. 迁移验证证据（一次性库，非生产）

脚本 `docs/acceptance/cloud-p2/scripts/verify-002.mjs`（破坏性脚本带 `--check` 零副作用自检）：
```
node verify-002.mjs --check   # 连库、验 001+002 在位、打印将做什么（未写任何行）
node verify-002.mjs --run     # 建 scrumws_p2_verify → 001 → 灌 1 local 任务 → 002 → 16 断言 → 无论成败都 DROP
```
2026-07-18 实测 `--run` **PASS=16 FAIL=0**（覆盖：origin 列仍在、四个新列的类型/可空性/默认、origin=local 行未删未改且
dispatch 落 null / auto_run 落 false、可插 cloud+pending、`check(origin=cloud⇒creator not null)` 仍挡、dispatch 脏值被挡、
偏索引存在且为 partial、`enable_seqscan=off` 下取件查询命中该 index、同机器可并存多条 null taskKey 的 pending、
取消=DELETE pending 成功、ack 回填后 unique 仍挡重复 taskKey）。
只读复核：沙箱已 DROP 无残留；生产 `scrumws`（1 user + 1 machine）未被动、task 表未被误加 P2 列、origin 列仍在。

### 迁移的执行与回滚
- **执行**（主 session 上线时，生产库）：`psql "$DATABASE_URL" -f cloud/migrations/002_p2_intent_dispatch.sql`
  （或用 `pg` 跑同一 SQL）。纯 ADD COLUMN + CREATE INDEX，可先于 P2 代码跑。
- **回滚**：迁移文件尾部有整段回滚 SQL（drop index + drop 四列），不丢任何行。

---

## 12. 已知缺口（诚实标注，别当 bug 去改）

1. **云端不知道机器的 cwd 白名单** → 建任务时 `cwd` 是自由文本，填错要等机器 reject 才知道。设计 §5.2 的
   `machine_project`（白名单镜像）本期不建——**刻意的**：镜像会让人以为云端知道真相，而白名单权威只在本地、随时可改。
   代价是首次派活的 cwd 得手输一次。
2. **owner-only 信任云端上报的 `createdBy`**（设计 §7.3 的 ⚠，**风险接受决定，不是技术选择**）：云端被攻破即可伪造
   「主人发起」→ 在 `off` 之外的机器上自动执行（限 cwd 白名单内）。想完全不信任云端只能用 `off` 档。
3. **cwd 白名单是「瞄准」控制，不是沙箱** ⚠：任务带 `--dangerously-skip-permissions` 跑，agent 对整个文件系统有全权，
   白名单**限制不了它跑起来之后能碰什么**，只限制**云端能把任务瞄到哪里**。另有边界外溢：`worktree:true` 时实际运行目录是
   `<git 仓库根>/.claude/worktrees/<name>`（`git.js` 的 `info.root`），**若白名单写的是仓库子目录**，worktree 会落在白名单外。
   因 agent 本就有全权，这不构成新增风险，但「白名单目录 = 任务能碰的全部」这个直觉是错的，别据此做安全论证。
4. **`links.json` 只增不减**：一 intent 一条（约 120 字节），永不修剪。本地任务被删了那条也留（留着才幂等）。够用才不修剪。
5. **本地改了云端任务的 spec，云端不知道**（设计 §9 决策 6 的 `task_status.local_spec` 本期不建）：plan 态任务在本地
   `editTask` 改了 title/prompt，云端仍显示原文、无任何提示。决策 6 要的 diff 是 P3 的活。
6. **本地 `/api/task/create` 仍无鉴权、无 CSRF、无 Origin 检查**（设计 §7.6）：本期不引入、不放大，但接了云端后价值变高。
   设计建议单开 PR 补 Origin 检查——**不在本期范围**。

## 13. 未收敛

1. **`reject` 之后没有「改好再来一次」的路径**：cwd 填错 → rejected 是终态 → 只能在云端重新建一个（原 prompt 得重敲）。
   加「按原意图重建」按钮是 UI 的活，本期没设计。
2. **一个人多台 online 机器**：UI 会列出多台让人选，符合真相；但「同一仓库在两台机器上都 online」时凭什么选，
   没想清楚（设计 §9b.4 同样标未收敛）。
3. **`origin='local'` 行的 `dispatch`/`auto_run` 语义在 UI 上的呈现**：本文定为「对 local 行无意义、不显示为可控」，
   但看板若把 `auto_run` 列一视同仁地画出来，会让人误以为能从云端控制本地任务。渲染侧要显式区分（设计 §9b.6 同款未决）。
