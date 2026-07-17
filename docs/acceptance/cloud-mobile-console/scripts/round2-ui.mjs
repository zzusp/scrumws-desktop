#!/usr/bin/env node
'use strict';
/* round-2 UI e2e（puppeteer-core + 系统 Edge，375×812）：
   #3 CLI 任务详情能渲染（不再整页报错）· #2 新建表单定时字段 + 单按钮切换 + 已定时 toast ·
   #4 动作按钮收敛（非全宽、38px 高）。前置：mock-server.mjs 跑着。
   用法：node round2-ui.mjs [port] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('D:/project/scrumws-desktop/node_modules/puppeteer-core');

const PORT = Number(process.argv[2] || 8931);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(fileURLToPath(import.meta.url), '../../round-2');
fs.mkdirSync(OUT, { recursive: true });
const exe = [process.env.BROWSER_EXE, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!exe) { console.error('找不到系统 Edge/Chrome'); process.exit(1); }

const results = [];
const step = (n, pass, note = '') => { results.push({ n, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${note ? '  — ' + note : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-proxy-server', '--disable-gpu', '--no-first-run'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(15000);
  const shot = async (n) => { await page.screenshot({ path: path.join(OUT, n) }); console.log('  📷 ' + n); };
  const count = (sel) => page.$$eval(sel, (e) => e.length).catch(() => 0);

  // 登录
  await page.goto(BASE + '/m/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#loginKey');
  await page.type('#loginKey', 'swuk_0123456789abcdef0123456789abcdef01234567');
  await page.click('#loginBtn');
  await page.waitForFunction(() => location.hash.includes('/machines') || document.querySelector('.mitem'), { timeout: 15000 });

  // ---- #3 CLI 任务详情能渲染（不再整页报错）----
  await page.evaluate(() => { location.hash = '#/task/m1/' + encodeURIComponent('cli:e3b0c442-98fc-4d21-a501-000000000001'); });
  await page.waitForFunction(() => document.querySelector('.blk') || document.querySelector('.holder'), { timeout: 15000 });
  const cliErr = await count('.holder');
  const cliBlk = await count('.blk');
  step('#3 CLI 任务详情渲染（有输出块、无错误占位）', cliErr === 0 && cliBlk >= 1, `holder=${cliErr} blk=${cliBlk}`);
  const cliSrcTag = await page.$$eval('#dtTags .tag', (els) => els.map((e) => e.textContent)).catch(() => []);
  step('#3 CLI 来源标签', cliSrcTag.some((t) => /CLI/i.test(t)), cliSrcTag.join(','));
  await shot('r2-cli-detail.png');

  // ---- #4 动作按钮收敛（processing 任务的「中断」）----
  await page.evaluate(() => { location.hash = '#/task/m1/' + encodeURIComponent('manual:2026-07-17T09-12-33'); });
  await page.waitForSelector('#actRow .btn', { timeout: 15000 });
  const btnBox = await page.$eval('#actRow .btn', (el) => { const r = el.getBoundingClientRect(); return { h: r.height, w: r.width }; });
  step('#4 动作按钮不再全宽（宽 < 视口 60%）', btnBox.w < 375 * 0.6, `w=${Math.round(btnBox.w)}px`);
  step('#4 动作按钮高度收敛（≤40px）', btnBox.h <= 40.5, `h=${btnBox.h.toFixed(1)}px`);
  await shot('r2-actions.png');

  // ---- #2 新建：定时字段 + 单按钮切换 + 已定时 toast ----
  await page.evaluate(() => { location.hash = '#/new/m1'; });
  await page.waitForSelector('#nSched', { timeout: 15000 });
  step('#2 新建表单有定时字段', true);
  // 未设时间 → 两个按钮
  const twoBtns = await page.$$eval('#subrow .btn', (els) => els.map((e) => e.id));
  step('#2 未设时间 = 存为计划/立即执行', twoBtns.includes('nPlan') && twoBtns.includes('nRun'), twoBtns.join(','));
  await page.type('#nPrompt', 'round-2 定时验证：到点自动执行。');
  // 设时间 → 单个「定时执行」
  await page.$eval('#nSched', (el) => { el.value = '2026-12-31T09:00'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForSelector('#nSchedBtn', { timeout: 5000 });
  const oneBtn = await page.$$eval('#subrow .btn', (els) => els.map((e) => e.id));
  step('#2 设时间 → 单按钮「定时执行」', oneBtn.length === 1 && oneBtn[0] === 'nSchedBtn', oneBtn.join(','));
  await shot('r2-new-scheduled.png');
  await page.click('#nSchedBtn');
  await page.waitForFunction(() => (document.getElementById('toastHost')?.textContent || '').includes('已定时'), { timeout: 8000 });
  step('#2 提交 → 「已定时到 …」toast', true, (await page.$eval('#toastHost', (e) => e.textContent).catch(() => '')).trim());
  // 跳详情后应能看到定时标（详情 meta 里 scheduledAt 由 mock 回读）
  await page.waitForFunction(() => location.hash.includes('/task/'), { timeout: 8000 });
  await shot('r2-new-created.png');

  const fails = results.filter((r) => !r.pass);
  console.log(`\n===== round-2 UI：${results.length - fails.length}/${results.length} PASS =====`);
  if (fails.length) { console.log('失败：' + fails.map((f) => f.n).join('；')); process.exitCode = 1; }
} catch (e) {
  console.error('E2E 异常：', e); process.exitCode = 1;
} finally {
  await browser.close();
}
