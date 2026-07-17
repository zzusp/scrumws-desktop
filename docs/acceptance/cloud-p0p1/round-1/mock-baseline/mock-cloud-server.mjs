/**
 * 云端前端验证用 mock 服务 —— 逐字实现 docs/spec/cloud-p0p1-contract.md 里
 * 前端会调的 6 个端点的**响应形状**（§6.1/6.2/6.3/6.7/6.11/6.12），塞进测试数据。
 *
 * 用途：cloud/src/ 的真服务由另一个 agent 写，前端不能等它才验布局与逻辑。
 * 这里只保证「形状与契约一致」，不做鉴权强度 / 限流 / DB —— 那是真服务的事。
 *
 *   node docs/acceptance/cloud-control-plane/scripts/mock-cloud-server.mjs
 *   端口：CLOUD_MOCK_PORT（默认 8791；**不用 8790**，真服务要占；**绝不碰 8799** 本地看板）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.CLOUD_MOCK_PORT || 8791);
const PUBLIC_DIR = path.resolve(import.meta.dirname, '../../../../cloud/public');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// ---------- 测试数据 ----------
const MACHINES = () => [
  {
    id: 'm-1111', machineUid: '3f2a9c1e-0000-4000-8000-000000000001',
    displayName: '孙鹏的开发机', owner: { id: 'u-1', name: '孙鹏' },
    hostname: 'DESKTOP-ABC', platform: 'win32', arch: 'x64',
    appVersion: '0.1.0', claudeVersion: '2.1.207',
    status: 'online', lastSeenAt: iso(8_000),
    load: { processing: 2, queued: 1, cap: 5 },
    enrolledAt: iso(26 * 3600e3), revokedAt: null,
    taskCounts: { plan: 1, queued: 1, processing: 2, awaitingHuman: 1, done: 3, archived: 40 },
  },
  {
    id: 'm-2222', machineUid: '3f2a9c1e-0000-4000-8000-000000000002',
    displayName: '李雷的笔记本', owner: { id: 'u-2', name: '李雷' },
    hostname: 'LAPTOP-XYZ', platform: 'darwin', arch: 'arm64',
    appVersion: '0.1.0', claudeVersion: null,
    status: 'offline', lastSeenAt: iso(47 * 60e3),
    load: { processing: 0, queued: 0, cap: 0 },       // cap=0 → 不限
    enrolledAt: iso(5 * 24 * 3600e3), revokedAt: null,
    taskCounts: { plan: 0, queued: 0, processing: 1, awaitingHuman: 1, done: 1, archived: 3 },
  },
];

const mach = (id) => { const m = MACHINES().find((x) => x.id === id); return { id: m.id, displayName: m.displayName, status: m.status }; };
const mk = (o) => ({
  origin: 'local', worktree: false, baseBranch: null, effort: 'xhigh', model: 'claude-opus-4-8',
  cwd: 'D:\\project\\scrumws-desktop', description: null, ...o,
  status: {
    outcome: null, resolvedAt: null, backgroundTaskCount: 0, isArchive: false,
    rounds: 1, numTurns: 4, totalCostUsd: 0.05, mirror: 'live', syncedAt: iso(9_000), ...o.status,
  },
});

const TASKS = () => [
  mk({
    id: 't-plan-1', machine: mach('m-1111'), source: 'manual', title: '把看板卡片排序改成按最后活动时间',
    localTaskKey: 'manual:20260716132301-482', createdAt: iso(3 * 3600e3),
    prompt: '看板现在按创建时间排序，应该改成按最后活动时间倒序。\n注意 nulls last。',
    status: { state: 'plan', enteredAt: iso(3 * 3600e3), lastActivityAt: iso(3 * 3600e3), rounds: 0, numTurns: 0, totalCostUsd: 0 },
  }),
  mk({
    id: 't-queued-1', machine: mach('m-1111'), source: 'chat', title: '钉钉群里提的：日报模版加一列',
    localTaskKey: 'chat:20260716140000-113', createdAt: iso(40 * 60e3),
    status: { state: 'queued', enteredAt: iso(12 * 60e3), lastActivityAt: iso(12 * 60e3), rounds: 0, numTurns: 0, totalCostUsd: 0 },
  }),
  mk({
    id: 't-proc-1', machine: mach('m-1111'), source: 'manual', title: '修复 connector 对账丢更新（rev 字段集缺 title/description）',
    localTaskKey: 'manual:20260716150000-901', createdAt: iso(2 * 3600e3),
    prompt: '重命名 / 改备注 / 归档都不动 rev 的 9 个字段 → 云端永久停在旧值。把 v1 字段集补齐。',
    status: {
      state: 'processing', enteredAt: iso(6 * 60e3), lastActivityAt: iso(15_000),
      sessionId: '9c2f1a2b-7788-4000-9000-aaaabbbbcccc', rounds: 3, numTurns: 12, totalCostUsd: 0.421337,
      worktreeBranch: 'worktree-cloud-control-plane',
      usage: { input_tokens: 128340, output_tokens: 5671, cache_read_input_tokens: 892100, cache_creation_input_tokens: 12030 },
    },
  }),
  mk({
    id: 't-proc-2', machine: mach('m-2222'), source: 'cli', title: 'CLI 观察态：重构 timeutil 时区解析',
    localTaskKey: 'cli:9c2f1a2b', createdAt: iso(90 * 60e3), prompt: null, model: null, effort: null,
    cwd: '/Users/lilei/work/scrumws',
    // 机器离线 → sweeper 把镜像标 stale（契约 §6.13）。这是「铁律」要显性的那一档。
    status: {
      state: 'processing', enteredAt: iso(80 * 60e3), lastActivityAt: iso(48 * 60e3),
      mirror: 'stale', syncedAt: iso(47 * 60e3), rounds: 5, numTurns: 20, totalCostUsd: 1.203,
      backgroundTaskCount: 2,
      usage: { input_tokens: 45000, output_tokens: 3200, cache_read_input_tokens: 210000, cache_creation_input_tokens: 0 },
    },
  }),
  mk({
    id: 't-await-1', machine: mach('m-1111'), source: 'manual', title: '等人工确认：迁移 001 要不要加 local_spec 列',
    localTaskKey: 'manual:20260716151500-233', createdAt: iso(4 * 3600e3),
    prompt: 'P2 才需要 local_spec，本期先不加。确认一下。',
    status: {
      state: 'awaiting-human', enteredAt: iso(22 * 60e3), lastActivityAt: iso(22 * 60e3),
      sessionId: 'aaa11122-3344-4000-9000-ffffeeeedddd', rounds: 2, numTurns: 9, totalCostUsd: 0.187,
      usage: { input_tokens: 61000, output_tokens: 2100, cache_read_input_tokens: 150000, cache_creation_input_tokens: 4400 },
    },
  }),
  mk({
    id: 't-await-2', machine: mach('m-2222'), source: 'manual', title: '本地已被删掉的草稿（local_missing 演示）',
    localTaskKey: 'manual:20260715090000-777', createdAt: iso(2 * 24 * 3600e3),
    prompt: '这条云端有、最近一次 digest 里本地没报 → mirror=local_missing。',
    status: {
      state: 'awaiting-human', enteredAt: iso(30 * 3600e3), lastActivityAt: iso(30 * 3600e3),
      mirror: 'local_missing', syncedAt: iso(6 * 3600e3), rounds: 1, numTurns: 3, totalCostUsd: 0.02,
    },
  }),
  mk({
    id: 't-done-1', machine: mach('m-1111'), source: 'manual', title: '任务详情：Skill 注入的技能正文不再当用户气泡',
    localTaskKey: 'manual:20260715171005-917', createdAt: iso(28 * 3600e3),
    prompt: 'live 路径丢 isMeta，导致 Skill 正文被当成用户气泡渲染。',
    status: {
      state: 'done', outcome: 'success', enteredAt: iso(20 * 3600e3), resolvedAt: iso(20 * 3600e3),
      lastActivityAt: iso(20 * 3600e3), rounds: 6, numTurns: 31, totalCostUsd: 2.4471,
      usage: { input_tokens: 210000, output_tokens: 12400, cache_read_input_tokens: 1_800_000, cache_creation_input_tokens: 33000 },
    },
  }),
  mk({
    id: 't-done-2', machine: mach('m-2222'), source: 'issue', title: '已归档 + 中断的老任务',
    localTaskKey: 'issue:20260710120000-555', createdAt: iso(6 * 24 * 3600e3),
    status: {
      state: 'done', outcome: 'cancelled', isArchive: true, enteredAt: iso(5 * 24 * 3600e3),
      resolvedAt: iso(5 * 24 * 3600e3), lastActivityAt: iso(5 * 24 * 3600e3),
      mirror: 'stale', syncedAt: iso(47 * 60e3), rounds: 2, numTurns: 7, totalCostUsd: 0.31,
    },
  }),
  mk({
    id: 't-done-3', machine: mach('m-1111'), source: 'manual', title: '失败的那次：pg 驱动把 numeric 取回成字符串',
    localTaskKey: 'manual:20260714100000-321', createdAt: iso(3 * 24 * 3600e3),
    status: {
      state: 'done', outcome: 'failed', enteredAt: iso(3 * 24 * 3600e3), resolvedAt: iso(3 * 24 * 3600e3),
      lastActivityAt: iso(3 * 24 * 3600e3), rounds: 1, numTurns: 2, totalCostUsd: 0.008,
    },
  }),
];

const HISTORY = () => ({
  't-proc-1': [
    { seq: 0, state: 'queued', at: iso(2 * 3600e3), by: 'create:manual' },
    { seq: 1, state: 'processing', at: iso(2 * 3600e3 - 1000), by: 'session' },
    { seq: 2, state: 'awaiting-human', at: iso(70 * 60e3), by: 'session' },
    { seq: 3, state: 'processing', at: iso(6 * 60e3), by: 'user' },
  ],
  't-await-1': [
    { seq: 0, state: 'plan', at: iso(4 * 3600e3), by: 'create:manual' },
    { seq: 1, state: 'queued', at: iso(50 * 60e3), by: 'user' },
    { seq: 2, state: 'processing', at: iso(49 * 60e3), by: 'session' },
    { seq: 3, state: 'awaiting-human', at: iso(22 * 60e3), by: 'session' },
  ],
  't-proc-2': [
    // 契约已知缺口 4：CLI 合成时间线前两条没有 by（collect-cli.js:421-425）→ by 可空
    { seq: 0, state: 'queued', at: iso(90 * 60e3) },
    { seq: 1, state: 'processing', at: iso(80 * 60e3) },
  ],
  't-done-1': [
    { seq: 0, state: 'queued', at: iso(28 * 3600e3), by: 'create:manual' },
    { seq: 1, state: 'processing', at: iso(28 * 3600e3 - 2000), by: 'session' },
    { seq: 2, state: 'awaiting-human', at: iso(21 * 3600e3), by: 'session' },
    { seq: 3, state: 'done', at: iso(20 * 3600e3), by: 'user' },
  ],
});

// ---------- 会话（mock：内存 Set，只认 swuk_ 前缀）----------
const sessions = new Set();
const ME = { user: { id: 'u-1', name: '孙鹏', email: null, avatarUrl: null }, workspace: { id: 'w-1', name: 'scrumws', slug: 'scrumws' } };
const err = (code, message) => ({ error: { code, message } });

function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function sessionOf(req) {
  const m = /(?:^|;\s*)swsession=([^;]+)/.exec(req.headers.cookie || '');
  return m && sessions.has(m[1]) ? m[1] : null;
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ---- 静态：cloud/public ----
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  }

  // ---- §6.1 登录 ----
  if (req.method === 'POST' && p === '/api/auth/login') {
    const b = await readBody(req);
    const key = typeof b?.key === 'string' ? b.key.trim() : '';
    if (!key.startsWith('swuk_') || key.length !== 48) return send(res, 401, err('UNAUTHORIZED', '登录密钥无效'));
    const tok = 'swst_' + crypto.randomBytes(32).toString('base64url');
    sessions.add(tok);
    return send(res, 200, ME, { 'Set-Cookie': `swsession=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
  }
  // ---- §6.2 退出 ----
  if (req.method === 'POST' && p === '/api/auth/logout') {
    const s = sessionOf(req);
    if (s) sessions.delete(s);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'swsession=; HttpOnly; Path=/; Max-Age=0' });
  }
  // ---- 以下全部要会话 ----
  if (!sessionOf(req)) return send(res, 401, err('UNAUTHORIZED', '未登录'));

  if (req.method === 'GET' && p === '/api/auth/me') return send(res, 200, ME);
  if (req.method === 'GET' && p === '/api/machines') return send(res, 200, { machines: MACHINES() });

  // ---- §6.11 看板 ----
  if (req.method === 'GET' && p === '/api/tasks') {
    const { state, machineId, mirror, q } = Object.fromEntries(url.searchParams);
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 200);
    let list = TASKS().filter((t) =>
      (!state || t.status.state === state) &&
      (!machineId || t.machine.id === machineId) &&
      (!mirror || t.status.mirror === mirror) &&
      (!q || (t.title + ' ' + (t.prompt || '')).toLowerCase().includes(q.toLowerCase())));
    // 固定排序：last_activity_at desc nulls last（契约 §6.11）
    list = list.slice().sort((a, b) => Date.parse(b.status.lastActivityAt || 0) - Date.parse(a.status.lastActivityAt || 0));
    const total = list.length;
    return send(res, 200, { total, tasks: list.slice(0, limit) });
  }
  // ---- §6.12 详情 ----
  const mDetail = /^\/api\/tasks\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && mDetail) {
    const t = TASKS().find((x) => x.id === decodeURIComponent(mDetail[1]));
    if (!t) return send(res, 404, err('NOT_FOUND', '任务不存在'));
    return send(res, 200, { ...t, history: HISTORY()[t.id] || [] });
  }
  return send(res, 404, err('NOT_FOUND', '端点不存在'));
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock cloud on http://127.0.0.1:${PORT}  (public: ${PUBLIC_DIR})`));
