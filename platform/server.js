import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { collectState } from './lib/collect.js';
import { readWorkerLog, archiveTask, renameTask, setTaskDescription, unarchiveCliTask } from './lib/logs.js';
import { writeConfig } from './lib/runner-config.js';
import { createTask, replyToTask, cancelTask, restartTask, taskCwds } from './lib/task-actions.js';
import { searchCliSessions, recentCliSessions, sessionCwds, addCliSession, removeCliSession, rewindCliSession } from './lib/cli-actions.js';
import * as scheduler from './lib/scheduler.js';
import { P } from './lib/paths.js';

const HOST = '127.0.0.1'; // owner 本机自查，不对外
const PORT = Number(process.env.SCRUMWS_PORT) || 8799;
const PUBLIC = path.join(import.meta.dirname, 'public');

// console 输出同步镜像到数据根 runtime/（与旧 web 看板的 dashboard-server.log 分开，避免交叉写）
const SERVER_LOG = path.join(P.tmpDir, 'desktop-server.log');
for (const m of ['log', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => {
    orig(...a);
    try {
      const p = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      fs.appendFileSync(SERVER_LOG, `[${ts}] ${a.map(String).join(' ')}\n`);
    } catch { /* 日志失败不影响服务 */ }
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  try {
    if (pathname === '/api/state') return sendJson(res, 200, await collectState());
    if (pathname === '/api/worker-log') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      return sendJson(res, 200, readWorkerLog(taskKey));
    }
    // 平台守护 Runner Checker 启停（数据看板页；runner-config.json.checkerEnabled）
    const checkerMatch = pathname.match(/^\/api\/checker\/(start|stop)$/);
    if (req.method === 'POST' && checkerMatch) {
      writeConfig({ checkerEnabled: checkerMatch[1] === 'start' });
      scheduler.reload();
      return sendJson(res, 200, { ok: true, checkerEnabled: checkerMatch[1] === 'start' });
    }
    // 归档 done 任务
    if (req.method === 'POST' && pathname === '/api/archive') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = archiveTask(taskKey);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    // 已知工作目录列表（新建任务「选已有目录」下拉）：现有任务 cwd + 近 30 天 CLI session cwd，去重
    if (pathname === '/api/task/cwds') {
      const seen = new Set();
      const cwds = [];
      for (const c of taskCwds()) { if (!seen.has(c)) { seen.add(c); cwds.push({ cwd: c, source: 'task' }); } }
      for (const c of sessionCwds({ limit: 80 })) { if (!seen.has(c)) { seen.add(c); cwds.push({ cwd: c, source: 'cli' }); } }
      return sendJson(res, 200, { ok: true, cwds: cwds.slice(0, 60) });
    }
    // 系统目录选择（新建任务「直接选电脑目录」）：仅桌面端（Electron dialog）；web 模式回退提示手填
    if (req.method === 'POST' && pathname === '/api/pick-dir') {
      if (!process.versions?.electron) {
        return sendJson(res, 200, { ok: false, error: 'web 模式无法调起系统目录选择，请直接填写目录绝对路径' });
      }
      try {
        const { dialog, BrowserWindow } = await import('electron');
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
        const opts = { title: '选择任务工作目录', properties: ['openDirectory'] };
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        if (r.canceled || !r.filePaths?.length) return sendJson(res, 200, { ok: true, canceled: true });
        return sendJson(res, 200, { ok: true, dir: r.filePaths[0] });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: `目录选择失败：${e.message}` });
      }
    }
    // 新增任务（推送式，任意来源）：body = {source?, title, prompt, model?, description?, plan?, cwd?}
    // 只入队（state=plan/queued），不 spawn；看板新建按钮与外部 CLI/API 共用此端点
    if (req.method === 'POST' && pathname === '/api/task/create') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 32 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = createTask(payload || {});
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    // 手动中断任务（processing/queued → awaiting-human + outcome=cancelled + kill pid）
    if (req.method === 'POST' && pathname === '/api/task/cancel') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = cancelTask({ taskKey });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    // 回复任务（跨 chat/issue/manual）：body = {message, model?}；taskKey 从 query 拿
    if (req.method === 'POST' && pathname === '/api/task/reply') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 32 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = replyToTask({ taskKey, message: payload?.message, model: payload?.model });
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    // 重新发起任务（awaiting-human/queued → queued + 立即 spawn worker；无 sessionId 或 manual quota 排队场景）
    if (req.method === 'POST' && pathname === '/api/task/restart') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = restartTask({ taskKey });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    // 确认排队（plan → queued + 立即 spawn worker；plan 态任务的用户确认动作）
    if (req.method === 'POST' && pathname === '/api/task/approve') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = restartTask({ taskKey, approve: true });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    // 编辑任务描述（body: {description}；纯用户备注不进 prompt，任意状态可编辑，空 = 清除）
    if (req.method === 'POST' && pathname === '/api/task/describe') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 16 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = setTaskDescription(taskKey, payload && payload.description);
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    // 重命名任务标题（body: {title: string}；空 title = 清除 customTitle 恢复默认）
    if (req.method === 'POST' && pathname === '/api/task/rename') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = renameTask(taskKey, payload && payload.title);
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    // CLI 添加弹窗默认列表：近 N 分钟活跃 session（免关键字）
    if (pathname === '/api/cli/recent') {
      const withinMinutes = Number(searchParams.get('within')) || 30;
      const limit = Number(searchParams.get('limit')) || 30;
      return sendJson(res, 200, recentCliSessions({ withinMinutes, limit }));
    }
    // CLI session 白名单：搜索 / 添加 / 移除
    if (req.method === 'POST' && pathname === '/api/cli/search') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = searchCliSessions(payload || {});
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/cli/add') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = addCliSession(payload || {});
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    // CLI 原地 rewind：改写历史 user 消息并从那里重新执行（同一 session；原时间线备份到 rewind-backup/）
    // body: {taskKey, uuid, message, model?}
    if (req.method === 'POST' && pathname === '/api/cli/rewind') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = rewindCliSession(payload || {});
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    // CLI 取消归档（archive 复用 /api/archive；unarchive 是 CLI 特有）
    if (req.method === 'POST' && pathname === '/api/cli/unarchive') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = unarchiveCliTask(taskKey);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && pathname === '/api/cli/remove') {
      const sidQuery = searchParams.get('sid');
      if (sidQuery) {
        const r = removeCliSession({ sid: sidQuery });
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = removeCliSession(payload || {});
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown api' });
    return serveStatic(req, res);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

// 桌面端宿主（electron/server-host.js）或 standalone 入口调用；错误（含 EADDRINUSE）交给调用方决定退出/弹窗
export function start() {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, HOST, () => {
      console.log(`claude 活儿总览（分身 + 本机 CLI）→ http://${HOST}:${PORT}`);
      // 调度器在端口拿到后再启动：撞端口的第二实例不会碰 scheduler.lock
      scheduler.start();
      resolve({ host: HOST, port: PORT, server });
    });
  });
}

