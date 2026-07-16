// 端到端验证：真起看板（只读实例）→ 无头 Chrome 开 cli 任务详情页 → 断言 workflow 确实展示出来。
// 走 CDP（Node 22 自带 WebSocket），不装 puppeteer；不碰用户在跑的 8799 桌面 app。
//
//   node docs/acceptance/workflow-detail-display/scripts/verify-live-detail.mjs --task cli:66b52133 [--port 8815]
//   --check 只自检环境（零副作用，不起服务、不开浏览器）
//
// 前置：另开一个只读看板实例（不启调度器、不与 8799 抢 scheduler.lock）：
//   SCRUMWS_PORT=8815 DASHBOARD_NO_SCHEDULER=1 node platform/standalone.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const TASK = argv.includes('--task') ? argv[argv.indexOf('--task') + 1] : 'cli:66b52133';
const PORT = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 8815;
const OUT = path.join(HERE, '..', 'round-2', 'live-detail.png');
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

if (!CHROME) { console.error('[check] 找不到 Chrome / Edge'); process.exit(2); }
console.log(`[check] 浏览器 ${path.basename(CHROME)}`);
// 看板必须已在跑：本脚本只读不起服务，避免误起第二个带调度器的实例
const ping = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.status).catch(() => 0);
if (ping !== 200) { console.error(`[check] 看板 ${PORT} 未就绪（${ping}）。先起只读实例，见文件头注释`); process.exit(2); }
console.log(`[check] 看板 127.0.0.1:${PORT} 就绪`);
if (CHECK_ONLY) { console.log('[check] 自检通过，未起浏览器'); process.exit(0); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-cdp-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--window-size=1500,1700', 'about:blank'],
  { windowsHide: true });
const cleanup = () => { try { chrome.kill(); } catch { } };
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 等 CDP 端口起来
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  target = await fetch('http://127.0.0.1:9333/json').then((r) => r.json())
    .then((l) => l.find((t) => t.type === 'page')).catch(() => null);
}
if (!target) { console.error('CDP 未就绪'); cleanup(); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.result?.value;

await cdp('Page.enable');
await cdp('Runtime.enable');
const url = `http://127.0.0.1:${PORT}/#/task/${encodeURIComponent(TASK)}`;
console.log(`\n[导航] ${url}`);
await cdp('Page.navigate', { url });
await sleep(9000);   // SPA 拉 /api/state + 渲染详情

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); } };

const body = await evaluate('document.body.innerText');
if (!body) { console.error('页面取不到文本'); cleanup(); process.exit(2); }

// 1) 侧栏「后台任务 N 个运行中」——断言「页面 == 后端真值」，而不是硬写"必须有 workflow 在跑"：
// 真实会话里 workflow 随时会收尾（实测那次跑完 108.9min 就收了），硬断言会变成必然失败的测试。
// 「workflow 在跑」那一刻的确定性覆盖在 verify-detail-sandbox.mjs（沙箱重放）。
const state = await fetch(`http://127.0.0.1:${PORT}/api/state`).then((r) => r.json());
const found = []; const seen = new Set();
(function walk(o) { if (!o || seen.has(o)) return; if (typeof o === 'object') seen.add(o);
  if (Array.isArray(o)) o.forEach(walk); else if (typeof o === 'object') { if (o.taskKey) found.push(o); Object.values(o).forEach(walk); } })(state);
const expect = Number(found.find((t) => t.taskKey === TASK)?.backgroundTaskCount) || 0;
const bgLine = await evaluate(`(()=>{const m=document.body.innerText.match(/后台任务[\\s\\S]{0,45}/);return m?m[0].split('\\n').slice(0,2).join(' | ').trim():''})()`);
console.log(`\n[侧栏] 后端 backgroundTaskCount=${expect}；页面：${bgLine || '(无「后台任务」行)'}`);
ok(`侧栏与后端一致（${expect} 个在跑 → ${expect > 0 ? '显示 N 个运行中' : '不显示该行'}）`,
  expect > 0 ? new RegExp(`${expect} 个运行中`).test(body) : !/后台任务[\s\S]{0,10}个运行中/.test(body),
  `后端 ${expect}，页面「${bgLine}」`);

// 2) 消息流里的 Workflow ⏺ 行
const wfLines = await evaluate(`JSON.stringify([...document.querySelectorAll('.cc-name')].filter(e=>e.textContent==='Workflow').map(e=>e.parentElement.innerText.replace(/\\s+/g,' ').trim()))`);
const lines = JSON.parse(wfLines || '[]');
console.log(`\n[消息流] Workflow 工具行 ${lines.length} 条：`);
lines.forEach((l) => console.log('   ⏺ ' + l));
ok('消息流渲染出 Workflow 工具行', lines.length > 0, '一条都没有');
ok('⏺ 行显示工作流名 cloud-p0p1', lines.some((l) => l.includes('cloud-p0p1')), JSON.stringify(lines));
ok('⏺ 行不再是脚本源码 JSON', !lines.some((l) => l.includes('export const meta')), JSON.stringify(lines).slice(0, 200));
ok('续跑那次标出 resumeFromRunId', lines.some((l) => l.includes('续跑')), JSON.stringify(lines));

// 3) 工作块折叠汇总（`launched N workflows`）在本页**不该**出现：renderCcFlow 对 `tools.length < 2`
// 的组平铺不折叠，而这三次 Workflow 前后都紧挨正文、各自单独成组（实测组内工具数 1,1,1）。
// 该汇总句的覆盖放在离线单测里（verify-workflow-display.mjs 的 GRP-1），不在这里假装能测。
const grouped = await evaluate('[...document.querySelectorAll(".cc-name")].filter(e=>e.textContent==="Workflow").map(e=>e.closest(".cc-group")?1:0).join(",")');
console.log(`\n[分组] 三次 Workflow 各自所在折叠组：${grouped || '(无)'}（0=单独成组不折叠 → 本页无 group 汇总句，符合预期）`);
ok('Workflow 单独成组时平铺不折叠（⏺ 行直接可见，无需展开）', !/1/.test(String(grouped)), `实得 ${grouped}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const shoot = async (file) => {
  const s = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'));
  console.log(`[截图] ${file} (${fs.statSync(file).size} bytes)`);
};
console.log('');
// ① 落地页：详情默认停在最新消息 → 右侧栏「后台任务 N 个运行中」在这张
await shoot(OUT);
// ② 把第一条 Workflow 滚进视野并展开入参：⏺ 行与源码区的视觉证据（消息流在页面靠上，落地页截不到）
await evaluate(`(()=>{const e=[...document.querySelectorAll('.cc-name')].find(x=>x.textContent==='Workflow');
  if(!e)return 0; const tool=e.closest('.cc-tool'); tool.querySelectorAll('details').forEach(d=>d.open=true);
  tool.scrollIntoView({block:'center'}); return 1;})()`);
await sleep(1200);
await shoot(path.join(path.dirname(OUT), 'live-detail-workflow-line.png'));

cleanup();
console.log(`\n==== ${fail === 0 ? 'ALL PASS' : 'FAILED'} : ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
