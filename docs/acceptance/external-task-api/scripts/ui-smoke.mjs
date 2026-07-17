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

  // U2a 弹窗打开 + 策略必选拦截：「＋ 生成密钥」开弹窗 → 只填 label/source → 点生成 → 弹窗内必选报错、弹窗不关、无明文
  await page.click('#akNewBtn');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('akModal')).display !== 'none', { timeout: 5000 });
  await page.type('#akLabelInput', 'UI 冒烟密钥');
  await page.type('#akSourceInput', 'uismoke');
  await page.click('#akCreateBtn');
  await page.waitForFunction(() => {
    const el = document.getElementById('akCreateErr');
    return el && getComputedStyle(el).display !== 'none' && /必选/.test(el.textContent || '');
  }, { timeout: 5000 });
  const u2a = await page.evaluate(() => ({
    modalOpen: getComputedStyle(document.getElementById('akModal')).display !== 'none',
    title: document.getElementById('akModalTitle').textContent,
    noPlain: !document.getElementById('akPlainText'),
  }));
  record('U2a-policy-required', u2a.modalOpen && u2a.title === '生成密钥' && u2a.noPlain,
    `弹窗打开（标题=${u2a.title}）、必选报错在弹窗内、未关闭、无明文`);

  // U2b 补全策略 → 生成成功：弹窗关闭 + 明文横幅出现（swak_）+ curl 示例
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
    return {
      rect: b.width > 200 && b.height > 40,
      curl: /api\/external\/task\/create/.test(box.textContent),
      modalClosed: getComputedStyle(document.getElementById('akModal')).display === 'none',
    };
  });
  record('U2b-create', plainOk.rect && plainOk.curl && plainOk.modalClosed,
    `生成成功：弹窗已关=${plainOk.modalClosed} 明文横幅=${plainOk.rect} curl=${plainOk.curl}`);

  // U3 列表含新 key 行（来源 uismoke、启用态）。等行出现而非等 table：明文框先渲染、
  // 列表刷新是其后的异步 fetch，旧 table 一直在，等 table 会竞态假过。
  await page.waitForFunction(() => [...document.querySelectorAll('#akListBox tbody tr')].some((x) => x.textContent.includes('uismoke')), { timeout: 5000 });
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

  // U6 编辑：行内「编辑」→ 弹窗打开且回填 + 标题/按钮切编辑态 → 改备注保存 → 弹窗关、行更新、不出新明文
  await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#akListBox tbody tr')].find((x) => x.textContent.includes('uismoke'));
    tr.querySelector('[data-ak-edit]').click();
  });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('akModal')).display !== 'none', { timeout: 5000 });
  const editState = await page.evaluate(() => ({
    title: document.getElementById('akModalTitle').textContent,
    label: document.getElementById('akLabelInput').value,
    btn: document.getElementById('akCreateBtn').textContent,
    cwd: document.getElementById('akCwdsInput').value,
    modelChecked: !!document.querySelector('#akModelsBox input[value="claude-opus-4-8"]:checked'),
  }));
  await page.evaluate(() => {
    document.getElementById('akLabelInput').value = 'UI 冒烟密钥改';
    document.getElementById('akPlainBox').style.display = 'none';
    document.getElementById('akPlainBox').innerHTML = '';
  });
  await page.click('#akCreateBtn');
  await page.waitForFunction(() => {
    const tr = [...document.querySelectorAll('#akListBox tbody tr')].find((x) => x.textContent.includes('uismoke'));
    return tr && tr.textContent.includes('UI 冒烟密钥改') && getComputedStyle(document.getElementById('akModal')).display === 'none';
  }, { timeout: 5000 });
  const noNewPlain = await page.evaluate(() => !document.getElementById('akPlainText'));
  record('U6-edit', editState.title === '编辑密钥' && editState.label === 'UI 冒烟密钥' && editState.btn === '保存修改' && editState.modelChecked && !!editState.cwd && noNewPlain,
    `弹窗编辑态（标题=${editState.title}、按钮=${editState.btn}、回填齐）+ 保存后弹窗关、行更新、无新明文`);

  // U7 复制：行内「复制」= 取回原密钥明文——剪贴板成功（按钮变「已复制」）或降级弹窗展示原文，二取一
  await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#akListBox tbody tr')].find((x) => x.textContent.includes('uismoke'));
    tr.querySelector('[data-ak-copy]').click();
  });
  await page.waitForFunction(() => {
    const tr = [...document.querySelectorAll('#akListBox tbody tr')].find((x) => x.textContent.includes('uismoke'));
    const btnCopied = tr && [...tr.querySelectorAll('button')].some((b) => b.textContent.trim() === '已复制');
    const ov = [...document.querySelectorAll('.overlay')].find((x) => getComputedStyle(x).display !== 'none');
    const fallback = ov && /swak_[A-Za-z0-9_-]{40,}/.test(ov.textContent || '');
    return btnCopied || fallback;
  }, { timeout: 5000 });
  const copied = await page.evaluate(() => {
    const ov = [...document.querySelectorAll('.overlay')].find((x) => getComputedStyle(x).display !== 'none');
    if (ov) {
      const m = /swak_[A-Za-z0-9_-]{40,}/.exec(ov.textContent || '');
      const btn = [...ov.querySelectorAll('button')].find((b) => /确定|关闭|好/.test(b.textContent));
      if (btn) btn.click();
      return { via: 'fallback-alert', plain: m ? m[0] : null };
    }
    return { via: 'clipboard', plain: null };
  });
  record('U7-copy-original', true, `取回原文成功（途径=${copied.via}）`);

  // U5 删除：删除 uismoke 钥（customConfirm 确认）→ 行移除
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
  await page.waitForFunction(() => ![...document.querySelectorAll('#akListBox tbody tr')].some((x) => x.textContent.includes('uismoke')), { timeout: 5000 });
  record('U5-delete', true, 'uismoke 钥经确认弹窗删除、行移除');

  // U8 看板「新建任务」回归：同源收口后看板自身零感知（浏览器同源 fetch 自带 Origin 过闸）
  await page.goto(`${BASE}/#/board`, { waitUntil: 'networkidle2', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 500));
  await page.click('#newTaskBtn');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('newTaskModal')).display !== 'none', { timeout: 5000 });
  await page.type('#newTaskTitle', 'UI冒烟-看板新建回归');
  await page.type('#newTaskPrompt', '冒烟占位指令');
  await page.click('#newTaskSubmit');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('newTaskModal')).display === 'none', { timeout: 8000 });
  const boardCreated = await fetch(`${BASE}/api/state`).then((r) => r.json())
    .then((s) => (s.lifecycle?.plan || []).some((t) => (t.title || '').includes('UI冒烟-看板新建回归')));
  record('U8-board-create', boardCreated, `看板新建经同源闸成功、plan 桶出卡=${boardCreated}`);

  await page.screenshot({ path: process.env.UI_SHOT || 'ui-apikeys.png' });
} finally {
  await browser.close();
}
const fails = results.filter((x) => !x.pass);
console.log(`\n== ${results.length - fails.length}/${results.length} PASS ==`);
process.exit(fails.length ? 1 : 0);
