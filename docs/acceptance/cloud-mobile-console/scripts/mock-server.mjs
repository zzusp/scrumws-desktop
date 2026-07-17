#!/usr/bin/env node
'use strict';
/* ==========================================================================
   SG4 手机端页面验证用 mock 云端（零依赖，node >= 18）
   - 静态托管 cloud/public/（与真实 @fastify/static root 同构：目录 → index.html）
   - stub 契约面（docs/spec/cloud-mobile-console.md §4.3/§4.4）：
       /api/auth/login|logout|me · /api/my/machines
       /api/my/machines/:id/rpc（state/cwds/taskDetail/workerLog/createTask/message/
                                 approve/cancel/complete/uncomplete）
       /api/my/machines/:id/watch?taskKey=…（SSE，每 2s 推一帧假输出块）
   - 错误语义齐全：离线机器 503 MACHINE_OFFLINE；args.__mock='timeout' → 504；
     本地拒绝（白名单外 cwd / 不可发消息态）→ 502 RELAY_FAILED 透传原因
   用法：node mock-server.mjs [port]   （默认 8931）
   ========================================================================== */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8931);
const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../../..'); // 仓库根
const PUBLIC_DIR = path.join(ROOT, 'cloud', 'public');
if (!fs.existsSync(path.join(PUBLIC_DIR, 'm', 'index.html'))) {
  console.error('[mock] 找不到 cloud/public/m/index.html，检查目录：' + PUBLIC_DIR);
  process.exit(1);
}

// ---------------- 假数据 ----------------
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const WHITELIST = ['D:\\project\\scrumws-desktop', 'D:\\project\\demo-app'];

const machines = [
  {
    id: 'm1', displayName: 'DESKTOP-7F2K · 工作站', status: 'online',
    lastSeenAt: iso(now - 6 * 1000), relayOnline: true, load: { processing: 2, queued: 1, cap: 5 },
  },
  {
    id: 'm2', displayName: 'MacBook Pro（未开远程控制）', status: 'online',
    lastSeenAt: iso(now - 40 * 1000), relayOnline: false, load: { processing: 0, queued: 0, cap: 3 },
  },
  {
    id: 'm3', displayName: '旧台式机', status: 'offline',
    lastSeenAt: iso(now - 26 * 3600 * 1000), relayOnline: false, load: { processing: 0, queued: 0, cap: 2 },
  },
];

/** 生成逼真 worker-log 块（markdown，含代码块/列表/长行，测横向滚动） */
let blockSeq = 0;
const GEN_MD = [
  () => `先读一下现有实现，确认 \`downlink.js\` 的重连退避从 **1s 起步、上限 30s**：\n\n- 每次失败 ×2\n- 收到 \`ping\` 帧重置计数`,
  () => `### 改动点\n\n1. \`platform/lib/cloud/downlink.js\` 新增 \`backoffMs\` 状态\n2. 断开时打日志并调度重连\n3. \`cloudRemoteControl=false\` 时直接停表`,
  () => '```js\nfunction scheduleReconnect() {\n  backoffMs = Math.min(30000, backoffMs * 2 || 1000);\n  log(`[downlink] reconnect in ${backoffMs}ms — lastError=${lastError?.message ?? "none"} url=${cloudBaseUrl}/api/machine/downlink`);\n  timer = setTimeout(connect, backoffMs);\n}\n```',
  () => `跑了一次本地验证：断开云端后观察重连间隔序列 \`1s → 2s → 4s → 8s\`，符合预期 ✅`,
  () => `| 场景 | 结果 |\n|---|---|\n| 断网 30s | 自动恢复 |\n| 开关热关闭 | ≤15s 断连 |`,
  () => `接着检查 watch 轮询器的指纹比对，避免每 1.5s 推重复帧 —— 只有 blocks 变化才上行。`,
];
// 块不带 idx —— 对齐真实 relay-verbs.js workerLogBlocks 的输出（手机端靠 total-L+i 算绝对下标去重）
function makeBlock(role, md, atMs) {
  blockSeq++;
  return { role, md, at: iso(atMs ?? Date.now()) };
}
/** CC content 数组形态的块（对齐 relay-verbs.js workerLogBlocks 的真实摊平输出） */
function makeCcBlock(role, content, atMs) {
  blockSeq++;
  return { role, at: iso(atMs ?? Date.now()), content };
}
function genBlocks(n, startMs) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const at = startMs + i * 90 * 1000;
    // 每 9 块混入一对 CC content 数组块（tool_use / tool_result），覆盖真实 relay 的块形态
    if (i % 9 === 3) {
      out.push(makeCcBlock('assistant', [
        { type: 'text', text: '先确认静态托管根，`/m/` 要能被真实部署托管到：' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'cloud/src/server.js', offset: 40, limit: 12 } },
      ], at));
      continue;
    }
    if (i % 9 === 4) {
      out.push(makeCcBlock('user', [
        { type: 'tool_result', content: [{ type: 'text', text: "44:  // 云端前端（cloud/public）必须由本服务托管、与 API 同源\n48:  app.register(fastifyStatic, { root: PUBLIC_DIR, index: ['index.html'] });" }] },
      ], at));
      continue;
    }
    const role = i % 7 === 0 ? 'user' : i % 5 === 4 ? 'tool' : 'assistant';
    const md = role === 'user' ? `继续，第 ${i} 步注意别碰主仓分支。` : GEN_MD[i % GEN_MD.length]();
    out.push(makeBlock(role, md, at));
  }
  return out;
}

/** 任务表（m1 的本地状态镜像；rpc 动作会真的迁移状态，UI 能看到变化） */
function mkTask(o) {
  return {
    taskKey: o.taskKey, title: o.title, state: o.state, outcome: o.outcome ?? null,
    source: o.source ?? 'manual', cwd: o.cwd ?? WHITELIST[0],
    enteredAt: iso(o.enteredAgoMin ? now - o.enteredAgoMin * 60000 : now),
    lastActivityMs: o.lastActMin != null ? now - o.lastActMin * 60000 : now - 8000,
    backgroundTaskCount: o.bg ?? 0, worktreeBranch: o.branch ?? null,
    prompt: o.prompt ?? `【mock】${o.title}\n\n目标：…\n约束：…\n验收：…`,
    model: o.model ?? 'claude-opus-4-8', effort: o.effort ?? 'xhigh',
    worktree: !!o.branch, baseBranch: o.branch ? 'master' : null,
    scheduledAt: o.scheduledAt ?? null,
    sessionId: crypto.randomUUID(), rounds: o.rounds ?? 1, numTurns: o.turns ?? 12,
    totalCostUsd: o.cost ?? 0.42,
    usage: { input_tokens: 183422, output_tokens: 20981, cache_read_input_tokens: 1204449, cache_creation_input_tokens: 88213 },
    history: o.history ?? [{ state: 'queued', at: iso(now - 40 * 60000), by: 'user' }, { state: o.state, at: iso(now - 30 * 60000) }],
    createdAt: iso(now - 50 * 60000),
    blocks: o.blocks ?? [],
  };
}
const tasks = new Map();
function addTask(t) { tasks.set(t.taskKey, t); }

addTask(mkTask({
  taskKey: 'manual:2026-07-17T09-12-33', title: '重构云端中继：downlink 断线重连与退避',
  state: 'processing', source: 'manual', branch: 'worktree-cloud-relay', bg: 1,
  enteredAgoMin: 25, lastActMin: 0.1, rounds: 3, turns: 57, cost: 1.2345,
  prompt: '在 platform/lib/cloud/downlink.js 实现 SSE 断线重连：指数退避 1s→30s，收到 ping 重置；cloudRemoteControl 热关闭时 ≤15s 断开。验收：断网 30s 自愈、开关关闭即断。',
  history: [
    { state: 'plan', at: iso(now - 3 * 3600 * 1000), by: 'user' },
    { state: 'queued', at: iso(now - 26 * 60000), by: 'user' },
    { state: 'processing', at: iso(now - 25 * 60000) },
  ],
  blocks: genBlocks(57, now - 25 * 60000),
}));
addTask(mkTask({
  taskKey: 'cli:e3b0c442-98fc-4d21-a501-000000000001', title: 'CLI: 排查 collect 缓存命中率',
  state: 'processing', source: 'cli', enteredAgoMin: 12, lastActMin: 1, blocks: genBlocks(9, now - 12 * 60000),
}));
addTask(mkTask({
  taskKey: 'manual:2026-07-16T18-40-02', title: '验收 §9b.1 在真实数据根规模复测 collect 缓存',
  state: 'awaiting-human', enteredAgoMin: 14 * 60, lastActMin: 13 * 60, blocks: genBlocks(21, now - 15 * 3600 * 1000),
}));
addTask(mkTask({
  taskKey: 'manual:2026-07-15T11-02-11', title: '旧看板样式统一（被中断）',
  state: 'awaiting-human', outcome: 'cancelled', enteredAgoMin: 2 * 24 * 60, lastActMin: 2 * 24 * 60, blocks: genBlocks(6, now - 2 * 86400 * 1000),
}));
addTask(mkTask({
  taskKey: 'mobile:2026-07-17T08-00-00', title: '手机端建的计划：整理 docs/ops runbook',
  state: 'plan', source: 'mobile', enteredAgoMin: 6 * 60, lastActMin: 6 * 60, blocks: [],
}));
addTask(mkTask({
  taskKey: 'manual:2026-07-17T10-05-00', title: '给 cloud README 补部署一节',
  state: 'queued', enteredAgoMin: 60, lastActMin: 60, blocks: [],
}));
addTask(mkTask({
  taskKey: 'manual:2026-07-14T09-00-00', title: '云端 HTTPS 不强制（CLOUD_INSECURE_COOKIE）',
  state: 'done', outcome: 'success', enteredAgoMin: 3 * 24 * 60, lastActMin: 3 * 24 * 60, blocks: genBlocks(15, now - 3 * 86400 * 1000),
}));
addTask(mkTask({
  taskKey: 'chat:2026-07-13T16-30-00', title: 'dws 派活：周报汇总', source: 'chat',
  state: 'done', outcome: 'success', enteredAgoMin: 4 * 24 * 60, lastActMin: 4 * 24 * 60, blocks: genBlocks(8, now - 4 * 86400 * 1000),
}));

// ---------------- 协议辅助 ----------------
function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}
const relayFailed = (res, message) => json(res, 502, { error: { code: 'RELAY_FAILED', message } });
const offline = (res) => json(res, 503, { error: { code: 'MACHINE_OFFLINE', message: '机器离线或未开启远程控制' } });
const timeout = (res) => json(res, 504, { error: { code: 'RELAY_TIMEOUT', message: '机器响应超时（10s）' } });
function authed(req) { return /(?:^|;\s*)msess=1(?:;|$)/.test(req.headers.cookie || ''); }
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}
function cardOf(t) {
  const { taskKey, title, state, outcome, source, cwd, enteredAt, lastActivityMs, backgroundTaskCount, worktreeBranch } = t;
  return { taskKey, title, state, outcome, source, cwd, enteredAt, lastActivityMs, backgroundTaskCount, worktreeBranch };
}
function lifecycle() {
  const b = { plan: [], processing: [], queued: [], done: [], awaitingHuman: [], archived: [] };
  for (const t of tasks.values()) {
    const key = t.state === 'awaiting-human' ? 'awaitingHuman' : t.state;
    (b[key] || b.archived).push(cardOf(t));
  }
  return b;
}

// ---------------- rpc 处理 ----------------
function handleRpc(res, verb, args) {
  if (args?.__mock === 'timeout') return timeout(res);
  const t = args?.taskKey ? tasks.get(args.taskKey) : null;
  const needTask = ['taskDetail', 'workerLog', 'message', 'approve', 'cancel', 'complete', 'uncomplete', 'toPlan'];
  if (needTask.includes(verb) && !t) return relayFailed(res, `任务不存在：${args?.taskKey ?? '(无 taskKey)'}`);

  switch (verb) {
    case 'state':
      return json(res, 200, { ok: true, data: { lifecycle: lifecycle() } });
    case 'cwds':
      return json(res, 200, { ok: true, data: { cwds: WHITELIST } });
    case 'taskDetail': {
      const { blocks, ...detail } = t;
      return json(res, 200, { ok: true, data: detail });
    }
    case 'workerLog': {
      const tail = Math.max(1, Number(args?.tail) || 30);
      return json(res, 200, { ok: true, data: { blocks: t.blocks.slice(-tail), total: t.blocks.length, state: t.state } });
    }
    case 'message': {
      if (['plan', 'queued', 'done'].includes(t.state)) {
        return relayFailed(res, `当前状态 ${t.state} 不可发消息（plan/queued/done 请先确认执行或撤回）`);
      }
      t.blocks.push(makeBlock('user', args.text || ''));
      t.lastActivityMs = Date.now();
      // awaiting-human → replyToTask 会 --resume 重新排队执行（本地行为），镜像为回到 processing
      if (t.state === 'awaiting-human') {
        t.state = 'processing'; t.outcome = null;
        t.history.push({ state: 'processing', at: iso(Date.now()), by: 'mobile' });
        return json(res, 200, { ok: true, data: { delivered: 'replyToTask', state: 'processing' } });
      }
      return json(res, 200, { ok: true, data: { delivered: 'sendUserMessage', state: t.state } });
    }
    case 'createTask': {
      const cwd = String(args?.cwd || '');
      if (!WHITELIST.some((w) => cwd === w || cwd.startsWith(w + '\\') || cwd.startsWith(w + '/'))) {
        return relayFailed(res, `cwd 不在白名单内：${cwd || '(空)'}`);
      }
      if (!String(args?.prompt || '').trim()) return relayFailed(res, 'prompt 不能为空');
      const ts = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const taskKey = `mobile:${ts.getFullYear()}-${p(ts.getMonth() + 1)}-${p(ts.getDate())}T${p(ts.getHours())}-${p(ts.getMinutes())}-${p(ts.getSeconds())}`;
      // 有定时 = 必落 plan（对齐真实 createTask：scheduledAt 强制 plan、到点由调度器提升执行）
      const scheduled = String(args?.scheduledAt || '').trim();
      const asPlan = !!args.plan || !!scheduled;
      const nt = mkTask({
        taskKey, title: args.title || String(args.prompt).slice(0, 40), source: 'mobile',
        state: asPlan ? 'plan' : 'queued', cwd,
        model: args.model, effort: args.effort, scheduledAt: scheduled || null,
        branch: args.worktree ? `worktree-mobile-${p(ts.getHours())}${p(ts.getMinutes())}` : null,
        prompt: args.prompt, blocks: [],
        history: [{ state: asPlan ? 'plan' : 'queued', at: iso(Date.now()), by: 'mobile' }],
      });
      nt.lastActivityMs = Date.now();
      addTask(nt);
      if (!asPlan) {
        // 模拟 worker 认领起跑：2s 后转 processing，watch 会开始推块
        setTimeout(() => {
          if (nt.state !== 'queued') return;
          nt.state = 'processing';
          nt.history.push({ state: 'processing', at: iso(Date.now()) });
          nt.blocks.push(makeBlock('assistant', `收到任务「${nt.title}」，开始分析仓库结构…`));
          nt.lastActivityMs = Date.now();
        }, 2000);
      }
      return json(res, 200, { ok: true, data: { taskKey } });
    }
    case 'approve': {
      if (t.state !== 'plan') return relayFailed(res, `非法状态迁移：${t.state} → queued（只有 plan 可确认执行）`);
      t.state = 'queued';
      t.history.push({ state: 'queued', at: iso(Date.now()), by: 'mobile' });
      t.lastActivityMs = Date.now();
      setTimeout(() => {
        if (t.state !== 'queued') return;
        t.state = 'processing';
        t.history.push({ state: 'processing', at: iso(Date.now()) });
        t.blocks.push(makeBlock('assistant', '任务已被 worker 认领，开始执行。'));
        t.lastActivityMs = Date.now();
      }, 2000);
      return json(res, 200, { ok: true, data: { state: 'queued' } });
    }
    case 'cancel': {
      if (t.state !== 'processing') return relayFailed(res, `非法状态迁移：${t.state} → awaiting-human（只有 processing 可中断）`);
      t.state = 'awaiting-human'; t.outcome = 'cancelled';
      t.history.push({ state: 'awaiting-human', at: iso(Date.now()), by: 'mobile' });
      t.lastActivityMs = Date.now();
      return json(res, 200, { ok: true, data: { state: 'awaiting-human', outcome: 'cancelled' } });
    }
    case 'complete': {
      if (t.state !== 'awaiting-human') return relayFailed(res, `非法状态迁移：${t.state} → done（只有 awaiting-human 可完成）`);
      t.state = 'done'; t.outcome = 'success';
      t.history.push({ state: 'done', at: iso(Date.now()), by: 'mobile' });
      t.lastActivityMs = Date.now();
      return json(res, 200, { ok: true, data: { state: 'done', outcome: 'success' } });
    }
    case 'uncomplete': {
      if (t.state !== 'done') return relayFailed(res, `非法状态迁移：${t.state}（只有 done 可撤回完成）`);
      t.state = 'awaiting-human'; t.outcome = null;
      t.history.push({ state: 'awaiting-human', at: iso(Date.now()), by: 'mobile' });
      t.lastActivityMs = Date.now();
      return json(res, 200, { ok: true, data: { state: 'awaiting-human', outcome: null } });
    }
    default:
      return relayFailed(res, `未知 verb：${verb}（connector 白名单外）`);
  }
}

// ---------------- watch SSE ----------------
function handleWatch(req, res, taskKey) {
  const t = tasks.get(taskKey);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  if (!t) { res.write(`data: ${JSON.stringify({ done: true, error: 'task not found' })}\n\n`); res.end(); return; }
  const send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`);
  const TAIL = 30;
  // 基线帧：观看者接入先补一帧尾窗（对齐 downlink.js sendBaseline —— 与详情页刚拉的 workerLog 整窗重叠，
  // 手机端必须按绝对下标去重，不得重复渲染）
  send({ kind: 'worker-log', blocks: t.blocks.slice(-TAIL), total: t.blocks.length, state: t.state });
  let lastCount = t.blocks.length;
  const timer = setInterval(() => {
    // processing 的任务每 tick 长出一个新块（模拟本地 1.5s 轮询 worker-log 的增量）
    if (t.state === 'processing') {
      t.blocks.push(makeBlock(blockSeq % 6 === 0 ? 'tool' : 'assistant', GEN_MD[blockSeq % GEN_MD.length]()));
      t.lastActivityMs = Date.now();
    }
    if (t.blocks.length !== lastCount) {
      // 增量帧带上前一帧的末块（「变化的尾部块」语义，对齐 downlink.js poller 的 slice(lastCount-1)）
      const blocks = t.blocks.slice(Math.max(0, lastCount - 1));
      lastCount = t.blocks.length;
      send({ kind: 'worker-log', blocks, total: t.blocks.length, state: t.state });
      return;
    }
    // 收敛 = 到达 awaiting-human / done 且无新块 → 推 done 帧并停表（§4.5）。
    // plan / queued 是「还没起跑」不是「已收敛」，保持连接等它起跑（新建任务 2s 后转 processing）。
    if (t.state === 'awaiting-human' || t.state === 'done') {
      send({ kind: 'worker-log', blocks: [], total: t.blocks.length, state: t.state, done: true });
      clearInterval(timer);
      res.end();
    }
  }, 2000);
  req.on('close', () => clearInterval(timer));
}

// ---------------- 静态托管（与 @fastify/static root=cloud/public, index.html 同构）----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {   // /m → /m/
    res.writeHead(301, { Location: pathname + '/' });
    res.end();
    return;
  }
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': buf.length });
  res.end(buf);
}

// ---------------- 路由 ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  try {
    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.key === 'string' && body.key.startsWith('swuk_') && body.key.length >= 20) {
        res.setHeader('Set-Cookie', 'msess=1; Path=/; HttpOnly; SameSite=Lax');
        return json(res, 200, { user: { id: 'u1', name: '孙鹏' }, workspace: { id: 'w1', name: 'ScrumWS 团队' } });
      }
      return json(res, 401, { error: { code: 'INVALID_KEY', message: '登录密钥无效' } });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'msess=; Path=/; HttpOnly; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/auth/me') {
      return authed(req)
        ? json(res, 200, { user: { id: 'u1', name: '孙鹏' }, workspace: { id: 'w1', name: 'ScrumWS 团队' } })
        : json(res, 401, { error: { code: 'UNAUTHENTICATED', message: '未登录' } });
    }
    if (p.startsWith('/api/my/')) {
      if (!authed(req)) return json(res, 401, { error: { code: 'UNAUTHENTICATED', message: '未登录' } });
      if (p === '/api/my/machines' && req.method === 'GET') return json(res, 200, { machines });
      let m = /^\/api\/my\/machines\/([^/]+)\/rpc$/.exec(p);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const mach = machines.find((x) => x.id === id);
        if (!mach) return json(res, 404, { error: { code: 'NOT_FOUND', message: '机器不存在' } });
        if (!mach.relayOnline) return offline(res);
        const body = await readBody(req);
        return handleRpc(res, body.verb, body.args || {});
      }
      m = /^\/api\/my\/machines\/([^/]+)\/watch$/.exec(p);
      if (m && req.method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const mach = machines.find((x) => x.id === id);
        if (!mach) return json(res, 404, { error: { code: 'NOT_FOUND', message: '机器不存在' } });
        if (!mach.relayOnline) return offline(res);
        return handleWatch(req, res, u.searchParams.get('taskKey') || '');
      }
      return json(res, 404, { error: { code: 'NOT_FOUND', message: p } });
    }
    return serveStatic(req, res, p);
  } catch (e) {
    console.error('[mock] error:', e);
    try { json(res, 500, { error: { code: 'MOCK_ERROR', message: String(e?.message || e) } }); } catch { }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] listening http://127.0.0.1:${PORT}/m/  (pid=${process.pid}, public=${PUBLIC_DIR})`);
});
