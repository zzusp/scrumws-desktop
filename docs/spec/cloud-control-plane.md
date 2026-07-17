# 云端控制面 · 设计

把每个人的本地 app 注册到云端，在云端新建 / 分配任务、看执行情况。

**关键决策（已与用户确认）**：本地权威 + 云端控制面；云端自研 Node/TS；团队内网自托管（~5–20 人）。

---

## 1. multica 的参考价值判断

结论：**同赛道成品，协议层直接照抄，产品层大部分不适用**。它的 daemon 就是"本地机器注册到云端 + 云端派活 + 实时回传"，和本需求是同一个问题。

### 高价值 · 直接照抄

| 设计 | 出处 | 为什么抄 |
|---|---|---|
| **出站拨号；WS 只发 hint，HTTP 轮询兜底** | `daemon/wakeup.go:377,462` | daemon 不需要任何入站端口。WS 断了功能**不降级**（30s 轮询照样拿到活）。我们本地 `server.js:17` 写死 `127.0.0.1` 且注释"不对外"，这个模型天然契合 |
| **机器 id 用持久 UUID，不用 hostname** | `048_runtime_daemon_uuid.up.sql`、`handler/daemon.go:678` | 他们一开始用 `os.Hostname()`，后来被迫迁移，还得写 `legacy_daemon_ids` 合并逻辑。我们第一天就用 UUID |
| **心跳/巡检时间参数的推导方式** | `runtime_sweeper.go:92` | `stale=150s` 不是拍的：60(DB flush)+15(beat)+30(tick)=105，留 45s buffer。我们照这个方法自己推（见 §6.2） |
| **消息 500ms 批量合并** | `daemon/daemon.go:4657` | 逐条 POST 会打爆；500ms 合并 + 累积 text/thinking 成一条 |
| **token 前缀分类 + 只存 SHA-256 hash + prefix** | `middleware/daemon_auth.go:79` | 前缀便于路由和 UI 展示，hash 便于泄露后不可用 |
| **非成员返回 404 而非 403** | `middleware/workspace.go:195-265` | 不泄露"存在但你没权限" |
| **定时：塌缩错过的触发 + (trigger, planned_at) 唯一索引** | `jobs_autopilot.go:34-38` | 停机 3 天不会开机补跑 4000 次；迟到 >5min 直接丢等下一槽 |

### 中价值 · 借概念不照抄

- **Runtime 概念 + Settings→Runtimes 页面形态**：我们的"机器"就是它的 runtime，但它是 `(workspace, daemon, provider)` 三元组（一台装了 claude+codex 的机器 = 2 行）。我们只跑 claude，**1 台机器 = 1 行**，简化。
- **静态 pin 路由**（`agent.runtime_id` NOT NULL）：它不做能力匹配，agent 建的时候就绑死机器。我们更简单——任务直接指定机器。

### 低价值 / 不适用

- **claim / prepare_lease / `FOR UPDATE SKIP LOCKED`**（`agent.sql:441`、`daemon.go:56`）：整套**不需要**。它的云端持任务队列、N 个 daemon 抢，所以要防重复认领。我们**一台机器只有一个消费者（本地 app 自己）**，没有竞争，下发只需 at-least-once + 本地幂等。
- **issue / comment / squad / skill / label / project / inbox** 那套协作体系（28 张表）：我们没有这个产品面。
- **runtime 掉线就把在跑任务判 failed + auto-retry**（`runtime.sql:229`）：本地权威下不需要，见 §6.2。
- Go + Next.js + Redis relay + S3 + pgvector 全栈。

### 反面教材（明确不学）

1. **`mdt_` daemon token 设计完整但无人调用**——表、缓存、中间件、撤销查询全有，`CreateDaemonToken` 零调用者；daemon 实际拿的是用户的全量 `mul_` PAT，**对该用户所有 workspace 有效**。他们自己在 `handler/workspace_revoke.go:28-31` 承认了。我们第一天就发机器令牌（§7.1）。
2. **无 RLS，纯应用层隔离，新表还主动去掉 FK**。我们规模小可接受，但 `workspace_id` 谓词必须写死在每条查询里——底下没有兜底。

---

## 2. 目标 / 非目标

**目标**
- 每个人的本地 app 注册到云端，云端能看到机器在线状态、claude 版本、负载。
- 云端看到**所有机器上的所有任务**（含本地手动 / CLI 建的），状态、历史、用量、结果。
- 云端新建任务并指派到某台机器；云端对已有任务做回复 / 确认执行 / 中断 / 完成。
- 云端定时任务（cron）。

**非目标（本期）**
- 跨机器自动调度 / 能力匹配 / 负载均衡（5–20 人不需要，见 §5.3）。
- 公网多租户 SaaS、计费、OAuth 三方登录。
- 把 transcript 全量长期存到云端（见 §6.4）。
- 重写本地状态机或磁盘契约（这正是选本地权威的原因）。

---

## 3. 核心架构决策：spec / status 分离

```
┌──────────────────────────────────────────────┐
│ 云端（意图 spec）                              │
│  谁 · 在哪台机器 · 跑什么 · 什么时候            │
│  task(spec) / task_command / schedule         │
└───────────────┬──────────────────────────────┘
                │ ① 下行：意图 + 命令（本地出站拉取）
                ▼
┌──────────────────────────────────────────────┐
│ 本地 app（执行真相 status）                    │
│  现有 5 态状态机 · Mode B 会话 · ~/.scrumws    │
│  plan|queued|processing|awaiting-human|done   │
└───────────────┬──────────────────────────────┘
                │ ② 上行：状态对账（reconcile）
                ▼
┌──────────────────────────────────────────────┐
│ 云端镜像（task_status，只由机器写）             │
│  看板 / 详情 / 用量                            │
└──────────────────────────────────────────────┘
```

**不变式：云端永不写 status，本地永不读 spec 以外的东西。**

为什么本地必须是执行权威——三条，都是代码里的既成事实：

1. **会话只活在内存 + 那台机器的磁盘上**。`session-manager.js:25` 的 `Map` 进程死就没了；唯一持久链接是 `meta.sessionId` + Claude Code 自己的 `~/.claude/projects/<cwd>/<sid>.jsonl`。**云端永远无法在别的机器上 resume 一个会话**——所以"云端持队列、谁空闲谁抢"根本不成立。
2. **用户可能自己开终端 `claude --resume <sid>` 接管**（README:45 明确写了这是设计意图）。这种情况只有本地 `collect-cli.js` 扫 `~/.claude/sessions/<pid>.json` 才发现得了。云端无从知晓。
3. **完成是人判定的，不是 agent 判定的**。`result` 事件只代表一轮收敛 → `awaiting-human`；`done` 只有人点 `/api/task/complete` 才到（`task-actions.js:122`）。所以"执行情况"本身就是本地人机交互的产物。

**这个选择的直接红利**（对比 multica）：

| multica 必须做的 | 我们不需要，因为 |
|---|---|
| claim + `SKIP LOCKED` + prepare_lease 三层防重复认领 | 一台机器一个消费者，无竞争 |
| runtime 掉线 → `FailTasksForOfflineRuntimes` → auto-retry | 云端只标 `stale`；任务真死了本地 `runner-checker` 自己会收（它已经在干这事） |
| 云端管并发槽位 | 本地 `maxConcurrentRunners` 已经是权威（`task-runner.js:164`），云端只管推，本地自己排 `queued` |

---

## 4. 概念模型

| 云端概念 | 对应本地 | 说明 |
|---|---|---|
| **Machine** | 一个 dataRoot 上的 app 实例 | = multica 的 Runtime。1 机器 1 行（只跑 claude） |
| **Project** | `cwd` | 机器上报的可用工作目录（复用 `/api/task/cwds`，`server.js:353`），**且在白名单内** |
| **Task** | `runner-state/<source>__<slug>/` | 云端 `id` 是 UUID（全局唯一）；本地 `taskKey` 只在本机唯一（`<source>:<ts>-<3随机>`，`task-actions.js:14`），两机器必撞 → 用 `(machine_id, local_task_key)` 联合唯一 |
| **Command** | `task-actions.js` 的各动作 | 回复/确认/中断/完成…，1:1 映射现有动作 |
| **Schedule** | — | 云端持 cron（不复用本地 `scheduledAt`，理由见 §6.5） |

**没有 Agent 概念**。multica 的 agent 是"人格 + 绑定的机器/CLI"；我们只有 claude，agent 这层是纯开销。任务直接带 `model` / `effort` / `cwd`——这些字段 `task.json` 本来就有。

---

## 5. 数据模型（PostgreSQL 18.3）

目标库：`115.159.161.47:55432/scrumws`（`.env` 的 `DATABASE_URL`）。当前 0 张表，全新开始。

### 5.1 身份与租户

**登录方式：登录密钥，无密码**（决策 4 修订）。服务暴露在公网（§10），而 32 字节随机密钥严格强于任何人会设的口令，且顺带消灭密码库、argon2、失败锁定、找回流程和整个爆破面。没有比"没有密码"更简单的密码策略。

**三种凭据，作用域各不相同，严禁共用校验路径**：

| | 登录密钥 `swuk_` | 注册密钥 `swrk_` | 机器令牌 `swmt_` |
|---|---|---|---|
| 谁持有 | 人，放密码管理器 | 云端生成并展示，人贴到桌面设置页 | 桌面 app，`identity.json` |
| 回答什么 | **你是谁** | **这台机器有资格加入这个云端吗** | **这台机器是哪台** |
| 作用域 | 该用户的一切（含给所有机器派活） | 云端实例级，一把管全体 | 单台机器 |
| 生命周期 | 长期，可轮换 | 实例级，可轮换（新旧并存） | enroll 换取，可单独撤销 |
| 是否落盘 | 人自己保管 | **否**——用完即弃 | 是（0600） |

**为什么不合并成一个**：诱惑在于"少一个概念"，但登录密钥与机器令牌合并的代价是**桌面配置文件泄露 = 账号沦陷 = 可给该用户所有机器派活**——正好放大 §7.3 那个洞。分开则磁盘泄露只丢一台机器的上报权限。附带好处：登录不依赖桌面 app 在场（手机看板 / 机器重装 / 换电脑）。

**注册密钥（决策 11）**：服务暴露在公网（§10），`/api/machine/enroll` 是个匿名可达的端点。注册密钥是门口的廉价拒绝——handler **最先**验它，早于任何 DB 查询和配对码校验，无效直接 401。

```sql
create table registration_key (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  key_hash text not null unique,        -- sha256；明文只在生成时展示一次
  key_prefix text not null,             -- 'swrk_ab12'
  label text,
  created_by uuid not null references app_user(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
```

**注册密钥不替代配对码，两者都必填**——它们回答的是不同问题：

- 注册密钥答"有资格加入吗"，是**实例级**的，不含任何身份信息
- 配对码答"这台机器是**谁的**"，绑 `machine.owner_user_id`

只有注册密钥的话，云端不知道机器归谁 → `machine.owner_user_id` 为空 → §7.3 的 `owner-only` 闸门（决策 9 要的"自己派的直接跑"）**直接失效**，因为无从判断"发起人是不是机器主人"。所以不能为了少贴一个字段把配对码去掉。

**注册密钥不在本地持久化**：只在 enroll 那一次请求里用，用完即弃，不写进 `identity.json` / `runner-config.json` / 任何配置。理由是机器令牌已能自我维持，持久化 rk 只是在磁盘上多放一个"能拉新机器入场"的常驻秘密，换不来任何东西。重新入场本来就该有人参与。

**rk 只管入场，不管在场**：撤销注册密钥不影响已在线的机器（它们靠机器令牌活着）。要踢掉某台机器是撤它的 `machine_token`。这两件事别混。

```sql
create table app_user (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique,                    -- 可选，仅用于展示
  avatar_url text,
  created_at timestamptz not null default now()
);

-- 登录密钥：可多把（轮换时新旧并存），只存哈希
create table user_key (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  key_hash text not null unique,        -- sha256；明文只在生成时展示一次
  key_prefix text not null,             -- 'swuk_ab12'，UI 展示用
  label text,                           -- '我的密码管理器' / '备用'
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table user_session (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- 内网自托管：单 workspace 起步，但列留着，将来不用改表
create table workspace (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table member (
  workspace_id uuid not null references workspace(id) on delete cascade,
  user_id uuid not null references app_user(id) on delete cascade,
  role text not null check (role in ('owner','admin','member')),
  primary key (workspace_id, user_id)
);
```

### 5.2 机器与令牌

```sql
create table machine (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  machine_uid text not null,              -- 本地 identity.json 的持久 UUID
  owner_user_id uuid not null references app_user(id),
  display_name text not null,
  hostname text, platform text, arch text,
  app_version text, claude_version text,
  status text not null default 'offline' check (status in ('online','offline')),
  last_seen_at timestamptz,
  -- 心跳带上来的负载快照
  max_concurrent_runners int, load_processing int, load_queued int,
  -- 本地「是否接受自动执行」开关的镜像（本地权威，云端只展示，让派活的人知道会不会自动跑）
  accept_auto_mode text check (accept_auto_mode in ('off','owner-only','on')),
  enrolled_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (workspace_id, machine_uid)
);

create table machine_token (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references machine(id) on delete cascade,
  token_hash text not null unique,        -- sha256，明文只在签发时返回一次
  token_prefix text not null,             -- 'swmt_ab12'，UI 展示用
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table enrollment_code (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  workspace_id uuid not null references workspace(id) on delete cascade,
  created_by uuid not null references app_user(id),
  expires_at timestamptz not null,        -- 10 分钟
  used_at timestamptz,
  used_by_machine_id uuid references machine(id)
);

-- 机器上报的可用 cwd；allowed 由机器主人在本地白名单决定，云端只镜像
create table machine_project (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references machine(id) on delete cascade,
  cwd text not null,
  label text,
  allowed boolean not null default false,
  last_reported_at timestamptz not null default now(),
  unique (machine_id, cwd)
);
```

### 5.3 任务：spec 与 status 分两张表

**分表不是洁癖——是把 §3 的不变式做成物理约束**：`task` 只由人类鉴权的 handler 写，`task_status` 只由机器鉴权的 handler 写。看表就知道谁能写什么。

```sql
create table task (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  machine_id uuid not null references machine(id) on delete cascade,
  origin text not null check (origin in ('cloud','local')),
  -- 发起人。origin='cloud' 必填——它是 §7.3 自动执行闸门的判据，不只是审计字段
  creator_user_id uuid references app_user(id),
  check (origin <> 'cloud' or creator_user_id is not null),

  -- spec：origin='cloud' 由云端撰写；origin='local' 从机器首次上报导入（云端不得改）
  title text not null,
  prompt text,                    -- 始终存（含 origin='local'，理由见 §6.5）
  model text, effort text,
  cwd text, worktree boolean, base_branch text,
  description text,

  -- 云端逐任务的自动执行意愿；与本地 accept_auto_mode 组成「与」门（§7.3）
  auto_run boolean not null default false,

  -- 下发状态（仅 origin='cloud'）
  dispatch text check (dispatch in ('pending','delivered','rejected')),
  dispatched_at timestamptz,
  reject_reason text,

  local_task_key text,            -- ack 时回填
  created_at timestamptz not null default now(),
  unique (machine_id, local_task_key)
);

-- 镜像：只由 machine 鉴权的上报 handler 写
create table task_status (
  task_id uuid primary key references task(id) on delete cascade,
  state text,                     -- plan|queued|processing|awaiting-human|done
  outcome text,                   -- null|success|cancelled|failed
  entered_at timestamptz, resolved_at timestamptz,
  session_id text,
  rounds int, num_turns int, total_cost_usd numeric,
  usage jsonb,                    -- meta.json 的最后一轮快照，原样存
  git_branch text, worktree_branch text,
  last_activity_at timestamptz,
  rev text not null,              -- 本地算的指纹，用于对账
  mirror text not null default 'live'
    check (mirror in ('live','stale','local_missing')),
  -- 本地当前 spec，仅当与 task.* 不一致时非 null（= 「已被本地修改」）。
  -- 云端 spec 不被覆盖，差异在详情页 diff 出来显性化（§9 决策 6）
  local_spec jsonb,
  synced_at timestamptz not null default now()
);

create table task_history (
  task_id uuid not null references task(id) on delete cascade,
  seq int not null,               -- state.json.history 的下标
  state text not null,
  at timestamptz not null,
  by text not null,               -- create:<source>|session|user|checker|cap
  primary key (task_id, seq)
);
```

> `usage` 原样存 jsonb：本地 `meta.json.usage` 是**最后一轮快照**，而 `rounds`/`totalCostUsd` 是累计——这个不对称在 `collect.js:263-265` 有注释。别在云端自作聪明重新聚合。

### 5.4 命令、定时、审计

```sql
create table task_command (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references task(id) on delete cascade,
  machine_id uuid not null references machine(id) on delete cascade,
  kind text not null check (kind in
    ('approve','reply','cancel','complete','uncomplete','to-plan','restart','archive','rename','describe')),
  payload jsonb not null default '{}',
  created_by uuid not null references app_user(id),
  status text not null default 'pending'
    check (status in ('pending','delivered','applied','failed')),
  delivered_at timestamptz, applied_at timestamptz, error text,
  created_at timestamptz not null default now()
);
create index on task_command (machine_id, status) where status = 'pending';

create table schedule (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  machine_id uuid not null references machine(id) on delete cascade,
  name text not null,
  cron_expression text not null,
  timezone text not null default 'Asia/Shanghai',
  enabled boolean not null default true,
  task_template jsonb not null,   -- {title, prompt, model, effort, cwd, worktree, ...}
  next_run_at timestamptz,
  created_by uuid not null references app_user(id)
);

create table schedule_run (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references schedule(id) on delete cascade,
  planned_at timestamptz not null,
  task_id uuid references task(id),
  status text not null check (status in ('created','skipped','failed')),
  unique (schedule_id, planned_at)   -- 幂等，抄 multica
);

create table audit_log (
  id bigserial primary key,
  workspace_id uuid not null,
  actor_type text not null check (actor_type in ('user','machine','system')),
  actor_id uuid,
  action text not null,
  target_type text, target_id uuid,
  details jsonb,
  at timestamptz not null default now()
);
```

---

## 6. 协议

所有本地→云端都是**出站**。云端**永远拿不到** 8799 的入站访问。

### 6.1 注册（enrollment）

注册密钥（有资格加入吗）+ 一次性配对码（这机器是谁的），两把一起验，且都不是用户的长期凭据：

```
⓪ 云端 Web：管理员生成注册密钥 swrk_（一次性展示，可轮换）——全体机器共用这一把

① 云端 Web：用户点「添加机器」→ POST /api/machines/enrollment-codes
   → 返回 8 位码，TTL 10min，单次使用，绑 (workspace, created_by)

② 桌面 App 设置页：填 云端 URL + 注册密钥 + 配对码（也支持粘一整串 join token 自动拆）
   → POST /api/machine/enroll
     { registrationKey, code, machineUid, hostname, platform, arch, appVersion, claudeVersion }

③ 云端：**先**验 registrationKey（门口廉价拒绝，早于任何 DB 查询）→ 再验 code
   → upsert machine 行（owner_user_id = code.created_by）→ 签发机器令牌
   → { token: "swmt_<32B>", machineId, workspaceId, workspaceName }
     token 明文仅此一次返回；库里只存 sha256 + prefix
     注意：rk 无效与 code 无效返回**同样**的 401 + 同一文案——
     否则攻击者能靠错误差异区分出"密钥对了但码错了"，把两把锁降级成两把独立的锁

④ 本地：写 $DATA_ROOT/runtime/cloud/identity.json（尽力 chmod 0600）
   { machineUid, cloudUrl, machineId, token, workspaceId, enrolledAt }
```

`machineUid` 在**首次启动时**生成并持久化（`crypto.randomUUID()`），与 hostname 无关——hostname 会变，改了名不该变成新机器。这是抄 multica 的教训，不是洁癖。

**解绑**：本地删 `identity.json`，或云端 `machine_token.revoked_at` 置位（下一次心跳 401 → 本地清理并停止上报）。

### 6.2 心跳与在线判定

```
POST /api/machine/heartbeat   (Bearer swmt_…)   每 15s
  → { claudeVersion, appVersion, load: {processing, queued, cap} }
  ← { pendingIntents: n, pendingCommands: n, serverTime }
```

WS 连着时走 WS 帧，HTTP 作兜底（抄 multica 的双通道：`daemon.go:877`，ack 新鲜度窗口 = 2×心跳间隔，掉一个 ack 能自愈）。

**在线判定参数**（按 multica 的推导方法自己算）：

| 参数 | 值 | 推导 |
|---|---|---|
| 心跳间隔 | 15s | 同 multica |
| sweeper 巡检 | 30s | 同 multica |
| stale 阈值 | **90s** | 我们没有 Redis、没有 60s 的 DB flush 延迟（直接写 `last_seen_at`），所以 15(beat)+30(tick)=45，留 45s buffer → 90s。multica 的 150s 是因为多了 60s flush |

**机器掉线时，云端不动任何任务状态**——只把 `task_status.mirror` 标 `stale`，UI 显示"最后同步于 X 分钟前"。这是本地权威最大的红利：multica 必须 `FailTasksForOfflineRuntimes` + auto-retry（`runtime.sql:229`），因为它的云端拥有任务；我们的任务在人家机器上活得好好的，笔记本合盖而已。真正的孤儿由本地 `runner-checker` 收（它本来就在干，`jobs/runner-checker.js:87`）。

### 6.3 上行：对账（reconcile），不是事件流

**为什么对账不是流**：本地是权威，云端只需**收敛到**本地真相。对账循环天然自愈（漏一次下次补上），而事件流漏一条就永久错。而且本地**根本没有 change feed**——`/api/state` 是全量文件系统重扫（`collect.js:361`），要造 feed 得新写一套。

```
connector 每 15s（复用 collectState() 的结果，见下）:
  ① 对每张卡算 rev = sha1(state|enteredAt|outcome|resolvedAt|history.length
                          |sessionId|rounds|totalCostUsd|lastActivityMs)
  ② 与 $DATA_ROOT/runtime/cloud/synced.json ({taskKey: rev}) 比对
  ③ 变化的批量推：POST /api/machine/tasks/upsert  [{taskKey, spec?, status, history}]
  ④ 成功后更新 synced.json

每 5 分钟 / 每次 WS 重连:
  全量对账 POST /api/machine/tasks/digest  { tasks: [{taskKey, rev}] }
   ← { needFull: [taskKey...] }
  云端把 digest 里没出现的任务标 mirror='local_missing'（本地删了 plan 草稿 / 归档漂移）
```

**性能**：`collectState()` 是全量重扫 + 重读每个任务包，还要反读 jsonl 数子 agent（`collect-cli.js:195`），不便宜。但**前端本来就在轮询它**。所以 connector **不得自己触发扫描**——要在 `collect.js` 上加一层进程内缓存 + 广播，UI 和 connector 共享同一次扫描结果。这是本设计对现有代码唯一的侵入性改动。

`origin='local'` 的任务同样上行（spec 从上报里导入）——这样云端看板能看到所有人所有活，包括本地手敲的。这正是"查看执行情况"的主体。

### 6.4 下行：意图（新建任务）与命令

```
WS 帧 cloud:intent_available  (hint only，掉了不影响正确性)
  → connector: GET /api/machine/intents        （HTTP 30s 轮询兜底）
    ← [{ intentId, title, prompt, model, effort, cwd, worktree, baseBranch,
         description, autoRun, createdBy: { userId, name } }]

  对每个 intent：
    a. 幂等：$DATA_ROOT/runtime/cloud/links/<intentId>.json 存在 → 直接用已有 taskKey ack
    b. 校验 cwd ∈ 本地白名单（§7.2）→ 不在则 reject
    c. 算自动执行闸门（§7.3）→ 得到 plan 标志
    d. 调 task-actions.createTask({ source: 'cloud', plan, ... })  ← 同一条代码路径
    e. 写 link 文件
    f. POST /api/machine/intents/{id}/ack { localTaskKey, state }
       或 /reject { reason }
```

**闸门就是 `createTask` 的 `plan` 入参**——不需要新机制。`task-actions.js:464` 的 `planFirst = !!plan || ...` 已经支持，连 `planSources` 都不用动（`planSources` 是"整个来源一刀切"，我们要的是逐任务）：

```js
// connector 内，本地算，云端说了不算
const autoExec = intent.autoRun && (
  cfg.acceptAutoRun === 'on' ||
  (cfg.acceptAutoRun === 'owner-only' && intent.createdBy.userId === identity.ownerUserId)
);
createTask({ source: 'cloud', plan: !autoExec, ... });
```

`autoExec=false` → 落 `plan`，机器主人在本地看板点「确认执行」才起 claude。

**必须走 `createTask()` 而不是新写一条路径**——README:43-47 的不变式："source 只是来源元数据，不是行为开关；所有来源共享同一套状态机，分支按状态走，绝不按 source 特判"。`cloud:` 前缀只进 taskKey 用于展示和筛选。历史上 `cli:` 的特判已经是技术债（README 自己列了 5 处偏离），别再添第六个。

**命令**同构：

```
GET /api/machine/commands  ← [{ commandId, taskKey, kind, payload }]
  → 按 commandId 幂等（$DATA_ROOT/runtime/cloud/applied.json，有界）
  → 映射到现有动作：approve→restartTask({approve:true})、reply→replyToTask、
     cancel→cancelTask、complete→completeTask …
  → POST /api/machine/commands/{id}/result { ok, error? }
  结果状态不在这里回传——它会自然地从 §6.3 的对账流上来
```

**机器离线**：intent 就在云端 `dispatch='pending'` 待着，UI 显示"待下发"。云端不需要执行队列——它排的是**意图**，不是执行。

### 6.5 存什么 vs 拉什么

分界线：**有界 + 云端本来就有一半 → 存；无界 + 脆弱 + 含源码 → 按需拉。**

**prompt 存，不按需拉**（决策 5）。曾考虑过"查看时才从机器实时拉 prompt"，否决理由是**会造成同一个详情页两种行为**：`origin='cloud'` 的 prompt 云端本来就有（是云端写的，不存反而怪），`origin='local'` 若改成按需拉，机器一离线，同事的 cloud 任务能看正文、local 任务看不了——用户无法预期。而 prompt 有 32KB 硬上限（`server.js:418`），存储成本可忽略，还换来云端可搜索。所以统一存。

**transcript 按需拉**。三个理由：

1. 它不是本地自己的数据——是**反读 Claude Code 私有的 jsonl 格式**，`logs.js` + `collect-cli.js` 用了约 1200 行防御性解析。把这份脆弱性搬到云端等于双倍维护。
2. 体量大，且**含源码**，可能含密钥。内网也不该无差别外传。
3. 看板要的"执行情况"（状态/历史/用量/结果）在 `state.json`+`meta.json` 里，**有界且便宜**——那些一直同步。

```
云端 UI 打开任务详情
  → 云端 WS 帧 cloud:watch_start { taskKey, watchId }
  → connector 挂到现有 SSE（/api/session/stream 或 /api/worker-log/stream）
  → 500ms 批量合并（抄 multica daemon.go:4657）
  → POST /api/machine/watch/{watchId}/frames
  → 云端存短 TTL 缓冲 + 广播给浏览器 WS
  → cloud:watch_stop 或 TTL 到期即停
```

可选（按 workspace 开关，默认关）：任务完成时归档最终 transcript 到云端。

### 6.6 定时

云端持 cron，**不复用本地 `scheduledAt`**。理由：机器在触发点离线时，本地 `scheduledAt` 就是错过了（`promoteDueScheduledTasks` 只在本地跑）；云端持有则 intent 挂 `pending`，开机即下发。

抄 multica 两条：塌缩错过的触发（只发最近一次，不补跑）；迟到 >5min 直接丢等下一槽；`(schedule_id, planned_at)` 唯一索引保幂等。

---

## 7. 安全模型 ⚠️ 本设计最大的风险面

**先把话说明白**：今天 `POST /api/task/create` 是**无鉴权的任意 prompt 执行**，本地所有任务路径都带 `--dangerously-skip-permissions`（`task-runner.js:265,267,300`）。今天它的边界是"绑 127.0.0.1，信任本机一切"。

**接上云端之后，"谁能在你机器上执行代码"的答案从「本机进程」变成「云端 + 所有能操作云端的人」。** 云端被攻破 = 全员开发机 RCE，带着他们的 git 凭据、SSH key、`~/.claude` token。这不是危言耸听，是这个架构的固有代价，必须显式接受并加控制。

**而且服务会走公网**（决策 3、§10）——不是内网自托管。所以云端登录页面是暴露在互联网上的，一次口令爆破成功 = 上面那句话成真。这把 §7.1 的 TLS、§7.4 的登录防爆破从"最佳实践"提升为"硬前提"。

### 7.1 机器令牌（不用用户 PAT）

作用域 = `(workspace, machine)`，只存 sha256 + prefix，云端可即时撤销。

这是**明确不学 multica** 的地方：它设计了 `mdt_` workspace 级 daemon token（表/缓存/中间件/撤销全有），但从没启用，daemon 实际拿用户的全量 `mul_` PAT——一个对该用户**所有 workspace** 有效的凭据，躺在 `~/.multica/config.json` 明文里。他们自己在 `workspace_revoke.go:28-31` 承认了这个缺口，并靠"撤销时同事务归档 agent + 取消任务 + 强制 runtime 离线 + 删 member"来兜底。我们规模小，第一天做对成本几乎为零。

### 7.2 cwd 白名单（本地权威，最硬的一道）

```jsonc
// runner-config.json（已有的热加载配置文件，runner-config.js）
{ "cloudAllowedCwds": [] }   // 默认空 = 拒绝一切云端任务
```

connector 校验 intent 的 `cwd` 必须落在白名单某个前缀下，否则 `reject`。**默认空**——机器主人必须显式加目录，云端才有落脚点。云端说什么都不算，判定在本地。

### 7.3 自动执行闸门：云端逐任务 ∧ 本地接受开关

**派活不需要权限，自动执行才需要。** 谁都能给任何机器派活（决策 9）——因为一个落在 `plan` 里等确认的任务是无害的，它只是个建议。所以没有 `assign_policy` 这种东西，闸门只管"跑不跑"。

两个开关做「与」：

| 开关 | 位置 | 权威 | 值 |
|---|---|---|---|
| `task.auto_run` | 云端，逐任务，发起人勾选 | 云端 | bool |
| `acceptAutoRun` | 本地 `runner-config.json` | **本地** | `off` / `owner-only` / `on` |

```
autoExec = task.auto_run ∧ ( local=='on' ∨ (local=='owner-only' ∧ 发起人==机器主人) )
```

判定在**本地**做（connector 内），云端说了不算——这是本地权威的应有之义。

三档的由来：决策 9 要"自己派的任务直接自动执行，不用判断开关"。但如果做成"云端声称是主人发的就免检"，那就是**云端单方面决定绕过本地闸门**。做成本地三档，语义变成"**我（机器主人）选择信任云端的发起人字段**"——闸门始终在本地手里，只是主人可以选择放松到哪一档。默认 `owner-only`（匹配决策 9 的意图：自己派的直接跑，同事派的要确认）。

> ⚠️ **诚实说明**：`owner-only` 档信任云端上报的 `createdBy`。**云端被攻破就能伪造"主人发起"，从而在 `off` 之外的所有机器上自动执行**（限于 cwd 白名单内）。这不是实现瑕疵，是"要便利就得信任云端"的固有代价。想完全不信任云端就只能用 `off` 档（一切都要本地点确认）。所以：
> **`owner-only` / `on` 档下，真正的遏制只剩 cwd 白名单（§7.2）**——它是唯一不依赖云端诚实的防线。这也是为什么白名单默认空、且判定必须在本地。

### 7.4 其余控制

| 控制 | 说明 |
|---|---|
| **本地 opt-in** | 机器主动 enroll；删 `identity.json` 即退出 |
| **强制 HTTPS** | 服务走公网（§10）→ 机器令牌若走明文 HTTP 等于裸奔。TLS 是硬前提，不是可选项 |
| **不放宽 bind** | 8799 永远只 `127.0.0.1`；云端只能靠 connector 出站拉 |
| **审计** | 每个 intent / command 记 actor + 时间进 `audit_log`；本地 `state.json.history` 的 `by` 也留 `create:cloud` |
| **workspace 谓词** | 无 RLS，每条查询必须带 `workspace_id`——底下没有兜底（multica 的教训） |
| **登录密钥** | 无密码 → 无弱口令、无爆破面（32B 随机不可猜）。仍需登录接口限流防刷；密钥只存 sha256，可轮换、可撤销 |
| **凭据分层** | 登录密钥（人）≠ 注册密钥（入场）≠ 机器令牌（磁盘），三套独立校验路径。桌面配置泄露不导致账号沦陷，也不导致别人能拉机器入场（§5.1） |
| **注册密钥** | 公网上的 `/api/machine/enroll` 不再匿名可达；门口最先验、廉价拒绝。可轮换，撤销不影响已在线机器 |

### 7.5 既存问题（本设计不引入，但会放大）

`/api/task/create` 无鉴权、无 CSRF token、无 Origin 检查——**今天任意本机进程、甚至任意网页都能 POST 建任务**。接云端不改变这一点，但会让攻击面从"本机"扩到"云端"。**建议单开一个 PR 补 Origin 检查**，不在本设计范围内。

---

## 8. 分期落地

**强烈建议 P1 单独交付并停一下评估**——它已经交付了"查看执行情况"的全部价值，且**零下行、零 RCE 面**。

| 期 | 内容 | 风险面 |
|---|---|---|
| **P0 · 身份与连线** | `identity.json` + machineUid + enroll + 心跳 + 云端机器列表（在线/离线/claude 版本/负载） | **零** |
| **P1 · 状态上行** ★ | 对账推送所有机器的任务卡 → 云端只读看板 + 任务详情（状态/历史/用量/结果）。含 `collect.js` 进程内缓存改造 | **零**（纯出站只读） |
| **P2 · 意图下行** | 云端新建 + 指派任务。**必须**带 cwd 白名单 + `planSources:['cloud']` 默认开 | **开始有 RCE 面，单独评审** |
| **P3 · 命令下行** | 回复 / 确认执行 / 中断 / 完成 | 中 |
| **P4 · 实时流** | 按需 transcript 拉流 | 低（含源码外传，需确认） |
| **P5 · 定时** | 云端 cron | 低 |

P0+P1 之后云端就是一个**全团队 agent 运行态的只读大盘**——本身就有价值，且完全不碰安全边界。

### 云端技术栈

- **Node 20+ / TypeScript**，Fastify（本地 `platform/` 的零依赖 `node:http` 风格不适合云端——要 WS、鉴权、连接池，手搓不划算）
- **PostgreSQL 18.3**（已有），`pg` 连接池；迁移用 `node-pg-migrate` 之类
- **WS**：`ws`，两个 hub 分开——机器 hub 与浏览器 hub 不共用 socket（抄 multica，职责和鉴权都不同）
- **前端**：复用 `platform/public/` 的看板风格（`docs/spec/multica-style-guide.md` 已有）
- **部署**：docker-compose，内网

---

## 9. 已决策

| # | 议题 | 决策 |
|---|---|---|
| 1 | `.env` 入 gitignore | 已做（`.gitignore:7`，且从未被 track，无需清历史） |
| 3 | 部署形态 | **走公网**（也可内网）→ TLS + 登录防爆破成硬前提，§7 已按公网重写 |
| 4 | 登录方式 | **登录密钥 `swuk_`，无密码**（修订自"账号密码"）。与机器令牌分开，理由见 §5.1 |
| 5 | `origin='local'` 的 prompt | **上行并存储**；不改按需拉，理由见 §6.5（避免同页两种行为 + 32KB 有界） |
| 6 | 云端 spec 被本地改了 | **标记"已被本地修改"**，不覆盖云端 spec；`task_status.local_spec` 存本地当前值，详情页 diff |
| 7 | 多租户维度 | 保留 `workspace_id` 列，先只建一个 workspace |
| 8 | 自动执行 | 云端逐任务 `auto_run` ∧ 本地 `acceptAutoRun` 三档，本地判定（§7.3） |
| 9 | 派活权限 | **都能派**（无 `assign_policy`）；自己派的走 `owner-only` 档免确认 |
| 10 | cwd 白名单 | 保留，默认空 = 拒绝一切云端任务 |
| 11 | **注册密钥** `swrk_` | 云端自己生成，本地 enroll 时必带。**不替代配对码**（否则丢 `owner_user_id`，§7.3 闸门失效）；**不在本地持久化**（入场券用完即弃）；只管入场不管在场（撤销不影响已在线机器） |
| 12 | **重注册不更新 `owner_user_id`** | 机器归**首次 enroll 时生成配对码的那个人**，之后换谁生成配对码给同一台机器重注册，机器仍归原主。这是 §7.3 `owner-only` 闸门的归属依据 |

**决策 12 的推论（P2 前要知道）**：

- **失效方向是安全的**。机器主人离职 / 账号停用后，`owner_user_id` 指向的人不再有效 → `owner-only` 档永远匹配不上 → 该机器退化成"一切都要本地确认"。**fail-closed，不是 fail-open**，这正是我们要的方向。
- **但没有转移所有权的路径**。同事接手一台旧机器，他自己派的活反而要本地点确认（因为他不是 owner）——只是别扭，不危险。真要转移，当前只能删 `machine` 行重新 enroll。是否补一个显式的转移端点，留到 P2 有实际需求时再说，不预先设计。

## 9b. 未收敛 / 拿不准

诚实标注——这些我没想透，不强凑结论：

1. **`collect.js` 加缓存层的影响面**（P1 唯一的技术不确定点）：UI 当前轮询频率与 connector 的 15s 如何共存、TTL 取多少，要实测。`/api/state` 是全量重扫 + 反读 jsonl 数子 agent（`collect-cli.js:195`），不便宜。
2. **`owner-only` 档的信任模型是否可接受**（§7.3 的 ⚠️）：它信任云端上报的 `createdBy`，云端被攻破即可伪造。技术上无解（除非签名），只能靠 cwd 白名单兜底。这是个**风险接受决定**，不是技术选择。
3. **本地 `acceptAutoRun` 的默认值**：`owner-only` 匹配决策 9 的便利意图，但 `off` 严格更安全（新机器 enroll 后不会因云端问题自动跑东西）。倾向 `owner-only`，但没底。
4. **同一个人多台机器跑同一个仓库**：各自 enroll、各自独立 machine，云端会看到两份任务流。符合真相，但 UI 按机器分组怎么设计没想。
5. **审计保留期与 `task_history` 增长**：没估算量级。
6. **`origin='local'` 任务的 `auto_run` 语义**：本地建的任务压根不经过闸门（它本来就在本地跑）。云端这一列对它无意义——是留 null 还是不显示，UI 上要想清楚，否则会让人误以为能从云端控制。
7. **Postgres 端口暴露**：`55432` 当前从公网可直连（我从开发机连上了）。云端服务上线后，它应该只对云端服务开放。这属于部署收口，不属本设计，但没人做就是个洞。

---

## 10. 环境现状（实测）

| 项 | 值 | 来源 |
|---|---|---|
| Postgres | **18.3** (Ubuntu, x86_64) | `select version()` |
| 地址 | `115.159.161.47:55432` | `.env` |
| 库 | **`scrumws`**，0 张表，owner `admin18` | `psql "$DATABASE_URL" -c "select current_database()" -c "\dt"` |
| 同实例其它库 | `claude_center`, `novel_writer` | `\l` |

按 `.env` 的 `DATABASE_URL` 直连已验证可达、库为空，可直接建表。

**部署形态**：服务**走公网**（也可走内网）。这不是内网自托管——`115.159.161.47` 是公网 IP，`55432` 当前从任意开发机可直连。后果全部体现在 §7：TLS 强制、登录防爆破、Postgres 端口应收口到只对云端服务开放（见 §9b.7）。

**`.env` 已收口**：`.gitignore:7` 加了 `.env` / `.env.*`（保留 `!.env.example`）；`git ls-files` 确认从未被 track，无需清历史。
