// 看板筛选迭代 UI 验收：真实 Chrome 驱动 http://127.0.0.1:8790/#/board（合成数据），断言 req1-6。
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://127.0.0.1:8790/#/board';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

const readCards = () => [...document.querySelectorAll('#lifecycleGrid .taskcard')].map((c) => ({
  title: c.querySelector('.card-title')?.textContent.trim() || '',
  cwd: c.querySelector('.card-sub')?.textContent.trim() || '',
  activity: c.querySelector('.card-status')?.textContent.trim() || '',
  source: c.querySelector('.card-foot .tag')?.textContent.trim() || '',
  html: c.innerHTML,
}));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  // 真正的 JS 运行时错误（排除「Failed to load resource」——资源加载失败改由 response 状态码把关）
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console.error: ' + m.text()); });
  // 资源加载失败：按状态码抓，忽略 favicon.ico 的 404（浏览器自动请求，本应用无 favicon，与本次改动无关）
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) errs.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#lifecycleGrid .taskcard', { timeout: 8000 });

  // ---- req2：卡片只留 标题 / 工作目录 / 最后活动时间 + 底部标签&操作 ----
  const cards = await page.evaluate(readCards);
  ok(cards.length === 4, `渲染 4 张卡（实际 ${cards.length}）`);
  const alpha = cards.find((c) => c.title.includes('登录页'));
  ok(!!alpha, 'plan 卡片存在');
  ok(alpha && alpha.cwd.includes('scrumws-desktop'), `卡片显示工作目录（${alpha?.cwd}）`);
  ok(alpha && /最后活动/.test(alpha.activity), `卡片显示最后活动时间（${alpha?.activity}）`);
  const leaked = cards.some((c) => /总耗时|心跳|排队 |待确认|运行 \d|轮\b|\$\d/.test(c.html));
  ok(!leaked, 'req2：卡片上半部分已去掉状态/耗时/心跳/描述等其余信息');
  const hasFoot = await page.evaluate(() => !!document.querySelector('.taskcard .card-foot .card-menu-btn'));
  ok(hasFoot, 'req2：底部标签 + 操作按钮保留');

  // ---- req5：manual → Manual ----
  ok(alpha && alpha.source === 'Manual', `req5：manual 来源标签显示 Manual（实际 ${alpha?.source}）`);

  // ---- req6：桶提示文案 ----
  const hints = await page.evaluate(() => ({
    plan: document.querySelector('#section-plan .col-hint')?.textContent.trim(),
    processing: document.querySelector('#section-processing .col-hint')?.textContent.trim(),
  }));
  ok(hints.plan === '待定', `req6：plan 提示「待定」（实际 ${hints.plan}）`);
  ok(hints.processing === '处理中', `req6：processing 提示「处理中」（实际 ${hints.processing}）`);

  // ---- req1：筛选按钮 + 面板 + 来源为自定义下拉（非原生 select），选项取自真实数据 ----
  ok(await page.evaluate(() => document.querySelector('.board-toolbar').textContent.includes('筛选')), 'req1：工具行有「筛选」按钮');
  await page.click('#boardFilterBtn');
  ok(await page.evaluate(() => document.querySelector('#boardFilterPanel').classList.contains('open')), 'req1：点击打开筛选面板');
  // 来源改为自定义下拉：无原生 select、有 .fp-dd 触发按钮 + .fp-dd-menu 选项面板
  const noNativeSelect = await page.evaluate(() => !document.querySelector('#boardFilterPanel select')
    && !!document.querySelector('#fpSourceDD .fp-dd-btn') && !!document.querySelector('#fpSourceMenu.fp-dd-menu')
    && !!document.querySelector('#fpCwdDD .fp-dd-btn') && !!document.querySelector('#fpCwdMenu.fp-dd-menu'));
  ok(noNativeSelect, '来源/工作目录改为自定义下拉（无原生 select，选项面板同款 .fp-dd-menu）');
  // 打开来源下拉，读选项面板项
  await page.click('#fpSourceBtn');
  const srcOpen = await page.evaluate(() => $('fpSourceMenu').classList.contains('open') && $('fpSourceBtn').classList.contains('open'));
  ok(srcOpen, 'req1：点击来源下拉展开选项面板');
  const srcOpts = await page.evaluate(() => [...document.querySelectorAll('#fpSourceMenu .fp-dd-item')].map((c) => c.textContent.replace('✓', '').trim()));
  // 来源按字母序：chat→dws / issue→issue / manual→Manual（数据里没有 cli 任务 → 不出 CLI 选项，证明取自真实数据）
  ok(JSON.stringify(srcOpts) === JSON.stringify(['全部', 'dws', 'issue', 'Manual']),
    `req1：来源选项取自真实数据（${srcOpts.join('/')}）`);

  // 点 Manual 选项 → 只剩 2 张 manual 卡（alpha plan + delta done）+ 触发按钮标签更新
  await page.evaluate(() => [...document.querySelectorAll('#fpSourceMenu .fp-dd-item')].find((c) => c.textContent.replace('✓', '').trim() === 'Manual').click());
  let shown = await page.evaluate(readCards);
  ok(shown.length === 2 && shown.every((c) => c.source === 'Manual'), `req1：按 Manual 筛选后只剩 manual 卡（${shown.length} 张）`);
  const srcLabel = await page.evaluate(() => $('fpSourceBtn').querySelector('.fp-dd-label').textContent.trim());
  ok(srcLabel === 'Manual', `req1：来源下拉触发按钮显示当前选择（${srcLabel}）`);
  const counts1 = await page.evaluate(() => ({ plan: $('count-plan').textContent, done: $('count-done').textContent, processing: $('count-processing').textContent }));
  ok(counts1.plan === '1' && counts1.done === '1' && counts1.processing === '0', `req1：计数随筛选更新（plan=${counts1.plan} done=${counts1.done} proc=${counts1.processing}）`);
  const badge1 = await page.evaluate(() => ({ txt: $('filterBadge').textContent, shown: getComputedStyle($('filterBadge')).display !== 'none' }));
  ok(badge1.shown && badge1.txt === '1', `req1：筛选徽章显示激活数（${badge1.txt}）`);

  // ---- req3：工作目录为自定义下拉，选项取真实 cwd ----
  // 先清来源（选「全部」）
  await page.click('#fpSourceBtn');
  await page.evaluate(() => [...document.querySelectorAll('#fpSourceMenu .fp-dd-item')].find((c) => c.textContent.replace('✓', '').trim() === '全部').click());
  await page.click('#fpCwdBtn');
  const cwdOpts = await page.evaluate(() => [...document.querySelectorAll('#fpCwdMenu .fp-dd-item')].map((c) => c.querySelector('.fp-dd-path').title));
  ok(cwdOpts.includes('D:\\project\\scrumws-desktop') && cwdOpts.includes('D:\\work\\another-repo\\packages\\ui') && cwdOpts.length === 3,
    `req3：工作目录选项取自真实数据（${cwdOpts.length} 项含全部）`);
  // 选 cwd=另一 repo → chat bravo + manual delta
  await page.evaluate(() => [...document.querySelectorAll('#fpCwdMenu .fp-dd-item')].find((c) => c.querySelector('.fp-dd-path').title === 'D:\\work\\another-repo\\packages\\ui').click());
  shown = await page.evaluate(readCards);
  ok(shown.length === 2 && shown.every((c) => c.cwd.includes('another-repo')), `req3：按工作目录筛选（${shown.length} 张，标题 ${shown.map((c) => c.title).join(',')}）`);

  // ---- req4：关键字筛选 ----
  // 清工作目录（选「全部」）
  await page.click('#fpCwdBtn');
  await page.evaluate(() => [...document.querySelectorAll('#fpCwdMenu .fp-dd-item')].find((c) => c.textContent.replace('✓', '').trim() === '全部').click());
  await page.type('#fpKeyword', '登录');
  shown = await page.evaluate(readCards);
  ok(shown.length === 1 && shown[0].title.includes('登录'), `req4：关键字「登录」→ 1 张（${shown.map((c) => c.title).join(',')}）`);
  await page.evaluate(() => { const el = $('fpKeyword'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });

  // ---- req4：sessionId 筛选 ----
  await page.type('#fpSessionId', 'bbbb1111');
  shown = await page.evaluate(readCards);
  ok(shown.length === 1 && shown[0].title.includes('崩溃'), `req4：sessionId「bbbb1111」→ 命中 issue 卡（${shown.map((c) => c.title).join(',')}）`);

  // ---- 清除筛选 ----
  await page.click('#fpClear');
  shown = await page.evaluate(readCards);
  const badge2 = await page.evaluate(() => getComputedStyle($('filterBadge')).display === 'none');
  ok(shown.length === 4 && badge2, `清除筛选：恢复 4 张卡 + 徽章隐藏（${shown.length} 张）`);

  ok(errs.length === 0, `无 JS 运行时错误${errs.length ? '：' + errs.join(' | ') : ''}`);
  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
