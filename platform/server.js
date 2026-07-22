import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getProviderRuntime, getState, invalidateState } from './lib/collect.js';
import { readWorkerLog, readWorkerLogRevision, archiveTask, renameTask, setTaskDescription, unarchiveTask, completeCliSession, uncompleteCliTask } from './lib/logs.js';
import { normalizeModelContextLimits, providerConfig, readConfig, setProviderEnabled, writeConfig, listWorkDirectories, setWorkDirectories } from './lib/runner-config.js';
import { createTask, replyToTask, cancelTask, completeTask, uncompleteTask, moveTaskToPlan, restartTask, readTaskEdit, editTask, deleteTask } from './lib/task-actions.js';
import { searchCliSessions, recentCliSessions, addCliSession, removeCliSession } from './lib/cli-actions.js';
import { detectGit } from './lib/git.js';
import { drainQueued } from './lib/task-runner.js';
import { getModelContextLimit, getClaudeUsage, startUsageTimer, stopUsageTimer, reloadUsageTimer } from './lib/claude-usage.js';
import * as scheduler from './lib/scheduler.js';
import { startConnector, connectorStatus, enroll, unenroll } from './lib/cloud/connector.js';
import { ensureMachineUid } from './lib/cloud/identity.js';
import { acceptAutoRunMode } from './lib/cloud/gate.js';
import { isCwdAllowed } from './lib/cloud/cwd-allow.js';
import { createApiKey, updateApiKey, listApiKeys, setApiKeyDisabled, deleteApiKey, verifyApiKey } from './lib/api-keys.js';
import { createExternalTask, externalTaskStatus, resumeExternalTask } from './lib/external-ingest.js';
import { P } from './lib/paths.js';
import { normalizeProvider } from './lib/providers/registry.js';

const HOST = '127.0.0.1'; // owner 本机自查，不对外
const PORT = Number(process.env.SCRUMWS_PORT) || 8799;
const PUBLIC = path.join(import.meta.dirname, 'public');
// 只有持有 scheduler 锁的主实例管理账号用量轮询；副实例只读状态，不能因用户点开关
// 意外启动第二个 claude -p /usage 定时器。
let ownsUsageTimer = false;

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
  // 写请求改完磁盘（任务包 / 配置）后作废状态缓存：前端每个 mutation 都紧跟一次 refreshState()，
  // 不作废就会命中 3s 缓存、拿到 mutation 之前的快照（read-your-writes 破坏）。
  // 挂 'finish' 而不是各 handler 里逐个调：响应发出时磁盘写必已完成（handler 都是 await 动作后才
  // sendJson），一个挂钩覆盖全部写端点，新增端点不会漏。
  if (req.method === 'POST') res.on('finish', invalidateState);
  try {
    // 缓存 + single-flight：3s 内的并发请求（多标签页 / modal 关闭补拉）合并成一次扫描；
    // UI 最快也只有 5s 一轮，故永不被降级，对外行为不变
    if (pathname === '/api/state') return sendJson(res, 200, await getState({ maxAgeMs: 3000 }));
    if (pathname === '/api/providers') {
      const runtime = await getProviderRuntime();
      const config = providerConfig();
      return sendJson(res, 200, {
        ok: true,
        ...config,
        providers: runtime.map((item) => ({
          ...item,
          enabled: config.providerEnabled[item.id] !== false,
          online: item.available,
          binPath: item.path,
          runtime: { available: item.available, online: item.available, version: item.version, binPath: item.path, error: item.error },
        })),
      });
    }
    if (req.method === 'POST' && /^\/api\/providers\/[^/]+\/enabled$/.test(pathname)) {
      const provider = decodeURIComponent(pathname.split('/')[3] || '');
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 4 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        if (typeof payload?.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'enabled 必须是 boolean' });
        const result = setProviderEnabled(provider, payload.enabled);
        if (result.ok && result.provider === 'claude' && ownsUsageTimer) {
          if (result.enabled) startUsageTimer();
          else stopUsageTimer();
        }
        sendJson(res, result.ok ? 200 : 400, result);
      });
      return;
    }
    // Claude Code 账号级用量（详情页卡片 + 运行时面板）：session / 本周滚动窗；经官方 CLI `/usage` 查、模块内缓存
    if (pathname === '/api/claude-usage') {
      const provider = normalizeProvider(searchParams.get('provider'));
      if (provider !== 'claude') return sendJson(res, 400, { ok: false, provider, error: '该 provider 不支持 accountUsage' });
      if (providerConfig().providerEnabled.claude === false) return sendJson(res, 409, { ok: false, provider, error: 'runtime-disabled' });
      return sendJson(res, 200, { ...(await getClaudeUsage()), provider: 'claude' });
    }
    // 模型上下文窗口上限（详情页上下文用量环形的分母）：读设置页配置的 model→max_input_tokens 映射，不打 API
    if (pathname === '/api/model-context') {
      const model = searchParams.get('model');
      if (!model) return sendJson(res, 400, { ok: false, error: 'model required' });
      const provider = normalizeProvider(searchParams.get('provider'));
      if (provider !== 'claude') return sendJson(res, 400, { ok: false, provider, model, error: '该 provider 暂无 model context 配置能力' });
      const configured = Number(normalizeModelContextLimits(readConfig().modelContextLimits)[`${provider}:${model}`]);
      if (Number.isFinite(configured) && configured > 0) {
        return sendJson(res, 200, { ok: true, provider, model, maxInputTokens: configured });
      }
      return sendJson(res, 200, { ...(await getModelContextLimit(model)), provider });
    }
    if (pathname === '/api/worker-log/revision') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      return sendJson(res, 200, readWorkerLogRevision(taskKey));
    }
    if (pathname === '/api/worker-log') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const before = readWorkerLogRevision(taskKey);
      const record = readWorkerLog(taskKey);
      const after = readWorkerLogRevision(taskKey);
      // JSONL 可能在整份读取期间继续 append。只有读前/读后 stat 一致才确认已追到该 revision；
      // 否则返回 null，让客户端下一次探测再补读，避免把未包含的尾部误标为已消费。
      const revision = before.ok && after.ok && before.revision === after.revision ? after.revision : null;
      return sendJson(res, 200, after.ok ? { ...record, revision } : record);
    }
    // 模型上下文上限配置（设置页）：body {modelContextLimits:{modelId:number}}；存 runner-config.json。
    // 详情页上下文环形的分母改读此映射，不再打 /v1/models（也不再需要代理/凭据）。
    if (req.method === 'POST' && pathname === '/api/config/model-limits') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 16 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const raw = payload?.modelContextLimits;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return sendJson(res, 400, { ok: false, error: 'modelContextLimits 需为对象 {modelId: 数字}' });
        const clean = {};
        for (const [k, v] of Object.entries(raw)) {
          const n = Number(v);
          if (!String(k).trim() || !Number.isFinite(n) || n <= 0) return sendJson(res, 400, { ok: false, error: `无效项：${k} → ${v}（值需为正整数 token 数）` });
          clean[String(k).trim()] = Math.round(n);
        }
        const normalized = normalizeModelContextLimits(clean);
        writeConfig({ modelContextLimits: normalized });
        sendJson(res, 200, { ok: true, modelContextLimits: normalized });
      });
      return;
    }
    // 账号用量定时拉取间隔（设置页）：后端每隔一段时间 spawn 一次 `claude -p /usage`（唯一触发 CLI 查用量的节拍）。
    // body {intervalSec}；夹到 [120, 3600] 秒（默认 600=10min），存 runner-config.json 后热更定时器。
    if (req.method === 'POST' && pathname === '/api/usage-poll/interval') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const sec = Math.round(Number(payload?.intervalSec));
        if (!Number.isFinite(sec) || sec < 120 || sec > 3600) return sendJson(res, 400, { ok: false, error: '间隔需为 120–3600 秒' });
        writeConfig({ usagePollSec: sec });
        reloadUsageTimer();
        sendJson(res, 200, { ok: true, intervalSec: sec });
      });
      return;
    }
    // 平台守护 Runner Checker 节拍（设置页）：项目固有调度常开不可停，只调间隔。
    // body {intervalSec}；夹到 [30, 3600] 秒，存 runner-config.json 后热更调度器。
    if (req.method === 'POST' && pathname === '/api/checker/interval') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const sec = Math.round(Number(payload?.intervalSec));
        if (!Number.isFinite(sec) || sec < 30 || sec > 3600) return sendJson(res, 400, { ok: false, error: '间隔需为 30–3600 秒' });
        writeConfig({ checkerIntervalSec: sec });
        scheduler.reload();
        sendJson(res, 200, { ok: true, intervalSec: sec });
      });
      return;
    }
    // processing 并发上限（设置页）：同时运行的看板任务上限。body {max}；夹到 [0, 50]，0=不限。
    // 存 runner-config.json 后立即排空一次（上调即放行等待的 queued）。
    if (req.method === 'POST' && pathname === '/api/config/max-runners') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const max = Math.round(Number(payload?.max));
        if (!Number.isFinite(max) || max < 0 || max > 50) return sendJson(res, 400, { ok: false, error: '并发上限需为 0–50（0=不限）' });
        writeConfig({ maxConcurrentRunners: max });
        try { drainQueued(); } catch { /* 排空失败不影响保存 */ }
        sendJson(res, 200, { ok: true, maxConcurrentRunners: max });
      });
      return;
    }
    // 归档 done 任务
    if (req.method === 'POST' && pathname === '/api/archive') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = archiveTask(taskKey);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    // 工作目录管理：仅保存本机新建任务的目录选择项，不影响任务 cwd、云端白名单或任何 taskKey。
    if (pathname === '/api/work-directories') {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, directories: listWorkDirectories() });
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 16 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        if (!Array.isArray(payload?.directories) || payload.directories.some((x) => typeof x !== 'string')) {
          return sendJson(res, 400, { ok: false, error: 'directories 需为字符串数组' });
        }
        return sendJson(res, 200, { ok: true, directories: setWorkDirectories(payload.directories) });
      });
      return;
    }
    // 新建任务的「选工作目录」下拉只读独立维护的列表。不能混入历史任务/CLI 会话 cwd，
    // 更不能借用 cloudAllowedCwds（它是云端安全白名单，语义不同）。
    if (pathname === '/api/task/cwds') {
      const cwds = listWorkDirectories().map((cwd) => ({ cwd, source: 'managed' }));
      return sendJson(res, 200, { ok: true, cwds });
    }
    // 读 plan 态任务可编辑字段（看板「编辑」弹窗回填）：仅 plan 可编辑，非 plan 返回 400
    if (pathname === '/api/task/detail') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = readTaskEdit(taskKey);
      return sendJson(res, r.ok ? 200 : 400, r);
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
    // 系统文件选择（新建任务 / 详情回复「添加本地文件」）：仅桌面端（Electron dialog）；web 模式回退提示手填。
    // 多选，返回绝对路径数组 {ok, files}；随任务/消息传给 claude（后端拼进文本尾部，让 claude 用 Read 读）。
    if (req.method === 'POST' && pathname === '/api/pick-file') {
      if (!process.versions?.electron) {
        return sendJson(res, 200, { ok: false, error: 'web 模式无法调起系统文件选择，请在桌面端使用' });
      }
      try {
        const { dialog, BrowserWindow } = await import('electron');
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
        const opts = { title: '选择本地文件', properties: ['openFile', 'multiSelections'] };
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        if (r.canceled || !r.filePaths?.length) return sendJson(res, 200, { ok: true, canceled: true, files: [] });
        return sendJson(res, 200, { ok: true, files: r.filePaths });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: `文件选择失败：${e.message}` });
      }
    }
    // 探测工作目录是否 git 项目（= 是否支持 worktree）：body {cwd} → {ok, isGit, root, currentBranch, branches}
    // 新建任务表单选目录后调，决定是否显示 worktree 开关 + 签出分支下拉。
    if (req.method === 'POST' && pathname === '/api/git/detect') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = detectGit(payload?.cwd || '');
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    // 新增任务（看板页面专用，2026-07-18 同源收口）：body = {source?, provider?, title, prompt, model?, effort?,
    //   description?, plan?, cwd?, scheduledAt?, worktree?, baseBranch?, dynamicWorkflow?}。
    // 仅接受看板页面自己的浏览器请求——同源 fetch POST 必带 Origin 标头且指向本服务；
    // 程序化/外部调用（无/异源 Origin）一律 403，必须走 /api/external/task/create 的密钥+策略管道。
    // （非防御本机恶意进程——开放 localhost 做不到——而是关死"无鉴权对接"路径，保证一切程序化
    //   任务新增都经过密钥鉴权，见 docs/api/external-api-guide.md。）
    if (req.method === 'POST' && pathname === '/api/task/create') {
      const origin = String(req.headers.origin || '');
      if (origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) {
        return sendJson(res, 403, { ok: false, error: '本端点仅限看板页面使用；程序化/外部任务新增请走 /api/external/task/create（Authorization: Bearer swak_…，密钥在「API 密钥」页生成，契约见 docs/api/external-api-guide.md）' });
      }
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
    // ---- API 密钥管理（「API 密钥」页；同其余本机管理端点，只听 127.0.0.1 不另设鉴权）----
    // 列表永不回明文/hash；明文只在 create 响应里出现一次
    if (pathname === '/api/apikeys' && req.method !== 'POST') {
      return sendJson(res, 200, { ok: true, keys: listApiKeys() });
    }
    if (req.method === 'POST' && pathname === '/api/apikeys/create') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = createApiKey(payload || {});
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    // 编辑已有密钥（label/source/策略/allowQueued；密钥本体与使用记录不动）
    if (req.method === 'POST' && pathname === '/api/apikeys/update') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = updateApiKey(payload || {});
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/apikeys/toggle') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = setApiKeyDisabled(payload?.id, payload?.disabled);
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/apikeys/delete') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = deleteApiKey(payload?.id);
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    // ---- 外部任务通道（Authorization: Bearer swak_…；key 见「API 密钥」页）----
    // 一切程序化任务新增的唯一入口：source 强制取 key 绑定值、per-key 策略、缺省落 plan 桶、
    // externalKey 幂等去重。契约见 docs/api/external-api-guide.md。
    if (req.method === 'POST' && pathname === '/api/external/task/create') {
      const auth = verifyApiKey(req.headers.authorization);
      if (!auth.ok) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 32 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = createExternalTask(auth.key, payload || {});
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    // 来源心跳：发起端每 tick 打一下即可让「API 密钥」页显示该来源活跃状态（verifyApiKey 已刷 lastUsedAt，
    // 端点本身无副作用）。不用长连接：发起端多为短命定时进程（fork per tick），无宿主可持连。
    if (req.method === 'POST' && pathname === '/api/external/heartbeat') {
      const auth = verifyApiKey(req.headers.authorization);
      if (!auth.ok) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return sendJson(res, 200, { ok: true });
    }
    // 持钥方自省：凭密钥查自己的身份与权限范围（模型+effort 组合 / 目录白名单 / 直执权限），调用方据此自适应。
    if (pathname === '/api/external/whoami') {
      const auth = verifyApiKey(req.headers.authorization);
      if (!auth.ok) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      const k = auth.key;
      return sendJson(res, 200, {
        ok: true,
        key: {
          label: k.label, source: k.source, prefix: k.prefix, createdAt: k.createdAt,
          provider: normalizeProvider(k.provider),
          allowedModelEfforts: k.allowedModelEfforts, allowedModels: k.allowedModels, allowedEfforts: k.allowedEfforts, allowedCwds: k.allowedCwds,
          allowQueued: k.allowQueued,
        },
      });
    }
    if (pathname === '/api/external/task/status') {
      const auth = verifyApiKey(req.headers.authorization);
      if (!auth.ok) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      const r = externalTaskStatus(auth.key, { taskKey: searchParams.get('taskKey'), externalKey: searchParams.get('externalKey') });
      if (!r.ok) return sendJson(res, r.code || 400, { ok: false, error: r.error });
      return sendJson(res, 200, r);
    }
    // 外部续接：仅同来源、已收敛任务可用；复用 task-actions 的 provider 原生 resume，plan 不可借此绕过确认。
    if (req.method === 'POST' && pathname === '/api/external/task/resume') {
      const auth = verifyApiKey(req.headers.authorization);
      if (!auth.ok) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 32 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = resumeExternalTask(auth.key, payload || {});
        sendJson(res, r.ok ? 200 : r.code || 400, r.ok ? r : { ok: false, error: r.error });
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
    // 确认完成（awaiting-human → done）；来源无关：completeTask 内部按「有无任务包」分派（未物化 CLI → watchlist.doneAt）。
    // resolvedBy=agent（决策 15）：agent 经注入的完成协议自己声明做完；缺省 / 其它值 → user（人工确认）。取值白名单在 completeTask 内。
    if (req.method === 'POST' && pathname === '/api/task/complete') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = completeTask({ taskKey, resolvedBy: searchParams.get('resolvedBy') });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    // 取消完成（done → awaiting-human）；来源无关：uncompleteTask 内部按「有无任务包」分派
    if (req.method === 'POST' && pathname === '/api/task/uncomplete') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = uncompleteTask({ taskKey });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    // 退回计划（awaiting-human/done → plan）：关空转会话 + 落 plan，保留 meta.sessionId 供确认执行时 --resume 续对话
    if (req.method === 'POST' && pathname === '/api/task/to-plan') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = moveTaskToPlan({ taskKey });
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
        const r = replyToTask({ taskKey, message: payload?.message, model: payload?.model, effort: payload?.effort, attachments: payload?.attachments });
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
    // 移除 plan 态任务（删除计划草稿目录；仅 plan 可用，不可恢复）
    if (req.method === 'POST' && pathname === '/api/task/delete') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = deleteTask({ taskKey });
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
    // 编辑 plan 态任务（body: {title, prompt, model, description?, cwd?}）：改写 task.json，仅 plan 可编辑
    if (req.method === 'POST' && pathname === '/api/task/edit') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 32 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const r = editTask({ taskKey, ...(payload || {}) });
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    // CLI 添加弹窗默认列表：近 N 分钟活跃 session（免关键字）
    if (pathname === '/api/cli/recent') {
      const withinMinutes = Number(searchParams.get('within')) || 30;
      const limit = Number(searchParams.get('limit')) || 30;
      const provider = searchParams.get('provider') || 'all';
      return sendJson(res, 200, recentCliSessions({ withinMinutes, limit, provider }));
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
    // 取消归档（archive 复用 /api/archive）；按来源分派：CLI 清 watchlist.archivedAt / 看板任务目录移回 runner-state
    if (req.method === 'POST' && pathname === '/api/unarchive') {
      const taskKey = searchParams.get('taskKey');
      if (!taskKey) return sendJson(res, 400, { ok: false, error: 'taskKey required' });
      const r = unarchiveTask(taskKey);
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
    // ---- 云端控制面（设置页「云端」区块）：本地只做出站上报，云端拿不到 8799 的入站访问 ----
    // 连线状态：⚠ 响应体里没有 registrationKey——入场券用完即弃，压根不在进程里
    if (pathname === '/api/cloud/status') return sendJson(res, 200, connectorStatus());
    // 连接云端：body {cloudUrl, registrationKey, code}。只收这三个显式字段，不收 joinToken
    // （拆包在浏览器做，畸形 token 根本到不了这里）。这是唯一碰 rk 的本地路径：转发给云端后即出作用域，
    // 不写盘、不记日志、不进 lastError。
    if (req.method === 'POST' && pathname === '/api/cloud/enroll') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8 * 1024) req.destroy(); });
      req.on('end', async () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        const str = (v) => (typeof v === 'string' ? v.trim() : '');
        const cloudUrl = str(payload?.cloudUrl);
        const registrationKey = str(payload?.registrationKey);
        const code = str(payload?.code);
        // 只报「缺哪个」，绝不回显值（rk 是密钥）
        if (!cloudUrl || !registrationKey || !code) {
          return sendJson(res, 400, { ok: false, error: '云端 URL / 注册密钥 / 配对码 三者均必填' });
        }
        try {
          const r = await enroll({ cloudUrl, registrationKey, code });
          sendJson(res, r.ok ? 200 : 400, r);
        } catch (e) {
          sendJson(res, 400, { ok: false, error: `连接云端失败：${e.message}` });
        }
      });
      return;
    }
    // 断开：停 connector + 清云端绑定（保留 machineUid，重连仍是同一台机器）
    if (req.method === 'POST' && pathname === '/api/cloud/unenroll') return sendJson(res, 200, unenroll());
    // 手机中继闸门（设置页「云端」区块）：cloudRemoteControl 总开关（默认关）+ createTask cwd 白名单（默认空=拒绝）。
    // 热加载：connector 每 tick（15s）读 runner-config 决定下行长连起停，无需重启。
    if (req.method === 'POST' && pathname === '/api/cloud/remote-config') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 16 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        if (typeof payload?.cloudRemoteControl !== 'boolean') return sendJson(res, 400, { ok: false, error: 'cloudRemoteControl 需为 boolean' });
        const raw = payload?.cloudAllowedCwds;
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) return sendJson(res, 400, { ok: false, error: 'cloudAllowedCwds 需为字符串数组（每项一个目录绝对路径）' });
        const cloudAllowedCwds = [...new Set(raw.map((s) => s.trim()).filter(Boolean))].slice(0, 50);
        writeConfig({ cloudRemoteControl: payload.cloudRemoteControl, cloudAllowedCwds });
        sendJson(res, 200, { ok: true, cloudRemoteControl: payload.cloudRemoteControl, cloudAllowedCwds });
      });
      return;
    }
    if (pathname === '/api/cloud/remote-config') {
      const cfg = readConfig();
      return sendJson(res, 200, { ok: true, cloudRemoteControl: !!cfg.cloudRemoteControl, cloudAllowedCwds: Array.isArray(cfg.cloudAllowedCwds) ? cfg.cloudAllowedCwds : [] });
    }
    // 云端派活的自动执行闸门档位（决策 8，契约 §7.1）。判定权威在 gate.js，本端点只读写 runner-config
    // 的 acceptAutoRun 键；acceptAutoRunMode 保证「缺省 / 脏值 → owner-only」与闸门判定同一口径。
    // cwd 白名单（cloudAllowedCwds）与手机中继共用一份，走 /api/cloud/remote-config，不在此重复。
    if (req.method === 'POST' && pathname === '/api/cloud/dispatch-config') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
        if (!['off', 'owner-only', 'on'].includes(payload?.acceptAutoRun)) {
          return sendJson(res, 400, { ok: false, error: 'acceptAutoRun 需为 off / owner-only / on 之一' });
        }
        writeConfig({ acceptAutoRun: payload.acceptAutoRun });
        sendJson(res, 200, { ok: true, acceptAutoRun: payload.acceptAutoRun });
      });
      return;
    }
    if (pathname === '/api/cloud/dispatch-config') {
      return sendJson(res, 200, { ok: true, acceptAutoRun: acceptAutoRunMode(readConfig()) });
    }
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown api' });
    return serveStatic(req, res);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

// 桌面端宿主（electron/server-host.js）或 standalone 入口调用；错误（含 EADDRINUSE）交给调用方决定退出/弹窗
export function start() {
  // 机器身份首启即生成并持久化，与 enroll 无关（改机器名不该变成新机器）
  ensureMachineUid();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, HOST, () => {
      console.log(`ScrumWS 任务看板（看板任务 + 本机 CLI）→ http://${HOST}:${PORT}`);
      // 调度器在端口拿到后再启动：撞端口的第二实例不会碰 scheduler.lock
      const mode = scheduler.start();
      // 账号用量定时拉取、云端上报都只在主（持锁）实例启：副实例「只看不调度」，
      // 不重复 spawn claude、也不重复上报（同一台机器两个实例上报会互相打架）
      if (mode === 'running') {
        ownsUsageTimer = true;
        if (providerConfig().providerEnabled.claude !== false) startUsageTimer();
        startConnector();
      }
      resolve({ host: HOST, port: PORT, server });
    });
  });
}

