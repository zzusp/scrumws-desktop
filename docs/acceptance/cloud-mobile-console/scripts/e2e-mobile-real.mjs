#!/usr/bin/env node
'use strict';
/* SG5 Phase C（C13）：手机 UI 对**真后端**跑通（真 cloud+relay+platform，非 mock）。
   验证接缝：真登录 → 真 /api/my/machines(relayOnline) → 真 rpc state 渲染 → 真 watch SSE → 真 createTask。
   数据无关断言（结构而非固定内容），因沙箱任务是动态的。
   用法：CLOUD=http://127.0.0.1:18790 SWUK=swuk_… CWD='C:\…' node e2e-mobile-real.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('D:/project/scrumws-desktop/node_modules/puppeteer-core');

const BASE = process.env.CLOUD || 'http://127.0.0.1:18790';
const SWUK = process.env.SWUK;
const OUT = path.resolve(fileURLToPath(import.meta.url), '../../round-1');
fs.mkdirSync(OUT, { recursive: true });
const exe = [process.env.BROWSER_EXE, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!exe) { console.error('找不到系统 Edge/Chrome'); process.exit(1); }

const results = [];
const step = (name, pass, note = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-proxy-server', '--disable-gpu', '--no-first-run'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(20000);
  const shot = async (n) => { await page.screenshot({ path: path.join(OUT, n) }); console.log('  📷 ' + n); };
  const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
  const text = (sel) => page.$eval(sel, (el) => el.textContent).catch(() => null);

  // 1. 登录（真 swuk_ → 真 /api/auth/login）
  await page.goto(BASE + '/m/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#loginKey');
  step('R1 无会话 → 登录页', page.url().includes('#/login'));
  await page.type('#loginKey', SWUK);
  await page.click('#loginBtn');

  // 2. 机器：单机可能直接进看板，也可能停机器列表
  await page.waitForFunction(() => location.hash.includes('/board') || document.querySelector('.mitem'), { timeout: 20000 });
  if (await page.$('.mitem')) {
    step('R2 机器列表渲染真机器', await count('.mitem') >= 1, `${await count('.mitem')} 台`);
    await shot('r1-real-machines.png');
    await page.click('a.mitem');
  }
  await page.waitForSelector('.chip', { timeout: 20000 });
  step('R2 进入看板（真 rpc state）', true);

  // 3. 看板：真桶 chips + 至少能渲染（沙箱有 Phase B 的 awaiting-human 任务）
  const chips = await page.$$eval('.chip', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  step('R3 分桶 chips 渲染', chips.length >= 5, chips.join(' | '));
  await shot('r1-real-board.png');

  // 切到「等人工」桶找 Phase B 留下的已收敛任务（有 worker-log 块）
  await page.$$eval('.chip', (els) => { const c = els.find((e) => e.textContent.includes('等人工')); if (c) c.click(); });
  await sleep(800);
  const hasCard = await count('.tcard') >= 1;
  step('R3 等人工桶有真实任务卡', hasCard, `${await count('.tcard')} 卡`);

  // 4. 详情：真 taskDetail + 真 workerLog 块渲染
  if (hasCard) {
    await page.click('.tcard');
    await page.waitForSelector('.blk', { timeout: 20000 });
    const nblk = await count('.blk');
    step('R4 详情渲染真 workerLog 块（Phase B 真 claude 输出）', nblk >= 1, `${nblk} 块`);
    await shot('r1-real-detail.png');
    await page.evaluate(() => { history.back(); });
    await page.waitForSelector('.chip', { timeout: 20000 });
  }

  // 5. 新建：真表单 → 真 createTask（存为计划，不 spawn）→ 跳详情
  await page.waitForSelector('#fabNew');
  await page.click('#fabNew');
  await page.waitForSelector('#nPrompt');
  const cwdOpts = await page.$$eval('#nCwd option', (els) => els.map((e) => e.value)).catch(() => []);
  step('R5 新建表单 cwd 白名单（真 rpc cwds）', cwdOpts.length >= 1, cwdOpts.join(' | '));
  await page.type('#nTitle', 'SG5 手机页真后端新建');
  await page.type('#nPrompt', '这是 SG5 Phase C 的真后端新建验证任务。');
  await shot('r1-real-new.png');
  // #nPlan =「存为计划」按钮（点击即以 plan 提交，不 spawn claude）
  await page.click('#nPlan');
  await page.waitForFunction(() => location.hash.includes('/task/'), { timeout: 20000 });
  step('R5 createTask → 跳详情（真任务落地）', true, decodeURIComponent(await page.evaluate(() => location.hash)).slice(0, 60));
  await shot('r1-real-created.png');

  const fails = results.filter((r) => !r.pass);
  console.log(`\n===== Phase C 真后端 e2e：${results.length - fails.length}/${results.length} PASS =====`);
  if (fails.length) { console.log('失败：' + fails.map((f) => f.name).join('；')); process.exitCode = 1; }
} catch (e) {
  console.error('E2E 异常：', e); process.exitCode = 1;
} finally {
  await browser.close();
}
