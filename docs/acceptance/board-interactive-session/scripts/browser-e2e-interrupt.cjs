// S6 打断/转向 真浏览器 E2E（Electron 驱动真前端）：长输出中点「打断」按钮→turn 停→输入框发转向指令→拿到新响应。
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { pathToFileURL } = require('url');
const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8799;
const SB = path.join(os.homedir(), '.s6-e2e-sandbox');
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
      document.getElementById('newSessionPrompt').value='Write a very detailed 600-word essay about oceans. Write the full essay. Do NOT use any tools.';
      document.getElementById('newSessionSubmit').click();`);

    // 等流式输出跑起来
    let started = false;
    for (let i = 0; i < 40; i++) { await sleep(300); if ((await bodyTxt()).length > 120 || await exec("!!document.getElementById('mbLive')")) { started = true; break; } }
    ok('会话开始流式输出', started);

    // 打断按钮当前应可点（state=running → 未 disabled）
    const btnEnabled = await exec("!document.getElementById('sessionInterruptBtn').disabled");
    ok('打断按钮在 running 时可用', btnEnabled);
    const lenAtInterrupt = (await bodyTxt()).length;
    await exec("document.getElementById('sessionInterruptBtn').click()");

    // 等一会，输出应停止增长（截断）
    await sleep(4000);
    const lenAfter = (await bodyTxt()).length;
    // 若打断生效，不会跑到完整 600 字 essay（~3000+ 字符）
    ok('打断后 turn 截断（未跑完整 essay）', lenAfter < 2500, `打断时 ${lenAtInterrupt} → 4s 后 ${lenAfter} 字（完整应 >3000）`);

    // 转向：用输入框发新指令
    await exec(`document.getElementById('sessionInput').value='Stop. Reply with exactly one word: REDIRECTED. No tools.';
      document.getElementById('sessionSendBtn').click();`);
    let redirected = false;
    for (let i = 0; i < 40; i++) { await sleep(400); if (/REDIRECTED/.test(await bodyTxt())) { redirected = true; break; } }
    ok('输入框转向后拿到新响应（REDIRECTED 出现在会话流）', redirected, (await bodyTxt()).replace(/\s+/g, ' ').slice(-60));

    await exec("try{document.querySelector('.session-head .btn')&&0}catch(e){}; true");
  } catch (e) { ok('运行异常', false, (e.stack || e.message || '').split('\n').slice(0, 2).join(' | ')); }

  let pass = 0, fail = 0;
  console.log('\n=== S6 打断/转向 真浏览器 E2E ===');
  for (const [n, c, e] of results) { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}${e ? ' — ' + e : ''}`); }
  console.log(`\n=== ${pass}/${pass + fail} PASS ===`);
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
});
