// 人类鉴权的端点（契约 §6.1–6.3 / 6.4 / 6.7 / 6.8 / 6.11 / 6.12 / 6.14–6.16）。
//
// 【§3.3 写权限矩阵】本文件的 handler：
//   · **永不写** task_status / task_history —— 那是执行真相的镜像，只由机器鉴权的 upsert/digest 写。
//   · P1 里也**不写** task（P2 才有云端建任务）。
//   能写的只有：user_session、enrollment_code、registration_key、machine.revoked_at。
// 【§3.5】每条业务查询都必须带 workspace_id 谓词 —— 无 RLS，底下没有兜底。
// 【§3.4】查不到 / 非本 workspace → 一律 404，不泄露「存在但你没权限」。
import {
  requireSession, verifyUserKey, createSession, destroySession,
  setSessionCookie, clearSessionCookie, publicUser, publicWorkspace,
  mintCredential, mintEnrollmentCode,
} from '../auth.js';
import { pool, q, withTx } from '../db.js';
import { sendError, rateLimit } from '../http.js';

const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const ENROLL_CODE_TTL_SEC = 600; // 10min（契约 §3.2 / §6.4）

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
    // 任务的真实创建时间取本地 task.json.createdAt 的镜像；task.created_at 只是云端入库时刻（导入产物）
    createdAt: iso(r.local_created_at),
    status: {
      state: r.state,
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
  t.local_task_key, t.local_created_at,
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
    const from = `
        from task t
        join machine m on m.id = t.machine_id
        join task_status ts on ts.task_id = t.id`;

    const total = await q(`select count(*)::int as n ${from} ${where}`, args);
    const { rows } = await q(
      // 排序固定：与本地看板各桶同源（collect.js:225）
      `select ${TASK_COLUMNS} ${from} ${where}
        order by ts.last_activity_at desc nulls last
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
    const { rows } = await q(
      `select ${TASK_COLUMNS}, t.prompt, t.description,
              ts.session_id, ts.git_branch, ts.worktree_branch, ts.usage
         from task t
         join machine m on m.id = t.machine_id
         join task_status ts on ts.task_id = t.id
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
      status: {
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
}
