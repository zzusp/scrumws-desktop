// 看板迭代截图证据：卡片（含 worktree 双目录）+ 工作目录下拉（含 worktree 选项）。用法：node shot.mjs（需 8790 服务在跑）
import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dir = 'D:/project/scrumws-desktop/.claude/worktrees/20260715135813-626/docs/acceptance/board-filter-iteration/round-1';
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 900 });
await p.goto('http://127.0.0.1:8790/#/board', { waitUntil: 'networkidle2' });
await p.waitForSelector('#lifecycleGrid .taskcard', { timeout: 8000 });
await p.screenshot({ path: dir + '/board-cards.png' });   // 含 worktree 任务双目录卡片
await p.click('#boardFilterBtn');
await new Promise((r) => setTimeout(r, 150));
await p.click('#fpCwdBtn');       // 展开工作目录下拉（含 worktree 选项）
await new Promise((r) => setTimeout(r, 150));
await p.screenshot({ path: dir + '/filter-cwd-dropdown.png' });
await b.close();
console.log('screenshots saved →', dir);
