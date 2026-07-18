// 人类鉴权的端点（契约 §6.1–6.3 / 6.4 / 6.7 / 6.8 / 6.11 / 6.12 / 6.14–6.16）。
//
// 【§3.3 写权限矩阵】本文件的 handler：
//   · **永不写** task_status / task_history —— 那是执行真相的镜像，只由机器鉴权的 upsert/digest 写。
//   · P1 里也**不写** task（P2 才有云端建任务）。
//   能写的只有：user_session、enrollment_code、registration_key、machine.revoked_at。
// 【§3.5】每条业务查询都必须带 workspace_id 谓词 —— 无 RLS，底下没有兜底。
// 【§3.4】查不到 / 非本 workspace → 一律 404，不泄露「存在但你没权限」。
import path from 'node:path';
import {
  requireSession, verifyUserKey, createSession, destroySession,
  setSessionCookie, clearSessionCookie, publicUser, publicWorkspace,
  mintCredential, mintEnrollmentCode,
} from '../auth.js';
import { requireDispatchAllowed } from '../dispatch-gate.js';
import { pool, q, withTx } from '../db.js';
import { sendError, rateLimit } from '../http.js';

const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const ENROLL_CODE_TTL_SEC = 600; // 10min（契约 §3.2 / §6.4）

// §5.6 model / effort 白名单 —— 与本地 task-actions.js:23-31 **逐字相同**。
// 云端先挡一道纯为体验；本地 createTask 再挡一次才是权威（不一致会让本地直接拒 → 变 reject）。
const CLOUD_MODELS = new Set([
  'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5',
]);
const CLOUD_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// cwd 必须是绝对路径。云端跑在 Linux，机器可能是 Windows（D:\proj）——单用 path.isAbsolute（随云端平台走）
// 会把 Windows 绝对路径判为相对而误拒。两个平台的判定都试：任一为真即绝对。
const isAbsolutePath = (p) => path.win32.isAbsolute(p) || path.posix.isAbsolute(p);

const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));
// numeric 列（total_cost_usd）从 pg 取回是**字符串** —— 前端要数字，这里显式转
const num = (v) => (v === null || v === undefined ? null : Number(v));
// ILIKE 的 % / _ / \ 必须转义，否则用户搜 "50%" 会变成通配
const likeArg = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID_RE } } };

/** 6.11 / 6.12 共用的单条投影。 */
function mapTaskRow(r) {
  return {
    id: r.id,
    machine: { id: r.machine_id, displayName: r.machine_display_name, status: r.machine_status },
    origin: r.origin,
    source: r.source,
    title: r.title,
    cwd: r.cwd,
    model: r.model,
    effort: r.effort,
    worktree: r.worktree,
    baseBranch: r.base_branch,
    localTaskKey: r.local_task_key,
    // 任务的真实创建时间取本地 task.json.createdAt 的镜像；task.created_at 只是云端入库时刻（导入产物）。
    // origin='cloud' 的意图尚未在本地建任务时 local_created_at 为 null，回退到云端入库时刻 created_at，
    // 否则前端拿不到任何创建时间。
    createdAt: iso(r.local_created_at ?? r.created_at),
    // §5.7c 下发面（origin='local' 行 dispatch 恒 null；origin='cloud' 意图才有值）：
    //   pending  待机器取件   delivered 机器已建本地任务并 ack   rejected 机器拒收（rejectReason 是机器给的自由文本）
    dispatch: r.dispatch,
    dispatchedAt: iso(r.dispatched_at),
    rejectReason: r.reject_reason,
    autoRun: r.auto_run,
    // §5.7c LEFT JOIN 后 pending/rejected 意图**没有** task_status 行（本地还没建任务，谁也报不上来），
    //   ts.* 全为 null。mirror 是 task_status 的 not null 列 → 它为 null 即「无 status 行」的可靠哨兵：
    //   此时只回 dispatch 面，status 显式给 null（不伪造一个全 null 的 status 对象骗消费者）。
    status: r.mirror == null ? null : {
      // ⚠ state 是本地 state.json 的**原值**，不是看板分桶。归档的 runner 任务原值仍是 'done'
      //   （collect.js:204 是「isArchive 优先」分桶，只有 CLI 卡的原值才会是 'archived'）。
      //   要分桶用下面的 bucket，别拿 state 分——拿它分会把归档任务算进 done。
      state: r.state,
      // 派生桶，与 §6.7 taskCounts 和 ?state= 筛选**同口径**（三处必须一起改）。
      // 补这个字段是因为「同名不同义」真的骗到人了：?state=archived 查得出 20 条，
      // 而同一批任务响应里 state 写着 'done' —— 消费者按 state 分桶就会得出与看板相反的结论。
      bucket: r.is_archive ? 'archived' : r.state,
      outcome: r.outcome,
      enteredAt: iso(r.entered_at),
      resolvedAt: iso(r.resolved_at),
      lastActivityAt: iso(r.last_activity_at),
      rounds: r.rounds,
      numTurns: r.num_turns,
      totalCostUsd: num(r.total_cost_usd),
      backgroundTaskCount: r.background_task_count,
      isArchive: r.is_archive,
      mirror: r.mirror,
      syncedAt: iso(r.synced_at),
    },
  };
}

const TASK_COLUMNS = `
  t.id, t.origin, t.source, t.title, t.cwd, t.model, t.effort, t.worktree, t.base_branch,
  t.local_task_key, t.local_created_at, t.created_at,
  t.dispatch, t.dispatched_at, t.reject_reason, t.auto_run,
  m.id as machine_id, m.display_name as machine_display_name, m.status as machine_status,
  ts.state, ts.outcome, ts.entered_at, ts.resolved_at, ts.last_activity_at,
  ts.rounds, ts.num_turns, ts.total_cost_usd, ts.background_task_count, ts.is_archive,
  ts.mirror, ts.synced_at`;

export default async function userRoutes(app) {
  // ============================================================
  // 6.1 POST /api/auth/login —— 登录密钥换会话（无鉴权入口，限流 10/5min/IP）
  // ============================================================
  app.post('/api/auth/login', {
    preHandler: [rateLimit({ limit: 10, windowMs: 5 * 60_000 })],
    schema: { body: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } } },
  }, async (req, reply) => {
    // 哈希后按唯一索引等值查 —— 不做明文比较，天然无时序泄露（§6.1）
    const hit = await verifyUserKey(req.body.key);
    if (!hit) return sendError(reply, 401, 'UNAUTHORIZED', '登录密钥无效或已撤销');

    const ws = await pool.query(
      `select w.id, w.name, w.slug
         from member mb join workspace w on w.id = mb.workspace_id
        where mb.user_id = $1 order by mb.created_at asc limit 1`,
      [hit.user_id],
    );
    if (!ws.rows[0]) return sendError(reply, 401, 'UNAUTHORIZED', '登录密钥无效或已撤销');

    await q('update user_key set last_used_at = now() where id = $1', [hit.key_id]);
    const token = await createSession(hit.user_id);
    setSessionCookie(reply, token);
    return { user: publicUser(hit), workspace: publicWorkspace(ws.rows[0]) };
  });

  // ============================================================
  // 6.2 POST /api/auth/logout
  // ============================================================
  app.post('/api/auth/logout', { preHandler: [requireSession] }, async (req, reply) => {
    await destroySession(req.auth.sessionId);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ============================================================
  // 6.3 GET /api/auth/me —— 前端启动判是否已登录
  // ============================================================
  app.get('/api/auth/me', { preHandler: [requireSession] }, async (req) => ({
    user: req.auth.user,
    workspace: req.auth.workspace,
  }));

  // ============================================================
  // 6.4 POST /api/machines/enrollment-codes —— 生成一次性配对码
  // ============================================================
  // 不声明 body schema：本端点**没有任何字段**（workspace 取会话所属），
  // 校验「body 必须是 object」只会把 fetch(url,{method:'POST'}) 这种无 body 的调用挡成 400，
  // 挡下来的也不是错误输入。有字段要校验的端点（如 registration-keys 的 label）才留 schema。
  app.post('/api/machines/enrollment-codes', {
    preHandler: [requireSession],
  }, async (req, reply) => {
    const { code, hash, prefix } = mintEnrollmentCode();
    // created_by 会成为被注册机器的 owner_user_id（§6.5 第 3 步）——
    // 它是 P2 owner-only 自动执行闸门的判据，不是审计字段，别随手改。
    const { rows } = await q(
      `insert into enrollment_code (code_hash, code_prefix, workspace_id, created_by, expires_at)
       values ($1, $2, $3, $4, now() + make_interval(secs => $5::int))
       returning expires_at`,
      [hash, prefix, req.auth.workspaceId, req.auth.user.id, ENROLL_CODE_TTL_SEC],
    );
    reply.code(201);
    // 明文 code 只此一次返回（库里只有 sha256）
    return { code, expiresAt: iso(rows[0].expires_at), ttlSec: ENROLL_CODE_TTL_SEC };
  });

  // ============================================================
  // 6.14 POST /api/registration-keys —— 生成注册密钥（登录后的人才能操作）
  // ============================================================
  app.post('/api/registration-keys', {
    preHandler: [requireSession],
    schema: {
      body: { type: 'object', properties: { label: { type: ['string', 'null'], maxLength: 64 } } },
    },
  }, async (req, reply) => {
    // 云端**自己生成**明文（不是人设的口令）
    const { plaintext, hash, prefix } = mintCredential('swrk_');
    const { rows } = await q(
      `insert into registration_key (workspace_id, key_hash, key_prefix, label, created_by)
       values ($1, $2, $3, $4, $5)
       returning id, created_at`,
      [req.auth.workspaceId, hash, prefix, req.body?.label ?? null, req.auth.user.id],
    );
    reply.code(201);
    // ⚠ 明文 key 只在这一次响应里存在，云端此后再也拿不到（只存 sha256）
    return {
      id: rows[0].id,
      key: plaintext,
      keyPrefix: prefix,
      label: req.body?.label ?? null,
      createdAt: iso(rows[0].created_at),
    };
  });

  // ============================================================
  // 6.15 GET /api/registration-keys —— ⚠ 永不返回明文，也永不返回 key_hash
  // ============================================================
  app.get('/api/registration-keys', {
    preHandler: [requireSession],
    schema: { querystring: { type: 'object', properties: { activeOnly: { type: 'string' } } } },
  }, async (req) => {
    const activeOnly = req.query.activeOnly === '1';
    const { rows } = await q(
      `select rk.id, rk.key_prefix, rk.label, rk.created_at, rk.last_used_at, rk.revoked_at,
              u.id as created_by_id, u.name as created_by_name
         from registration_key rk
         join app_user u on u.id = rk.created_by
        where rk.workspace_id = $1
          and ($2::boolean = false or rk.revoked_at is null)
        order by rk.created_at desc`,
      [req.auth.workspaceId, activeOnly],
    );
    return {
      keys: rows.map((r) => ({
        id: r.id,
        keyPrefix: r.key_prefix,
        label: r.label,
        createdBy: { id: r.created_by_id, name: r.created_by_name },
        createdAt: iso(r.created_at),
        // 轮换的操作依据：贴出新的一把 → 观察旧那把的 lastUsedAt 不再前进 → 撤销旧的
        lastUsedAt: iso(r.last_used_at),
        revokedAt: iso(r.revoked_at),
      })),
    };
  });

  // ============================================================
  // 6.16 POST /api/registration-keys/:id/revoke —— 幂等；**不影响已在线机器**（§6.5.2 rk 只管入场不管在场）
  // ============================================================
  app.post('/api/registration-keys/:id/revoke', {
    preHandler: [requireSession],
    schema: { params: uuidParams },
  }, async (req, reply) => {
    // coalesce：已撤销的再撤 → 幂等返回原 revokedAt，不报错、不刷新时间
    const { rows } = await q(
      `update registration_key set revoked_at = coalesce(revoked_at, now())
        where id = $1 and workspace_id = $2
        returning id, revoked_at`,
      [req.params.id, req.auth.workspaceId],
    );
    if (!rows[0]) return sendError(reply, 404, 'NOT_FOUND', '注册密钥不存在');
    return { ok: true, id: rows[0].id, revokedAt: iso(rows[0].revoked_at) };
  });

  // ============================================================
  // 6.7 GET /api/machines —— 机器列表
  // ============================================================
  app.get('/api/machines', {
    preHandler: [requireSession],
    schema: { querystring: { type: 'object', properties: { includeRevoked: { type: 'string' } } } },
  }, async (req) => {
    const includeRevoked = req.query.includeRevoked === '1';
    const { rows } = await q(
      `select m.id, m.machine_uid, m.display_name, m.hostname, m.platform, m.arch,
              m.app_version, m.claude_version, m.status, m.last_seen_at,
              m.max_concurrent_runners, m.load_processing, m.load_queued,
              m.enrolled_at, m.revoked_at,
              u.id as owner_id, u.name as owner_name
         from machine m
         join app_user u on u.id = m.owner_user_id
        where m.workspace_id = $1
          and ($2::boolean = true or m.revoked_at is null)
        order by m.display_name asc`,
      [req.auth.workspaceId, includeRevoked],
    );

    // taskCounts 的 6 个桶 = 本地看板 collectState().lifecycle 的 6 个桶，必须同口径：
    // collect.js:197 是「isArchive 优先」——归档任务的 state 仍是底层态（done 等），桶却是 archived。
    // 只按 state 数会把归档任务错算进 done，与看板对不上，所以这里按 is_archive 派生桶。
    const counts = await q(
      `select t.machine_id,
              case when ts.is_archive then 'archived' else ts.state end as bucket,
              count(*)::int as n
         from task t
         join task_status ts on ts.task_id = t.id
        where t.workspace_id = $1
        group by 1, 2`,
      [req.auth.workspaceId],
    );
    const BUCKET_KEY = {
      plan: 'plan', queued: 'queued', processing: 'processing',
      'awaiting-human': 'awaitingHuman', done: 'done', archived: 'archived',
    };
    const byMachine = new Map();
    for (const r of counts.rows) {
      const key = BUCKET_KEY[r.bucket];
      if (!key) continue; // 6 桶之外的历史遗留 state（collect.js 的 other 桶）本就不上行，§9 缺口 2
      const bucket = byMachine.get(r.machine_id) ?? {};
      bucket[key] = r.n;
      byMachine.set(r.machine_id, bucket);
    }
    const zero = { plan: 0, queued: 0, processing: 0, awaitingHuman: 0, done: 0, archived: 0 };

    return {
      machines: rows.map((r) => ({
        id: r.id,
        machineUid: r.machine_uid,
        displayName: r.display_name,
        owner: { id: r.owner_id, name: r.owner_name },
        hostname: r.hostname,
        platform: r.platform,
        arch: r.arch,
        appVersion: r.app_version,
        claudeVersion: r.claude_version,
        status: r.status,
        lastSeenAt: iso(r.last_seen_at),
        load: { processing: r.load_processing, queued: r.load_queued, cap: r.max_concurrent_runners },
        enrolledAt: iso(r.enrolled_at),
        revokedAt: iso(r.revoked_at),
        taskCounts: { ...zero, ...(byMachine.get(r.id) ?? {}) },
      })),
    };
  });

  // ============================================================
  // 6.8 POST /api/machines/:id/revoke —— 撤销机器 = 踢掉已在线机器
  // ============================================================
  app.post('/api/machines/:id/revoke', {
    preHandler: [requireSession],
    schema: { params: uuidParams },
  }, async (req, reply) => {
    const done = await withTx(async (c) => {
      const { rows } = await c.query(
        `update machine set revoked_at = coalesce(revoked_at, now())
          where id = $1 and workspace_id = $2
          returning id`,
        [req.params.id, req.auth.workspaceId],
      );
      if (!rows[0]) return false;
      // 令牌一并作废 → 下次心跳即 401 → 本地自行清身份（§7.4 401 是终局）
      await c.query('update machine_token set revoked_at = now() where machine_id = $1 and revoked_at is null', [rows[0].id]);
      return true;
    });
    if (!done) return sendError(reply, 404, 'NOT_FOUND', '机器不存在');
    // 任务数据不删（历史仍可看）；也不动任何 task_status（§3 不变式）
    return { ok: true };
  });

  // ============================================================
  // 6.11 GET /api/tasks —— 云端看板
  // ============================================================
  app.get('/api/tasks', {
    preHandler: [requireSession],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          machineId: { type: 'string', pattern: UUID_RE },
          state: { type: 'string' },
          mirror: { type: 'string' },
          q: { type: 'string' },
          limit: { type: 'integer', minimum: 1, default: 100 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (req) => {
    const limit = Math.min(req.query.limit, 200); // 契约：默认 100、上限 200
    const offset = req.query.offset;
    const args = [
      req.auth.workspaceId,
      req.query.machineId ?? null,
      req.query.state ?? null,
      req.query.mirror ?? null,
      req.query.q ? likeArg(req.query.q) : null,
    ];
    // state 过滤必须与 §6.7 taskCounts 同口径：按 is_archive 派生桶，不能裸比 ts.state。
    // collect.js:204 是「isArchive 优先」分桶——归档任务的 state 仍是底层态（done 等），桶却是 archived。
    // 裸比 state 会让 done 列混入归档任务：机器页显示 done 10 / archived 40、看板 done 列头却是 50，
    // 同一界面两个矛盾的数字；且归档只增不减，会在 limit 内把真正活跃的 done 挤出去。
    const where = `
       where t.workspace_id = $1
         and ($2::uuid is null or t.machine_id = $2::uuid)
         and ($3::text is null or (case when ts.is_archive then 'archived' else ts.state end) = $3::text)
         and ($4::text is null or ts.mirror = $4::text)
         and ($5::text is null or t.title ilike $5::text or t.prompt ilike $5::text)`;
    // §5.7c LEFT JOIN task_status：pending/rejected 的云端意图还没有 task_status 行（本地未建任务），
    //   内连接会让它们「建了看不见」。left join 后这些行 ts.* 为 null，mapTaskRow 只回 dispatch 面。
    //   注意：带 ?state= / ?mirror= 过滤时 ts 为 null 的意图天然不匹配（null = 值 → 落空），符合语义。
    const from = `
        from task t
        join machine m on m.id = t.machine_id
        left join task_status ts on ts.task_id = t.id`;

    const total = await q(`select count(*)::int as n ${from} ${where}`, args);
    const { rows } = await q(
      // 排序与本地看板各桶同源（collect.js:225）按最近活动倒序；意图无 last_activity_at，
      //   回退到云端入库时刻 created_at，否则新建的意图会被 nulls last 压到最底、在 limit 内被挤掉。
      `select ${TASK_COLUMNS} ${from} ${where}
        order by coalesce(ts.last_activity_at, t.created_at) desc nulls last
        limit $6 offset $7`,
      [...args, limit, offset],
    );
    return { total: total.rows[0].n, tasks: rows.map(mapTaskRow) };
  });

  // ============================================================
  // 6.12 GET /api/tasks/:id —— 任务详情
  // ============================================================
  app.get('/api/tasks/:id', {
    preHandler: [requireSession],
    schema: { params: uuidParams },
  }, async (req, reply) => {
    // §5.7c LEFT JOIN：pending/rejected 意图无 task_status 行，内连接会让详情页 404（明明建出来了）。
    const { rows } = await q(
      `select ${TASK_COLUMNS}, t.prompt, t.description,
              ts.session_id, ts.git_branch, ts.worktree_branch, ts.usage
         from task t
         join machine m on m.id = t.machine_id
         left join task_status ts on ts.task_id = t.id
        where t.id = $1 and t.workspace_id = $2`,
      [req.params.id, req.auth.workspaceId],
    );
    // 不存在 / 非本 workspace → 一律 404，不泄露「存在但你没权限」（§3.4）
    if (!rows[0]) return sendError(reply, 404, 'NOT_FOUND', '任务不存在');
    const r = rows[0];
    const history = await q(
      'select seq, state, at, by from task_history where task_id = $1 order by seq asc',
      [r.id],
    );
    const base = mapTaskRow(r);
    return {
      ...base,
      prompt: r.prompt,
      description: r.description,
      // base.status 为 null 时（意图尚无 task_status 行）只回 dispatch 面，不拼 session/usage 等执行字段。
      status: base.status == null ? null : {
        ...base.status,
        sessionId: r.session_id,
        gitBranch: r.git_branch,
        worktreeBranch: r.worktree_branch,
        // usage 是**末轮快照**，rounds / totalCostUsd 是累计 —— collect.js:263-265 的既定口径，
        // 云端原样透传，不重新聚合（§3 不变式）
        usage: r.usage,
      },
      history: history.rows.map((h) => ({ seq: h.seq, state: h.state, at: iso(h.at), by: h.by })),
    };
  });

  // ============================================================
  // 5.1 POST /api/tasks —— 建意图（造成下发 → 挂绊线；绊线排在鉴权之前）
  // ============================================================
  app.post('/api/tasks', {
    preHandler: [requireDispatchAllowed, requireSession],
    schema: {
      body: {
        type: 'object',
        required: ['machineId', 'title', 'prompt', 'cwd'],
        properties: {
          machineId: { type: 'string', pattern: UUID_RE },
          // 长度上界防超大 payload；「trim 后 1..N」的精确判定在 handler（schema 量不到 trim）
          title: { type: 'string', maxLength: 200 },
          prompt: { type: 'string', maxLength: 100000 },
          cwd: { type: 'string', maxLength: 1000 },
          model: { type: ['string', 'null'] },
          effort: { type: ['string', 'null'] },
          worktree: { type: 'boolean', default: false },
          baseBranch: { type: ['string', 'null'], maxLength: 200 },
          description: { type: ['string', 'null'], maxLength: 2000 },
          autoRun: { type: 'boolean', default: false }, // 只是**意愿**，跑不跑由本地闸门定
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body;
    const workspaceId = req.auth.workspaceId;

    // 校验顺序即语义（§5.1）。
    // 1. machine：同 workspace + revoked_at is null + status='online'。
    //    不存在 / 跨 workspace → 404（不泄露「存在但你没权限」，§3.4）；存在但离线 / 已撤销 → 409。
    const m = (await q(
      `select id, status, revoked_at from machine where id = $1 and workspace_id = $2`,
      [b.machineId, workspaceId],
    )).rows[0];
    if (!m) return sendError(reply, 404, 'NOT_FOUND', '机器不存在');
    if (m.revoked_at || m.status !== 'online') {
      // 决策 16「能用才能选」：建时要求 online（别对着从没连过的机器许愿）；下发容忍离线（已许的愿不因掉线作废）。
      return sendError(reply, 409, 'MACHINE_UNAVAILABLE', '目标机器当前不在线，无法派活');
    }

    // 2. model / effort 落在与本地逐字相同的白名单（§5.6）。云端先挡一道纯为体验，本地再挡一次才是权威。
    if (b.model != null && !CLOUD_MODELS.has(b.model)) return sendError(reply, 400, 'BAD_REQUEST', `model 不在白名单：${b.model}`);
    if (b.effort != null && !CLOUD_EFFORTS.has(b.effort)) return sendError(reply, 400, 'BAD_REQUEST', `effort 不在白名单：${b.effort}`);

    // 3. title / prompt / cwd trim 后非空；cwd 必须绝对路径。
    const title = String(b.title).trim();
    const prompt = String(b.prompt).trim();
    const cwd = String(b.cwd).trim();
    if (!title || title.length > 200) return sendError(reply, 400, 'BAD_REQUEST', 'title 不能为空且不超过 200 字符');
    if (!prompt) return sendError(reply, 400, 'BAD_REQUEST', 'prompt 不能为空');
    if (!cwd) return sendError(reply, 400, 'BAD_REQUEST', 'cwd 不能为空');
    // 为什么 cwd 必填且必须绝对：createTask 的 cwd 空则 claude 跑在桌面 app 进程自己的 CWD 里
    //   （session-manager.js:206），那不在任何白名单里 —— 最不该被云端指到的地方。
    if (!isAbsolutePath(cwd)) return sendError(reply, 400, 'BAD_REQUEST', 'cwd 必须是绝对路径');
    const description = (b.description != null && String(b.description).trim()) || null;
    const baseBranch = (b.baseBranch != null && String(b.baseBranch).trim()) || null;

    // 4. ⚠ 红线：creator_user_id **只从会话取，绝不从 body 取**。它是 owner-only 闸门判据，
    //    一旦可由请求体指定，任何登录用户都能自称机器主人 → 闸门当场失效。
    const creatorUserId = req.auth.user.id;

    // 5. insert：origin='cloud'、dispatch='pending'。云端永不写 task_status / task_history（不变式 1）。
    const { rows } = await q(
      `insert into task (workspace_id, machine_id, origin, creator_user_id, title, prompt, model, effort,
                         cwd, worktree, base_branch, description, auto_run, dispatch)
       values ($1, $2, 'cloud', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
       returning id, dispatch, created_at`,
      [
        workspaceId, b.machineId, creatorUserId, title, prompt, b.model ?? null, b.effort ?? null,
        cwd, b.worktree ?? false, baseBranch, description, b.autoRun ?? false,
      ],
    );
    reply.code(201);
    return { id: rows[0].id, dispatch: rows[0].dispatch, createdAt: iso(rows[0].created_at) };
  });

  // ============================================================
  // 5.2 POST /api/tasks/:id/cancel —— 取消未下发的意图
  //   不挂绊线：取消只**移除**、不造成下发，且运维中途关掉开关也该能收口。
  // ============================================================
  app.post('/api/tasks/:id/cancel', {
    preHandler: [requireSession],
    schema: { params: uuidParams },
  }, async (req, reply) => {
    // pending 意图无 task_status / task_history / local_task_key 足迹，删行即彻底消失（无级联残留）。
    // 用 DELETE 而非第四个枚举值：语义即「这条从未到达机器的意图不复存在」（§5.2 / 迁移旁注）。
    const del = await q(
      `delete from task
        where id = $1 and workspace_id = $2 and origin = 'cloud' and dispatch = 'pending'
        returning id`,
      [req.params.id, req.auth.workspaceId],
    );
    if (del.rowCount === 1) return { ok: true, cancelled: true };

    // rowCount = 0 → 再查该行判分支（§5.2）
    const cur = await q(
      `select origin, dispatch from task where id = $1 and workspace_id = $2`,
      [req.params.id, req.auth.workspaceId],
    );
    const row = cur.rows[0];
    // 不存在 / 跨 workspace / origin<>'cloud' → 404
    if (!row || row.origin !== 'cloud') return sendError(reply, 404, 'NOT_FOUND', '意图不存在');
    // 已下发的撤回是 P3 命令下行，本期不做。响应带当前 dispatch（§5.2）。
    if (row.dispatch === 'delivered') {
      reply.code(409).send({ error: { code: 'ALREADY_DISPATCHED', message: '意图已下发到机器，无法取消（撤回已下发任务是 P3 命令下行）' }, dispatch: row.dispatch });
      return reply;
    }
    if (row.dispatch === 'rejected') {
      reply.code(409).send({ error: { code: 'ALREADY_REJECTED', message: '意图已被机器拒收' }, dispatch: row.dispatch });
      return reply;
    }
    return sendError(reply, 409, 'CONFLICT', '意图状态冲突');
  });
}
