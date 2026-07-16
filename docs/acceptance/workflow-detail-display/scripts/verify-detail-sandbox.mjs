// 端到端验证（可复现版）：在**一次性沙箱**里重放「workflow 正在后台跑」这一刻，起只读看板 → 无头
// Chrome 开详情页 → 断言 workflow 两处都展示得出来 → 截图。跑完即拆，零污染。
//
// 为什么要沙箱：现场那次（cli:66b52133 的 cloud-p0p1）跑了 108.9min 后已收尾，"在跑"这个状态自然不再
// 复现；而它恰恰是本次改动的核心形态（远超 15min BG_STALE_MS 仍在跑）。沙箱用**真实 jsonl 字节**重放：
// 只做两件事——砍掉该 workflow 的终态通知行（回到"还没收尾"）、把 transcriptDir 指向自建目录并给个新
// mtime（"刚有动静"）。其余原样。
//
// 隔离靠项目自带的两个 env（非本次新增）：SCRUMWS_DATA_ROOT（看板数据根）+ SCRUMWS_CC_PROJECTS（CC 会话根）。
// 全程不碰用户的 ~/.scrumws 与在跑的 8799 桌面 app，也不启调度器。
//
//   node docs/acceptance/workflow-detail-display/scripts/verify-detail-sandbox.mjs [--port 8816] [--keep]
//   --check 只自检（零副作用）  --keep 保留沙箱目录供排查
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const KEEP = argv.includes('--keep');
const PORT = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 8816;
const OUT = path.join(HERE, '..', 'round-2', 'sandbox-detail-workflow-running.png');

const SID = '66b52133-bae7-4f2c-bdcf-34fe03a01cc4';
const PROJ = 'D--project-scrumws-desktop--claude-worktrees-cloud-control-plane';
const SRC = path.join(os.homedir(), '.claude/projects', PROJ, `${SID}.jsonl`);
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

if (!CHROME) { console.error('[check] 找不到 Chrome / Edge'); process.exit(2); }
if (!fs.existsSync(SRC)) { console.error(`[check] 缺语料 jsonl: ${SRC}`); process.exit(2); }
if (!fs.existsSync(path.join(REPO, 'platform/standalone.js'))) { console.error('[check] 缺 platform/standalone.js'); process.exit(2); }
console.log(`[check] 浏览器 ${path.basename(CHROME)}`);
console.log(`[check] 语料 ${(fs.statSync(SRC).size / 1024).toFixed(0)}KB ${SRC}`);
if (CHECK_ONLY) { console.log('[check] 自检通过，未建沙箱、未起服务'); process.exit(0); }

// ---- 搭沙箱 ----
const SBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sbox-'));
const DATA = path.join(SBOX, 'data');
const PROJECTS = path.join(SBOX, 'projects', PROJ);
const WFDIR = path.join(SBOX, 'wf-transcript');
fs.mkdirSync(path.join(DATA, 'runtime'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(WFDIR, { recursive: true });
// workflow 的 transcriptDir：给个"刚写过"的文件 → lastActivityMs 判活
fs.writeFileSync(path.join(WFDIR, 'agent-replay.jsonl'), '{}', 'utf8');

// 重放 = 把文件**截断**到「最后一次 workflow 启动 +1min」那一刻，再把该次启动的 transcriptDir 指到沙箱
// 新目录（给个新 mtime = "刚有动静"）。就这两步：
//   · 截断而不是删中间行 —— jsonl 是 append-only，前缀天然是某一时刻的合法快照，parentUuid 链完整。
//     （删中间行会把后续消息的 parentUuid 指空，logs.js 的死分支过滤会把它们整片当撤回丢掉 → 详情
//      只剩 3 个工具。第一版就栽在这，见 round-2.md。）
//   · 截断后，该 workflow 的终态通知（+108min）自然落在窗口外 → 读作"还在跑"，无需伪造。
//   · 其余后台任务（subagent / 后台命令）都在更早时刻启动，按启动时刻早已过 15min 死线 → 不计入，
//     故结果应恰好 1 个在跑。
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/).filter(Boolean);
let liveLaunchAt = 0, LIVE_ID = null;
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.toolUseResult?.taskType === 'local_workflow') {
    const id = (o.message?.content || []).find((b) => b?.type === 'tool_result')?.tool_use_id;
    const t = Date.parse(o.timestamp) || 0;
    if (id && t >= liveLaunchAt) { liveLaunchAt = t; LIVE_ID = id; }
  }
}
if (!LIVE_ID) { console.error('语料里没有 Workflow 启动'); process.exit(2); }
const CUT = liveLaunchAt + 60 * 1000;
let rewired = 0, kept = 0;
const out = [];
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  const t = Date.parse(o.timestamp) || 0;
  if (t && t > CUT) continue;                       // 截断：该时刻之后的行不存在
  const r = o.toolUseResult;
  if (r && typeof r === 'object' && r.taskType === 'local_workflow'
    && (o.message?.content || []).some((b) => b?.tool_use_id === LIVE_ID)) {
    r.transcriptDir = WFDIR; rewired++; out.push(JSON.stringify(o)); kept++; continue;
  }
  out.push(line); kept++;
}
fs.writeFileSync(path.join(PROJECTS, `${SID}.jsonl`), out.join('\n'), 'utf8');
console.log(`[沙箱] ${SBOX}`);
console.log(`[重放] 截断到 ${new Date(CUT).toLocaleTimeString()}（末次 workflow 启动 +1min）：留 ${kept}/${lines.length} 行`
  + `；该次启动的 transcriptDir 重指沙箱新目录 ${rewired} 处 → 读作"还在跑"`);

fs.writeFileSync(path.join(DATA, 'runtime', 'cli-watchlist.json'), JSON.stringify({
  sessions: { [SID]: { addedAt: '2026-07-16 20:50:18', customTitle: null, note: null,
    jsonlPath: path.join(PROJECTS, `${SID}.jsonl`), projectDir: PROJ, archivedAt: null, doneAt: null } },
}, null, 2), 'utf8');

// ---- 起只读看板（沙箱数据根 / 沙箱 CC 根 / 不启调度器）----
const srv = spawn(process.execPath, [path.join(REPO, 'platform/standalone.js')], {
  env: { ...process.env, SCRUMWS_PORT: String(PORT), DASHBOARD_NO_SCHEDULER: '1',
    SCRUMWS_DATA_ROOT: DATA, SCRUMWS_CC_PROJECTS: path.join(SBOX, 'projects') },
  windowsHide: true,
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d; });
srv.stderr.on('data', (d) => { srvLog += d; });
let chrome = null;
const cleanup = () => {
  try { srv.kill(); } catch { }
  try { chrome?.kill(); } catch { }
  if (!KEEP) { try { fs.rmSync(SBOX, { recursive: true, force: true }); } catch { } }
};
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let up = 0;
for (let i = 0; i < 40 && !up; i++) { await sleep(250); up = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.status).catch(() => 0); }
if (up !== 200) { console.error(`看板起不来（${PORT}）：\n${srvLog}`); cleanup(); process.exit(2); }
console.log(`[看板] 127.0.0.1:${PORT} 就绪 · ${srvLog.trim().split('\n').pop()}`);

// 后端真值先确认
const state = await fetch(`http://127.0.0.1:${PORT}/api/state`).then((r) => r.json());
const found = [];
const seen = new Set();
(function walk(o) { if (!o || seen.has(o)) return; if (typeof o === 'object') seen.add(o);
  if (Array.isArray(o)) o.forEach(walk); else if (typeof o === 'object') { if (o.taskKey) found.push(o); Object.values(o).forEach(walk); } })(state);
const task = found.find((t) => String(t.taskKey).includes('66b52133'));
console.log(`[后端] ${task?.taskKey} state=${task?.state} backgroundTaskCount=${task?.backgroundTaskCount}`);

// ---- 开详情页 ----
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-cdp-'));
chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9335', `--user-data-dir=${profile}`, '--window-size=1500,1700', 'about:blank'], { windowsHide: true });
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  target = await fetch('http://127.0.0.1:9335/json').then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
}
if (!target) { console.error('CDP 未就绪'); cleanup(); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/task/cli%3A66b52133` });
await sleep(9000);

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}\n        ${d}`); } };
const body = await evaluate('document.body.innerText');

console.log('\n[断言]');
ok('后端把在跑的 workflow 计入 backgroundTaskCount', task?.backgroundTaskCount === 1, `实得 ${task?.backgroundTaskCount}`);
const bgLine = await evaluate(`(()=>{const m=document.body.innerText.match(/后台任务[\\s\\S]{0,45}/);return m?m[0].split('\\n').slice(0,2).join(' | ').trim():''})()`);
ok('侧栏显示「后台任务 1 个运行中」', /后台任务/.test(body) && /1 个运行中/.test(body), `实得「${bgLine}」`);
console.log(`        侧栏实得：${bgLine}`);
const wf = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.cc-name')].filter(e=>e.textContent==='Workflow').map(e=>e.parentElement.innerText.replace(/\\s+/g,' ').trim()))`) || '[]');
// 空列表不许当通过：诊断一下页面到底渲出了什么，别让"没渲染"伪装成"没问题"
if (!wf.length) {
  console.log('        [诊断] .cc-tool 数 :', await evaluate('document.querySelectorAll(".cc-tool").length'));
  console.log('        [诊断] .cc-name 样本 :', await evaluate('JSON.stringify([...document.querySelectorAll(".cc-name")].slice(0,8).map(e=>e.textContent))'));
  console.log('        [诊断] body 前 160 字 :', String(body).replace(/\s+/g, ' ').slice(0, 160));
}
console.log('        消息流实得：'); wf.forEach((l) => console.log('          ⏺ ' + l));
ok('消息流出 3 条 Workflow 行且都带工作流名', wf.length === 3 && wf.every((l) => l.includes('cloud-p0p1')), JSON.stringify(wf));
ok('⏺ 行不再是脚本源码 JSON', wf.length > 0 && !wf.some((l) => l.includes('export const meta')), `wf 行数 ${wf.length}（0 行不算通过）`);

// 截图：把侧栏 + 第一条 Workflow 都摆进视野
await evaluate(`(()=>{const e=[...document.querySelectorAll('.cc-name')].find(x=>x.textContent==='Workflow');
  if(e){const t=e.closest('.cc-tool'); t.querySelectorAll('details').forEach(d=>d.open=true); t.scrollIntoView({block:'center'});} return 1;})()`);
await sleep(1200);
const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log(`\n[截图] ${OUT} (${fs.statSync(OUT).size} bytes)`);

cleanup();
console.log(`\n==== ${fail === 0 ? 'ALL PASS' : 'FAILED'} : ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
