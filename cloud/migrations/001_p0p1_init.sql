-- 云端控制面 · P0（身份与连线）+ P1（状态上行）建表
-- 权威设计：docs/spec/cloud-control-plane.md §5；契约：docs/spec/cloud-p0p1-contract.md
-- 目标库：.env 的 DATABASE_URL（PostgreSQL 18.3，库 scrumws）
--
-- 【核心不变式（§3 / §5.3）】云端永不写 status，本地永不读 spec 以外的东西。
--   · task        ← 只由「人类鉴权（登录密钥 / 会话）」的 handler 写
--   · task_status ← 只由「机器鉴权（swmt_ 机器令牌）」的上报 handler 写
--   · task_history← 同 task_status，只由机器上报写
--   分表不是洁癖，是把不变式做成物理约束：看表就知道谁能写什么。
--   评审红线：任何让「人类 handler 写 task_status」或「机器 handler 改 task.title/prompt」的补丁，
--   都是在拆这条不变式，不许过。
--
-- 【三种凭据 = 三张表，严禁合并】它们回答三个不同的问题，作用域各不相同（契约 §3.1）：
--   · user_key(swuk_)        「你是谁」        —— 人持有，长期，可轮换/撤销
--   · registration_key(swrk_)「这台机器有资格加入这个云端吗」—— 实例级入场券，一把管全体，可轮换（新旧并存）
--   · machine_token(swmt_)   「这台机器是哪台」—— enroll 换取，单机作用域，可单独撤销
--   评审红线：不许把任意两张表合并，也不许写一个 verify(prefix, table) 的通用校验函数去共用——
--   前缀一旦成为参数，就有人会传错，让 swmt_ 冒充 swrk_ 过闸。每种凭据一张表 + 一个专用校验函数。
--
-- 【registration_key 不替代 enrollment_code，两者都必填】（契约 §6.6）
--   · registration_key 答「有资格加入吗」（实例级，不含身份信息）
--   · enrollment_code  答「这台机器是谁的」（定 machine.owner_user_id，是 §7.3 owner-only 闸门的根据）
--   只有注册密钥的话云端不知道机器归谁，owner-only 闸门直接失效 → 绝不能为了少一个字段把配对码去掉。
--
-- 【本迁移的范围边界】只建 P0+P1 用得上的表/列。P2+（意图下行 / 命令下行 / 定时）刻意不建：
--   · 不建表：task_command、schedule、schedule_run、audit_log、machine_project
--     - audit_log：§7.4 的写入方是 intent / command，P0+P1 没有下行、没有写入方 → 建了就是死表
--     - machine_project：cwd 白名单镜像只服务于「云端派活时选目录」（P2）；P1 的 cwd 从任务上报里就能看到
--   · 不建列：task.auto_run / dispatch / dispatched_at / reject_reason（P2 下发机）
--             task_status.local_spec（§9 决策 6 的「云端 spec 被本地改了」，只对 origin='cloud' 有意义 → P2）
--             machine.accept_auto_mode（§7.3 自动执行闸门的镜像 → P2）
--   保留 task.origin / creator_user_id：它们是任务行的身份约束而非下发机制，P1 全部写 origin='local'，
--   creator_user_id 留 null；P2 加 cloud 任务时无需改这两列。
--
-- 幂等性：本文件不带迁移账本（cloud/ 将来若引入 node-pg-migrate 由其自建 pgmigrations 表，避免打架）。
-- 全量重跑请先 DROP（见契约文档「迁移的执行与回滚」）。

begin;

-- ============================================================
-- §5.1 身份与租户
-- ============================================================

create table app_user (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique,                      -- 可选，仅用于展示
  avatar_url text,
  created_at timestamptz not null default now()
);

-- 登录密钥（swuk_）：回答「你是谁」。可多把（轮换时新旧并存），只存 sha256 哈希；明文只在生成时展示一次
create table user_key (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  key_hash text not null unique,          -- sha256(明文密钥) 的 hex
  key_prefix text not null,               -- 'swuk_ab12'，UI 展示用（不足以反推明文）
  label text,                             -- '我的密码管理器' / '备用'
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index user_key_user_idx on user_key (user_id) where revoked_at is null;

-- Web 登录会话（拿登录密钥换来的短期凭据）
create table user_session (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  token_hash text not null unique,        -- sha256(会话 token) 的 hex
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index user_session_expires_idx on user_session (expires_at);

-- 内网/公网自托管：单 workspace 起步，但列留着，将来不用改表（§9 决策 7）
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
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- ============================================================
-- 注册密钥（swrk_）：回答「这台机器有资格加入这个云端吗」
-- ============================================================
-- 与 user_key / machine_token 的区别（见文件头）：
--   · 实例级、不含身份信息：一把管全体机器，不绑到某个人、也不绑到某台机器
--   · 云端**自己生成**（不是人设的口令），明文只在生成时展示一次，库里只留 sha256 + prefix
--   · 可多把并存以便轮换：贴出新的一把 → 让所有机器改用 → 撤销旧的（revoked_at 置位）
--   · /api/machine/enroll 的**门口**校验它（在配对码校验与任何 machine 写入之前）：
--     这个端点暴露在公网，门口挡住能省掉后面所有开销
--   · **本地绝不持久化**：它是入场券，只在 enroll 请求里用一次，用完即弃（契约 §7.1）
create table registration_key (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  key_hash text not null unique,          -- sha256(明文密钥) 的 hex
  key_prefix text not null,               -- 'swrk_ab12'，UI 展示用（不足以反推明文）
  label text,                             -- '2026 上半年' / '轮换备用'
  created_at timestamptz not null default now(),
  created_by uuid not null references app_user(id),
  last_used_at timestamptz,               -- 最近一次 enroll 用到它的时刻（UI 判断「这把还有人在用吗」再撤销）
  revoked_at timestamptz
);
-- enroll 门口校验：按 key_hash 等值查（unique 索引直接命中，单次索引查询）
create index registration_key_live_idx on registration_key (workspace_id) where revoked_at is null;

-- ============================================================
-- §5.2 机器与令牌
-- ============================================================

create table machine (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  machine_uid text not null,              -- 本地 identity.json 的持久 UUID（与 hostname 无关：改机器名不该变成新机器）
  owner_user_id uuid not null references app_user(id),
  display_name text not null,
  hostname text,
  platform text,                          -- process.platform：win32 / darwin / linux
  arch text,
  app_version text,                       -- 桌面 app 版本（package.json.version）
  claude_version text,                    -- 本机 claude --version 探测值
  status text not null default 'offline' check (status in ('online','offline')),
  last_seen_at timestamptz,               -- 心跳直写（无 Redis / 无 flush 延迟 → stale 阈值 90s，见 §6.2）
  -- 心跳带上来的负载快照
  max_concurrent_runners int,
  load_processing int,
  load_queued int,
  enrolled_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (workspace_id, machine_uid)
);
-- 机器列表页 / sweeper 扫描：均按 workspace 过滤（无 RLS，workspace_id 谓词必须写死在每条查询里）
create index machine_workspace_idx on machine (workspace_id, status);
-- sweeper：30s tick 找 status='online' 且 last_seen_at < now()-90s 的机器
create index machine_online_seen_idx on machine (last_seen_at) where status = 'online';

-- 机器令牌（swmt_）：回答「这台机器是哪台」。作用域 = 单台机器，不是用户 PAT（§7.1 明确不学 multica）
create table machine_token (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references machine(id) on delete cascade,
  token_hash text not null unique,        -- sha256(明文令牌) 的 hex；明文只在签发时返回一次
  token_prefix text not null,             -- 'swmt_ab12'，UI 展示用
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index machine_token_machine_idx on machine_token (machine_id) where revoked_at is null;

-- 一次性配对码（TTL 10min）：回答「这台机器是谁的」——不让机器碰用户的长期凭据（§6.1）。
-- created_by 会成为 machine.owner_user_id，是 P2 owner-only 闸门的根据，不是审计字段。
create table enrollment_code (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,         -- sha256(明文配对码) 的 hex
  code_prefix text not null,              -- 码的前 2 位，UI 列「待用配对码」时展示
  workspace_id uuid not null references workspace(id) on delete cascade,
  created_by uuid not null references app_user(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_machine_id uuid references machine(id),
  created_at timestamptz not null default now()
);
create index enrollment_code_live_idx on enrollment_code (workspace_id, expires_at) where used_at is null;

-- ============================================================
-- §5.3 任务：spec 与 status 分两张表（见文件头不变式）
-- ============================================================

-- task = spec（意图）。P1 阶段全部由机器上报导入（origin='local'），
-- 但仍只走「导入」这一条写路径，不由 status 上报 handler 顺手改（见契约 §3.4 写权限矩阵）。
create table task (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  machine_id uuid not null references machine(id) on delete cascade,
  origin text not null check (origin in ('cloud','local')),
  -- 发起人。origin='cloud' 必填——它是 §7.3 自动执行闸门的判据，不只是审计字段。
  -- P1 只产生 origin='local'（本地手敲 / CLI 建的任务上报上来），故恒为 null。
  creator_user_id uuid references app_user(id),
  check (origin <> 'cloud' or creator_user_id is not null),

  -- spec 字段：origin='local' 从机器上报导入；origin='cloud'（P2）由云端撰写、云端权威
  title text not null,
  prompt text,                            -- 始终存（含 origin='local'，§6.5 决策 5）；本地上限 100000 字符
  model text,
  effort text,                            -- low|medium|high|xhigh|max
  cwd text,
  worktree boolean,
  base_branch text,
  description text,                       -- 纯用户备注（看板编辑，不进 prompt）
  scheduled_at timestamptz,               -- 本地 task.json.scheduledAt 的镜像（plan 到点自动执行）
  source text,                            -- 本地 taskKey 前缀：manual / cli / api / …（README 任务来源不变量：只是元数据）

  local_task_key text,                    -- 本地 taskKey（<source>:<slug>）；origin='local' 导入即有值
  local_created_at timestamptz,           -- 本地 task.json.createdAt
  created_at timestamptz not null default now(),
  unique (machine_id, local_task_key)     -- 本地 taskKey 只在本机唯一，两台机器必撞 → 联合唯一（§4）
);
create index task_workspace_idx on task (workspace_id);
create index task_machine_idx on task (machine_id);

-- task_status = 执行真相的镜像。**只由机器鉴权的上报 handler 写**。
create table task_status (
  task_id uuid primary key references task(id) on delete cascade,
  state text,                             -- plan|queued|processing|awaiting-human|done|archived
                                          -- 注意：这是看板的「显示态」（collect.js deriveBackgroundState 会把
                                          -- 有后台子任务在跑的 awaiting-human 显示成 processing），不是 state.json 原值。
  outcome text,                           -- null|success|cancelled|failed
  entered_at timestamptz,
  resolved_at timestamptz,
  session_id text,                        -- meta.sessionId（Claude Code 会话 id）
  rounds int,
  num_turns int,
  total_cost_usd numeric,
  usage jsonb,                            -- meta.json 的**最后一轮快照**，原样存。
                                          -- ⚠ rounds/total_cost_usd 是累计口径，usage 是末轮口径——这个不对称在
                                          -- collect.js:263-265 有注释。别在云端自作聪明重新聚合。
  git_branch text,                        -- P1 仅 CLI 观察态卡片有值（card.cli.gitBranch）；托管任务恒 null，见契约「已知缺口」
  worktree_branch text,                   -- meta.worktreeBranch（task-runner.js:235 实际建出的 worktree 分支）
  background_task_count int,              -- >0 = 该会话仍有后台子任务在跑（displayState 被抬成 processing 的原因）
  is_archive boolean not null default false,  -- 任务包落在 runner-archive/ 下（归档区）
  last_activity_at timestamptz,           -- card.lastActivityMs（各活动时间戳取最大值）
  rev text not null,                      -- 本地算的指纹，云端**原样存、不重算**（算法见契约 §5）
  mirror text not null default 'live'
    check (mirror in ('live','stale','local_missing')),
  synced_at timestamptz not null default now()
);
-- 看板按最近活动倒序；sweeper 批量标 stale 时按 mirror 过滤
create index task_status_activity_idx on task_status (last_activity_at desc nulls last);
create index task_status_mirror_idx on task_status (mirror) where mirror <> 'live';

-- task_history = state.json.history 的镜像（同样只由机器上报写）
create table task_history (
  task_id uuid not null references task(id) on delete cascade,
  seq int not null,                       -- state.json.history 的下标（0-based），保证幂等重推不重复
  state text not null,
  at timestamptz not null,
  by text,                                -- create:<source>|session|user|checker|cap|user:materialize-cli …
                                          -- ⚠ 可空：collect-cli.js:419-425 合成的 CLI 时间线前两条只有 {state, at}，
                                          -- 没有 by。§5.3 原文写的 `by text not null` 与真实数据冲突，此处按真实数据放宽。
  primary key (task_id, seq)
);

commit;
