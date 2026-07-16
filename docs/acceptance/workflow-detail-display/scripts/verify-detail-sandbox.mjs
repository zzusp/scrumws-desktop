// 端到端验证（可复现）：一次性沙箱里重放「后台任务还在跑」，起只读看板 → 无头 Chrome 开详情页 →
// 断言两处展示（侧栏后台任务 / 消息流 Workflow ⏺ 行）→ 截图。跑完即拆，零污染。
//
// 两个场景（覆盖新判据的两面）：
//   ① 活会话 + 未配平的后台任务      → 侧栏「后台任务 N 个运行中」    （不再按启动时长误杀）
//   ② 死会话 + 同样未配平的后台任务  → 不显示该行                     （陈旧值由 sessionAlive 短路）
// 场景 ② 是新判据的唯一防线，必须验：删掉 15min 死线后，若 sessionAlive 失灵就会永久误报。
//
// 为什么要沙箱：真实"在跑"的状态随时收尾（现场那条 workflow 跑了 108.9min 就收了），不可按需复现。
// 沙箱用**真实 jsonl 字节**重放：截断到某时刻（append-only 前缀 = 合法快照，parentUuid 链完整；
// 删中间行会断链，logs.js 死分支过滤会把后续消息整片丢掉 → 详情只剩几个工具）。
// 隔离靠项目的 SCRUMWS_* env（DATA_ROOT / CC_PROJECTS / CC_SESSIONS），不碰 ~/.scrumws 与在跑的 8799。
//
//   node docs/acceptance/workflow-detail-display/scripts/verify-detail-sandbox.mjs [--port 8816] [--keep]
//   --check 只自检（零副作用）
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
const OUT = path.join(HERE, '..', 'round-3', 'sandbox-detail-running.png');

const SID = '66b52133-bae7-4f2c-bdcf-34fe03a01cc4';
const PROJ = 'D--project-scrumws-desktop--claude-worktrees-cloud-control-plane';
const SRC = path.join(os.homedir(), '.claude/projects', PROJ, `${SID}.jsonl`);
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

if (!CHROME) { console.error('[check] 找不到 Chrome / Edge'); process.exit(2); }
if (!fs.existsSync(SRC)) { console.error(`[check] 缺语料 jsonl: ${SRC}`); process.exit(2); }
console.log(`[check] 浏览器 ${path.basename(CHROME)}`);
console.log(`[check] 语料 ${(fs.statSync(SRC).size / 1024).toFixed(0)}KB`);
if (CHECK_ONLY) { console.log('[check] 自检通过，未建沙箱、未起服务'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-sbox-'));
const DATA = path.join(SBOX, 'data');
const PROJECTS = path.join(SBOX, 'projects', PROJ);
const SESSIONS = path.join(SBOX, 'sessions');
fs.mkdirSync(path.join(DATA, 'runtime'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(SESSIONS, { recursive: true });

// ---- 重放：截断到「最后一个未配平后台启动 +1min」，该时刻这些任务都还在跑 ----
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/).filter(Boolean);
let cutAt = 0;
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  const r = o.toolUseResult;
  if (!r || typeof r !== 'object') continue;
  const isBg = r.taskType === 'local_workflow' || r.isAsync === true || r.backgroundTaskId
    || (r.taskId && typeof r.timeoutMs === 'number' && typeof r.persistent === 'boolean');
  if (isBg) cutAt = Math.max(cutAt, Date.parse(o.timestamp) || 0);
}
const CUT = cutAt + 60 * 1000;
const kept = lines.filter((l) => { try { const t = Date.parse(JSON.parse(l).timestamp); return !t || t <= CUT; } catch { return false; } });
fs.writeFileSync(path.join(PROJECTS, `${SID}.jsonl`), kept.join('\n'), 'utf8');
console.log(`[沙箱] ${SBOX}`);
console.log(`[重放] 截断到 ${new Date(CUT).toLocaleTimeString()}（末个后台启动 +1min）：留 ${kept.length}/${lines.length} 行`);

fs.writeFileSync(path.join(DATA, 'runtime', 'cli-watchlist.json'), JSON.stringify({
  sessions: { [SID]: { addedAt: '2026-07-16 20:50:18', customTitle: null, note: null,
    jsonlPath: path.join(PROJECTS, `${SID}.jsonl`), projectDir: PROJ, archivedAt: null, doneAt: null } },
}, null, 2), 'utf8');

// ---- 造「活会话」：拉一个真进程占着 pid，按 CC 注册表格式登记 ----
const dummy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
await sleep(300);
const regFile = path.join(SESSIONS, `${dummy.pid}.json`);
const writeReg = (pid) => fs.writeFileSync(regFile, JSON.stringify({
  pid, sessionId: SID, cwd: 'D:\\project\\scrumws-desktop', startedAt: Date.now(),
  version: '2.1.211', kind: 'interactive', entrypoint: 'cli', status: 'busy', updatedAt: Date.now(),
}), 'utf8');
writeReg(dummy.pid);
console.log(`[活会话] 傀儡进程 pid=${dummy.pid} 已登记进沙箱注册表`);

let srv = null, chrome = null;
const cleanup = () => {
  try { srv?.kill(); } catch { }
  try { chrome?.kill(); } catch { }
  try { dummy.kill(); } catch { }
  if (!KEEP) { try { fs.rmSync(SBOX, { recursive: true, force: true }); } catch { } }
};
process.on('exit', cleanup);

const startServer = () => spawn(process.execPath, [path.join(REPO, 'platform/standalone.js')], {
  env: { ...process.env, SCRUMWS_PORT: String(PORT), DASHBOARD_NO_SCHEDULER: '1',
    SCRUMWS_DATA_ROOT: DATA, SCRUMWS_CC_PROJECTS: path.join(SBOX, 'projects'), SCRUMWS_CC_SESSIONS: SESSIONS },
  windowsHide: true, stdio: 'ignore',
});
const apiCount = async () => {
  const j = await fetch(`http://127.0.0.1:${PORT}/api/state`).then((r) => r.json());
  const found = []; const seen = new Set();
  (function walk(o) { if (!o || seen.has(o)) return; if (typeof o === 'object') seen.add(o);
    if (Array.isArray(o)) o.forEach(walk); else if (typeof o === 'object') { if (o.taskKey) found.push(o); Object.values(o).forEach(walk); } })(j);
  return found.find((t) => String(t.taskKey).includes('66b52133'));
};
const waitUp = async () => { for (let i = 0; i < 40; i++) { await sleep(250); if (await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.status === 200).catch(() => 0)) return true; } return false; };

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}\n        ${d}`); } };

// ================= 场景 ①：活会话 =================
srv = startServer();
if (!await waitUp()) { console.error('看板起不来'); cleanup(); process.exit(2); }
const t1 = await apiCount();
console.log(`\n[场景① 活会话] ${t1?.taskKey} state=${t1?.state} backgroundTaskCount=${t1?.backgroundTaskCount}`);
ok('① 活会话 + 未配平后台任务 → 计入（不按启动时长误杀）', t1?.backgroundTaskCount >= 1, `实得 ${t1?.backgroundTaskCount}`);

// 开详情页
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-cdp-'));
chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9336', `--user-data-dir=${profile}`, '--window-size=1500,1700', 'about:blank'], { windowsHide: true });
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  target = await fetch('http://127.0.0.1:9336/json').then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
}
if (!target) { console.error('CDP 未就绪'); cleanup(); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evaluate = async (x) => (await cdp('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/task/cli%3A66b52133` });
await sleep(9000);

const body1 = await evaluate('document.body.innerText');
const bgLine = await evaluate(`(()=>{const m=document.body.innerText.match(/后台任务[\\s\\S]{0,45}/);return m?m[0].split('\\n').slice(0,2).join(' | ').trim():''})()`);
console.log(`        侧栏实得：${bgLine || '(无)'}`);
ok('① 侧栏显示「后台任务 N 个运行中」', new RegExp(`${t1.backgroundTaskCount} 个运行中`).test(body1), `实得「${bgLine}」`);
const wf = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.cc-name')].filter(e=>e.textContent==='Workflow').map(e=>e.parentElement.innerText.replace(/\\s+/g,' ').trim()))`) || '[]');
console.log('        消息流实得：'); wf.forEach((l) => console.log('          ⏺ ' + l));
ok('① 消息流出 3 条 Workflow ⏺ 行且都带工作流名', wf.length === 3 && wf.every((l) => l.includes('cloud-p0p1')), JSON.stringify(wf));
ok('① ⏺ 行不再是脚本源码 JSON', wf.length > 0 && !wf.some((l) => l.includes('export const meta')), `wf 行数 ${wf.length}（0 行不算通过）`);

await evaluate(`(()=>{const e=[...document.querySelectorAll('.cc-name')].find(x=>x.textContent==='Workflow');
  if(e){const t=e.closest('.cc-tool'); t.querySelectorAll('details').forEach(d=>d.open=true); t.scrollIntoView({block:'center'});} return 1;})()`);
await sleep(1200);
const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log(`\n[截图] ${OUT} (${fs.statSync(OUT).size} bytes)`);

// ================= 场景 ②：死会话 =================
// 杀掉傀儡进程 → 注册表文件仍在（CC 实际也会残留），但 pidAlive 应判死 → 陈旧 launched 必须被短路
srv.kill(); await sleep(500);
dummy.kill(); await sleep(800);
console.log(`\n[场景② 死会话] 傀儡 pid=${dummy.pid} 已杀，注册表文件故意保留（模拟 CC 残留）`);
srv = startServer();
if (!await waitUp()) { console.error('看板起不来（场景②）'); cleanup(); process.exit(2); }
const t2 = await apiCount();
console.log(`        ${t2?.taskKey} state=${t2?.state} backgroundTaskCount=${t2?.backgroundTaskCount}`);
ok('② 死会话 → 后台任务计数归 0（陈旧未配平值被 sessionAlive 短路，不永久误报）',
  t2?.backgroundTaskCount === 0, `实得 ${t2?.backgroundTaskCount}`);
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/task/cli%3A66b52133` });
await sleep(8000);
const body2 = await evaluate('document.body.innerText');
ok('② 死会话 → 侧栏不显示「后台任务 N 个运行中」', !/后台任务[\s\S]{0,10}个运行中/.test(body2),
  `页面仍有该行：${String(body2).match(/后台任务[\s\S]{0,40}/)?.[0]}`);

cleanup();
console.log(`\n==== ${fail === 0 ? 'ALL PASS' : 'FAILED'} : ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
