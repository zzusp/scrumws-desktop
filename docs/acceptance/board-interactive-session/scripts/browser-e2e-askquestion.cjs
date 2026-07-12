// S8 真浏览器 E2E：AskUserQuestion → 交互卡渲染问题+选项 → 选 Tea 提交 → claude 拿到答案继续。
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { pathToFileURL } = require('url');
const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8802;
const SB = path.join(os.homedir(), '.s8-e2e-sandbox');
fs.rmSync(SB, { recursive: true, force: true }); fs.mkdirSync(path.join(SB, 'runtime'), { recursive: true });
process.env.SCRUMWS_DATA_ROOT = SB; process.env.SCRUMWS_PORT = String(PORT);
const results = []; const ok = (n, c, e = '') => results.push([n, !!c, e]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const { start } = await import(pathToFileURL(path.join(REPO, 'platform/server.js')).href);
    await start();
    const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { offscreen: true } });
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
    const exec = (js) => win.webContents.executeJavaScript(js);
    const bodyTxt = () => exec("(document.getElementById('sessionBody')||{}).textContent||''");
    await sleep(1000);

    await exec("document.getElementById('newSessionBtn').click()"); await sleep(200);
    await exec(`document.getElementById('newSessionModel').value='claude-haiku-4-5-20251001';
      document.getElementById('newSessionPrompt').value='Use the AskUserQuestion tool to ask whether I prefer Tea or Coffee (options: Tea, Coffee). After I answer, reply with exactly: YOU PICKED <my choice>.';
      document.getElementById('newSessionSubmit').click();`);

    // 等交互卡
    let askSeen = false;
    for (let i = 0; i < 44; i++) { await sleep(400); if (await exec("!!document.querySelector('.ask-card')")) { askSeen = true; break; } }
    ok('AskUserQuestion 渲染成交互卡（非裸 allow/deny）', askSeen);
    if (askSeen) {
      const hasOpts = await exec(`(function(){var c=document.querySelector('.ask-card');var t=c?c.textContent:'';return /Tea/.test(t)&&/Coffee/.test(t)&&document.querySelectorAll('.ask-card .ask-opt input').length>=2;})()`);
      ok('交互卡含问题 + Tea/Coffee 选项', hasOpts);
      // 选 Tea + 提交
      const picked = await exec(`(function(){var i=document.querySelector('.ask-card input[value="Tea"]');if(!i)return false;i.checked=true;return true;})()`);
      ok('可选中 Tea 选项', picked);
      await exec("document.querySelector('.ask-card .btn-primary').click()");
      // 交互卡应消失（已提交）
      await sleep(600);
      ok('提交后交互卡移除', !(await exec("!!document.querySelector('.ask-card')")));
      // claude 拿到答案继续
      let got = false;
      for (let i = 0; i < 40; i++) { await sleep(400); if (/PICKED\s*TEA|TEA/i.test(await bodyTxt())) { got = true; break; } }
      ok('提交后 claude 拿到答案继续（会话流含 PICKED/TEA）', got, (await bodyTxt()).replace(/\s+/g, ' ').slice(-70));
    }
  } catch (e) { ok('运行异常', false, (e.stack || e.message || '').split('\n').slice(0, 2).join(' | ')); }
  let pass = 0, fail = 0;
  console.log('\n=== S8 AskUserQuestion 真浏览器 E2E ===');
  for (const [n, c, e] of results) { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}${e ? ' — ' + e : ''}`); }
  console.log(`\n=== ${pass}/${pass + fail} PASS ===`);
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
});
