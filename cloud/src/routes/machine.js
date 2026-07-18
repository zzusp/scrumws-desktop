// 机器鉴权的端点（契约 §6.5 enroll / §6.6 心跳 / §6.9 upsert / §6.10 digest）。
//
// 【§3.3 写权限矩阵】本文件的 handler：
//   · 是 task_status / task_history 的**唯一**写入方（sweeper 只改 mirror 新鲜度，不动执行真相）。
//   · 对 task 只做「导入 origin='local' 行」，对 app_user / user_key / user_session / workspace / member **无权**。
// 【§3.5】机器鉴权的查询一律带 machine_id 谓词。
import {
  requireMachine, verifyRegistrationKey, hashEnrollmentCode, mintCredential,
} from '../auth.js';
import { requireDispatchAllowed } from '../dispatch-gate.js';
import { q, withTx } from '../db.js';
import { sendError, rateLimit } from '../http.js';

const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const BODY_LIMIT_8MB = 8 * 1024 * 1024;
// :id 路径参数（ack / reject 用）
const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID_RE } } };
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));

/**
 * ⚠ enroll 的唯一 401 —— 注册密钥失败与配对码失败必须返回**逐字节相同**的响应（契约 §6.5）。
 * 若「rk 对了但 code 错了」与「rk 错了」可区分，攻击者拿垃圾 code 逐个试 rk，
 * 错误差异就是一个完美的 rk 有效性 oracle，「两把一起验」的与门当场退化成两把可各个击破的独立锁。
 * 代价（明知的取舍）：合法用户配对码过期时也只看到这句话 —— 文案里的「重新生成配对码」就是出路。
 * **别为了体验好一点把错误码分回去。**
 */
const enroll401 = (reply) => sendError(reply, 401, 'UNAUTHORIZED', '注册密钥或配对码无效／已过期，请向管理员确认后重新生成配对码');

export default async function machineRoutes(app) {
  // ============================================================
  // 6.5 POST /api/machine/enroll —— 机器注册
  // 无 Bearer（机器此刻还没有令牌），凭注册密钥 + 配对码两把一起验。
  // **全服务唯一匿名可达的写端点，且暴露在公网** → 门口的廉价拒绝是它存在的理由。
  // ============================================================
  app.post('/api/machine/enroll', {
    preHandler: [rateLimit({ limit: 10, windowMs: 5 * 60_000 })],
    schema: {
      // 第 0 步：只校验「形状」，**绝不校验凭据内容** ——
      // registrationKey / code 只声明 type:string（缺失/非字符串 → 400）；
      // 它们的长度、前缀、有效性一律是凭据内容 → 走下面的 401，不许在这里变成 400（那就是个 oracle）。
      body: {
        type: 'object',
        required: ['registrationKey', 'code', 'machineUid', 'hostname', 'platform', 'arch', 'appVersion'],
        properties: {
          registrationKey: { type: 'string' },
          code: { type: 'string' },
          machineUid: { type: 'string', pattern: UUID_RE },
          displayName: { type: ['string', 'null'] },
          hostname: { type: 'string', minLength: 1 },
          platform: { type: 'string', minLength: 1 },
          arch: { type: 'string', minLength: 1 },
          appVersion: { type: 'string', minLength: 1 },
          claudeVersion: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body;

    // 1. ★ 最先校验 registrationKey ——「在任何 DB 查询和配对码校验之前」。
    //    verifyRegistrationKey 内部先判前缀/长度（连库都不查，纯字符串，零成本）再等值查。
    //    ⚠ 别再往这一步前面加任何耗时操作：那会放大「rk 失败比 code 失败快」的计时侧信道。
    const rk = await verifyRegistrationKey(b.registrationKey);
    if (!rk) {
      // 运维要排障 → 日志里可以分 rk_invalid / code_expired；但绝不进响应体，
      // 也绝不记 rk / code 的明文或完整哈希。
      req.log.warn({ reason: 'rk_invalid', machineUid: b.machineUid }, 'enroll 拒绝');
      return enroll401(reply);
    }
    // 命中 → 得到 workspace_id。rk 是实例级的：它只给出 workspace，不含任何身份信息。

    // 2. 校验配对码。不存在 / 已用 / 过期 / workspace 与第 1 步不一致 → 全部同一个 401。
    const { rows: codeRows } = await q(
      `select id, created_by, workspace_id, used_at, (expires_at < now()) as expired
         from enrollment_code where code_hash = $1`,
      [hashEnrollmentCode(b.code)],
    );
    const ec = codeRows[0];
    if (!ec || ec.used_at || ec.expired || ec.workspace_id !== rk.workspace_id) {
      req.log.warn({ reason: 'code_invalid', machineUid: b.machineUid }, 'enroll 拒绝');
      return enroll401(reply);
    }
    // 命中 → 得到 created_by，它将成为 machine.owner_user_id（这是 rk 给不出来的，§6.5.1）

    // 3–6 同一个事务
    const out = await withTx(async (c) => {
      // 3. upsert machine on (workspace_id, machine_uid)
      //    ⚠ owner_user_id **不在 on conflict 的更新列里**：契约第 3 步只列了
      //    hostname/platform/arch/版本/display_name + 清 revoked_at。重注册不改机器归属。
      const { rows: mrows } = await c.query(
        `insert into machine (workspace_id, machine_uid, owner_user_id, display_name,
                              hostname, platform, arch, app_version, claude_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (workspace_id, machine_uid) do update set
           display_name = excluded.display_name,
           hostname = excluded.hostname,
           platform = excluded.platform,
           arch = excluded.arch,
           app_version = excluded.app_version,
           claude_version = excluded.claude_version,
           revoked_at = null
         returning id, display_name, workspace_id, owner_user_id`,
        [
          rk.workspace_id, b.machineUid, ec.created_by,
          (typeof b.displayName === 'string' && b.displayName.trim()) || b.hostname, // 缺省用 hostname
          b.hostname, b.platform, b.arch, b.appVersion, b.claudeVersion ?? null,
        ],
      );
      const machine = mrows[0];
      // status 不写：新机器用表默认 'offline'，由第一次心跳翻 online；重注册也不动在线态。

      // 4. 重注册即轮换：名下所有令牌作废，再签发新的
      await c.query('update machine_token set revoked_at = now() where machine_id = $1 and revoked_at is null', [machine.id]);
      const token = mintCredential('swmt_');
      await c.query(
        'insert into machine_token (machine_id, token_hash, token_prefix) values ($1, $2, $3)',
        [machine.id, token.hash, token.prefix],
      );

      // 5. 配对码置为已用。**单次使用的原子闸门**：`used_at is null` 放在 where 里，
      //    并发两个 enroll 撞同一个码时只有一个能翻过去，另一个 rowCount=0 → 整个事务回滚 → 同一个 401。
      //    （第 2 步的只读校验挡不住这个竞态：它在事务外。）
      const used = await c.query(
        `update enrollment_code set used_at = now(), used_by_machine_id = $2
          where id = $1 and used_at is null and expires_at > now()
          returning id`,
        [ec.id, machine.id],
      );
      if (!used.rowCount) return null;

      // 6. rk 置 last_used_at，供 §6.15 判断「这把还有人在用吗」再撤销
      await c.query('update registration_key set last_used_at = now() where id = $1', [rk.key_id]);

      const { rows: wrows } = await c.query('select name from workspace where id = $1', [machine.workspace_id]);
      return { token: token.plaintext, machine, workspaceName: wrows[0]?.name ?? null };
    });

    if (!out) {
      req.log.warn({ reason: 'code_race_or_expired', machineUid: b.machineUid }, 'enroll 拒绝');
      return enroll401(reply);
    }

    reply.code(201);
    // 明文 token 只此一次返回
    return {
      token: out.token,
      machineId: out.machine.id,
      workspaceId: out.machine.workspace_id,
      workspaceName: out.workspaceName,
      displayName: out.machine.display_name,
      // §5.7a owner-only 自动执行闸门的前提：本地要拿 ownerUserId 与 intent.createdBy.userId 比对（§7.2）。
      // on conflict 更新列里没有 owner_user_id，机器重注册返回的仍是原主人（决策 12「重注册不改归属」自动兑现）。
      ownerUserId: out.machine.owner_user_id,
    };
  });

  // ============================================================
  // 6.6 POST /api/machine/heartbeat —— 心跳（15s）
  // ============================================================
  app.post('/api/machine/heartbeat', {
    preHandler: [requireMachine],
    schema: {
      body: {
        type: 'object',
        required: ['appVersion', 'load'],
        properties: {
          claudeVersion: { type: ['string', 'null'] },
          appVersion: { type: 'string' },
          load: {
            type: 'object',
            required: ['processing', 'queued', 'cap'],
            properties: {
              processing: { type: 'integer' },
              queued: { type: 'integer' },
              cap: { type: 'integer' }, // = runnerConfig.maxConcurrentRunners（0 = 不限）
            },
          },
        },
      },
    },
  }, async (req) => {
    const b = req.body;
    await q(
      `update machine
          set last_seen_at = now(), status = 'online',
              claude_version = $2, app_version = $3,
              load_processing = $4, load_queued = $5, max_concurrent_runners = $6
        where id = $1 and workspace_id = $7`,
      [
        req.machine.machineId, b.claudeVersion ?? null, b.appVersion,
        b.load.processing, b.load.queued, b.load.cap, req.machine.workspaceId,
      ],
    );
    // machine_token.last_used_at 由 requireMachine 统一更新。
    // §5.7b 取件门铃：connector 靠 pendingIntents>0 才去 GET /api/machine/intents，idle 机器每 tick 省一次请求。
    //   read-only、P0 面、不受绊线约束（设计 §6.2 就是这个模型；P0P1 因无下行把它砍了，现在加回来是向后兼容的新增字段）。
    const p = await q(
      `select count(*)::int as n from task where machine_id = $1 and workspace_id = $2 and dispatch = 'pending'`,
      [req.machine.machineId, req.machine.workspaceId],
    );
    return {
      serverTime: new Date().toISOString(),
      machineId: req.machine.machineId,
      pendingIntents: p.rows[0].n,
    };
  });

  // ============================================================
  // 6.9 POST /api/machine/tasks/upsert —— 增量上报（P1 主干）
  // ============================================================
  app.post('/api/machine/tasks/upsert', {
    preHandler: [requireMachine],
    bodyLimit: BODY_LIMIT_8MB,
    schema: {
      body: {
        type: 'object',
        required: ['tasks'],
        properties: {
          tasks: {
            type: 'array',
            maxItems: 50, // 契约：50 条/批
            items: {
              type: 'object',
              required: ['taskKey', 'rev', 'spec', 'status', 'history'],
              properties: {
                taskKey: { type: 'string', minLength: 1 },
                rev: { type: 'string', minLength: 1 },
                spec: { type: 'object' },
                status: { type: 'object' },
                // history 必填：它的语义是「本次全量」，缺省成 [] 会静默清空历史，
                // 与「漏字段」无法区分 → 宁可 400 报出来。
                history: { type: 'array' },
              },
            },
          },
        },
      },
    },
  }, async (req) => {
    const { machineId, workspaceId } = req.machine;
    const results = [];

    for (const t of req.body.tasks) {
      try {
        // 每条一个事务（契约 §6.9）：一条坏数据不该带崩整批
        const taskId = await withTx(async (c) => {
          const spec = t.spec;
          const st = t.status;

          // 1. upsert task（spec 面）
          //    origin='local'、creator_user_id 留 null（P1 恒定，check(origin<>'cloud' or creator...) 天然满足）
          const ins = await c.query(
            `insert into task (workspace_id, machine_id, origin, title, prompt, model, effort, cwd,
                               worktree, base_branch, description, scheduled_at, source,
                               local_task_key, local_created_at)
             values ($1, $2, 'local', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             on conflict (machine_id, local_task_key) do update set
               title = excluded.title, prompt = excluded.prompt, model = excluded.model,
               effort = excluded.effort, cwd = excluded.cwd, worktree = excluded.worktree,
               base_branch = excluded.base_branch, description = excluded.description,
               scheduled_at = excluded.scheduled_at, source = excluded.source,
               local_created_at = excluded.local_created_at
             where task.origin = 'local'
             returning id`,
            [
              workspaceId, machineId, spec.title ?? null, spec.prompt ?? null, spec.model ?? null,
              spec.effort ?? null, spec.cwd ?? null, spec.worktree ?? null, spec.baseBranch ?? null,
              spec.description ?? null, spec.scheduledAt ?? null, spec.source ?? null,
              t.taskKey, spec.createdAt ?? null,
            ],
          );

          let taskId = ins.rows[0]?.id;
          if (!taskId) {
            // 冲突行是 origin='cloud'（P2 才有）→ 上面的 where 拦住了 spec 覆盖：
            // 云端撰写的 spec 云端权威，机器不许改。但 status 仍要写，所以把 id 查出来。
            const got = await c.query(
              'select id from task where machine_id = $1 and local_task_key = $2',
              [machineId, t.taskKey],
            );
            taskId = got.rows[0]?.id;
            if (!taskId) throw new Error('task upsert 未返回 id');
          }

          // 2. upsert task_status（全列覆盖）+ mirror='live' + rev **原样存**（云端不重算 rev，§5.5）
          await c.query(
            `insert into task_status (task_id, state, outcome, entered_at, resolved_at, session_id,
                                      rounds, num_turns, total_cost_usd, usage, git_branch,
                                      worktree_branch, background_task_count, is_archive,
                                      last_activity_at, rev, mirror, synced_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, 'live', now())
             on conflict (task_id) do update set
               state = excluded.state, outcome = excluded.outcome, entered_at = excluded.entered_at,
               resolved_at = excluded.resolved_at, session_id = excluded.session_id,
               rounds = excluded.rounds, num_turns = excluded.num_turns,
               total_cost_usd = excluded.total_cost_usd, usage = excluded.usage,
               git_branch = excluded.git_branch, worktree_branch = excluded.worktree_branch,
               background_task_count = excluded.background_task_count, is_archive = excluded.is_archive,
               last_activity_at = excluded.last_activity_at, rev = excluded.rev,
               mirror = 'live', synced_at = now()`,
            [
              taskId, st.state ?? null, st.outcome ?? null, st.enteredAt ?? null, st.resolvedAt ?? null,
              st.sessionId ?? null, st.rounds ?? null, st.numTurns ?? null, st.totalCostUsd ?? null,
              // usage 原样透传（末轮快照），云端不得重新聚合
              st.usage == null ? null : JSON.stringify(st.usage),
              st.gitBranch ?? null, st.worktreeBranch ?? null, st.backgroundTaskCount ?? null,
              st.isArchive ?? false, st.lastActivityAt ?? null, t.rev,
            ],
          );

          // 3. history 同步
          const hist = t.history;
          if (hist.length) {
            await c.query(
              `insert into task_history (task_id, seq, state, "at", "by")
               select $1, s.seq, s.state, s.at_ts, s.by_who
                 from unnest($2::int[], $3::text[], $4::timestamptz[], $5::text[])
                        as s(seq, state, at_ts, by_who)
               on conflict (task_id, seq) do update set
                 state = excluded.state, "at" = excluded."at", "by" = excluded."by"`,
              [
                taskId,
                hist.map((h) => h.seq),
                hist.map((h) => h.state),
                hist.map((h) => h.at),
                hist.map((h) => h.by ?? null),
              ],
            );
          }
          // ⚠ 必须能截断，不能只 append：CLI 观察态卡片的 history 是每次扫描现场合成的
          // （collect-cli.js:418-427），条数会随状态增减。当 append-only 会攒出幽灵历史。
          await c.query('delete from task_history where task_id = $1 and seq >= $2', [taskId, hist.length]);

          return taskId;
        });
        results.push({ taskKey: t.taskKey, taskId, ok: true });
      } catch (err) {
        req.log.error({ err, taskKey: t.taskKey }, 'task upsert 失败');
        results.push({ taskKey: t.taskKey, ok: false, error: err.message });
      }
    }

    return { accepted: results.filter((r) => r.ok).length, results };
  });

  // ============================================================
  // 6.10 POST /api/machine/tasks/digest —— 全量对账（每 5min）
  // ============================================================
  app.post('/api/machine/tasks/digest', {
    preHandler: [requireMachine],
    bodyLimit: BODY_LIMIT_8MB, // 全量清单，条数无上限；1MB 默认只够约 1.4 万条
    schema: {
      body: {
        type: 'object',
        required: ['tasks'],
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              required: ['taskKey', 'rev'],
              properties: { taskKey: { type: 'string' }, rev: { type: 'string' } },
            },
          },
        },
      },
    },
  }, async (req) => {
    const incoming = new Map(req.body.tasks.map((t) => [t.taskKey, t.rev]));

    // 1. 取该机器名下全部 task + rev/mirror
    const { rows } = await q(
      `select t.id, t.local_task_key, ts.rev, ts.mirror
         from task t
         join task_status ts on ts.task_id = t.id
        where t.machine_id = $1`,
      [req.machine.machineId],
    );
    const cloud = new Map(rows.map((r) => [r.local_task_key, r]));

    const needFull = [];
    const relive = [];
    for (const [key, rev] of incoming) {
      const c = cloud.get(key);
      // 2. 云端没有 或 rev 不等 → 机器下一 tick 全量推这些
      if (!c || c.rev !== rev) needFull.push(key);
      // 3. rev 相等但镜像不新鲜 → 复位 live（机器回来了 / 本地又出现了）
      else if (c.mirror !== 'live') relive.push(c.id);
    }
    // 4. 云端有、请求里没有 → 标 local_missing。**不删行、不动 state**。
    const missing = rows.filter((r) => !incoming.has(r.local_task_key)).map((r) => r.id);

    if (relive.length) {
      await q("update task_status set mirror = 'live' where task_id = any($1::uuid[])", [relive]);
    }
    let markedMissing = 0;
    if (missing.length) {
      const res = await q(
        `update task_status set mirror = 'local_missing'
          where task_id = any($1::uuid[]) and mirror <> 'local_missing'`,
        [missing],
      );
      markedMissing = res.rowCount; // 本次真正翻过去的条数（已经是 local_missing 的不重复计）
    }

    return { needFull, markedMissing };
  });

  // ============================================================
  // 5.3 GET /api/machine/intents —— 取件（造成下发 → 挂绊线）
  // ============================================================
  // preHandler 顺序：绊线在鉴权前（明文姿态下不做任何 DB 查询、对有无凭据一视同仁）。
  app.get('/api/machine/intents', {
    preHandler: [requireDispatchAllowed, requireMachine],
  }, async (req) => {
    // 命中偏索引 task_pending_intent_idx (machine_id) where dispatch='pending'；FIFO；每机器 15s 一次。
    // ⚠ GET 绝不改 dispatch：取件不是下发，ack 才是。at-least-once 全靠这条（重复下发有 link 兜底，丢失无人兜底）。
    // dispatch='pending' 蕴含 origin='cloud'（001 的 check 保证 origin='cloud' ⇒ creator_user_id not null），故 join app_user 安全。
    const { rows } = await q(
      `select t.id, t.title, t.prompt, t.model, t.effort, t.cwd, t.worktree, t.base_branch,
              t.description, t.auto_run, t.creator_user_id, u.name as creator_name
         from task t
         join app_user u on u.id = t.creator_user_id
        where t.machine_id = $1 and t.workspace_id = $2 and t.dispatch = 'pending'
        order by t.created_at asc
        limit 50`,
      [req.machine.machineId, req.machine.workspaceId],
    );
    return {
      intents: rows.map((r) => ({
        intentId: r.id,
        title: r.title,
        prompt: r.prompt,
        cwd: r.cwd,
        model: r.model,
        effort: r.effort,
        worktree: r.worktree,
        baseBranch: r.base_branch,
        description: r.description,
        autoRun: r.auto_run,
        // createdBy.userId 是本地 owner-only 闸门的唯一判据（§7.2）：必须是 task.creator_user_id，不是别的。
        createdBy: { userId: r.creator_user_id, name: r.creator_name },
      })),
    };
  });

  // ============================================================
  // 5.4 POST /api/machine/intents/:id/ack —— 回执（不挂绊线：让已在飞的意图落地收口，别制造孤儿）
  // ============================================================
  app.post('/api/machine/intents/:id/ack', {
    preHandler: [requireMachine],
    schema: {
      params: uuidParams,
      body: {
        type: 'object',
        required: ['localTaskKey'],
        properties: { localTaskKey: { type: 'string', minLength: 1, maxLength: 200 } },
      },
    },
  }, async (req, reply) => {
    const { machineId, workspaceId } = req.machine;
    // 一条语句同时兑现「首次 ack」与「重发 ack」（幂等）。别写成先 select 再 update：中间有竞态。
    // dispatched_at = coalesce(...)：重发不刷新——它是首次 ack 成功的时刻，不是 GET 到的时刻。
    const upd = await q(
      `update task
          set dispatch       = 'delivered',
              dispatched_at  = coalesce(dispatched_at, now()),
              local_task_key = $3
        where id = $1 and machine_id = $2 and workspace_id = $4 and origin = 'cloud'
          and ( dispatch = 'pending'
             or (dispatch = 'delivered' and local_task_key = $3) )
        returning id, dispatched_at`,
      [req.params.id, machineId, req.body.localTaskKey, workspaceId],
    );
    if (upd.rows[0]) return { ok: true, dispatchedAt: iso(upd.rows[0].dispatched_at) };

    // rowCount = 0 → 再查判分支（§5.4）
    const cur = await q(
      `select dispatch, local_task_key from task
        where id = $1 and machine_id = $2 and workspace_id = $3 and origin = 'cloud'`,
      [req.params.id, machineId, workspaceId],
    );
    const row = cur.rows[0];
    // 行不存在 / 不属本机（含 §5.2 竞态：意图被取消删掉了）
    if (!row) return sendError(reply, 404, 'NOT_FOUND', '意图不存在或不属于本机');
    // delivered 但 local_task_key 不同 = 同一意图建出两个本地任务，本地幂等破了，必须响
    if (row.dispatch === 'delivered') return sendError(reply, 409, 'ALREADY_ACKED', '该意图已回执到另一个本地任务');
    if (row.dispatch === 'rejected') return sendError(reply, 409, 'ALREADY_REJECTED', '该意图已被拒收');
    return sendError(reply, 409, 'CONFLICT', '意图状态冲突');
  });

  // ============================================================
  // 5.5 POST /api/machine/intents/:id/reject —— 拒收（不挂绊线，同 ack）
  // ============================================================
  app.post('/api/machine/intents/:id/reject', {
    preHandler: [requireMachine],
    schema: {
      params: uuidParams,
      // reason 是机器给的自由文本，原样存、原样显示 → 云端 UI 渲染必须 escapeHtml（cloud/public/app.js 已有该函数）
      body: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
      },
    },
  }, async (req, reply) => {
    const { machineId, workspaceId } = req.machine;
    // 首次 reject 或重发同理由 reject（幂等命中）。reject 天然幂等：丢包 → 意图仍 pending → 下轮重拉重判再 reject。
    const upd = await q(
      `update task
          set dispatch = 'rejected', reject_reason = $3
        where id = $1 and machine_id = $2 and workspace_id = $4 and origin = 'cloud'
          and ( dispatch = 'pending'
             or (dispatch = 'rejected' and reject_reason = $3) )
        returning id`,
      [req.params.id, machineId, req.body.reason, workspaceId],
    );
    if (upd.rows[0]) return { ok: true };

    const cur = await q(
      `select dispatch from task
        where id = $1 and machine_id = $2 and workspace_id = $3 and origin = 'cloud'`,
      [req.params.id, machineId, workspaceId],
    );
    const row = cur.rows[0];
    if (!row) return sendError(reply, 404, 'NOT_FOUND', '意图不存在或不属于本机');
    if (row.dispatch === 'delivered') return sendError(reply, 409, 'ALREADY_ACKED', '该意图已被回执，无法拒收');
    // 已 rejected 但理由不同（重发换了文本）→ 已是终态，据实告知
    if (row.dispatch === 'rejected') return sendError(reply, 409, 'ALREADY_REJECTED', '该意图已被拒收');
    return sendError(reply, 409, 'CONFLICT', '意图状态冲突');
  });
}
