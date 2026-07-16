// 截图 + 量取「仅一个 textarea 的弹窗」(customPrompt) 的纵向间距。
// 用法: node shot-prompt-modal.mjs <out.png>   （需 SCRUMWS_PORT=8931 的 verify server 在跑）
import puppeteer from 'file:///D:/project/scrumws-desktop/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const out = process.argv[2] || 'shot.png';
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--force-device-scale-factor=2'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:8931/', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.customPrompt === 'function');

// 完全照搬 editTaskDesc() 的入参（app.js:719-724）
await page.evaluate(() => {
  window.customPrompt({
    title: '任务描述',
    message: '<span style="color:var(--mut);font-size:11px">自己看的备注 · 不会发给 claude · 清空保存 = 删除</span>',
    initial: '',
    placeholder: '记录任务背景 / 想达成什么 / 归档前的进展…',
  });
});
await new Promise((r) => setTimeout(r, 300));

const gaps = await page.evaluate(() => {
  const r = (el) => el.getBoundingClientRect();
  const card = document.querySelector('.confirm-card');
  const title = document.getElementById('confirmTitle');
  const body = document.getElementById('confirmBody');
  const msg = body.querySelector('div');
  const ta = document.getElementById('confirmPromptInput');
  const hint = document.getElementById('promptCount').parentElement;
  const actions = document.querySelector('.confirm-actions');
  return {
    cardHeight: Math.round(r(card).height),
    '标题↓小字': Math.round(r(msg).top - r(title).bottom),
    '小字↓textarea': Math.round(r(ta).top - r(msg).bottom),
    'textarea↓提示行': Math.round(r(hint).top - r(ta).bottom),
    '提示行↓按钮': Math.round(r(actions).top - r(hint).bottom),
    bodyWhiteSpace: getComputedStyle(body).whiteSpace,
  };
});
console.log(JSON.stringify(gaps, null, 2));

await page.screenshot({ path: out, clip: (await page.evaluate(() => {
  const b = document.querySelector('.confirm-card').getBoundingClientRect();
  return { x: b.x - 12, y: b.y - 12, width: b.width + 24, height: b.height + 24 };
}))});
await browser.close();
