// CLI 看板 rewind 迁 Mode B · 前端真浏览器 E2E（Electron 真 Chromium + 真 claude haiku）。
// 场景：终端起的 CLI 会话（两轮：暗号 BANANA42 / 口令 APPLE_Q→APPLE_A）退出后加入看板 →
//       详情观察态点第 2 轮 user 消息的「⑂ 改写重跑」→ customPrompt 改写成 GRAPE_Q →
//       后端截断 jsonl（丢弃 APPLE 轮）→ 收养成 Mode B live 会话 → 改写消息经 live 会话 stdin 重跑。
// 验证点（UI 全链路，专抓 mbSend 把 cli:* 误路由到已废弃 ps1 的坑）：
//   ① 观察态出现 rewind 按钮且历史含 APPLE_Q；② rewind 后进 live（mb.id）；
//   ③ live 视图出现改写消息 GRAPE_Q（乐观回显）+ 新回复 GRAPE_A（消息真经 live 会话处理，非 ps1）；
//   ④ live 视图 & 磁盘 jsonl 均不含被截断的 APPLE_Q。
// 用法（需真 claude 已登录 + 本机代理）：
//   http_proxy=http://127.0.0.1:10808 https_proxy=http://127.0.0.1:10808 \
//   node_modules/.bin/electron docs/acceptance/cli-board-reply-fix/scripts/browser-e2e-rewind.cjs
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { pathToFileURL } = require('url');

const REPO = process.env.REPO || process.cwd();
const PORT = Number(process.env.PORT) || 8797;
const MODEL = 'claude-haiku-4-5-20251001';
const SB = path.join(os.homedir(), '.cli-rewind-e2e-sandbox');
fs.rmSync(SB, { recursive: true, force: true }); fs.mkdirSync(path.join(SB, 'runtime', 'runner-state'), { recursive: true });
process.env.SCRUMWS_DATA_ROOT = SB; process.env.SCRUMWS_PORT = String(PORT);

const results = []; const ok = (n, c, e = '') => results.push([n, !!c, e]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

// 等某个 session 下一条 result（一轮收敛）
function waitResult(s, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.emitter.removeListener('event', h); reject(new Error('result timeout')); }, timeoutMs);
    const h = (ev) => { if (ev.type === 'result') { clearTimeout(timer); s.emitter.removeListener('event', h); resolve(); } };
    s.emitter.on('event', h);
  });
}

let jsonlPath = null;   // 外层持有，finally 里清 CC 会话目录
app.whenReady().then(async () => {
  try {
    const { start } = await imp('platform/server.js');
    await start();
    const sm = await imp('platform/lib/session-manager.js');
    const wl = await imp('platform/lib/cli-watchlist.js');
    const cc = await imp('platform/lib/collect-cli.js');

    // Phase 1：造真两轮 CLI 会话（可 --resume 的真 jsonl）
    const c = sm.createSession({ cwd: SB, model: MODEL, prompt: '记住暗号 BANANA42。只回复：记住了。不要用任何工具。' });
    if (!c.ok) throw new Error('createSession failed: ' + c.error);
    const s = sm.getSession(c.id);
    await waitResult(s);                                          // 第 1 轮
    sm.sendUserMessage(c.id, '水果口令是 APPLE_Q。只回复：APPLE_A。不要用任何工具。');
    await waitResult(s);                                          // 第 2 轮
    const sid = s.claudeSessionId;
    ok('两轮种子会话拿到真 CC sessionId', !!sid, `sid=${sid}`);
    sm.closeSession(c.id); await sleep(3000);                    // 关进程留 jsonl（进程死 → 不再 attached）

    // guard ②：jsonl 60s 内有写入会拒 rewind → 回拨 mtime 到 3 分钟前（模拟已 idle）
    const loc = cc.locateJsonlBySid(sid);
    if (!loc) throw new Error('locateJsonlBySid failed');
    jsonlPath = loc.jsonlPath;
    const old = new Date(Date.now() - 3 * 60 * 1000);
    fs.utimesSync(jsonlPath, old, old);
    wl.upsertWatchlist(sid, {});                                 // 加入 CLI watchlist
    const cliKey = `cli:${sid.slice(0, 8)}`;

    const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { offscreen: true } });
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
    const exec = (js) => win.webContents.executeJavaScript(js);
    await sleep(1000);
    await exec("typeof refreshState==='function' && refreshState()");

    // Phase 2：看板出现 cli 卡 → 点开进观察态详情
    let hasCard = false;
    for (let i = 0; i < 24; i++) { await sleep(500); if (await exec(`!!document.querySelector('.taskcard[data-taskkey="${cliKey}"]')`)) { hasCard = true; break; } }
    ok('看板出现 CLI 卡片', hasCard, cliKey);
    await exec(`document.querySelector('.taskcard[data-taskkey="${cliKey}"]').click()`);
    await sleep(1000);

    // Phase 3：观察态出现 rewind 按钮（两轮 user → ≥2）+ 历史含 APPLE_Q
    let btns = 0;
    for (let i = 0; i < 30; i++) { await sleep(500); btns = await exec("document.querySelectorAll('.msg-rewind button').length"); if (btns >= 2) break; }
    ok('观察态出现 rewind 按钮（≥2）', btns >= 2, `count=${btns}`);
    const hist0 = await exec("(document.getElementById('modalBody')||{}).textContent||''");
    ok('rewind 前历史含 APPLE_Q', /APPLE_Q/.test(hist0), hist0.slice(0, 120));

    // Phase 4：点最后一个 rewind 按钮（第 2 轮 APPLE_Q）→ customPrompt 改写成 GRAPE_Q
    await exec("(function(){const b=document.querySelectorAll('.msg-rewind button');b[b.length-1].click();return true;})()");
    let cpOpen = false;
    for (let i = 0; i < 12; i++) { await sleep(300); cpOpen = await exec("!!document.getElementById('confirmPromptInput') && document.getElementById('confirmModal').style.display==='flex'"); if (cpOpen) break; }
    ok('rewind 编辑框弹出', cpOpen);
    await exec("document.getElementById('confirmPromptInput').value='颜色口令是 GRAPE_Q。只回复：GRAPE_A。不要用任何工具。';true;");
    await exec("document.getElementById('confirmOk').click()");

    // Phase 5：进 live（mb.id）→ 改写消息经 live 会话 stdin 重跑（专测 mbSend 不再走 ps1）
    let live = false;
    for (let i = 0; i < 40; i++) { await sleep(500); live = await exec("typeof mb!=='undefined' && mb && !!mb.id"); if (live) break; }
    ok('rewind 后进入 live 模式（mb.id）', live, await exec("location.hash"));

    let body = '';
    let sawReply = false;
    for (let i = 0; i < 100; i++) { await sleep(500); body = await exec("(document.getElementById('modalBody')||{}).textContent||''"); if (/GRAPE_A/.test(body)) { sawReply = true; break; } }
    ok('live 出现改写后新回复 GRAPE_A（消息真经 live 会话处理，非 ps1）', sawReply, body.slice(-180));
    ok('live 含改写消息 GRAPE_Q（乐观回显可见）', /GRAPE_Q/.test(body));
    ok('APPLE 轮已截断（live 不含 APPLE_Q）', !/APPLE_Q/.test(body), body.slice(0, 160));

    // Phase 6：磁盘 jsonl 落盘校验（claude --resume 在一轮 result 时才 flush，晚于流式 token → 轮询等落盘）
    let diskOk = false; let users = [];
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      let lines;
      try { lines = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { continue; }
      users = lines.filter((o) => o.type === 'user' && !o.isMeta).map((o) => {
        const cnt = o.message && o.message.content;
        return (Array.isArray(cnt) ? cnt.map((x) => (x && x.text) || '').join(' ') : (typeof cnt === 'string' ? cnt : '')).trim();
      }).filter((u) => u && !u.startsWith('<'));
      if (users.some((u) => /GRAPE_Q/.test(u)) && !users.some((u) => /APPLE_Q/.test(u))) { diskOk = true; break; }
    }
    ok('磁盘 jsonl：user 轮含 GRAPE_Q 且不含 APPLE_Q', diskOk, JSON.stringify(users));

  } catch (e) {
    ok('运行异常', false, e && e.message);
  } finally {
    const pass = results.filter((r) => r[1]).length;
    console.log(`\n==== CLI rewind 迁 Mode B · UI E2E：${pass}/${results.length} PASS ====`);
    for (const [n, c, e] of results) console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  — ' + e : ''}`);
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { }
    try { if (jsonlPath) fs.rmSync(path.dirname(jsonlPath), { recursive: true, force: true }); } catch { }   // 清 CC 会话目录
    app.exit(pass === results.length ? 0 : 1);
  }
});
