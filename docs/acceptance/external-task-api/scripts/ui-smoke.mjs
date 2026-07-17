// 「API 密钥」页 UI 冒烟（puppeteer-core + 系统 Edge headless，真实浏览器渲染）。
// 前置：隔离实例已起（同 api-tests.mjs）。用法：node ui-smoke.mjs [baseUrl]
// 断言原则：可见性用 getBoundingClientRect 非退化（>0）+ 负对照（board 应为 0），不做等值假 PASS。
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:18799';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const results = [];
const record = (id, pass, detail) => { results.push({ id, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/#/apikeys`, { waitUntil: 'networkidle2', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 800));

  // U1 路由/导航：view-apikeys 可见（rect 非退化）、view-board 为负对照（rect=0）、导航项高亮
  const vis = await page.evaluate(() => {
    const r = (id) => { const el = document.getElementById(id); if (!el) return null; const b = el.getBoundingClientRect(); return { w: b.width, h: b.height }; };
    return {
      apikeys: r('view-apikeys'), board: r('view-board'),
      navActive: document.querySelector('.topnav a.active')?.dataset?.nav || null,
      title: document.getElementById('crumbs')?.textContent || '',
    };
  });
  record('U1-route', !!vis.apikeys && vis.apikeys.w > 200 && vis.apikeys.h > 100
    && vis.board && vis.board.w === 0 && vis.board.h === 0
    && vis.navActive === 'apikeys' && vis.title.includes('API 密钥'),
    `视图可见 ${JSON.stringify(vis.apikeys)}，board 负对照 ${JSON.stringify(vis.board)}，nav=${vis.navActive}，面包屑含标题=${vis.title.includes('API 密钥')}`);

  // U2a 策略必选拦截：只填 label/source 不选策略 → 点生成 → 前端必选报错、不出明文框
  await page.type('#akLabelInput', 'UI 冒烟密钥');
  await page.type('#akSourceInput', 'uismoke');
  await page.click('#akCreateBtn');
  await page.waitForFunction(() => {
    const el = document.getElementById('akCreateErr');
    return el && getComputedStyle(el).display !== 'none' && /必选/.test(el.textContent || '');
  }, { timeout: 5000 });
  const noPlain = await page.evaluate(() => !document.getElementById('akPlainText'));
  record('U2a-policy-required', noPlain, `全不选被拦（必选报错可见、无明文框）`);

  // U2b 补全策略 → 生成成功：一次性明文框出现（swak_ 开头）+ curl 示例
  await page.evaluate(() => {
    document.querySelector('#akModelsBox input[value="claude-opus-4-8"]').click();
    document.querySelector('#akEffortsBox input[value="xhigh"]').click();
    document.getElementById('akCwdsInput').value = 'C:\\Windows';
  });
  await page.click('#akCreateBtn');
  await page.waitForFunction(() => {
    const el = document.getElementById('akPlainText');
    return el && /^swak_[A-Za-z0-9_-]{40,}$/.test(el.textContent || '');
  }, { timeout: 5000 });
  const plainOk = await page.evaluate(() => {
    const box = document.getElementById('akPlainBox');
    const b = box.getBoundingClientRect();
    return { rect: b.width > 200 && b.height > 40, curl: /api\/external\/task\/create/.test(box.textContent) };
  });
  record('U2b-create', plainOk.rect && plainOk.curl, `补全策略后生成成功：明文框可见=${plainOk.rect} curl 示例=${plainOk.curl}`);

  // U3 列表含新 key 行（来源 uismoke、启用态）
  await page.waitForFunction(() => document.querySelector('#akListBox table'), { timeout: 5000 });
  const row = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#akListBox tbody tr')].find((x) => x.textContent.includes('uismoke'));
    return tr ? { text: tr.textContent, hasToggle: !!tr.querySelector('[data-ak-toggle]'), hasDel: !!tr.querySelector('[data-ak-del]') } : null;
  });
  record('U3-list-row', !!row && row.text.includes('UI 冒烟密钥') && row.text.includes('启用') && row.hasToggle && row.hasDel,
    `列表行=${!!row} 备注/状态/按钮齐全=${!!row && row.hasToggle && row.hasDel}`);

  // U4 禁用：点该行「禁用」→ 状态变「已禁用」、按钮文案变「启用」
  await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#akListBox tbody tr')].find((x) => x.textContent.includes('uismoke'));
    tr.querySelector('[data-ak-toggle]').click();
  });
  await page.waitForFunction(() => {
    const tr = [...document.querySelectorAll('#akListBox tbody tr')].find((x) => x.textContent.includes('uismoke'));
    return tr && tr.textContent.includes('已禁用');
  }, { timeout: 5000 });
  record('U4-toggle', true, '禁用后行内出现「已禁用」');

  // U5 删除：点删除 → customConfirm 弹窗出现 → 确认 → 行消失
  await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#akListBox tbody tr')].find((x) => x.textContent.includes('uismoke'));
    tr.querySelector('[data-ak-del]').click();
  });
  await page.waitForFunction(() => {
    const ov = [...document.querySelectorAll('.overlay')].find((x) => getComputedStyle(x).display !== 'none');
    return ov && /删除密钥/.test(ov.textContent);
  }, { timeout: 5000 });
  await page.evaluate(() => {
    const ov = [...document.querySelectorAll('.overlay')].find((x) => getComputedStyle(x).display !== 'none');
    const btn = [...ov.querySelectorAll('button')].find((b) => b.textContent.trim() === '删除');
    btn.click();
  });
  await page.waitForFunction(() => {
    const trs = [...document.querySelectorAll('#akListBox tbody tr')];
    return trs.length === 0 ? !!document.querySelector('#akListBox div') : !trs.some((x) => x.textContent.includes('uismoke'));
  }, { timeout: 5000 });
  record('U5-delete', true, '确认弹窗出现、确认后行移除');

  await page.screenshot({ path: process.env.UI_SHOT || 'ui-apikeys.png' });
} finally {
  await browser.close();
}
const fails = results.filter((x) => !x.pass);
console.log(`\n== ${results.length - fails.length}/${results.length} PASS ==`);
process.exit(fails.length ? 1 : 0);
