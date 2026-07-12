// 运行时视图 · 前端真浏览器 E2E（Electron/真 Chromium 驱动真实 index.html+app.js）。
// 覆盖：侧边栏「运行时」菜单 → #/runtime 路由切视图 + 面包屑标题「运行时」→ 运行时卡片（Claude Code/在线/
//       版本/路径/主机/活跃会话）→ 用量 stat tiles（总成本$/输入/输出/缓存，值来自 fixture meta.usage）。
// 用法（需真 claude 已登录，探测 online/版本/路径）：node_modules/.bin/electron docs/acceptance/runtime-panel/scripts/browser-e2e-runtime.cjs
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { pathToFileURL } = require('url');

const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8797;
const SB = path.join(os.homedir(), '.runtime-e2e-sandbox');
fs.rmSync(SB, { recursive: true, force: true });
const rs = path.join(SB, 'runtime', 'runner-state', 'manual__test1');
fs.mkdirSync(rs, { recursive: true });
process.env.SCRUMWS_DATA_ROOT = SB; process.env.SCRUMWS_PORT = String(PORT);

// fixture：一个 done 任务带真实 meta.usage（验证用量聚合真实链路）
fs.writeFileSync(path.join(rs, 'state.json'), JSON.stringify({ state: 'done', outcome: 'success', enteredAt: '2026-07-12 10:00:00', resolvedAt: '2026-07-12 10:05:00', history: [{ state: 'done', at: '2026-07-12 10:05:00', by: 'user' }] }));
fs.writeFileSync(path.join(rs, 'task.json'), JSON.stringify({ taskKey: 'manual:test1', source: 'manual', kind: 'interactive', title: '运行时验证假任务', createdAt: '2026-07-12 09:59:00' }));
fs.writeFileSync(path.join(rs, 'meta.json'), JSON.stringify({ sessionId: 'test-0001', rounds: 2, numTurns: 5, totalCostUsd: 0.1234, usage: { input_tokens: 100, output_tokens: 2000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 8000 } }));

const results = []; const ok = (n, c, e = '') => results.push([n, !!c, e]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const { start } = await import(pathToFileURL(path.join(REPO, 'platform/server.js')).href);
    await start();
    const win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { offscreen: true } });
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
    const exec = (js) => win.webContents.executeJavaScript(js);
    await sleep(1200);

    // 1) 侧边栏「运行时」菜单项存在
    ok('侧边栏含「运行时」菜单', await exec(`!!document.querySelector('a[data-nav="runtime"]')`));

    // 2) 点菜单 → 路由到 #/runtime
    await exec(`document.querySelector('a[data-nav="runtime"]').click()`);
    await sleep(400);
    ok('hash 切到 #/runtime', await exec(`location.hash === '#/runtime'`), await exec(`location.hash`));
    ok('view-runtime 可见', await exec(`getComputedStyle(document.getElementById('view-runtime')).display !== 'none'`));
    ok('view-dashboard 隐藏', await exec(`getComputedStyle(document.getElementById('view-dashboard')).display === 'none'`));
    ok('nav「运行时」高亮 active', await exec(`document.querySelector('a[data-nav="runtime"]').classList.contains('active')`));
    ok('面包屑标题=运行时', await exec(`(document.querySelector('#crumbs .view-title')||{}).textContent === '运行时'`), await exec(`(document.querySelector('#crumbs .view-title')||{}).textContent`));

    // 3) 等 claude 探测完成（online），最多 ~10s
    let cardTxt = '';
    for (let i = 0; i < 20; i++) {
      cardTxt = await exec(`document.getElementById('runtimeCard').textContent`);
      if (/在线|离线/.test(cardTxt)) break;
      await sleep(500);
    }
    ok('运行时卡片含 Claude Code', /Claude Code/.test(cardTxt), cardTxt.slice(0, 80));
    ok('运行时卡片显示「在线」', /在线/.test(cardTxt), cardTxt.slice(0, 120));
    ok('运行时卡片含版本号', /\d+\.\d+\.\d+/.test(cardTxt), (cardTxt.match(/\d+\.\d+\.\d+/) || ['无'])[0]);
    ok('运行时卡片含 claude 路径', /claude/.test(await exec(`(document.querySelector('#runtimeCard .rt-kv:last-child .v')||{}).getAttribute?.('title')||''`)) || /\/claude|\\claude/.test(cardTxt), '');
    ok('运行时卡片含主机名', /主机/.test(cardTxt));
    ok('运行时卡片含活跃会话数', /活跃会话/.test(cardTxt));

    // 4) 用量 stat tiles（值来自 fixture）
    const usageTxt = await exec(`document.getElementById('usageGrid').textContent`);
    ok('用量含总成本 $0.1234', /\$0\.1234/.test(usageTxt), usageTxt.slice(0, 140));
    ok('用量含输入 tokens 100', /100/.test(usageTxt));
    ok('用量含输出 2.0K', /2\.0K/.test(usageTxt), usageTxt);
    ok('用量含缓存 50.0K', /50\.0K/.test(usageTxt));
    ok('用量含「覆盖 1 个已执行任务」', /覆盖 1 个已执行任务/.test(usageTxt), usageTxt.slice(0, 160));
    ok('stat tile 数=4', (await exec(`document.querySelectorAll('#usageGrid .stat-tile').length`)) === 4);
  } catch (e) {
    ok('脚本异常', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  }

  const pass = results.filter((r) => r[1]).length;
  console.log('\n==== 运行时视图 E2E 结果 ====');
  for (const [n, c, e] of results) console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  → ' + e : ''}`);
  console.log(`\n合计 ${pass}/${results.length} 通过`);
  app.exit(pass === results.length ? 0 : 1);
});
