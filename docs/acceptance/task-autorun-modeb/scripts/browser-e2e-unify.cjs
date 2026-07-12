// 交互会话统一为任务 · 前端真浏览器 E2E（Electron/真 Chromium 驱动真实 index.html+app.js）。
// 覆盖：单入口（无「交互会话」按钮）→ 新建任务(uncheck 先计划)→自动起会话→路由 #/session/<id>→
//       逐字 #mbLive 增长→assistant 文本→会话头含「任务」面包屑+「← 看板」→composer 续一轮→返回看板见卡片。
// 用法（需真 claude 已登录）：node_modules/.bin/electron docs/acceptance/task-autorun-modeb/scripts/browser-e2e-unify.cjs
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { pathToFileURL } = require('url');

const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8796;
const SB = path.join(os.homedir(), '.unify-e2e-sandbox');
fs.rmSync(SB, { recursive: true, force: true }); fs.mkdirSync(path.join(SB, 'runtime', 'runner-state'), { recursive: true });
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

    // 逐字观察器
    await exec(`window.__liveSeq=[];var sb=document.getElementById('sessionBody');
      window.__mo=new MutationObserver(function(){var el=document.getElementById('mbLive');if(el){var L=el.textContent.length;var s=window.__liveSeq;if(!s.length||s[s.length-1]!==L)s.push(L);}});
      window.__mo.observe(sb,{childList:true,subtree:true,characterData:true});true;`);

    // ① 单入口：无「交互会话」按钮，有「新建任务」
    ok('无独立交互会话入口(newSessionBtn 已删)', await exec("!document.getElementById('newSessionBtn')"));
    ok('新建任务入口存在', await exec("!!document.getElementById('newTaskBtn')"));

    // ② 新建任务(uncheck 先计划 → 直接 queued 自动执行)
    await exec("document.getElementById('newTaskBtn').click()"); await sleep(300);
    ok('新建任务 modal 打开', await exec("getComputedStyle(document.getElementById('newTaskModal')).display!=='none'"));
    await exec(`document.getElementById('newTaskTitle').value='unify e2e';
      document.getElementById('newTaskPrompt').value='先用一句话（约40字）描述大海，最后另起一行只写一个词：mango。不要使用任何工具。';
      document.getElementById('newTaskModel').value='claude-haiku-4-5-20251001';
      document.getElementById('newTaskCwd').value=${JSON.stringify(SB)};
      document.getElementById('newTaskPlanFirst').checked=false;true;`);
    await exec("document.getElementById('newTaskSubmit').click()");

    // ③ 自动起会话 → 路由到 #/session/<id>
    let routed = false;
    for (let i = 0; i < 20; i++) { await sleep(300); if (await exec("location.hash.indexOf('#/session/')===0")) { routed = true; break; } }
    ok('提交后路由到实时会话面 #/session/<id>', routed);
    ok('view-session 可见', await exec("getComputedStyle(document.getElementById('view-session')).display!=='none'"));

    // ④ 逐字增长 + assistant 文本收敛
    let sawText = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const txt = await exec("(document.getElementById('sessionBody')||{}).textContent||''");
      if (/mango/i.test(txt)) { sawText = true; break; }
    }
    const liveSeq = await exec("JSON.stringify(window.__liveSeq)");
    ok('逐字 #mbLive 流式增长', JSON.parse(liveSeq).length >= 2, `seq=${liveSeq}`);
    ok('assistant 文本(mango)已渲染', sawText);

    // ⑤ 会话头：任务面包屑 + 返回看板
    const headTxt = await exec("(document.getElementById('sessionHead')||{}).textContent||''");
    ok('会话头含「任务」面包屑', /任务/.test(headTxt) && /manual:/.test(headTxt), headTxt.slice(0, 120));
    ok('会话头含「← 看板」返回', /←\s*看板/.test(headTxt));

    // ⑥ composer 续一轮（走 /api/task/reply）
    await exec(`document.getElementById('sessionInput').value='再回复一个词：mango2。不要用工具。';true;`);
    await exec("document.getElementById('sessionSendBtn').click()");
    let sawText2 = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const txt = await exec("(document.getElementById('sessionBody')||{}).textContent||''");
      if (/mango2/i.test(txt)) { sawText2 = true; break; }
    }
    ok('composer 续一轮 assistant(mango2) 已渲染', sawText2);

    // ⑦ 返回看板 → 任务卡在（awaiting-human 分区）；轮询等自动刷新重画
    await exec("location.hash='#/board'");
    let hasCard = false;
    for (let i = 0; i < 24; i++) { await sleep(500); if (await exec("!!document.querySelector('.taskcard[data-taskkey^=\"manual:\"]')")) { hasCard = true; break; } }
    ok('返回看板可见该任务卡', hasCard);

  } catch (e) {
    ok('运行异常', false, e && e.message);
  } finally {
    const pass = results.filter((r) => r[1]).length;
    console.log(`\n==== 交互统一 E2E：${pass}/${results.length} PASS ====`);
    for (const [n, c, e] of results) console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  — ' + e : ''}`);
    app.exit(pass === results.length ? 0 : 1);
  }
});
