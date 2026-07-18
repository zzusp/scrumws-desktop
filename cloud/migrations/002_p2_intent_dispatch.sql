-- 云端控制面 · P2（意图下行 / 云端下发队列）迁移
-- 权威设计：docs/spec/cloud-control-plane.md §5.3（task 的 P2 列）/ §6.4 / §7.2 / §7.3 /
--           §9 决策 8·9·10·16；契约：docs/spec/cloud-p2-dispatch-contract.md
-- 目标库：.env 的 DATABASE_URL（PostgreSQL 18.3，库 scrumws）
--
-- 【本迁移只做一件事：给 task 加「云端下发队列」四列 + 一个取件用的偏索引】
--   补的正是 001 头注（cloud/migrations/001_p0p1_init.sql:29）刻意留白的 P2 列，
--   以及 user.js:5 那句「P1 里也不写 task（P2 才有云端建任务）」留的位置。
--
-- 【绝不删 origin，绝不删任何行】—— 与「决策 14 只同步云端下发的任务」协作分工：
--   · task.origin('cloud'|'local') **原样保留**。上行过滤（本地任务不上云）在**本地 connector**
--     侧按 link 做（platform/lib/cloud/reconcile.js，另一条 PR 负责），不靠删列 / 删行。
--   · 一列只剩单值才该删；本表 origin 仍是双值：origin='local' 是机器上报导入的镜像（P1 主干，
--     upsert handler 仍在写，machine.js:241），origin='cloud' 是本期新增的云端意图。两者都在，列有意义。
--   · P1 已导入的 origin='local' 行（生产实测 51 条）**一行不动**：它们是「查看执行情况」的主体，
--     删了云端看板就空了。删不删由上行过滤在本地决定，不是这张迁移的事。
--
-- 【为什么不动 creator_user_id 的约束】001 已建 check(origin<>'cloud' or creator_user_id is not null)：
--   origin='cloud' 的行天然被强制填 creator_user_id（§7.3 owner-only 闸门的判据），origin='local' 允许 null。
--   保留 origin 就保留了这条条件约束，无需改成无条件 not null（那会连带要求 local 行也填发起人，错）。
--
-- 【dispatch 为什么可空、auto_run 为什么 not null，见各列旁注】
--
-- 幂等性：同 001，不带迁移账本（将来若引入 node-pg-migrate 由其自建 pgmigrations 表，避免打架）。
--   本迁移**只跑一次**；全量重跑请先 DROP 库（见契约「迁移的执行与回滚」）。
-- 事务：全文包在 begin/commit 里 —— 中途失败即整体回滚，不会留下半迁移的库。
-- 部署安全：纯 ALTER ADD COLUMN（常量默认，PG 11+ 是元数据变更、不重写表）+ CREATE INDEX，
--   不删列 / 不删行 / 不改现有列 → 生产上正在跑的 P1 代码（select t.origin、insert origin='local'）
--   **一个字都不会 break**，可先跑迁移再上 P2 代码（与 P1「删列」草案相反，那份已废弃）。

begin;

-- ============================================================
-- 云端下发队列（设计 §5.3 的 P2 列）
-- ============================================================
alter table task
  -- 云端逐任务的自动执行**意愿**（发起人在建意图时勾选）。它只是 §7.3「与」门的一半，
  -- 另一半是本地 runner-config 的 acceptAutoRun —— 判定在**本地** connector 做，云端说了不算。
  -- not null default false：origin='local' 行（本地手敲的活，本就不经闸门、在本地直接跑）拿到 false，
  --   对它无意义但无害（设计 §9b.6 标的「local 行 auto_run 语义」在此定为：恒 false / 被忽略，不显示为可控）。
  add column auto_run boolean not null default false,

  -- 下发状态机：pending → delivered | rejected（三态，终态不回头）。**可空**：
  --   · origin='local' 行 dispatch = null —— 它们从不经云端下发，没有「下发状态」这回事
  --     （machine.js:241 的 upsert insert 不写 dispatch → 落 null，正确）。
  --   · origin='cloud' 行由建意图端点显式写 'pending'（契约 §5.1），机器 ack→'delivered' / reject→'rejected'。
  --   pending   建好待取；机器离线就一直待着（设计 §6.4：云端排的是意图，不是执行队列）
  --   delivered 机器已建出本地任务并 ack（local_task_key 此时回填）
  --   rejected  机器拒收（cwd 不在白名单 / 本地建任务失败）→ reject_reason 是机器给的自由文本
  -- 「取消未下发的意图」不新增枚举值：pending 行没有任何本地/镜像足迹（无 task_status、无 task_history、
  --   local_task_key 仍 null），直接 DELETE 该行即可，语义即「这条从未到达机器的意图不复存在」（契约 §5.2）。
  add column dispatch text check (dispatch in ('pending','delivered','rejected')),

  -- ack 成功回执的时刻（**不是**机器 GET 取件的时刻，见契约 ack 语义）。重发 ack 不刷新它。
  add column dispatched_at timestamptz,

  -- 机器给的拒收理由，原样存、原样显示。⚠ 机器可写的自由文本 → 云端 UI 渲染时必须转义（escapeHtml）。
  add column reject_reason text;

-- 取件查询（契约 §5.3 GET /api/machine/intents）：
--   where machine_id = $1 and dispatch = 'pending'   —— 每 15s 一次 × 每台机器。
-- 偏索引只覆盖 pending：delivered 会一直堆积（是多数派），pending 是少数派，只索引它省空间、够快。
-- origin='local' 行 dispatch=null，天然不进这个偏索引。
create index task_pending_intent_idx on task (machine_id) where dispatch = 'pending';

commit;

-- ============================================================
-- 回滚（若 P2 代码尚未上线 / 需退版）
-- ============================================================
-- 结构可整体回退，且不丢任何行（本迁移从没删过行）：
--   begin;
--   drop index if exists task_pending_intent_idx;
--   alter table task
--     drop column if exists auto_run,
--     drop column if exists dispatch,
--     drop column if exists dispatched_at,
--     drop column if exists reject_reason;
--   commit;
-- 回滚后若库里已存在 origin='cloud' 的意图行，drop column 会把它们的下发状态一并带走 ——
-- 但行本身还在（origin='cloud' + creator_user_id 齐全）。回滚前若已有云端意图，先自行决定是否
-- `delete from task where origin='cloud'`（P1 代码不认这些行的下发列，但 select t.origin 仍能查到它们）。
