// 云端前端截图（机器列表 / 看板 / 任务详情）—— 走**真实服务端**（8790），不是 mock。
// 这条最要紧：blocker 1 的成因就是前端 agent 全程只对着 mock-cloud-server 验，没碰过真 server.js。
//
// puppeteer-core 装在 scratchpad（仓库外），用系统 Edge/Chrome —— 不给仓库任何 package.json 加依赖。
// 用法：node shots.mjs <cloudUrl> <swukFile> <outDir> <puppeteerPath> [browserPath]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [, , CLOUD, SWUK_FILE, OUT, PUP, BROWSER_ARG] = process.argv;
if (!CLOUD || !SWUK_FILE || !OUT || !PUP) {
  throw new Error('用法：node shots.mjs <cloudUrl> <swukFile> <outDir> <puppeteerPath> [browserPath]');
}
const CANDIDATES = [
  BROWSER_ARG,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const browser0 = CANDIDATES.find((p) => fs.existsSync(p));
if (!browser0) throw new Error('找不到系统 Edge/Chrome');

// 用 require.resolve 找入口，别硬编码包内路径（v25 的入口是 lib/puppeteer/…，没有 lib/esm/）。
// Windows 上 ESM 动态 import 绝对路径必须转 file:// URL（否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME: 'c:'）。
const req = createRequire(pathToFileURL(path.join(PUP, 'anchor.cjs')).href);
const puppeteer = (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;
fs.mkdirSync(OUT, { recursive: true });
const swuk = fs.readFileSync(SWUK_FILE, 'utf8').trim();

const browser = await puppeteer.launch({
  executablePath: browser0,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1600, height: 1000 },
});
const shots = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + r.failure()?.errorText));

  const shot = async (name, note) => {
    const f = path.join(OUT, name);
    await page.screenshot({ path: f, fullPage: true });
    shots.push({ name, note, bytes: fs.statSync(f).size });
    console.log(`  截图 ${name}  ${fs.statSync(f).size} bytes  — ${note}`);
  };

  // ① 登录页（blocker 1 的直接证明：真实服务端能把前端吐出来）
  const resp = await page.goto(CLOUD + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  console.log(`GET / → HTTP ${resp.status()}  content-type=${resp.headers()['content-type']}`);
  await page.waitForSelector('#loginView', { visible: true, timeout: 10000 });
  await shot('01-login.png', '登录页（由真实 cloud/src/server.js 托管）');

  // ② 登录
  await page.type('#loginKey', swuk);
  await Promise.all([
    page.click('#loginBtn').catch(async () => { await page.keyboard.press('Enter'); }),
    page.waitForSelector('#shell', { visible: true, timeout: 15000 }),
  ]);
  await new Promise((r) => setTimeout(r, 1500));
  await shot('02-board.png', '云端看板（5 桶：plan/queued/processing/awaiting-human/done）');

  // ③ 机器列表
  await page.evaluate(() => { location.hash = '#/machines'; });
  await new Promise((r) => setTimeout(r, 1800));
  await shot('03-machines.png', '机器列表（在线/离线、claude 版本、负载、taskCounts）');

  // ④ 任务详情：回看板点第一张卡（卡片是 <a class="taskcard" href="#/task/<id>">，app.js:210）
  await page.evaluate(() => { location.hash = '#/board'; });
  await new Promise((r) => setTimeout(r, 1800));
  const clicked = await page.evaluate(() => {
    const c = document.querySelector('a.taskcard');
    if (!c) return null;
    const t = c.querySelector('.card-title')?.textContent?.trim() ?? '';
    c.click();
    return t;
  });
  if (!clicked) throw new Error('看板上没有 a.taskcard —— 卡片没渲染出来，截图无意义');
  await new Promise((r) => setTimeout(r, 2000));
  await shot('04-task-detail.png', `任务详情（点开卡片「${clicked}」）`);

  // ⑤ 再来一张「有用量数据」的详情：④ 恰好点到 local_missing 那张（rounds/成本全 0、用量面板空），
  //    不足以证明「状态/历史/用量/结果」都渲染得出来。这里挑一张 rounds>0 的。
  await page.evaluate(() => { location.hash = '#/board'; });
  await new Promise((r) => setTimeout(r, 1500));
  const rich = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('a.taskcard')];
    const c = cards.find((x) => /接入云端 connector/.test(x.textContent)) || cards[cards.length - 1];
    if (!c) return null;
    const t = c.querySelector('.card-title')?.textContent?.trim() ?? '';
    c.click();
    return t;
  });
  await new Promise((r) => setTimeout(r, 2000));
  await shot('05-task-detail-usage.png', `任务详情·有用量（「${rich}」：rounds/turns/成本/usage 末轮快照）`);

  console.log('\n浏览器侧错误（应为空 —— 有 404 就说明静态资源没托管好）：');
  console.log(errors.length ? errors.map((e) => '  ❌ ' + e).join('\n') : '  ✅ 无');
  fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify({ shots, errors }, null, 2));
} finally {
  await browser.close();
}
