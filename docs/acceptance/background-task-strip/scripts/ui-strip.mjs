// UI 取证：后台任务栏在真浏览器（系统 Edge）里的渲染与位置。
// 数据通路由 e2e-api.mjs 用真 CC 会话验；这里只验渲染 + 布局位置（是否真夹在内容区与发送区之间）。
// 位置断言带基线非退化校验（display:none 下 rect 全 0 会让等值断言假 PASS）+ 空列表负对照。
//
// 跑法：先起看板（见 e2e-api.mjs 头部），然后
//   npm install --no-save --prefer-offline puppeteer-core
//   node docs/acceptance/background-task-strip/scripts/ui-strip.mjs
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 截图只作人工核对，落临时目录：不入库（acceptance 红线：大 binary 不入库，留再生成配方即可）
const SHOT = path.join(os.tmpdir(), 'bg-strip.png');
const PORT = process.env.SCRUMWS_PORT || 8893;
let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof mbRenderBgTasks === 'function', { timeout: 10000 });

// 打开任务详情视图（直接切视图 + 注入 mb 状态，绕过需要真会话的加载路径——数据通路另测）
const shot = await page.evaluate(() => {
  document.querySelectorAll('.view').forEach((v) => { v.style.display = 'none'; });
  document.getElementById('view-task').style.display = '';
  document.getElementById('modalReplyBox').style.display = '';
  document.getElementById('modalBody').innerHTML = '<div style="height:400px">消息流占位</div>';
  mb = {
    id: 'x', bgTasks: [
      { task_id: 'b83iee8rv', task_type: 'local_bash', description: 'Sleep for 240 seconds' },
      { task_id: 'ae24cdd9ab', task_type: 'local_agent', description: '查前端草稿localStorage机制' },
    ], bgOutFor: null,
  };
  mbRenderBgTasks();
  const el = document.getElementById('modalBgTasks');
  const body = document.getElementById('modalBody');
  const reply = document.getElementById('modalReplyBox');
  const r = (n) => { const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, w: b.width, h: b.height }; };
  return {
    visible: getComputedStyle(el).display !== 'none',
    rects: { strip: r(el), body: r(body), reply: r(reply) },
    rows: el.querySelectorAll('.bg-task-row').length,
    kinds: [...el.querySelectorAll('.bg-task-kind')].map((x) => x.textContent),
    descs: [...el.querySelectorAll('.bg-task-desc')].map((x) => x.textContent),
    acts: [...el.querySelectorAll('.bg-task-act')].map((x) => x.textContent),
    headText: el.querySelector('.bg-tasks-head')?.textContent?.trim(),
  };
});

console.log(JSON.stringify(shot.rects, null, 1));
t('栏可见', shot.visible === true);
t('基线非退化（栏有真实尺寸，非 0×0）', shot.rects.strip.h > 10 && shot.rects.strip.w > 100, `${Math.round(shot.rects.strip.w)}×${Math.round(shot.rects.strip.h)}`);
t('位置：在内容展示区下方', shot.rects.strip.top >= shot.rects.body.bottom - 1, `strip.top=${Math.round(shot.rects.strip.top)} body.bottom=${Math.round(shot.rects.body.bottom)}`);
t('位置：在消息发送区上方', shot.rects.strip.bottom <= shot.rects.reply.top + 1, `strip.bottom=${Math.round(shot.rects.strip.bottom)} reply.top=${Math.round(shot.rects.reply.top)}`);
t('与发送区同宽居中（左边缘对齐）', Math.abs(shot.rects.strip.left - shot.rects.reply.left) < 2, `strip.left=${Math.round(shot.rects.strip.left)} reply.left=${Math.round(shot.rects.reply.left)}`);
t('两条任务各一行', shot.rows === 2, `实际 ${shot.rows}`);
t('类型标签按 task_type 映射', JSON.stringify(shot.kinds) === JSON.stringify(['后台命令', 'subagent']), JSON.stringify(shot.kinds));
t('描述取自 CC 的 description', shot.descs[0] === 'Sleep for 240 seconds', JSON.stringify(shot.descs));
t('每行都有「查看」「停止」', JSON.stringify(shot.acts) === JSON.stringify(['查看', '停止', '查看', '停止']), JSON.stringify(shot.acts));
t('栏头显示条数', /后台任务 2/.test(shot.headText || ''), shot.headText);

// 负对照：空列表必须整条隐藏（否则空栏白占位）
const empty = await page.evaluate(() => {
  mb.bgTasks = []; mbRenderBgTasks();
  const el = document.getElementById('modalBgTasks');
  return { display: getComputedStyle(el).display, html: el.innerHTML.length };
});
t('负对照：无后台任务时整条隐藏', empty.display === 'none' && empty.html === 0, `display=${empty.display} htmlLen=${empty.html}`);

await page.screenshot({ path: SHOT });
console.log(`\n合计 PASS=${pass} FAIL=${fail}  截图 ${SHOT}`);
await browser.close();
process.exit(fail ? 1 : 0);
