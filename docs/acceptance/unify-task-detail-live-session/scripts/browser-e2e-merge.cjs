// 详情页归一（Mode B live 折进 #/task/）· 前端真浏览器 E2E（Electron 真 Chromium 驱动真 index.html+app.js）。
// 覆盖：view-session 已删 / 打断按钮就位 / 未知会话链接重定向 / 新建任务落 #/task/(不跳 #/session/) /
//       逐字 #mbLive 进 #modalBody / assistant 文本 / 侧栏 taskSide populated / composer 续轮插话 /
//       打断按钮 live 可见 / 旧 #/session/<活会话id> 重定向回 #/task/ / 看板点卡片走 #/task/。
// 用法（需真 claude 已登录）：node_modules/.bin/electron docs/acceptance/unify-task-detail-live-session/scripts/browser-e2e-merge.cjs
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { pathToFileURL } = require('url');

const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8797;
const SB = path.join(os.homedir(), '.merge-detail-e2e-sandbox');
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

    // 逐字观察器：现在观察 #modalBody（live 折进任务详情）
    await exec(`window.__liveSeq=[];var mbBody=document.getElementById('modalBody');
      window.__mo=new MutationObserver(function(){var el=document.getElementById('mbLive');if(el){var L=el.textContent.length;var s=window.__liveSeq;if(!s.length||s[s.length-1]!==L)s.push(L);}});
      window.__mo.observe(mbBody,{childList:true,subtree:true,characterData:true});true;`);

    // ① 结构：独立会话视图已删 + 打断按钮就位
    ok('view-session 已删（getElementById 为 null）', await exec("!document.getElementById('view-session')"));
    ok('详情 composer 打断按钮 #modalReplyInterrupt 存在', await exec("!!document.getElementById('modalReplyInterrupt')"));

    // ② 未知 #/session/<x> → 重定向到 #/board（找不到归属任务）
    await exec("location.hash='#/session/nonexistent-xyz'"); await sleep(400);
    ok('未知会话链接重定向到 #/board', await exec("location.hash==='#/board'"));

    // ③ 新建任务（uncheck 先计划 → queued 自动执行）
    await exec("document.getElementById('newTaskBtn').click()"); await sleep(300);
    await exec(`document.getElementById('newTaskTitle').value='merge detail e2e';
      document.getElementById('newTaskPrompt').value='先用一句话（约40字）描述大海，最后另起一行只写一个词：mango。不要使用任何工具。';
      document.getElementById('newTaskModel').value='claude-haiku-4-5-20251001';
      document.getElementById('newTaskCwd').value=${JSON.stringify(SB)};
      document.getElementById('newTaskPlanFirst').checked=false;true;`);
    await exec("document.getElementById('newTaskSubmit').click()");

    // ④ 自动起会话 → 路由到 #/task/<key>（不是 #/session/）
    let routedTask = false;
    for (let i = 0; i < 24; i++) { await sleep(300); if (await exec("location.hash.indexOf('#/task/')===0")) { routedTask = true; break; } }
    ok('提交后路由到任务详情 #/task/<key>', routedTask);
    ok('未跳独立会话面 #/session/', await exec("location.hash.indexOf('#/session/')!==0"));
    ok('view-task 可见', await exec("getComputedStyle(document.getElementById('view-task')).display!=='none'"));

    // ⑤ 逐字增长 + assistant 文本收敛（渲染进 #modalBody）
    let sawText = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const txt = await exec("(document.getElementById('modalBody')||{}).textContent||''");
      if (/mango/i.test(txt)) { sawText = true; break; }
    }
    const liveSeq = await exec("JSON.stringify(window.__liveSeq)");
    ok('逐字 #mbLive 流式增长（进 #modalBody）', JSON.parse(liveSeq).length >= 2, `seq=${liveSeq}`);
    ok('assistant 文本(mango) 已渲染进 #modalBody', sawText);

    // ⑥ 右侧任务信息块 populated（live 模式侧栏含 taskKey manual:）
    const sideTxt = await exec("(document.getElementById('taskSide')||{}).textContent||''");
    ok('右侧 taskSide 含任务信息(manual:)', /manual:/.test(sideTxt), sideTxt.slice(0, 100));

    // ⑦ composer 就位 + 续一轮插话（走 /api/task/reply → 渲染 mango2）
    ok('composer #modalReplyText 存在', await exec("!!document.getElementById('modalReplyText')"));
    ok('打断按钮 live 模式可见', await exec("getComputedStyle(document.getElementById('modalReplyInterrupt')).display!=='none'"));
    await exec(`document.getElementById('modalReplyText').value='再回复一个词：mango2。不要用工具。';true;`);
    await exec("document.getElementById('modalReplySend').click()");
    let sawText2 = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const txt = await exec("(document.getElementById('modalBody')||{}).textContent||''");
      if (/mango2/i.test(txt)) { sawText2 = true; break; }
    }
    ok('composer 续一轮 assistant(mango2) 已渲染', sawText2);

    // ⑧ 旧 #/session/<活会话id> → 重定向回该任务 #/task/<key>
    const curTaskHash = await exec("location.hash");
    const sid = await exec("(typeof mb!=='undefined' && mb && mb.id) || ''");
    ok('拿到当前活会话 id', !!sid, `sid=${sid}`);
    if (sid) {
      await exec(`location.hash='#/session/'+encodeURIComponent(${JSON.stringify(sid)})`); await sleep(500);
      ok('旧会话链接重定向回 #/task/<key>', await exec(`location.hash===${JSON.stringify(curTaskHash)}`), await exec("location.hash"));
    } else { ok('旧会话链接重定向回 #/task/<key>', false, 'no sid'); }

    // ⑨ 返回看板点卡片 → openTaskModal 走 #/task/（不 #/session/）
    await exec("location.hash='#/board'");
    let clicked = false;
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const has = await exec("!!document.querySelector('.taskcard[data-taskkey^=\"manual:\"]')");
      if (has) { await exec("document.querySelector('.taskcard[data-taskkey^=\"manual:\"]').click()"); clicked = true; break; }
    }
    await sleep(500);
    ok('看板点卡片进 #/task/（openTaskModal 归一）', clicked && await exec("location.hash.indexOf('#/task/')===0"));

  } catch (e) {
    ok('运行异常', false, e && e.message);
  } finally {
    const pass = results.filter((r) => r[1]).length;
    console.log(`\n==== 详情归一 E2E：${pass}/${results.length} PASS ====`);
    for (const [n, c, e] of results) console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  — ' + e : ''}`);
    app.exit(pass === results.length ? 0 : 1);
  }
});
