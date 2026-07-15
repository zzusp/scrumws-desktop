// 真实浏览器复现：编辑（退回 plan / worktree）态的高 modal 里，日期时间控件选日期是否生效。
// 用真实 index.html + app.js + CSS（standalone 服务），Edge/Chrome headless 驱动，检测：
//   - 打开弹层后所选日格是否在视口内、点击是否被别的元素拦截（elementFromPoint）
//   - 点击后 hidden.value / 标签是否更新
// 运行：node docs/acceptance/task-replan-resume/scripts/repro-dtpicker-browser.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '../../../..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const exe = fs.existsSync(EDGE) ? EDGE : CHROME;
const PORT = 8794;
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dtrepro-'));

const srv = spawn(process.execPath, [path.join(repo, 'platform/standalone.js')], {
  env: { ...process.env, SCRUMWS_PORT: String(PORT), SCRUMWS_DATA_ROOT: dataRoot },
  stdio: 'ignore', windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/state`); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

let pass = 0, fail = 0;
const ok = (c, m, d) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m + (d ? ` — ${JSON.stringify(d)}` : ''))); };

const browser = await (async () => {
  if (!(await waitServer())) { console.error('❌ standalone 未起来'); srv.kill(); process.exit(2); }
  return puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] });
})();

try {
  const page = await browser.newPage();
  const VH = Number(process.env.VH || 620);
  await page.setViewport({ width: 1200, height: VH });   // 矮视口 → 把定时字段顶到偏下，逼近真实编辑态
  console.log(`>>> viewport height = ${VH}`);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('typeof window.__syncDtPicker === "function"', { timeout: 8000 });

  console.log('[A] 进入「编辑（退回 plan / worktree）」视觉态：显示高 modal + 回填 scheduledAt');
  await page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    $('newTaskModal').style.display = 'flex';
    $('newTaskWorktreeRow').style.display = 'flex';       // worktree 行可见 → modal 变高
    const hint = $('newTaskDirLockHint'); if (hint) hint.style.display = 'block';
    $('newTaskScheduledAt').value = '2026-08-01T14:30';
    window.__syncDtPicker();
  });
  await sleep(300);   // 过掉 modal open 动画（rise .25s，期间 transform 会影响 fixed 定位）
  ok((await page.evaluate(() => document.getElementById('newTaskDtLabel').textContent)).includes('2026-08-01 14:30'), '标签回填 2026-08-01 14:30');
  const geo = await page.evaluate(() => {
    const card = document.querySelector('#newTaskModal .modal-card');
    const btn = document.getElementById('newTaskDtBtn');
    const cr = card.getBoundingClientRect(), br = btn.getBoundingClientRect();
    return { cardH: Math.round(cr.height), cardTop: Math.round(cr.top), cardBottom: Math.round(cr.bottom), btnTop: Math.round(br.top), btnBottom: Math.round(br.bottom), vh: window.innerHeight };
  });
  console.log('    几何：', JSON.stringify(geo), geo.cardH > geo.vh ? '→ modal 高于视口（下缘字段不可达）' : '→ modal 适配视口');

  console.log('[B] 滚动定时字段入视口（可滚动 modal）→ 打开日历弹层 → 目标日格 15 号的可见性 / 是否被拦截');
  await page.evaluate(() => document.getElementById('newTaskDtBtn').scrollIntoView({ block: 'center' }));   // 真实用户：先滚到该字段
  await sleep(250);   // 滚动落定再点（避免滚动事件把刚开的弹层关掉——真实用户也是滚完停下再点）
  const openDiag = await page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    const pop = $('newTaskDtPop');
    const before = pop.classList.contains('open');
    let threw = null;
    try { $('newTaskDtBtn').click(); } catch (e) { threw = String(e); }
    return { before, afterImmediate: pop.classList.contains('open'), threw };
  });
  console.log('    诊断 openDiag=', JSON.stringify(openDiag));
  await sleep(250);   // 过 rise .15s；看是否被异步关掉
  const probe = await page.evaluate(() => {
    const pop = document.getElementById('newTaskDtPop');
    const open = pop.classList.contains('open');
    const day = [...document.querySelectorAll('.dt-day:not(.other)')].find((b) => b.dataset.d === '15');
    if (!day) return { open, hasDay: false };
    const r = day.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const pr = pop.getBoundingClientRect();
    return {
      open, hasDay: true, cx, cy,
      dayRect: { top: Math.round(r.top), left: Math.round(r.left), bottom: Math.round(r.bottom) },
      popRect: { top: Math.round(pr.top), bottom: Math.round(pr.bottom), left: Math.round(pr.left) },
      vh: window.innerHeight, vw: window.innerWidth,
      hitIsDay: hit === day || (day.contains(hit)),
      hitTag: hit ? `${hit.tagName}.${hit.className}` : null,
    };
  });
  ok(probe.open, '弹层已打开');
  ok(probe.hasDay, '渲染出 15 号日格');
  ok(probe.popRect && probe.popRect.top >= 0 && probe.popRect.bottom <= probe.vh, '弹层完整落在视口内（未溢出上/下沿）', probe.popRect && { pop: probe.popRect, vh: probe.vh });
  ok(probe.dayRect && probe.dayRect.top >= 0 && probe.dayRect.bottom <= probe.vh, '15 号日格在视口内', probe.dayRect && { day: probe.dayRect, vh: probe.vh });
  ok(probe.hitIsDay, `点位命中的是 15 号日格本身（未被其它元素拦截）`, { hitTag: probe.hitTag, at: [probe.cx, probe.cy] });

  console.log('[C] 真实鼠标点 15 号 → hidden.value / 标签应更新为 15 号');
  const before = await page.evaluate(() => document.getElementById('newTaskScheduledAt').value);
  if (probe.hasDay) await page.mouse.click(probe.cx, probe.cy);
  await sleep(150);
  const after = await page.evaluate(() => ({
    v: document.getElementById('newTaskScheduledAt').value,
    label: document.getElementById('newTaskDtLabel').textContent,
    open: document.getElementById('newTaskDtPop').classList.contains('open'),
  }));
  ok(after.v !== before, `点 15 号后 hidden.value 变化`, { before, after: after.v });
  ok(/^\d{4}-\d{2}-15T/.test(after.v), 'hidden.value 落到 15 号', after.v);
  ok(after.label.includes('-15 '), '标签同步 15 号', after.label);
  ok(after.open, '选日期后弹层仍开（不自动关）');

  if (errs.length) { console.log('  ⚠ 页面 JS 错误：', errs.slice(0, 3)); }
  console.log(`\n==== ${fail === 0 ? '✅ ALL PASS' : '❌ FAIL/复现'} : ${pass} passed, ${fail} failed ====`);
} finally {
  await browser.close();
  srv.kill();
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
}
process.exit(fail === 0 ? 0 : 1);
