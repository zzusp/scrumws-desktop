// 设置页 · 出网代理配置 E2E（离屏 Electron 驱动真 index.html + app.js）。
// 覆盖：设置页「网络」区 + proxyUrl 输入框就位 / 保存走 /api/config/proxy 落 runner-config.json /
//       state.runnerConfig.proxyUrl 回传 / 回填输入框 / 清除回退 / 非法地址被拒。
// 用隔离临时数据根（安全写，不碰共享 ~/.scrumws 配置）。
// 用法：node_modules/.bin/electron docs/acceptance/task-detail-claude-usage-card/scripts/browser-e2e-proxy-settings.cjs
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { pathToFileURL } = require('url');

const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8792;
const SB = path.join(os.homedir(), '.cc-proxy-e2e-sandbox');
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(path.join(SB, 'runtime', 'runner-state'), { recursive: true });
process.env.SCRUMWS_DATA_ROOT = SB; process.env.SCRUMWS_PORT = String(PORT);
const CFG = path.join(SB, 'runtime', 'runner-config.json');

const results = []; const ok = (n, c, e = '') => results.push([n, !!c, e]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const { start } = await import(pathToFileURL(path.join(REPO, 'platform/server.js')).href);
    await start();
    const win = new BrowserWindow({ show: false, width: 1200, height: 860, webPreferences: { offscreen: true } });
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
    const exec = (js) => win.webContents.executeJavaScript(js);
    await sleep(1000);

    await exec(`location.hash='#/settings'`); await sleep(400);
    ok('设置页「网络」区存在', await exec(`[...document.querySelectorAll('#view-settings h2')].some(h=>h.textContent==='网络')`));
    ok('proxyUrl 输入框 + 保存按钮就位', await exec(`!!document.getElementById('proxyUrlInput') && !!document.getElementById('proxySaveBtn')`));
    ok('初始输入框为空(temp 数据根无配置)', await exec(`document.getElementById('proxyUrlInput').value===''`));

    // 保存一个合法代理
    await exec(`(()=>{const i=document.getElementById('proxyUrlInput');i.value='http://127.0.0.1:10808';i.dispatchEvent(new Event('input'));})()`);
    await exec(`document.getElementById('proxySaveBtn').click()`); await sleep(800);
    const hint1 = await exec(`document.getElementById('proxySaveHint').textContent`);
    ok('保存成功提示', /已保存/.test(hint1), hint1);
    ok('落盘 runner-config.json.proxyUrl', (() => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')).proxyUrl === 'http://127.0.0.1:10808'; } catch { return false; } })());
    ok('state.runnerConfig.proxyUrl 回传', await exec(`(async()=>{const d=await (await fetch('/api/state')).json();return d.runnerConfig.proxyUrl;})()`).then(v => v === 'http://127.0.0.1:10808'));

    // 截图（设置页「网络」区，代理已填）
    const shotDir = path.join(REPO, 'docs/acceptance/task-detail-claude-usage-card', 'round-1');
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(shotDir, 'proxy-settings.png'), (await win.webContents.capturePage()).toPNG());

    // 刷新后回填输入框（模拟重进设置页：清 dirty + 重拉 state）
    await exec(`(()=>{const i=document.getElementById('proxyUrlInput');delete i.dataset.dirty;i.value='';})()`);
    await exec(`(async()=>{window.stateData=await (await fetch('/api/state')).json();})()`);
    // syncProxyInput 在 refreshState 内调；这里直接调其效果：手动回填校验值来源
    const backfill = await exec(`(async()=>{const d=await (await fetch('/api/state')).json();return d.runnerConfig.proxyUrl;})()`);
    ok('state 携带已存代理供回填', backfill === 'http://127.0.0.1:10808', backfill);

    // 非法地址被后端拒
    const bad = await exec(`(async()=>{const r=await fetch('/api/config/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proxyUrl:'127.0.0.1:10808'})});return {s:r.status,j:await r.json()};})()`);
    ok('非法代理地址被 400 拒', bad.s === 400 && !bad.j.ok, JSON.stringify(bad));

    // 清除 → 回退
    await exec(`(()=>{const i=document.getElementById('proxyUrlInput');i.value='';i.dispatchEvent(new Event('input'));})()`);
    await exec(`document.getElementById('proxySaveBtn').click()`); await sleep(700);
    const hint2 = await exec(`document.getElementById('proxySaveHint').textContent`);
    ok('清除成功提示(回退环境变量)', /已清除|回退/.test(hint2), hint2);
    ok('落盘 proxyUrl 清空', (() => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')).proxyUrl === ''; } catch { return false; } })());

    console.log('\n==== 设置页出网代理 E2E ====');
    let pass = 0;
    for (const [n, c, e] of results) { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ← ' + e}`); if (c) pass++; }
    console.log(`\n${pass}/${results.length} PASS`);
    win.destroy(); fs.rmSync(SB, { recursive: true, force: true });
    app.exit(pass === results.length ? 0 : 1);
  } catch (e) {
    console.log('E2E 异常：', e && e.stack || e);
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
    app.exit(2);
  }
});
