// Mode A 详情页真浏览器 E2E（Electron/真 Chromium 驱动真实前端）。
// 清 S1(块级 SSE + 回落轮询) / S2(每步 live 跳秒) / S3(每轮上下行 token) 三个渲染项。
// 造一个 processing 任务 + in-flight jsonl（assistant: 带 usage 的 text + 无 result 的 Bash 工具），
// 开 #/task/ 断言 token footer / live 跳秒 / SSE 追加块近实时 / 删 EventSource 后回落轮询。
// 用法（无需 claude）：node_modules/.bin/electron docs/acceptance/board-interactive-session/scripts/browser-e2e-modea.cjs
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { pathToFileURL } = require('url');

const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8798;
const SB = path.join(os.homedir(), '.modea-e2e-sandbox');
const ccName = SB.replace(/[:\\/]/g, '-');
const CCDIR = path.join(os.homedir(), '.claude', 'projects', ccName);
const SID = '77770000-1111-2222-3333-444455556666';
const taskKey = 'manual:mareA'; const safeKey = 'manual__mareA';
const taskDir = path.join(SB, 'runtime', 'runner-state', safeKey);
const jsonl = path.join(CCDIR, `${SID}.jsonl`);

fs.rmSync(SB, { recursive: true, force: true }); fs.rmSync(jsonl, { force: true });
fs.mkdirSync(taskDir, { recursive: true }); fs.mkdirSync(CCDIR, { recursive: true });
process.env.SCRUMWS_DATA_ROOT = SB; process.env.SCRUMWS_PORT = String(PORT);

const p2 = (n) => String(n).padStart(2, '0');
const fmtNow = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const L = (o) => JSON.stringify(o) + '\n';
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

// 首帧：user + assistant(text 带 usage + tool_use Bash 无 result；_ts=6s 前 → 跳秒可见)
fs.writeFileSync(jsonl,
  L({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: isoAgo(9000), cwd: SB, message: { role: 'user', content: 'do a thing' } }) +
  L({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: isoAgo(6000), message: { id: 'm1', model: 'claude-x', content: [{ type: 'text', text: 'Working on it now.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 30' } }], usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 } } })
);
fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ taskKey, source: 'manual', title: 'ModeA E2E', createdAt: fmtNow() }));
fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify({ sessionId: SID, sessionHistory: [{ sessionId: SID, round: 1 }] }));
fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({ state: 'processing', enteredAt: fmtNow(), history: [{ state: 'processing', at: fmtNow() }] }));
fs.writeFileSync(path.join(taskDir, 'lease.json'), JSON.stringify({ taskKey, pid: 0, claimedAt: fmtNow(), heartbeatAt: fmtNow() }));

const results = []; const ok = (n, c, e = '') => results.push([n, !!c, e]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const { start } = await import(pathToFileURL(path.join(REPO, 'platform/server.js')).href);
    await start();
    const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { offscreen: true } });
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
    const exec = (js) => win.webContents.executeJavaScript(js);
    await sleep(1600);   // 等 refreshState populate stateData（含本任务）

    // 进详情页
    await exec(`location.hash = '#/task/' + encodeURIComponent('${taskKey}')`);
    let bodyTxt = '';
    for (let i = 0; i < 30; i++) { await sleep(400); bodyTxt = await exec("(document.getElementById('modalBody')||{}).textContent||''"); if (/Bash|Working on it/.test(bodyTxt)) break; }
    ok('详情页渲染（工具 Bash 出现）', /Bash/.test(bodyTxt), bodyTxt.replace(/\s+/g, ' ').slice(0, 60));

    // S3：每轮上/下行 token footer（↑ ↓）
    ok('S3 token footer 渲染（↑ 上行 / ↓ 下行）', /↑/.test(bodyTxt) && /↓/.test(bodyTxt), (bodyTxt.match(/↑[^↓]*↓[^\n]{0,18}/) || [''])[0]);

    // S2：每步 live 跳秒（.cc-live-timer[data-since] 存在且文本随秒增长）
    const t1 = await exec("(function(){var e=document.querySelector('.cc-live-timer[data-since]');return e?e.textContent:null;})()");
    await sleep(2200);
    const t2 = await exec("(function(){var e=document.querySelector('.cc-live-timer[data-since]');return e?e.textContent:null;})()");
    ok('S2 进行中步骤 live 跳秒存在', t1 !== null, `t1=${t1}`);
    ok('S2 跳秒随时间增长', t1 !== null && t2 !== null && t1 !== t2, `${t1} → ${t2}`);

    // S1：SSE 追加块近实时到达（不等 5s）
    const before = await exec("(document.getElementById('modalBody')||{}).textContent||''");
    const marker = 'SSE_PUSH_MARKER_' + Date.now();
    fs.appendFileSync(jsonl, L({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: isoAgo(0), message: { id: 'm1', content: [{ type: 'text', text: marker }], usage: { input_tokens: 12, output_tokens: 40, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 } } }));
    let pushed = false, pushMs = 0;
    for (let i = 0; i < 8; i++) { await sleep(400); pushMs += 400; if ((await exec("(document.getElementById('modalBody')||{}).textContent||''")).includes(marker)) { pushed = true; break; } }
    ok('S1 SSE 块级推送(追加块 ~≤3s 到达前端)', pushed && !before.includes(marker), `~${pushMs}ms`);

    // S1 回落：删 window.EventSource，重进详情 → 走 5s 轮询；追加新块应在 ≤6s 内到
    await exec("location.hash='#/board'"); await sleep(500);
    await exec("try{window.__ES=window.EventSource;delete window.EventSource;}catch(e){}; true");
    await exec(`location.hash = '#/task/' + encodeURIComponent('${taskKey}')`); await sleep(800);
    const marker2 = 'POLL_MARKER_' + Date.now();
    fs.appendFileSync(jsonl, L({ type: 'assistant', uuid: 'a3', parentUuid: 'a2', timestamp: isoAgo(0), message: { id: 'm1', content: [{ type: 'text', text: marker2 }], usage: { input_tokens: 12, output_tokens: 44, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 } } }));
    let polled = false;
    for (let i = 0; i < 16; i++) { await sleep(500); if ((await exec("(document.getElementById('modalBody')||{}).textContent||''")).includes(marker2)) { polled = true; break; } }
    ok('S1 回落轮询（删 EventSource 后仍更新）', polled);
    await exec("try{window.EventSource=window.__ES;}catch(e){}; true");
  } catch (e) { ok('运行异常', false, (e.stack || e.message || '').split('\n').slice(0, 2).join(' | ')); }

  let pass = 0, fail = 0;
  console.log('\n=== Mode A 详情页真浏览器 E2E ===');
  for (const [n, c, e] of results) { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}${e ? ' — ' + e : ''}`); }
  console.log(`\n=== ${pass}/${pass + fail} PASS ===`);
  try { fs.rmSync(SB, { recursive: true, force: true }); fs.rmSync(CCDIR, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
});
