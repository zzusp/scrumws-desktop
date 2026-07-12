// Mode B 前端真浏览器 E2E（Electron/真 Chromium 驱动真实 index.html+app.js）。
// 覆盖：入口→新建会话 modal→路由 view-session→会话视图渲染工具→权限卡出现→点「允许」→工具执行→卡片移除；
//       并用 MutationObserver 定论逐字 #mbLive 流式增长。
// 用法（需真 claude 已登录）：node_modules/.bin/electron docs/acceptance/board-interactive-session/scripts/browser-e2e-modeb.cjs
// 环境：REPO 默认 process.cwd()；端口 8797；haiku（省 quota）。
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { pathToFileURL } = require('url');

const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8797;
const SB = path.join(os.homedir(), '.modeb-e2e-sandbox');
fs.rmSync(SB, { recursive: true, force: true }); fs.mkdirSync(path.join(SB, 'runtime'), { recursive: true });
process.env.SCRUMWS_DATA_ROOT = SB; process.env.SCRUMWS_PORT = String(PORT);

const results = []; const ok = (n, c, e = '') => results.push([n, !!c, e]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const { start } = await import(pathToFileURL(path.join(REPO, 'platform/server.js')).href);
    await start();
    const win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { offscreen: true } });
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
    const exec = (js) => win.webContents.executeJavaScript(js);
    await sleep(1000);

    // 装逐字观察器
    await exec(`window.__liveSeq=[];var sb=document.getElementById('sessionBody');
      window.__mo=new MutationObserver(function(){var el=document.getElementById('mbLive');if(el){var L=el.textContent.length;var s=window.__liveSeq;if(!s.length||s[s.length-1]!==L)s.push(L);}});
      window.__mo.observe(sb,{childList:true,subtree:true,characterData:true});true;`);

    ok('入口按钮存在', await exec("!!document.getElementById('newSessionBtn')"));
    const target = path.join(os.tmpdir(), `modeb-e2e-${Date.now()}.txt`);
    fs.rmSync(target, { force: true });
    const targetJs = target.replace(/\\/g, '\\\\');
    await exec("document.getElementById('newSessionBtn').click()"); await sleep(300);
    ok('新建会话 modal 打开', await exec("getComputedStyle(document.getElementById('newSessionModal')).display!=='none'"));
    await exec(`document.getElementById('newSessionModel').value='claude-haiku-4-5-20251001';
      document.getElementById('newSessionPrompt').value='First write one short sentence about the sea, then use the Write tool to create the file ${targetJs} with the exact content: hi';
      document.getElementById('newSessionSubmit').click();`);

    let permSeen = false, sawView = false, sawWrite = false;
    for (let i = 0; i < 44; i++) {
      await sleep(500);
      const st = await exec(`(function(){var b=document.getElementById('sessionBody');var t=b?b.textContent:'';
        return {hash:location.hash,shown:getComputedStyle(document.getElementById('view-session')).display!=='none',perm:!!document.querySelector('.perm-card'),write:/Write/.test(t)};})()`);
      if (st.hash.indexOf('#/session/') === 0 && st.shown) sawView = true;
      if (st.write) sawWrite = true;
      if (st.perm) { permSeen = true; break; }
    }
    ok('路由进入 view-session', sawView);
    ok('会话视图渲染 Write 工具', sawWrite);
    ok('权限卡在 DOM 出现', permSeen);
    if (permSeen) {
      ok('权限卡含工具名 Write', /Write/.test(await exec("document.querySelector('.perm-card').textContent")));
      await exec("document.querySelector('.perm-card .btn-primary').click()");
      let created = false; for (let i = 0; i < 24; i++) { await sleep(500); if (fs.existsSync(target)) { created = true; break; } }
      ok('点「允许」后工具执行(文件建 hi)', created && fs.readFileSync(target, 'utf8').trim() === 'hi', created ? 'hi' : '未创建');
      await sleep(600);
      ok('允许后权限卡移除', !(await exec("!!document.querySelector('.perm-card')")));
    }
    const seq = await exec("window.__liveSeq");
    ok('逐字 #mbLive 流式增长', seq.length >= 2 && Math.max(0, ...seq) > 5, `序列=${JSON.stringify(seq.slice(0, 12))}`);
    try { fs.rmSync(target, { force: true }); } catch {}
  } catch (e) { ok('运行异常', false, (e.stack || e.message || '').split('\n').slice(0, 2).join(' | ')); }

  let pass = 0, fail = 0;
  console.log('\n=== Mode B 真浏览器 E2E ===');
  for (const [n, c, e] of results) { c ? pass++ : fail++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}${e ? ' — ' + e : ''}`); }
  console.log(`\n=== ${pass}/${pass + fail} PASS ===`);
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
});
