/**
 * 云端前端 UI 取证：puppeteer-core + 系统 Edge 驱真浏览器，跑断言 + 截图。
 * 配 mock-cloud-server.mjs 用（先起 mock，再跑本脚本）。
 *
 *   node docs/.../scripts/mock-cloud-server.mjs &
 *   PUPPETEER_HOME=<装了 puppeteer-core 的目录> node docs/.../scripts/verify-cloud-ui.mjs
 *
 * 依赖不入仓（platform/ 零运行时依赖是硬约束，根 package.json 不许加东西）：
 *   PUPPETEER_HOME  指向一个 `npm i --no-save puppeteer-core` 过的目录（默认取本脚本所在处）
 *   EDGE            msedge.exe 路径（默认取 Windows 常规安装位）
 *   CLOUD_MOCK_PORT mock 端口（默认 8791）
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const req = createRequire(path.join(process.env.PUPPETEER_HOME || import.meta.dirname, 'noop.js'));
const puppeteer = req('puppeteer-core');

const PORT = Number(process.env.CLOUD_MOCK_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SHOT_DIR = process.env.SHOT_DIR || path.join(import.meta.dirname, '..', 'round-1');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  → ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`); }
};

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
// 截图前先等 rise 入场动画跑完（animation:rise .3s both）——
// 不等会拍到 opacity<1 的半透明帧，整页看起来「发灰」，会被误读成对比度不足。
const shot = async (n) => {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => { }))));
  await page.screenshot({ path: path.join(SHOT_DIR, n) });
  console.log(`  shot  ${n}`);
};
const vis = (sel) => page.$eval(sel, (el) => el.offsetParent !== null || getComputedStyle(el).display !== 'none').catch(() => false);

// ============ 1. 登录闸门 ============
console.log('\n[1] 登录闸门');
await page.goto(BASE, { waitUntil: 'networkidle0' });
ok('未登录 → 登录页可见', await vis('#loginView'));
ok('未登录 → 主 shell 不可见', (await page.$eval('#shell', (el) => getComputedStyle(el).display)) === 'none');
ok('密钥输入框是 password 型（不明文回显）', (await page.$eval('#loginKey', (el) => el.type)) === 'password');
await shot('01-login.png');

// 错误密钥 → 401 文案，不进 app
await page.type('#loginKey', 'swuk_wrong');
await page.click('#loginBtn');
await page.waitForFunction(() => document.getElementById('loginErr').style.display === 'block', { timeout: 5000 });
ok('错误密钥 → 显示云端 401 文案', (await page.$eval('#loginErr', (el) => el.textContent)).includes('登录密钥无效'));
ok('错误密钥 → 仍停在登录页', (await page.$eval('#shell', (el) => getComputedStyle(el).display)) === 'none');
await shot('02-login-err.png');

// ============ 2. 登录成功 ============
console.log('\n[2] 登录成功 → 看板');
const KEY = 'swuk_' + Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 % 256)).toString('base64url');
await page.$eval('#loginKey', (el) => { el.value = ''; });
await page.type('#loginKey', KEY);
await page.click('#loginBtn');
await page.waitForFunction(() => document.getElementById('shell').style.display === 'flex', { timeout: 5000 });
ok('登录后 → 主 shell 可见', await vis('#shell'));
ok('登录后 → 密钥输入框已清空（不留在 DOM）', (await page.$eval('#loginKey', (el) => el.value)) === '');
ok('侧边栏显示当前登录人', (await page.$eval('#userName', (el) => el.textContent)) === '孙鹏');
ok('侧边栏显示 workspace', (await page.$eval('#userWs', (el) => el.textContent)) === 'scrumws');
ok('登录密钥未落任何浏览器存储',
  await page.evaluate(() => JSON.stringify(localStorage) === '{}' && JSON.stringify(sessionStorage) === '{}'));

// ============ 3. 看板分桶 ============
console.log('\n[3] 看板：state 分桶 + 计数');
await page.waitForFunction(() => document.querySelectorAll('#list-processing .taskcard').length > 0, { timeout: 5000 });
const counts = await page.evaluate(() => Object.fromEntries(
  ['plan', 'queued', 'processing', 'awaiting-human', 'done'].map((s) => [s, {
    count: document.getElementById('count-' + s).textContent,
    cards: document.querySelectorAll('#list-' + s + ' .taskcard').length,
  }])));
ok('plan 桶 1 条', counts.plan.count === '1' && counts.plan.cards === 1, JSON.stringify(counts.plan));
ok('queued 桶 1 条', counts.queued.count === '1' && counts.queued.cards === 1, JSON.stringify(counts.queued));
ok('processing 桶 2 条', counts.processing.count === '2' && counts.processing.cards === 2, JSON.stringify(counts.processing));
ok('awaiting-human 桶 2 条', counts['awaiting-human'].count === '2' && counts['awaiting-human'].cards === 2, JSON.stringify(counts['awaiting-human']));
ok('done 桶 3 条', counts.done.count === '3' && counts.done.cards === 3, JSON.stringify(counts.done));
ok('每张卡都显示所属机器（云端多机必需）',
  await page.evaluate(() => [...document.querySelectorAll('.taskcard')].every((c) => c.querySelector('.card-machine .nm')?.textContent.trim())));
await shot('03-board.png');

// ============ 4. 铁律：mirror != live 必须显性 ============
console.log('\n[4] 铁律：mirror 陈旧必须显性');
const mirrorCards = await page.evaluate(() => [...document.querySelectorAll('.taskcard')].map((c) => ({
  title: c.querySelector('.card-title').textContent.trim(),
  mirror: c.querySelector('.card-mirror')?.textContent.trim() || null,
})));
const stale = mirrorCards.find((c) => c.title.startsWith('CLI 观察态'));
const missing = mirrorCards.find((c) => c.title.startsWith('本地已被删掉'));
const live = mirrorCards.find((c) => c.title.startsWith('修复 connector'));
ok('stale 卡显示「陈旧 + 最后同步 X 前」', /陈旧/.test(stale?.mirror || '') && /最后同步 \d+ 分钟前/.test(stale?.mirror || ''), stale?.mirror);
ok('local_missing 卡显示「本地已消失」', /本地已消失/.test(missing?.mirror || ''), missing?.mirror);
ok('live 卡不出陈旧条（避免噪音）', live?.mirror === null, String(live?.mirror));

// ============ 5. 筛选 ============
console.log('\n[5] 筛选：机器 / mirror / 关键字');
await page.select('#boardMachine', 'm-2222');
await page.waitForFunction(() => document.getElementById('count-processing').textContent === '1', { timeout: 5000 });
const f1 = await page.evaluate(() => ({
  proc: document.getElementById('count-processing').textContent,
  mach: [...document.querySelectorAll('.taskcard .card-machine .nm')].map((e) => e.textContent),
}));
ok('按机器筛选 → 只剩该机器的卡', f1.proc === '1' && f1.mach.every((m) => m === '李雷的笔记本'), JSON.stringify(f1));
await page.click('#boardClear');
await page.waitForFunction(() => document.getElementById('count-processing').textContent === '2', { timeout: 5000 });
ok('清除筛选 → 计数还原', (await page.$eval('#count-processing', (e) => e.textContent)) === '2');

await page.select('#boardMirror', 'stale');
await page.waitForFunction(() => document.getElementById('count-done').textContent === '1', { timeout: 5000 });
const f2 = await page.evaluate(() => [...document.querySelectorAll('.taskcard')].every((c) => /陈旧/.test(c.querySelector('.card-mirror')?.textContent || '')));
ok('按 mirror=stale 筛选 → 全是陈旧卡', f2);
await page.click('#boardClear');
await page.waitForFunction(() => document.getElementById('count-done').textContent === '3', { timeout: 5000 });

await page.type('#boardQ', 'timeutil');
await page.waitForFunction(() => document.getElementById('count-processing').textContent === '1', { timeout: 5000 });
ok('关键字筛选命中 title', (await page.$eval('#count-processing', (e) => e.textContent)) === '1');
await page.click('#boardClear');
await page.waitForFunction(() => document.getElementById('count-processing').textContent === '2', { timeout: 5000 });

// ============ 6. 任务详情（stale 档）============
console.log('\n[6] 任务详情：stale 横幅 / 时间线 / 用量');
await page.click('a.taskcard[data-taskid="t-proc-2"]');
await page.waitForFunction(() => document.querySelector('#taskDetail .mirror-banner'), { timeout: 5000 });
const d = await page.evaluate(() => ({
  banner: document.querySelector('.mirror-banner')?.textContent.replace(/\s+/g, ' ').trim(),
  bannerCls: document.querySelector('.mirror-banner')?.className,
  tl: document.querySelectorAll('.tl-item').length,
  tlBy: [...document.querySelectorAll('.tl-item')].map((i) => i.querySelector('.tl-by')?.textContent || null),
  usageHead: [...document.querySelectorAll('.sec-head')].map((h) => h.textContent.replace(/\s+/g, ' ').trim()),
  stats: [...document.querySelectorAll('.stat')].map((s) => s.querySelector('.stat-k').textContent + '=' + s.querySelector('.stat-v').textContent),
  writeBtns: [...document.querySelectorAll('#view-task button')].map((b) => b.textContent.trim()),
}));
ok('stale 详情 → 横幅是 stale 档', /stale/.test(d.bannerCls || ''), d.bannerCls);
ok('stale 详情 → 横幅明写「不是实时状态」', /这不是实时状态/.test(d.banner || ''), d.banner?.slice(0, 60));
ok('stale 详情 → 横幅带「最后同步 X 前」', /停留在最后一次同步：\d+ 分钟前/.test(d.banner || ''));
ok('history 时间线渲染 2 条', d.tl === 2, String(d.tl));
ok('history.by 可空时不渲染 by（契约已知缺口 4）', d.tlBy.every((b) => b === null), JSON.stringify(d.tlBy));
ok('用量卡标注「末轮快照」', d.usageHead.some((h) => h.includes('用量末轮快照')), JSON.stringify(d.usageHead));
ok('累计值（轮次/成本）与末轮 usage 分开呈现',
  d.stats.some((s) => s.startsWith('轮次=5')) && d.stats.some((s) => s.startsWith('成本=$1.2030')) && d.stats.some((s) => s.startsWith('输入=45.0K')),
  JSON.stringify(d.stats));
ok('token 数字与本地看板 compactTokens 同口径（45000→45.0K / 210000→210.0K）',
  d.stats.includes('输入=45.0K') && d.stats.includes('缓存读=210.0K'), JSON.stringify(d.stats));
ok('只读大盘：详情页无任何写操作按钮', d.writeBtns.length === 0, JSON.stringify(d.writeBtns));
await shot('04-task-detail-stale.png');

// live 档详情
await page.goto(BASE + '/#/task/t-proc-1', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelector('#taskDetail .mirror-banner'), { timeout: 5000 });
const dl = await page.evaluate(() => ({
  cls: document.querySelector('.mirror-banner').className,
  txt: document.querySelector('.mirror-banner').textContent.replace(/\s+/g, ' ').trim(),
  prompt: document.querySelector('.prompt-box')?.textContent.slice(0, 30),
  branch: [...document.querySelectorAll('.kv dd')].map((e) => e.textContent),
}));
ok('live 详情 → 横幅是 live 档且写明「实时镜像」', /live/.test(dl.cls) && /实时镜像/.test(dl.txt), dl.txt.slice(0, 40));
ok('详情页出 prompt 全文', (dl.prompt || '').startsWith('重命名 / 改备注 / 归档'), dl.prompt);
ok('详情页出 worktree 分支', dl.branch.includes('worktree-cloud-control-plane'));
await shot('05-task-detail-live.png');

// local_missing 档
await page.goto(BASE + '/#/task/t-await-2', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelector('#taskDetail .mirror-banner'), { timeout: 5000 });
const dm = await page.evaluate(() => document.querySelector('.mirror-banner').textContent.replace(/\s+/g, ' ').trim());
ok('local_missing 详情 → 明写「本地已不存在这个任务」', /本地已不存在这个任务/.test(dm), dm.slice(0, 40));

// ============ 7. 机器列表 ============
console.log('\n[7] 机器列表');
await page.goto(BASE + '/#/machines', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelectorAll('.mach-card').length === 2, { timeout: 5000 });
const m = await page.evaluate(() => [...document.querySelectorAll('.mach-card')].map((c) => ({
  name: c.querySelector('.mach-name').textContent.trim(),
  online: c.querySelector('.mach-dot').className.includes('online'),
  badge: c.querySelector('.tag').textContent.trim(),
  load: c.querySelector('.load-txt').textContent.trim(),
  kv: Object.fromEntries([...c.querySelectorAll('.kv dt')].map((dt, i) => [dt.textContent.trim(), c.querySelectorAll('.kv dd')[i].textContent.trim()])),
  counts: [...c.querySelectorAll('.cnt')].map((x) => x.textContent.replace(/\s+/g, '')),
})));
ok('两台机器都出卡', m.length === 2);
ok('在线机：online 徽章 + 呼吸点', m[0].online && m[0].badge === 'online', JSON.stringify({ o: m[0].online, b: m[0].badge }));
ok('离线机：offline 徽章', !m[1].online && m[1].badge === 'offline', JSON.stringify({ o: m[1].online, b: m[1].badge }));
ok('负载显示 processing/cap（+排队）', m[0].load === '2 / 5 · +1 排队', m[0].load);
ok('cap=0 → 显示 ∞（契约 §6.6：0=不限）', m[1].load === '0 / ∞', m[1].load);
ok('hostname 显示', m[0].kv['主机名'] === 'DESKTOP-ABC', m[0].kv['主机名']);
ok('claude 版本显示', m[0].kv['claude'] === '2.1.207', m[0].kv['claude']);
ok('未装 claude → 显示「未装」不是空白', m[1].kv['claude'] === '未装', m[1].kv['claude']);
ok('last seen 显示相对时间', /秒前|分钟前/.test(m[0].kv['最后心跳']), m[0].kv['最后心跳']);
ok('离线机 last seen 47 分钟前', m[1].kv['最后心跳'] === '47 分钟前', m[1].kv['最后心跳']);
ok('acceptAutoMode 契约未返回 → 如实显示「未上报」', m[0].kv['自动执行'] === '未上报', m[0].kv['自动执行']);
ok('任务计数条', m[0].counts.includes('processing2') && m[0].counts.includes('归档40'), JSON.stringify(m[0].counts));
ok('只读大盘：机器页无写操作按钮', (await page.$$eval('#view-machines button', (b) => b.length)) === 0);
await shot('06-machines.png');

// ============ 8. 布局 / 可点性 ============
console.log('\n[8] 布局与可点性');
await page.goto(BASE + '/#/board', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelectorAll('.taskcard').length > 0, { timeout: 5000 });
ok('body 不出现横向滚动', await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1),
  await page.evaluate(() => `${document.body.scrollWidth} <= ${window.innerWidth}`));
const hit = await page.evaluate(() => {
  const c = document.querySelector('#list-processing .taskcard');
  const r = c.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + 12);
  return { w: Math.round(r.width), h: Math.round(r.height), hitSelf: c.contains(top) };
});
ok('任务卡未被遮挡（命中测试）', hit.hitSelf, JSON.stringify(hit));
ok('任务卡有合理点击面积', hit.w > 180 && hit.h > 60, JSON.stringify(hit));
const nav = await page.evaluate(() => [...document.querySelectorAll('.topnav a')].map((a) => ({ t: a.textContent.trim(), h: a.getAttribute('href') })));
ok('侧边栏导航 2 项', nav.length === 2 && nav[0].h === '#/board' && nav[1].h === '#/machines', JSON.stringify(nav));
// 窄屏
await page.setViewport({ width: 900, height: 800 });
await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
ok('900px 窄屏不出 body 横向滚动', await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1));
await shot('07-board-narrow.png');
await page.setViewport({ width: 1440, height: 900 });

// ============ 9. 退出 ============
console.log('\n[9] 退出登录');
await page.click('#logoutBtn');
await page.waitForFunction(() => document.getElementById('loginView').style.display === 'grid', { timeout: 5000 });
ok('退出 → 回登录页', await vis('#loginView'));
const after = await page.evaluate(async () => (await fetch('/api/auth/me', { credentials: 'same-origin' })).status);
ok('退出 → 会话真失效（/api/auth/me 401）', after === 401, 'HTTP ' + after);

await browser.close();
console.log(`\n==== PASS ${pass} · FAIL ${fail} ====`);
process.exit(fail ? 1 : 0);
