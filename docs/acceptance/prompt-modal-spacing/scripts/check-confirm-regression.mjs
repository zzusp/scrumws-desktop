// 回归：pre-wrap 从 .confirm-body 下沉到 .confirm-text 之后
//  - 往 #confirmBody 塞「缩进过的 HTML」不再渲染出空行（源头治理的直接证明）
//  - customConfirm/customAlert 的动态纯文本 \n 仍靠 .confirm-text 断行（能力没丢）
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
const esc = async () => { await page.keyboard.press('Escape'); await sleep(150); };

// 注意：evaluate 回调必须用块体、别 return customPrompt/customConfirm 的 Promise——
// puppeteer 会 await 它，而它只在用户交互后 resolve（会挂死）

// --- 源头：body 不再有 pre-wrap，缩进 HTML 不产生空行 ---
await page.evaluate(() => { window.customPrompt({ title: '任务描述', message: '<span>备注</span>', initial: '' }); });
await sleep(200);
check('confirmBody white-space=normal（基类就不带 pre-wrap）',
  await page.evaluate(() => getComputedStyle(document.getElementById('confirmBody')).whiteSpace), 'normal');
check('customPrompt 不再改 className（无需 cleanup 还原）',
  await page.evaluate(() => document.getElementById('confirmBody').className), 'confirm-body');
// customPrompt 用的仍是缩进过的模板字面量 —— 源头治好了它就该正常
check('标题↓小字 < 20px（模板缩进不再渲染成空行）',
  await page.evaluate(() => {
    const t = document.getElementById('confirmTitle').getBoundingClientRect();
    const m = document.querySelector('.prompt-msg').getBoundingClientRect();
    return Math.round(m.top - t.bottom) < 20;
  }), 'true');
await esc();

// --- 能力没丢：confirm 的动态纯文本 \n 仍断行 ---
const confirmRes = await page.evaluate(async () => {
  window.customConfirm({ title: '确认', message: '第一行\n第二行' });
  await new Promise((r) => setTimeout(r, 200));
  const txt = document.querySelector('#confirmBody .confirm-text');
  return { ws: getComputedStyle(txt).whiteSpace, height: Math.round(txt.getBoundingClientRect().height) };
});
check('confirm 的 .confirm-text 带 pre-wrap', confirmRes.ws, 'pre-wrap');
check('confirm 纯文本 \\n 仍断成两行(高度>30)', confirmRes.height > 30, 'true');
await esc();

// customAlert 同一条路径（错误弹窗常塞 escapeHtml(e.message)，可能带真 \n）
const alertRes = await page.evaluate(async () => {
  window.customAlert({ title: '操作失败', message: 'boom\nstack line 2' });
  await new Promise((r) => setTimeout(r, 200));
  const txt = document.querySelector('#confirmBody .confirm-text');
  return { ws: getComputedStyle(txt).whiteSpace, height: Math.round(txt.getBoundingClientRect().height) };
});
check('alert 的 .confirm-text 带 pre-wrap', alertRes.ws, 'pre-wrap');
check('alert 纯文本 \\n 仍断成两行(高度>30)', alertRes.height > 30, 'true');
await esc();

// --- 源头证明：往 body 塞缩进过的多行 HTML，不再多出空行 ---
// 修复前 confirm-body 的 pre-wrap 会把每处 "\n      " 渲染成 ~42px 空白；修复后应与紧凑写法等高
// 必须在 modal 可见时量：display:none 下 height 恒为 0，两边都 0 会假 PASS（下面 tight>0 就是防这个）
const indentRes = await page.evaluate(async () => {
  window.customConfirm({ title: '量缩进', message: 'x' });
  await new Promise((r) => setTimeout(r, 200));
  const b = document.getElementById('confirmBody');
  const measure = (html) => { b.innerHTML = html; return Math.round(b.getBoundingClientRect().height); };
  const tight = measure('<div>甲</div><div>乙</div>');
  const indented = measure(`
      <div>甲</div>
      <div>乙</div>
  `);
  return { tight, indented };
});
check('缩进对照基线非 0（modal 可见，断言没退化成永真）', indentRes.tight > 0, 'true');
check(`缩进 HTML 与紧凑 HTML 等高（缩进不再变空行，tight=${indentRes.tight}px）`, indentRes.indented, indentRes.tight);

// 负对照：把 pre-wrap 加回 body（= 修复前的样子），上面那条断言必须 FAIL——
// 否则它只是碰巧通过、根本抓不到这个 bug
const negative = await page.evaluate(async () => {
  const b = document.getElementById('confirmBody');
  b.style.whiteSpace = 'pre-wrap';
  const measure = (html) => { b.innerHTML = html; return Math.round(b.getBoundingClientRect().height); };
  const tight = measure('<div>甲</div><div>乙</div>');
  const indented = measure(`
      <div>甲</div>
      <div>乙</div>
  `);
  b.style.whiteSpace = '';
  return { tight, indented, delta: indented - tight };
});
check(`负对照：pre-wrap 一加回来缩进就变空行（+${negative.delta}px，证明断言有效）`, negative.delta > 20, 'true');
await esc();

// --- 另两个 customPrompt 调用点 ---
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
  await esc();
}

// --- 长文本 autoGrow 仍生效 ---
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
