// S7 真浏览器 E2E：Mode B 每步计时（工具 duration 徽章 / 进行中跳秒）+ 实时 token 读数（生成中估算→末尾真值）。
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { pathToFileURL } = require('url');
const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8801;
const SB = path.join(os.homedir(), '.s7-e2e-sandbox');
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
    await sleep(1000);
    // 观察 #mbLiveTokens 文本序列（含转瞬"生成中"）
    await exec(`window.__tok=[];window.__mo=new MutationObserver(function(){var el=document.getElementById('mbLiveTokens');if(el){var t=el.textContent;var s=window.__tok;if(t&&(!s.length||s[s.length-1]!==t))s.push(t);}});
      window.__mo.observe(document.getElementById('sessionHead'),{childList:true,subtree:true,characterData:true});true;`);

    const target = path.join(os.tmpdir(), `s7-${Date.now()}.txt`);
    fs.rmSync(target, { force: true }); const tJs = target.replace(/\\/g, '\\\\');
    await exec("document.getElementById('newSessionBtn').click()"); await sleep(200);
    await exec(`document.getElementById('newSessionModel').value='claude-haiku-4-5-20251001';
      document.getElementById('newSessionPrompt').value='First write one sentence about the sea, then use the Write tool to create the file ${tJs} with content: hi';
      document.getElementById('newSessionSubmit').click();`);

    // 等权限卡 + 抓进行中的 token 读数 & 进行中工具跳秒
    let permSeen = false, sawLiveTick = false, genToken = null;
    for (let i = 0; i < 44; i++) {
      await sleep(400);
      const st = await exec(`(function(){return{
        perm:!!document.querySelector('.perm-card'),
        liveTick:!!document.querySelector('#sessionBody .cc-live-timer[data-since]'),
        tok:(document.getElementById('mbLiveTokens')||{}).textContent||''
      };})()`);
      if (st.liveTick) sawLiveTick = true;
      if (/生成中/.test(st.tok)) genToken = st.tok;
      if (st.perm) { permSeen = true; break; }
    }
    ok('P2 实时 token 读数(生成中: ↑真值 + ↓~估算)', !!genToken && /↑/.test(genToken) && /生成中/.test(genToken), genToken || '(未捕获生成中)');
    ok('P1 进行中工具 live 跳秒(Mode B)', sawLiveTick);
    ok('权限卡出现', permSeen);
    if (permSeen) {
      await exec("document.querySelector('.perm-card .btn-primary').click()");
      let created = false; for (let i = 0; i < 24; i++) { await sleep(500); if (fs.existsSync(target)) { created = true; break; } }
      ok('允许后工具执行', created);
    }
    await sleep(2500);   // 等 result + message_delta
    const finalTok = await exec("(document.getElementById('mbLiveTokens')||{}).textContent||''");
    ok('P2 末尾 token 读数为真值(无 ~、有 ↓)', /↓/.test(finalTok) && !/~/.test(finalTok) && !/生成中/.test(finalTok), finalTok);
    const stepDur = await exec("(function(){var e=document.querySelector('#sessionBody .cc-step-dur:not(.cc-live-timer)');return e?e.textContent:null;})()");
    ok('P1 完成工具每步耗时徽章渲染', stepDur !== null, stepDur);
    const footerTok = await exec("(function(){var b=document.getElementById('sessionBody');return b&&/↑[\\s\\d,]+\\/ ↓/.test(b.textContent);})()");
    ok('P2 每轮 token footer 显示真值(贴回 message_delta usage)', footerTok);
    const seq = await exec("window.__tok");
    console.log('  token 读数序列:', JSON.stringify(seq));
    fs.rmSync(target, { force: true });
  } catch (e) { ok('运行异常', false, (e.stack || e.message || '').split('\n').slice(0, 2).join(' | ')); }
  let pass = 0, fail = 0;
  console.log('\n=== S7 Mode B 每步计时 + 实时 token E2E ===');
  for (const [n, c, e] of results) { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}${e ? ' — ' + e : ''}`); }
  console.log(`\n=== ${pass}/${pass + fail} PASS ===`);
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
});
