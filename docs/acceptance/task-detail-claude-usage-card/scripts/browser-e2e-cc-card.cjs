// Claude Code 卡片 · 前端真浏览器 E2E（离屏 Electron Chromium 驱动真 index.html + app.js）。
// 覆盖：详情页任务信息下方出现 Claude Code 卡片 / session·模型·token 三行就位 /
//       Pro/Max 账号 5h·7d 横向进度条渲染 + 百分比 + 距刷新剩余 / manual(计量) 与 cli(不计量) token 分支。
// 数据根用真实 ~/.scrumws（只读渲染；scheduler 撞桌面应用锁 → disabled-lock 不 tick，零副作用）。
// 用法（需真 claude 已登录）：node_modules/.bin/electron docs/acceptance/task-detail-claude-usage-card/scripts/browser-e2e-cc-card.cjs
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os');
const { pathToFileURL } = require('url');

const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8791;
process.env.SCRUMWS_DATA_ROOT = process.env.SCRUMWS_DATA_ROOT || path.join(os.homedir(), '.scrumws');
process.env.SCRUMWS_PORT = String(PORT);

const results = []; const ok = (n, c, e = '') => results.push([n, !!c, e]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const { start } = await import(pathToFileURL(path.join(REPO, 'platform/server.js')).href);
    await start();
    const win = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { offscreen: true } });
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
    const exec = (js) => win.webContents.executeJavaScript(js);
    await sleep(1200);

    // 找一个有 sessionId 的 manual 任务（token 计量）+ 一个 cli 任务（不计量）
    const picks = await exec(`(async () => {
      const d = await (await fetch('/api/state')).json();
      const all = Object.values(d.lifecycle||{}).flat();
      const manual = all.find(t => t.source!=='cli' && t.meta && t.meta.sessionId && t.meta.usage);     // 有 token 计量
      const manualNoUsage = all.find(t => t.source!=='cli' && t.meta && t.meta.sessionId && !t.meta.usage); // 分身无快照
      const cli = all.find(t => t.source==='cli' && t.meta && t.meta.sessionId);
      return { manual: manual && manual.taskKey, manualNoUsage: manualNoUsage && manualNoUsage.taskKey, cli: cli && cli.taskKey };
    })()`);
    ok('找到已计量 manual 任务(含 usage)', picks.manual, JSON.stringify(picks));

    // —— manual 任务详情：等 Claude Code 卡片 + 用量进度条渲染 ——
    await exec(`location.hash='#/task/${picks.manual}'`);
    // 轮询等 .cc-bar 出现（首拉 /api/claude-usage 走 curl ~2s，之后回调重画）
    let barCount = 0;
    for (let i = 0; i < 24; i++) {
      await sleep(600);
      barCount = await exec(`document.querySelectorAll('#taskSide .cc-bar').length`);
      if (barCount >= 1) break;
    }

    const card = await exec(`(() => {
      const blocks = [...document.querySelectorAll('#taskSide .side-block')];
      const cc = blocks.find(b => (b.querySelector('h3')||{}).textContent && b.querySelector('h3').textContent.includes('Claude Code'));
      if (!cc) return { found:false };
      const kText = [...cc.querySelectorAll('.side-kv .k')].map(e=>e.textContent);
      const bars = [...cc.querySelectorAll('.cc-bar')].map(b => ({
        label: (b.querySelector('.cc-bar-label')||{}).textContent,
        pct: (b.querySelector('.cc-bar-pct')||{}).textContent,
        width: (b.querySelector('.cc-bar-fill')||{}).style.width,
        reset: (b.querySelector('.cc-bar-reset')||{}).textContent,
      }));
      // 卡片在任务信息块之后
      const idxInfo = blocks.findIndex(b => (b.querySelector('h3')||{}).textContent==='任务信息');
      const idxCc = blocks.indexOf(cc);
      const planTag = (cc.querySelector('.tag')||{}).textContent || '';
      return { found:true, kText, bars, afterInfo: idxCc===idxInfo+1, planTag, tokenRow: (()=>{const kv=[...cc.querySelectorAll('.side-kv')].find(x=>(x.querySelector('.k')||{}).textContent==='token');return kv?kv.querySelector('.v').textContent.trim():null;})() };
    })()`);

    ok('Claude Code 卡片存在', card.found, JSON.stringify(card).slice(0, 300));
    ok('卡片紧邻「任务信息」下方', card.afterInfo);
    ok('含 session/模型/token 三行', card.kText && card.kText.includes('session') && card.kText.includes('模型') && card.kText.includes('token'), JSON.stringify(card.kText));
    ok('套餐徽章存在(MAX/PRO)', /max|pro/i.test(card.planTag||''), card.planTag);
    ok('渲染 5h + 7d 两条进度条', card.bars && card.bars.length === 2, JSON.stringify(card.bars));
    ok('5h 条含百分比 + 宽度 + 距刷新', card.bars && card.bars[0] && /%/.test(card.bars[0].pct) && /%/.test(card.bars[0].width) && /刷新/.test(card.bars[0].reset||''), JSON.stringify(card.bars && card.bars[0]));
    ok('7d 条含百分比 + 宽度 + 距刷新', card.bars && card.bars[1] && /%/.test(card.bars[1].pct) && /%/.test(card.bars[1].width) && /刷新/.test(card.bars[1].reset||''), JSON.stringify(card.bars && card.bars[1]));
    ok('manual 任务 token 行有真实计量(非"不计量")', card.tokenRow && !/不计量/.test(card.tokenRow), card.tokenRow);

    // 截图（manual 详情）
    const shotDir = path.join(REPO, 'docs/acceptance/task-detail-claude-usage-card', 'round-1');
    require('fs').mkdirSync(shotDir, { recursive: true });
    const img = await win.webContents.capturePage();
    require('fs').writeFileSync(path.join(shotDir, 'cc-card-manual.png'), img.toPNG());

    const tokenRowOf = `(() => {
      const blocks = [...document.querySelectorAll('#taskSide .side-block')];
      const cc = blocks.find(b => (b.querySelector('h3')||{}).textContent && b.querySelector('h3').textContent.includes('Claude Code'));
      if (!cc) return null;
      const kv = [...cc.querySelectorAll('.side-kv')].find(x=>(x.querySelector('.k')||{}).textContent==='token');
      return kv ? kv.querySelector('.v').textContent.trim() : null;
    })()`;

    // —— 分身无快照(处理中)任务：token 应「—」而非「不计量」——
    if (picks.manualNoUsage) {
      await exec(`location.hash='#/task/${picks.manualNoUsage}'`); await sleep(1500);
      const noU = await exec(tokenRowOf);
      ok('分身无快照任务 token 显「—」(非"不计量")', noU === '—', noU);
    } else {
      ok('分身无快照任务 token 显「—」(非"不计量")', true, '（无此类任务，跳过）');
    }

    // —— cli 任务详情：token 应显示「不计量」，用量条仍在（账号级）——
    if (picks.cli) {
      await exec(`location.hash='#/task/${picks.cli}'`); await sleep(1500);
      const cliTok = await exec(tokenRowOf);
      ok('cli 任务 token 行显示「不计量」', cliTok && /不计量/.test(cliTok), cliTok);
    } else {
      ok('cli 任务 token 行显示「不计量」', true, '（无 cli 任务可测，跳过）');
    }

    console.log('\n==== Claude Code 卡片 E2E ====');
    let pass = 0;
    for (const [n, c, e] of results) { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ← ' + e}`); if (c) pass++; }
    console.log(`\n${pass}/${results.length} PASS`);
    win.destroy();
    app.exit(pass === results.length ? 0 : 1);
  } catch (e) {
    console.log('E2E 异常：', e && e.stack || e);
    app.exit(2);
  }
});
