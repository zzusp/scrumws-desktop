// CLI 收养归一 · 前端真浏览器 E2E（Electron 真 Chromium + 真 claude haiku）。
// 场景：终端起的 CLI 会话退出后加入看板 → 详情里发消息「续接」→ 收养成 Mode B live 会话，
//       归一后**留在 #/task/<cliTaskKey>**（不跳 #/session/），且 --resume 续上上下文。
// 造真会话：主进程用 session-manager 起一个种子会话记住暗号 BANANA42 → 关掉（留真 jsonl 可 --resume）
//           → 加进 CLI watchlist → 浏览器走收养流程。
// 用法（需真 claude 已登录）：node_modules/.bin/electron docs/acceptance/unify-task-detail-live-session/scripts/browser-e2e-cli-adopt.cjs
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { pathToFileURL } = require('url');

const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8798;
const MODEL = 'claude-haiku-4-5-20251001';
const SB = path.join(os.homedir(), '.cli-adopt-e2e-sandbox');
fs.rmSync(SB, { recursive: true, force: true }); fs.mkdirSync(path.join(SB, 'runtime', 'runner-state'), { recursive: true });
process.env.SCRUMWS_DATA_ROOT = SB; process.env.SCRUMWS_PORT = String(PORT);

const results = []; const ok = (n, c, e = '') => results.push([n, !!c, e]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

// 起种子会话记住暗号，等 result 收敛，拿真 CC sessionId，关掉留 jsonl
function seedSession(createSession, getSession) {
  return new Promise((resolve, reject) => {
    const r = createSession({ cwd: SB, model: MODEL, prompt: '记住这个暗号：BANANA42。只回复"记住了"。不要用任何工具。' });
    if (!r.ok) return reject(new Error('createSession failed: ' + r.error));
    const s = getSession(r.id);
    const timer = setTimeout(() => reject(new Error('seed result timeout')), 90000);
    s.emitter.on('event', (ev) => { if (ev.type === 'result') { clearTimeout(timer); resolve({ id: r.id, sid: s.claudeSessionId }); } });
  });
}

app.whenReady().then(async () => {
  try {
    const { start } = await imp('platform/server.js');
    await start();
    // 主进程与 server 共享同一 session-manager 实例（ESM 单例）
    const sm = await imp('platform/lib/session-manager.js');
    const wl = await imp('platform/lib/cli-watchlist.js');

    // Phase 1：造真可 --resume 的种子会话
    const seed = await seedSession(sm.createSession, sm.getSession);
    ok('种子会话拿到真 CC sessionId', !!seed.sid, `sid=${seed.sid}`);
    sm.closeSession(seed.id); await sleep(2000);   // 关进程留 jsonl
    wl.upsertWatchlist(seed.sid, {});              // 加入 CLI watchlist → 看板出 cli:<short> 卡
    const shortSid = seed.sid.slice(0, 8);
    const cliKey = `cli:${shortSid}`;

    const win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { offscreen: true } });
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
    const exec = (js) => win.webContents.executeJavaScript(js);
    await sleep(1000);
    await exec("typeof refreshState==='function' && refreshState()");

    // Phase 2：看板出现 cli 卡 → 点开进 #/task/<cliKey>（observe 模式，未 live）
    let hasCard = false;
    for (let i = 0; i < 24; i++) { await sleep(500); if (await exec(`!!document.querySelector('.taskcard[data-taskkey="${cliKey}"]')`)) { hasCard = true; break; } }
    ok('看板出现 CLI 卡片 cli:<short>', hasCard, cliKey);
    await exec(`(document.querySelector('.taskcard[data-taskkey="${cliKey}"]')||{}).click&&document.querySelector('.taskcard[data-taskkey="${cliKey}"]').click()`);
    await sleep(800);
    ok('点开 CLI 卡进 #/task/<cliKey>', await exec(`location.hash.indexOf('#/task/')===0`), await exec("location.hash"));
    ok('尚未进 live 模式（mb 为空）', await exec("typeof mb==='undefined' || !mb"));
    const stTxt0 = await exec("(document.getElementById('modalReplyState')||{}).textContent||''");
    ok('observe 模式 composer = CLI 可续接对话', /CLI/.test(stTxt0) && /续接/.test(stTxt0), stTxt0);
    const hist0 = await exec("(document.getElementById('modalBody')||{}).textContent||''");
    ok('只读历史含种子对话(BANANA42/记住了)', /BANANA42/.test(hist0) || /记住了/.test(hist0), hist0.slice(0, 80));

    // Phase 3：composer 发消息「续接」→ 收养 → 归一后仍在 #/task/（不跳 #/session/）
    await exec(`document.getElementById('modalReplyText').value='暗号是什么？只回复暗号本身，不要用任何工具。';true;`);
    await exec("document.getElementById('modalReplySend').click()");
    // 收养 + refreshState + 进 live 需要点时间
    let live = false;
    for (let i = 0; i < 30; i++) { await sleep(500); if (await exec("typeof mb!=='undefined' && mb && !!mb.id")) { live = true; break; } }
    ok('发消息后进入 live 模式（mb.id 有值）', live);
    ok('收养后仍在 #/task/<cliKey>（未跳 #/session/）', await exec(`location.hash.indexOf('#/task/')===0 && location.hash.indexOf('#/session/')!==0`), await exec("location.hash"));
    ok('view-session 视图不存在', await exec("!document.getElementById('view-session')"));

    // Phase 4：--resume 上下文续上 → BANANA42 出现 ≥2 次（历史种子 1 次 + 收养回答复述 1 次）。
    // 只匹配"出现"不够：历史回放本就含 1 次；只有回答里再复述才证明 --resume 把上下文续上了。
    let secretCount = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      secretCount = await exec("((document.getElementById('modalBody')||{}).textContent||'').split('BANANA42').length-1");
      if (secretCount >= 2) break;
    }
    ok('收养会话 --resume 续上上下文（BANANA42 复现 ≥2 次）', secretCount >= 2, `count=${secretCount}`);

  } catch (e) {
    ok('运行异常', false, e && e.message);
  } finally {
    const pass = results.filter((r) => r[1]).length;
    console.log(`\n==== CLI 收养归一 E2E：${pass}/${results.length} PASS ====`);
    for (const [n, c, e] of results) console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  — ' + e : ''}`);
    app.exit(pass === results.length ? 0 : 1);
  }
});
