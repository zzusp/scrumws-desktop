// 回归：customPrompt 开关一轮后，共用 #confirmBody 的 customConfirm/customAlert 必须拿回 pre-wrap
// （customPrompt 会给 body 挂 prompt-body 类关掉 pre-wrap，cleanup 不还原就会污染下一个 confirm）
// 用法: node check-confirm-regression.mjs   （需 SCRUMWS_PORT=8931 的 verify server 在跑）
import puppeteer from 'file:///D:/project/scrumws-desktop/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

// 看板首页有 5s 轮询 / SSE，networkidle2 可能永不 settle → 用 domcontentloaded + 等函数就绪
const stage = (s) => process.stdout.write(`[stage] ${s}\n`);
const watchdog = setTimeout(() => { process.stdout.write('[watchdog] 90s 超时，卡在上一个 stage\n'); process.exit(2); }, 90_000);

stage('launch');
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700 });
stage('goto');
await page.goto('http://127.0.0.1:8931/', { waitUntil: 'domcontentloaded' });
stage('wait customPrompt ready');
await page.waitForFunction(() => typeof window.customPrompt === 'function');
stage('ready');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got=${got} want=${want})`);
  if (!ok) fails.push(name);
};

// 1) prompt 打开时 body 关掉 pre-wrap
// 注意：evaluate 回调必须用块体、别 return customPrompt 的 Promise——puppeteer 会 await 它，而它只在用户交互后 resolve（会挂死）
await page.evaluate(() => { window.customPrompt({ title: '任务描述', message: '<span>备注</span>', initial: '' }); });
await sleep(200);
check('prompt 打开时 white-space=normal',
  await page.evaluate(() => getComputedStyle(document.getElementById('confirmBody')).whiteSpace), 'normal');

// 2) Esc 关闭后 body 还原 confirm-body
await page.keyboard.press('Escape');
await sleep(200);
check('prompt 关闭后 className 还原',
  await page.evaluate(() => document.getElementById('confirmBody').className), 'confirm-body');

// 3) 之后开 customConfirm：pre-wrap 回来了，且纯文本换行仍然断行（两行 → 高度 > 单行）
const confirmRes = await page.evaluate(async () => {
  window.customConfirm({ title: '确认', message: '第一行\n第二行' });
  await new Promise((r) => setTimeout(r, 200));
  const b = document.getElementById('confirmBody');
  return { ws: getComputedStyle(b).whiteSpace, height: Math.round(b.getBoundingClientRect().height) };
});
check('confirm 拿回 pre-wrap', confirmRes.ws, 'pre-wrap');
check('confirm 纯文本 \\n 仍断成两行(高度>30)', confirmRes.height > 30, 'true');
await page.keyboard.press('Escape');
await sleep(150);

// 4) 另两个 customPrompt 调用点（重命名 / rewind）同样紧凑：标题↓小字 应 < 20px
for (const [name, args] of [
  ['重命名任务', { title: '重命名任务', message: '<span>留空恢复默认</span>', initial: '某任务标题', maxlength: 200 }],
  ['rewind', { title: '改写并从这里重新执行（rewind）', message: '<span>同一会话内 rewind</span>', initial: '原消息内容' }],
]) {
  const gap = await page.evaluate(async (a) => {
    window.customPrompt(a);
    await new Promise((r) => setTimeout(r, 200));
    const t = document.getElementById('confirmTitle').getBoundingClientRect();
    const m = document.querySelector('.prompt-msg').getBoundingClientRect();
    return Math.round(m.top - t.bottom);
  }, args);
  check(`${name} 标题↓小字 < 20px`, gap < 20, 'true');
  await page.keyboard.press('Escape');
  await sleep(150);
}

// 5) 长文本 autoGrow 仍生效（内容多撑高，封顶 320）
const grown = await page.evaluate(async () => {
  window.customPrompt({ title: '任务描述', message: '<span>备注</span>', initial: 'x\n'.repeat(40) });
  await new Promise((r) => setTimeout(r, 250));
  return Math.round(document.getElementById('confirmPromptInput').getBoundingClientRect().height);
});
check('长文本 autoGrow 撑高且封顶 320', grown > 100 && grown <= 320, 'true');

stage('close');
await browser.close();
clearTimeout(watchdog);
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
