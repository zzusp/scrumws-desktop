#!/usr/bin/env node
'use strict';
/* ==========================================================================
   SG4 手机端页面 e2e（puppeteer-core + 系统 Edge/Chrome，375×812）
   前置：mock-server.mjs 已在目标端口跑着（node mock-server.mjs 8931）
   跑通：登录 → 机器 → 看板 → 详情（watch 增量）→ 发消息 → 中断确认 → 新建 →
        离线占位（503）→ 502 透传 → 暗色主题
   截图存 ../round-1/。用法：node e2e-mobile.mjs [port]
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 复用主检出已装的 puppeteer-core（仓库惯例：连系统浏览器，不下载 Chromium）
const puppeteer = require('D:/project/scrumws-desktop/node_modules/puppeteer-core');

const PORT = Number(process.argv[2] || 8931);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(fileURLToPath(import.meta.url), '../../round-1');
fs.mkdirSync(OUT, { recursive: true });

const BROWSERS = [
  process.env.BROWSER_EXE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!exe) { console.error('找不到系统 Edge/Chrome，可用 BROWSER_EXE 指定'); process.exit(1); }

const results = [];
function step(name, pass, note = '') {
  results.push({ name, pass, note });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  // --no-proxy-server：宿主机配了系统代理，别让 127.0.0.1 的请求绕出去
  args: ['--no-proxy-server', '--disable-gpu', '--no-first-run'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(15000);
  const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name) }); console.log('  📷 ' + name); };
  // 等残留 toast 消失（TTL 2.6s）：证据截图别被上一步的 toast 挡住
  const drainToasts = () => page.waitForFunction(
    () => !document.getElementById('toastHost')?.children.length, { timeout: 8000 }).catch(() => { });
  const text = (sel) => page.$eval(sel, (el) => el.textContent).catch(() => null);
  const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);

  // ---------- 1. 登录页 ----------
  await page.goto(BASE + '/m/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#loginKey');
  step('无会话打开 /m/ → 登录页', page.url().includes('#/login'), page.url());
  const btnH = await page.$eval('#loginBtn', (el) => el.getBoundingClientRect().height);
  step('登录按钮触控目标 ≥44px', btnH >= 44, `${btnH}px`);
  await shot('01-login.png');

  // 错误分支：坏密钥 → 401 文案
  await page.type('#loginKey', 'bad_key');
  await page.click('#loginBtn');
  await page.waitForFunction(() => document.getElementById('loginErr')?.style.display === 'block');
  step('坏密钥 → 显示错误', true, await text('#loginErr'));

  // 正确密钥
  await page.$eval('#loginKey', (el) => { el.value = ''; });
  await page.type('#loginKey', 'swuk_0123456789abcdef0123456789abcdef01234567');
  await page.click('#loginBtn');

  // ---------- 2. 机器列表 ----------
  await page.waitForSelector('.mitem');
  const nMach = await count('.mitem');
  const nOff = await count('.mitem.off');
  const offTxt = await page.$$eval('.m-sub.warn', (els) => els.map((e) => e.textContent));
  step('登录后进入机器列表（3 台）', nMach === 3, `共 ${nMach} 台`);
  step('未开中继的机器置灰 + 文案', nOff === 2 && offTxt.every((t) => t.includes('离线或未开启远程控制')), JSON.stringify(offTxt));
  await shot('02-machines.png');

  // ---------- 3. 看板 ----------
  await page.click('a.mitem');
  await page.waitForSelector('.chip');
  const chips = await page.$$eval('.chip', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const wantOrder = ['处理中', '等人工', '待定', '待认领', '完成'];
  step('分桶 chips 用词与本地看板一致', wantOrder.every((w, i) => chips[i]?.startsWith(w)), chips.join(' | '));
  await page.waitForSelector('.tcard');
  const procCount = chips[0]?.match(/\d+/)?.[0];
  step('默认选中「处理中」且计数=2', procCount === '2' && await count('.tcard') === 2, `chips=${chips[0]}`);
  const chipH = await page.$eval('.chip', (el) => el.getBoundingClientRect().height);
  step('chip 触控目标 ≥44px', chipH >= 44, `${chipH}px`);
  await shot('03-board.png');

  // 切桶：完成桶（卡片流内容跟着换，不只是计数巧合相等）
  await page.$$eval('.chip', (els) => els.find((e) => e.textContent.includes('完成')).click());
  await page.waitForFunction(() =>
    document.querySelector('.chip.on')?.textContent.includes('完成')
    && [...document.querySelectorAll('.tcard')].some((c) => c.textContent.includes('周报')));
  step('切桶「完成」→ 卡片流切换', true);
  await page.$$eval('.chip', (els) => els.find((e) => e.textContent.includes('处理中')).click());
  await page.waitForFunction(() => document.querySelector('.chip.on')?.textContent.includes('处理中'));

  // ---------- 4. 详情：taskDetail + workerLog + watch 增量 ----------
  await page.click('.tcard');
  await page.waitForSelector('.blk');
  const n0 = await count('.blk');
  step('详情加载 workerLog tail=30', n0 === 30, `${n0} 块`);
  // 真实 connector 语义：watch 接入先补一帧「基线尾窗」（与刚拉的 workerLog 整窗重叠）——
  // 必须按绝对下标去重，块数不得翻倍
  await sleep(1200);
  const nBase = await count('.blk');
  step('watch 基线帧去重（仍 30 块，不重复渲染）', nBase === 30, `${nBase} 块`);
  const moreTxt = await text('#loadMore');
  step('「加载更早」显示剩余块数', /还有 27 块/.test(moreTxt || ''), moreTxt);
  // watch 增量：mock 每 2s 一帧，5s 内必须长出新块（端到端 ≤3s 的 UI 侧等价验证）
  await page.waitForFunction((n) => document.querySelectorAll('.blk').length > n, { timeout: 6000 }, n0);
  const n1 = await count('.blk');
  step('watch SSE 增量渲染', n1 > n0, `${n0} → ${n1} 块`);
  const liveTxt = await text('#liveTxt');
  step('实时状态点亮', liveTxt === '实时', liveTxt);
  // 代码块横向滚动容器
  const preScroll = await page.$eval('.md pre', (el) => getComputedStyle(el).overflowX);
  step('代码块横向滚动（overflow-x:auto）', preScroll === 'auto', preScroll);
  // CC content 数组块（真实 relay-verbs 形态）：tool_use 轨迹行 + tool_result 折叠窗
  step('CC content 块渲染（tool_use/tool_result）', await count('.tool-line') >= 1 && await count('.tool-res') >= 1,
    `tool-line=${await count('.tool-line')} tool-res=${await count('.tool-res')}`);
  await shot('04-detail.png');

  // 加载更早
  await page.click('#loadMore');
  await page.waitForFunction((n) => document.querySelectorAll('.blk').length >= n + 27, {}, n1);
  step('加载更早 → 补齐历史块', true, `${n1} → ${await count('.blk')} 块`);

  // ---------- 5. 发消息 ----------
  const sendH = await page.$eval('#msgSend', (el) => el.getBoundingClientRect().height);
  step('发送按钮触控目标 ≥44px', sendH >= 44, `${sendH}px`);
  await page.type('#msgInput', '收到，注意 safe-area 适配，继续。');
  await page.click('#msgSend');
  await page.waitForFunction(() => document.getElementById('toastHost')?.textContent.includes('已发送'));
  step('rpc message → toast 已发送', true);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.blk.role-user')].some((b) => b.textContent.includes('safe-area')), { timeout: 6000 });
  step('消息经 watch 回显为用户块', true);
  await shot('05-message.png');

  // ---------- 6. 中断（破坏性动作二次确认）----------
  await drainToasts();
  await page.click('.actrow .btn-danger');
  await page.waitForSelector('.sheet');
  step('中断 → 底部确认 sheet', true, await text('.sheet-t'));
  await shot('06-confirm.png');
  await page.click('.sheet [data-yes]');
  await page.waitForFunction(() => document.getElementById('dtTags')?.textContent.includes('等人工'));
  step('确认中断 → 状态迁移 等人工 + cancelled', (await text('#dtTags')).includes('cancelled'));
  await page.waitForFunction(() => document.getElementById('streamDone')?.style.display !== 'none', { timeout: 8000 });
  step('任务收敛 → watch done 帧 + 「已收敛」', (await text('#liveTxt')) === '已收敛');
  const acts = await page.$$eval('.actrow button', (els) => els.map((e) => e.textContent.trim()));
  step('动作条随状态切换（等人工 → 完成）', acts.join() === '完成', acts.join());

  // ---------- 7. 502 透传：plan 任务发消息被本地拒绝 ----------
  await page.evaluate(() => { location.hash = '#/task/m1/' + encodeURIComponent('mobile:2026-07-17T08-00-00'); });
  await page.waitForFunction(() => document.getElementById('dtTags')?.textContent.includes('待定'));
  await page.type('#msgInput', '这条应该被拒');
  await page.click('#msgSend');
  await page.waitForFunction(() => document.getElementById('toastHost')?.textContent.includes('不可发消息'));
  step('502 RELAY_FAILED → 本地拒绝原因透传', true, (await text('#toastHost')).trim());
  const planActs = await page.$$eval('.actrow button', (els) => els.map((e) => e.textContent.trim()));
  step('plan 态动作条 = 确认执行', planActs.join() === '确认执行', planActs.join());

  // ---------- 8. 新建任务 ----------
  await page.evaluate(() => { location.hash = '#/board/m1'; });
  await page.waitForSelector('#fabNew');
  await page.click('#fabNew');
  await page.waitForSelector('#nPrompt');
  const cwdOpts = await page.$$eval('#nCwd option', (els) => els.map((e) => e.value));
  step('cwd 白名单选择器（2 项）', cwdOpts.length === 2, cwdOpts.join(' | '));
  await page.type('#nTitle', '手机新建：给 /m/ 补 e2e 截图');
  await page.type('#nPrompt', '在 docs/acceptance/cloud-mobile-console/round-1/ 补关键页截图，375×812。');
  await page.select('#nModel', 'claude-fable-5');
  await page.click('#nWorktree');
  await drainToasts();
  await shot('07-new.png');
  await page.click('#nRun');
  await page.waitForFunction(() => location.hash.startsWith('#/task/m1/mobile%3A'), { timeout: 8000 });
  step('立即执行 → createTask → 跳详情', true, decodeURIComponent(await page.evaluate(() => location.hash)));
  // queued → (2s) processing → watch 开始出块
  await page.waitForFunction(() => document.getElementById('dtTags')?.textContent.includes('处理中'), { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('.blk').length >= 1, { timeout: 8000 });
  step('新任务起跑：状态→处理中 + watch 出块', true, `${await count('.blk')} 块`);
  await drainToasts();
  await shot('08-created.png');

  // ---------- 9. 机器离线 → 503 占位 ----------
  await page.evaluate(() => { location.hash = '#/board/m2'; });
  await page.waitForFunction(() => document.querySelector('.holder .h-t')?.textContent.includes('机器离线或未开启远程控制'), { timeout: 8000 });
  step('503 MACHINE_OFFLINE → 占位页', true, await text('.holder .h-t'));
  await drainToasts();
  await shot('09-offline.png');

  // ---------- 10. 暗色主题 ----------
  await page.evaluate(() => { location.hash = '#/board/m1'; });
  await page.waitForSelector('#themeBtn');
  await page.click('#themeBtn');   // auto → light
  await page.click('#themeBtn');   // light → dark
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  step('手动切换暗色主题', true, 'data-theme=dark');
  await page.waitForSelector('.tcard');
  await drainToasts();
  await shot('10-dark-board.png');
  await page.click('.tcard');
  await page.waitForSelector('.blk');
  await sleep(500);   // 等 .view/.blk 的 rise 入场动画结束，别截到半透明帧
  await shot('11-dark-detail.png');

  // ---------- 汇总 ----------
  const fails = results.filter((r) => !r.pass);
  console.log(`\n===== e2e 结果：${results.length - fails.length}/${results.length} PASS =====`);
  if (fails.length) { console.log('失败项：' + fails.map((f) => f.name).join('；')); process.exitCode = 1; }
} catch (e) {
  console.error('E2E 异常：', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
