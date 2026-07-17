// 鉴权 —— 契约 §3。
//
// 【评审红线 §3.1.1】三种凭据 = 三张表 = 三个各自独立的校验函数，禁止任何形式的共用。
//   verifyUserKey(swuk_)         只查 user_key         「你是谁」
//   verifyRegistrationKey(swrk_) 只查 registration_key 「这台机器有资格加入吗」
//   verifyMachineToken(swmt_)    只查 machine_token    「这台机器是哪台」
// 明确禁止写成 verifyCredential(plaintext, { table, prefix })：三者的哈希空间完全同构
// （都是 sha256(明文全串) 存 text 列），前缀一旦成为参数，一个传参错误就让 swmt_ 冒充 swrk_ 过闸，
// 而类型系统救不了你（都是 string）。所以下面每个函数把自己的前缀**写死成字面量**，不抽公共 helper。
import crypto from 'node:crypto';
import { pool } from './db.js';
import { sendError } from './http.js';

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// 契约 §3.2：明文 = "<prefix>_" + base64url(randomBytes(32))（43 字符）→ 总长 48
const CREDENTIAL_LEN = 48;
const SESSION_COOKIE = 'swsession';
export const SESSION_TTL_SEC = 30 * 24 * 3600; // 30 天

/**
 * 生成一把凭据 → { plaintext, hash, prefix }。
 *
 * ⚠ 为什么这里 prefix 可以当参数、而上面三个校验函数绝不可以：两者的失败方向相反。
 *   · 生成传错前缀 → 明文前缀与所在表不匹配 → 校验函数的前缀判断当场拒绝（fail closed，且立刻暴露）。
 *   · 校验传错表   → 一种凭据冒充另一种过闸（fail open，静默）。§3.1.1 禁的是后者。
 */
export function mintCredential(prefix) {
  const plaintext = prefix + crypto.randomBytes(32).toString('base64url');
  return { plaintext, hash: sha256(plaintext), prefix: plaintext.slice(0, 9) };
}

// 配对码另一套：要人手输，不能用 base64url。Crockford 风格字母表，剔除易混的 0/1/I/O。
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 个 → 8 位 = 40 bit 熵
/** 生成 8 位一次性配对码（契约 §3.2）。必须 crypto.randomInt 逐位取，禁 Math.random()。 */
export function mintEnrollmentCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return { code, hash: sha256(code), prefix: code.slice(0, 2) };
}
/** 配对码的 sha256（enroll 校验用）。 */
export const hashEnrollmentCode = (code) => sha256(code);

// ============================================================
// 三条独立校验路径（§3.1.1）
// ============================================================

/** 登录密钥 swuk_ → { key_id, user_id, name, email, avatar_url } | null。只查 user_key。 */
export async function verifyUserKey(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length !== CREDENTIAL_LEN || !plaintext.startsWith('swuk_')) return null;
  const { rows } = await pool.query(
    `select k.id as key_id, u.id as user_id, u.name, u.email, u.avatar_url
       from user_key k
       join app_user u on u.id = k.user_id
      where k.key_hash = $1 and k.revoked_at is null`,
    [sha256(plaintext)],
  );
  return rows[0] ?? null;
}

/**
 * 注册密钥 swrk_ → { key_id, workspace_id } | null。只查 registration_key。
 * rk 是实例级的：它**只**给出 workspace，不含任何身份信息（owner_user_id 由配对码定，§6.5.1）。
 */
export async function verifyRegistrationKey(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length !== CREDENTIAL_LEN || !plaintext.startsWith('swrk_')) return null;
  const { rows } = await pool.query(
    `select id as key_id, workspace_id
       from registration_key
      where key_hash = $1 and revoked_at is null`,
    [sha256(plaintext)],
  );
  return rows[0] ?? null;
}

/** 机器令牌 swmt_ → { token_id, machine_id, workspace_id } | null。只查 machine_token。 */
export async function verifyMachineToken(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length !== CREDENTIAL_LEN || !plaintext.startsWith('swmt_')) return null;
  const { rows } = await pool.query(
    // 机器本身被撤销 → 它的令牌一并失效（§6.8 两者同时置 revoked_at，这里是同一条 join 上的谓词，不是兜底路径）
    `select t.id as token_id, m.id as machine_id, m.workspace_id
       from machine_token t
       join machine m on m.id = t.machine_id
      where t.token_hash = $1 and t.revoked_at is null and m.revoked_at is null`,
    [sha256(plaintext)],
  );
  return rows[0] ?? null;
}

// ============================================================
// Web 会话（swst_）—— 登录密钥换来的短期载体，不是第四种身份
// ============================================================

/** 只查 user_session；另加 expires_at > now()（§3.1.1）。 */
async function verifySessionToken(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length !== CREDENTIAL_LEN || !plaintext.startsWith('swst_')) return null;
  const { rows } = await pool.query(
    `select s.id as session_id, u.id as user_id, u.name, u.email, u.avatar_url
       from user_session s
       join app_user u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(plaintext)],
  );
  return rows[0] ?? null;
}

/** 建会话 → 明文 token（只此一次可得，库里只落 sha256）。 */
export async function createSession(userId) {
  const c = mintCredential('swst_');
  await pool.query(
    `insert into user_session (user_id, token_hash, expires_at)
     values ($1, $2, now() + make_interval(secs => $3::int))`,
    [userId, c.hash, SESSION_TTL_SEC],
  );
  return c.plaintext;
}

/** 销毁会话（删行）。 */
export async function destroySession(sessionId) {
  await pool.query('delete from user_session where id = $1', [sessionId]);
}

/** 取 workspace（§9 决策 7：单 workspace 起步，列留着）。 */
async function workspaceOf(userId) {
  const { rows } = await pool.query(
    `select w.id, w.name, w.slug, m.role
       from member m
       join workspace w on w.id = m.workspace_id
      where m.user_id = $1
      order by m.created_at asc
      limit 1`,
    [userId],
  );
  return rows[0] ?? null;
}

// cookie 只有一个、名字固定，手写解析比引 @fastify/cookie 更省一个依赖（§11 钉死 fastify + pg）
function readSessionCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * 契约 §3.2：HttpOnly; Secure; SameSite=Lax，名 swsession。
 *
 * Secure 默认开，但**不强制 HTTPS**：置 CLOUD_INSECURE_COOKIE=1 可摘掉它，让服务在裸 HTTP 上可用。
 *
 * 为什么做成开关而不是直接删：浏览器**拒绝在非安全上下文存 Secure cookie**，所以 Secure 恒开时
 * 一旦部到 http://<公网IP>:8790，登录会**静默坏掉**——POST /api/auth/login 返回 200，
 * 但 cookie 没存下，下一个请求就 401。而 http://127.0.0.1 是安全上下文（浏览器特例），
 * 本地联调永远复现不出来。默认开 = 公网忘配反代时坏得响亮（登不进去），而不是无声泄露凭据。
 *
 * 摘掉它的代价（内网可接受，公网不可）：swuk_ 登录密钥与 swmt_ 机器令牌明文过网，
 * 路径上任何人抓到即可完全冒充。P1 只读时危害止于「看到全团队任务」；P2 起 = 可给所有机器派活。
 */
const INSECURE_COOKIE = process.env.CLOUD_INSECURE_COOKIE === '1';
const COOKIE_ATTRS = `Path=/; HttpOnly;${INSECURE_COOKIE ? '' : ' Secure;'} SameSite=Lax`;

export function setSessionCookie(reply, token) {
  reply.header('set-cookie', `${SESSION_COOKIE}=${token}; ${COOKIE_ATTRS}; Max-Age=${SESSION_TTL_SEC}`);
}
export function clearSessionCookie(reply) {
  reply.header('set-cookie', `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`);
}

export const publicUser = (u) => ({ id: u.user_id ?? u.id, name: u.name, email: u.email ?? null, avatarUrl: u.avatar_url ?? null });
export const publicWorkspace = (w) => ({ id: w.id, name: w.name, slug: w.slug });

// ============================================================
// 两个 preHandler —— **必须分开**，别混（§3.3 写权限矩阵按这条线卡）
// ============================================================

/**
 * 人类鉴权：会话 cookie → req.auth = { sessionId, user, workspace, workspaceId, role }。
 * 挂了它的 handler **永不写 task_status / task_history**（§3 不变式）。
 */
export async function requireSession(req, reply) {
  const token = readSessionCookie(req);
  const sess = token ? await verifySessionToken(token) : null;
  if (!sess) return sendError(reply, 401, 'UNAUTHORIZED', '未登录或会话已过期');
  const ws = await workspaceOf(sess.user_id);
  // 有会话但不属于任何 workspace → 无任何可授权的资源，等同未登录
  if (!ws) return sendError(reply, 401, 'UNAUTHORIZED', '未登录或会话已过期');
  await pool.query('update user_session set last_used_at = now() where id = $1', [sess.session_id]);
  req.auth = {
    sessionId: sess.session_id,
    user: publicUser(sess),
    workspace: publicWorkspace(ws),
    workspaceId: ws.id,
    role: ws.role,
  };
}

/**
 * 机器鉴权：Authorization: Bearer swmt_… → req.machine = { machineId, workspaceId, tokenId }。
 * 挂了它的 handler **永不写 task 的 spec 以外的东西、永不碰 app_user/user_key/…**（§3.3）。
 */
export async function requireMachine(req, reply) {
  const h = req.headers.authorization;
  const token = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  const m = token ? await verifyMachineToken(token) : null;
  // 401 在本地是**终局**（清 identity.json + 停上报，契约 §7.4）—— 别把网络错误也整成这个码
  if (!m) return sendError(reply, 401, 'UNAUTHORIZED', '机器令牌缺失、无效或已撤销');
  await pool.query('update machine_token set last_used_at = now() where id = $1', [m.token_id]);
  req.machine = { machineId: m.machine_id, workspaceId: m.workspace_id, tokenId: m.token_id };
}
