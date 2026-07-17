// 机器纳管管理页 e2e —— **真实浏览器 + 真实云端 8790 + 真实桌面看板 8797**。
// 剧本：登录 → 管理页 → 生成 rk → 生成配对码 → 拼 join token → 复制 →
//       粘到桌面端设置页 → 点连接 → enroll 成功 → 回云端看机器 online →
//       负例：刷新后再拼 → 必须明确拒绝。
//
// puppeteer-core 装在 scratchpad（仓库外），用系统 Edge/Chrome —— 不给仓库任何 package.json 加依赖。
// 用法：node e2e-enroll-ui.mjs <cloudUrl> <boardUrl> <swukFile> <outDir> <puppeteerPath>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [, , CLOUD, BOARD, SWUK_FILE, OUT, PUP] = process.argv;
if (!CLOUD || !BOARD || !SWUK_FILE || !OUT || !PUP) {
  throw new Error('用法：node e2e-enroll-ui.mjs <cloudUrl> <boardUrl> <swukFile> <outDir> <puppeteerPath>');
}
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!exe) throw new Error('找不到系统 Edge/Chrome');

const req = createRequire(pathToFileURL(path.join(PUP, 'anchor.cjs')).href);
const puppeteer = (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;
fs.mkdirSync(OUT, { recursive: true });
const swuk = fs.readFileSync(SWUK_FILE, 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 迷你断言器：每条都记 PASS/FAIL，最后统一汇报（跑不通如实标 FAIL，不 silently skip）----
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '\n           ' + detail : ''}`);
  return ok;
}

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1500, height: 1000 },
});
// ⚠ **刻意不调 overridePermissions** —— 实测它是反的：
//   · 不调           → permissions.query(clipboard-write) = granted，writeText 成功（= 真实用户档：
//                      安全上下文 + 用户手势下浏览器本就自动放行写剪贴板）
//   · 调 ['clipboard-read','clipboard-write'] → 反而 denied，writeText 抛 NotAllowedError
//   第一版 e2e 就是被这个坑出了「复制失败」的**假 FAIL**（详见 round-2.md §2 假 FAIL 复盘）。
// 读回剪贴板（readText）需要 clipboard-read，真实浏览器里是 prompt 档、自动化点不了 → 本脚本不读回，
// 只断言 toast（writeText 兑现即 resolve）。「剪贴板里逐字就是那串」由**有头**跑的 OS 级证据补上：
// scratchpad clip-os.mjs 用 PowerShell Get-Clipboard 读到 153 字节 = join token 逐字相同（round-2.md §3⑤）。

const shot = async (page, name, note) => {
  const f = path.join(OUT, name);
  await page.screenshot({ path: f, fullPage: true });
  console.log(`  📷 ${name}  ${fs.statSync(f).size} bytes — ${note}`);
};

let joinToken = null;
let rkPrefix = null;

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  const nonOk = [];   // 按 URL 记非 2xx —— 「404」这种光看控制台文本分不清是 favicon 还是 ui.js 没加载
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) nonOk.push(`${r.status()} ${r.url()}`); });

  // 原生组件运行时探针：静态 grep 看不见 innerHTML 里拼出来的东西，运行时才是定论。
  // 必须在任何页面脚本执行前装（evaluateOnNewDocument），否则漏掉早期调用。
  await page.evaluateOnNewDocument(() => {
    window.__native = [];
    for (const k of ['alert', 'confirm', 'prompt']) {
      window[k] = (...a) => { window.__native.push(k + '(' + String(a[0]).slice(0, 40) + ')'); return true; };
    }
  });

  console.log('\n=== ① 登录 ===');
  const resp = await page.goto(CLOUD + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  check('GET / 由真实 server.js 托管', resp.status() === 200, `HTTP ${resp.status()} ${resp.headers()['content-type']}`);
  await page.waitForSelector('#loginView', { visible: true, timeout: 10000 });
  await page.type('#loginKey', swuk);
  await page.click('#loginBtn');
  await page.waitForSelector('#shell', { visible: true, timeout: 15000 });
  check('swuk_ 登录进入 shell', true);

  console.log('\n=== ② 进管理页 · 生成注册密钥（明文只此一次）===');
  await page.evaluate(() => { location.hash = '#/enroll'; });
  await sleep(900);
  await page.waitForSelector('#wizRk', { visible: true, timeout: 8000 });
  check('侧边栏有「机器纳管」入口且路由可达', await page.$eval('a[data-nav="enroll"]', (a) => !!a));

  await page.type('#rkLabel', 'P1 UI 验收');
  await page.click('#rkGenBtn');
  await page.waitForSelector('#rkVal', { visible: true, timeout: 10000 });
  const rkShown = await page.$eval('#rkVal', (e) => e.textContent.trim());
  rkPrefix = rkShown.slice(0, 9);
  check('rk 明文当场展示', rkShown.startsWith('swrk_') && rkShown.length === 48, `长度=${rkShown.length} 前缀=${rkPrefix}`);
  check('展示「明文只此一次」的复制引导', await page.$eval('#wizRk .once', (e) => /只在这一次|永久拿不回来/.test(e.textContent)));
  // 列表是 loadRegKeys() 另发一次 fetch 填的 —— 必须**等它回来**再断言。
  // 第一版没等，断出个假 FAIL（实测 1.5s 后行数 1→2、命中 false→true，实现本来就对）。
  const listed = await page.waitForFunction(
    (p) => [...document.querySelectorAll('#rkList tr')].some((r) => r.textContent.includes(p)),
    { timeout: 6000 }, rkPrefix,
  ).then(() => true).catch(() => false);
  check('新生成的 rk 出现在下方列表', listed, `prefix=${rkPrefix}`);

  console.log('\n=== ③ 生成配对码 ===');
  await page.click('#codeGenBtn');
  await page.waitForSelector('.code-big', { visible: true, timeout: 10000 });
  const code = await page.$eval('.code-big', (e) => e.textContent.trim());
  check('配对码 8 位', /^[A-Z0-9]{8}$/.test(code), `code=${code}`);
  const ttl = await page.$eval('#codeTtl', (e) => e.textContent.trim());
  // \d{1,2}：TTL 是 10 分钟，一开始就是 "10:00"，第一版写死 \d 只认个位数 → 假 FAIL
  check('配对码有 10min 倒计时', /^\d{1,2}:\d\d 后过期$/.test(ttl), `倒计时=${ttl}`);

  console.log('\n=== ④ 就地拼 join token + 复制 ===');
  await page.click('#jtBuildBtn');
  await page.waitForSelector('#jtVal', { visible: true, timeout: 8000 });
  joinToken = await page.$eval('#jtVal', (e) => e.textContent.trim());
  check('join token 拼出且 swjt_ 前缀', joinToken.startsWith('swjt_'), `长度=${joinToken.length}`);
  // 就地解回来对拍：内容必须 = 本页 origin + 刚才那把 rk + 刚才那个 code
  const decoded = await page.evaluate((t) => {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(t.slice(5).replace(/-/g, '+').replace(/_/g, '/')))));
    } catch (e) { return { err: e.message }; }
  }, joinToken);
  check('join token 内容 = {v:1, 本页 origin, rk 明文, code}',
    decoded.v === 1 && decoded.url === CLOUD && decoded.rk === rkShown && decoded.code === code,
    `v=${decoded.v} url=${decoded.url} rk 匹配=${decoded.rk === rkShown} code 匹配=${decoded.code === code}`);
  check('join token 的 url 无尾斜杠（§6.17）', !decoded.url?.endsWith('/'), `url=${decoded.url}`);

  await page.bringToFront();
  await page.click('#jtCopyBtn');
  await sleep(700);
  // writeText 成功 resolve = 明文已进剪贴板（它的契约就是这个）；toast 是它的直接回执。
  // 无头下 readText 读不回（clipboard-read 是 prompt 档），OS 级对拍见有头跑的 clip-os（round-2.md §3⑤）。
  const copyToast = await page.$eval('#toastHost .toast', (e) => e.textContent.trim()).catch(() => '(无 toast)');
  check('点复制 → writeText 兑现，自研 toast 报「已复制」（非 alert）',
    copyToast.includes('已复制'), `toast="${copyToast}"`);

  console.log('\n=== ⑤ 红线：明文绝不进 localStorage / sessionStorage / URL ===');
  const leak = await page.evaluate((secrets) => {
    const dump = (s) => { let o = ''; for (let i = 0; i < s.length; i++) o += s.key(i) + '=' + s.getItem(s.key(i)) + ';'; return o; };
    const hay = dump(localStorage) + dump(sessionStorage) + location.href + document.cookie;
    return { hay, hits: secrets.filter((x) => x && hay.includes(x)) };
  }, [rkShown, code, joinToken]);
  check('localStorage/sessionStorage/URL/cookie 里搜不到 rk / code / token 明文',
    leak.hits.length === 0, `存储与 URL 全文 = ${JSON.stringify(leak.hay).slice(0, 120)}…`);

  console.log('\n=== ⑥ 自研组件：无任何原生组件（运行时定论）===');
  for (const h of ['#/board', '#/machines', '#/enroll']) {
    await page.evaluate((x) => { location.hash = x; }, h);
    await sleep(700);
    const n = await page.$$eval('select', (s) => s.length).catch(() => 0);
    check(`${h} 页面里 <select> 元素数 = 0`, n === 0, `实测 ${n} 个`);
  }
  // 下拉展开态（本次改动重点，要能验收）
  await page.evaluate(() => { location.hash = '#/board'; });
  await sleep(900);
  await page.click('#boardMirror .dd-trig');
  await sleep(400);
  const ddOpen = await page.evaluate(() => {
    const pop = document.querySelector('.dd-pop');
    const trig = document.querySelector('#boardMirror .dd-trig');
    if (!pop) return null;
    const cs = getComputedStyle(pop);
    return {
      opts: pop.querySelectorAll('.dd-opt').length,
      role: pop.getAttribute('role'),
      expanded: trig.getAttribute('aria-expanded'),
      selected: pop.querySelectorAll('[aria-selected="true"]').length,
      bg: cs.backgroundColor,
      inBody: pop.parentElement === document.body,   // 浮层挂 body 才能盖出 overflow 容器
      pos: cs.position,
    };
  });
  check('下拉展开：自绘浮层出现且挂在 body 上（能盖出 overflow 容器）',
    ddOpen && ddOpen.inBody && ddOpen.pos === 'fixed', JSON.stringify(ddOpen));
  check('下拉 ARIA：role=listbox / aria-expanded=true / 有 aria-selected 项',
    ddOpen?.role === 'listbox' && ddOpen?.expanded === 'true' && ddOpen?.selected >= 1);
  await shot(page, '01-dropdown-open-light.png', '自研下拉展开态（亮色）——原生 select 的展开框是 OS 画的，这里全自绘');

  // 键盘可达：↑↓ 选择 + Enter 确认
  await page.keyboard.press('Escape');
  await sleep(250);
  const escClosed = await page.$('.dd-pop');
  check('Esc 关闭下拉', escClosed === null);
  await page.focus('#boardMirror .dd-trig');
  await page.keyboard.press('ArrowDown');   // 开
  await sleep(300);
  await page.keyboard.press('ArrowDown');   // 移到下一项
  await page.keyboard.press('Enter');       // 确认
  await sleep(800);
  const kbVal = await page.$eval('#boardMirror .dd-val', (e) => e.textContent.trim());
  check('键盘 ↑↓ + Enter 能选中（原生 select 白送的能力，自研必须补齐）',
    kbVal !== '全部', `选中=${kbVal}`);
  // 点外部关闭
  await page.click('#boardMirror .dd-trig');
  await sleep(300);
  await page.mouse.click(700, 40);
  await sleep(300);
  check('点浮层外部关闭下拉', (await page.$('.dd-pop')) === null);

  console.log('\n=== ⑦ 暗色主题 ===');
  await page.click('#themeBtn');
  await sleep(600);
  const darkBg = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    body: getComputedStyle(document.body).backgroundColor,
  }));
  check('切到暗色主题', darkBg.theme === 'dark', JSON.stringify(darkBg));
  await page.click('#boardMirror .dd-trig');
  await sleep(400);
  const darkPop = await page.evaluate(() => {
    const p = document.querySelector('.dd-pop');
    return p ? getComputedStyle(p).backgroundColor : null;
  });
  check('暗色下拉浮层用的是 token 底色（不是系统白底）', darkPop && darkPop !== 'rgb(255, 255, 255)', `浮层底色=${darkPop}`);
  await shot(page, '02-dropdown-open-dark.png', '自研下拉展开态（暗色）——若用原生 select 这里会露出 Windows 白底列表');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { location.hash = '#/enroll'; });
  await sleep(900);
  await shot(page, '03-enroll-dark.png', '机器纳管（暗色）：rk 明文 + 配对码 + join token 三步');
  await page.click('#themeBtn');
  await sleep(600);
  await shot(page, '04-enroll-light.png', '机器纳管（亮色）：同上');

  console.log('\n=== ⑧ 把 join token 真的粘到桌面端（8797）设置页 → 点连接 ===');
  const dpage = await browser.newPage();
  const dErrors = [];
  dpage.on('pageerror', (e) => dErrors.push(e.message));
  await dpage.goto(BOARD + '/#/settings', { waitUntil: 'networkidle2', timeout: 30000 });
  await dpage.waitForSelector('#cloudJoinToken', { visible: true, timeout: 15000 });
  await dpage.click('#cloudJoinToken');
  await dpage.type('#cloudJoinToken', joinToken);      // = 用户把那串贴进来
  await sleep(800);
  const filled = await dpage.evaluate(() => ({
    url: document.getElementById('cloudUrlInput').value,
    rk: document.getElementById('cloudRkInput').value,
    code: document.getElementById('cloudCodeInput').value,
    hint: document.getElementById('cloudEnrollHint')?.textContent || '',
  }));
  // 这条是**格式契约的真正验收**：云端 encodeJoinToken 拼的串，被桌面端真实的 parseJoinToken 拆开且三项逐字还原
  check('桌面端就地拆包：URL / rk / 配对码 三项自动填好',
    filled.url === CLOUD && filled.rk === rkShown && filled.code === code,
    `url=${filled.url} · rk 逐字匹配=${filled.rk === rkShown} · code=${filled.code} · 提示="${filled.hint}"`);
  await shot(dpage, '07-desktop-paste-jointoken.png', '桌面端设置页：贴 join token → 三项自动填好（未点连接）');

  await dpage.click('#cloudEnrollBtn');
  const enrolled = await dpage.waitForSelector('#cloudUnenrollBtn', { visible: true, timeout: 25000 })
    .then(() => true).catch(() => false);
  const dstatus = await dpage.evaluate(() => fetch('/api/cloud/status').then((r) => r.json()));
  check('点「连接」→ enroll 成功（桌面端切到「已连接」面板）', enrolled,
    `enrolled=${dstatus.enrolled} workspace=${dstatus.workspaceName} machineId=${dstatus.machineId}`);
  check('本地 identity 落盘且不含 rk（入场券用完即弃）',
    dstatus.enrolled === true && !JSON.stringify(dstatus).includes(rkShown),
    `/api/cloud/status 全文搜 rk 明文 = ${JSON.stringify(dstatus).includes(rkShown) ? '❌ 命中' : '✅ 无'}`);
  check('桌面端设置页无 JS 报错', dErrors.length === 0, dErrors.join(' | '));
  await sleep(1200);
  await shot(dpage, '08-desktop-connected.png', '桌面端：已连接（workspace / machineId / 心跳）');

  console.log('\n=== ⑨ 回云端机器列表 → 这台机器 online ===');
  await page.bringToFront();
  await page.evaluate(() => { location.hash = '#/machines'; });
  const online = await page.waitForFunction(() => {
    const c = document.querySelector('.mach-card');
    return !!c && /online/.test(c.textContent) && !!document.querySelector('.mach-dot.online');
  }, { timeout: 45000, polling: 2000 }).then(() => true).catch(() => false);
  const machInfo = await page.$eval('.mach-card', (c) => c.textContent.replace(/\s+/g, ' ').trim().slice(0, 120)).catch(() => '(无机器卡)');
  check('云端机器列表出现这台机器且 online', online, machInfo);
  await shot(page, '09-cloud-machine-online.png', '云端机器列表：刚 enroll 的机器 online');

  // ⚠ 这里**不落盘任何明文**：join token 内含 rk + 配对码明文，写进 docs/ 就等于把凭据提交进仓库。
  // （第一版写过 `path.join(OUT,'..','jt.txt')` 并自我安慰地注释成「scratchpad，仓库外」——
  //   OUT 是仓库里的 round-2/，'..' 当然还在仓库里。已删，教训记在 round-2.md §2。
  //   桌面端那步现在同进程内做，本来也不需要跨进程传这串。）

  console.log('\n=== ⑩ 负例：刷新后再拼 join token（rk 明文已丢）===');
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1200);
  await page.evaluate(() => { location.hash = '#/enroll'; });
  await sleep(900);
  check('刷新后回到「生成一把」态（内存里的 rk 明文没了）', await page.$('#rkGenBtn') !== null);
  await page.waitForSelector('#jtBuildBtn', { visible: true, timeout: 8000 });
  await page.click('#jtBuildBtn');
  await sleep(500);
  const err = await page.$eval('#jtErr', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
  check('点「拼 join token」→ 给出明确提示而不是坏串', !!err, err ? err.slice(0, 150) + '…' : '没有出现 #jtErr！');
  check('提示说清「刷新后 rk 明文已丢失」', !!err && /没有注册密钥的明文|永久丢失/.test(err));
  check('提示给出出路：重新生成 或 手动贴三个字段', !!err && /重新生成一把注册密钥/.test(err) && /手动/.test(err));
  check('负例下**没有**拼出任何 token（绝不半成品）', (await page.$('#jtVal')) === null);
  await shot(page, '05-negative-no-rk-plaintext.png', '负例：刷新后拼 join token → 明确提示 + 手动路径，未产出坏串');

  console.log('\n=== ⑫ 撤销走自研 modal（非 confirm）===');
  await page.click('button[data-revoke]');
  await sleep(500);
  const modal = await page.evaluate(() => {
    const c = document.querySelector('.mo-card');
    return c ? { role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), txt: c.textContent.replace(/\s+/g, ' ').trim().slice(0, 90) } : null;
  });
  check('撤销弹自研 modal（role=dialog / aria-modal）', modal?.role === 'dialog' && modal?.modal === 'true', JSON.stringify(modal));
  check('modal 讲清「不影响已在线机器」', /已在线的机器不受任何影响/.test(modal?.txt || ''));
  await shot(page, '06-revoke-modal-light.png', '撤销确认：自研 modal（danger 档，点遮罩不关）');
  // 背景不滚动（mask 是 fixed 铺满视口 + body overflow:hidden → 滚轮到不了 #pageWrap）
  const scrollBefore = await page.evaluate(() => document.getElementById('pageWrap').scrollTop);
  await page.mouse.wheel({ deltaY: 400 });
  await sleep(300);
  const scrollAfter = await page.evaluate(() => document.getElementById('pageWrap').scrollTop);
  check('modal 打开时背景不滚动', scrollBefore === scrollAfter, `scrollTop ${scrollBefore} → ${scrollAfter}`);
  // Esc 关闭
  await page.keyboard.press('Escape');
  await sleep(400);
  check('Esc 关闭 modal（且未执行撤销）', (await page.$('.mo-card')) === null);

  console.log('\n=== ⑬ 全程零原生对话框 ===');
  const native = await page.evaluate(() => window.__native);
  check('alert/confirm/prompt 全程被调用 0 次（运行时探针）', native.length === 0, `实际=${JSON.stringify(native)}`);

  console.log('\n=== ⑭ 静态资源与控制台 ===');
  console.log('  非 2xx 响应（按 URL）：');
  nonOk.forEach((r) => console.log('    · ' + r));
  // 只认这两条既有的：401 /api/auth/me（登录前探测，契约 §6.3 就定的）+ 404 /favicon.ico（round-1 §9 观察-3 已记）
  const unexpected = nonOk.filter((r) => !/401 .*\/api\/auth\/me/.test(r) && !/404 .*\/favicon\.ico/.test(r));
  check('无非预期的非 2xx（401 探测 / favicon 除外）', unexpected.length === 0, unexpected.join(' | '));
  check('ui.js / app.js 均 200（新增的组件层真被托管）',
    !nonOk.some((r) => /ui\.js|app\.js/.test(r)) && await page.evaluate(() => typeof UI?.dropdown === 'function'),
    'UI.dropdown 可用 = 组件层确实加载了');
  console.log('  控制台错误：');
  console.log(consoleErrors.length ? consoleErrors.map((e) => '    · ' + e).join('\n') : '    ✅ 无');

  fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify({ results, consoleErrors, nonOk }, null, 2));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n================ 小计：${results.length - failed.length}/${results.length} PASS ================`);
if (failed.length) { failed.forEach((f) => console.log('  ❌ ' + f.name + ' — ' + f.detail)); process.exit(1); }
