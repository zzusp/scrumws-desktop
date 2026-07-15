// 看板迭代截图证据：卡片视图 + 展开的筛选面板。用法：node shot.mjs（需 8790 服务在跑）
import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dir = 'D:/project/scrumws-desktop/.claude/worktrees/20260715135813-626/docs/acceptance/board-filter-iteration/round-1';
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 900 });
await p.goto('http://127.0.0.1:8790/#/board', { waitUntil: 'networkidle2' });
await p.waitForSelector('#lifecycleGrid .taskcard', { timeout: 8000 });
await p.screenshot({ path: dir + '/board-cards.png' });
await p.click('#boardFilterBtn');
await new Promise((r) => setTimeout(r, 200));
await p.screenshot({ path: dir + '/filter-panel.png' });
await b.close();
console.log('screenshots saved →', dir);
