// 复现「编辑（退回 plan）任务时日期时间控件选择后无效」——用 jsdom 加载 app.js 真实 initDtPicker 源码驱动。
// 运行：node docs/acceptance/task-replan-resume/scripts/repro-dtpicker.mjs
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(here, '../../../../platform/public/app.js');
const appSrc = fs.readFileSync(appPath, 'utf8');

// 抽取真实源码：从 toDatetimeLocal 到 initDtPicker IIFE 收尾（不改写、用 app.js 原码）
const start = appSrc.indexOf('function toDatetimeLocal');
const marker = 'window.__syncDtPicker = syncFromHidden;';
const iifeEnd = appSrc.indexOf('})();', appSrc.indexOf(marker)) + '})();'.length;
if (start < 0 || iifeEnd < 5) { console.error('❌ 抽取 picker 源码失败'); process.exit(2); }
const pickerSrc = appSrc.slice(start, iifeEnd);

const dom = new JSDOM(`<!DOCTYPE html><body>
  <div id="newTaskModal" class="overlay" style="display:none"><div class="modal">
  <input type="hidden" id="newTaskScheduledAt">
  <div class="dt-wrap" id="newTaskDtWrap">
    <button type="button" class="dt-btn" id="newTaskDtBtn" aria-expanded="false">
      <span class="dt-btn-icon">🗓</span>
      <span class="dt-btn-label dim" id="newTaskDtLabel">留空 = 不定时</span>
      <span class="dt-btn-clear" id="newTaskDtClear" style="display:none">×</span>
      <span class="dt-btn-caret">▾</span>
    </button>
    <div class="dt-pop" id="newTaskDtPop" role="dialog"></div>
  </div></div></div>
</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });

const { window } = dom;
const { document } = window;
const $ = (id) => document.getElementById(id);
// jsdom 无布局：getBoundingClientRect 返回全 0，openPop 里只用于定位，不影响逻辑
window.innerHeight = 800;

// 用真实源码装配 picker（$ 注入闭包，等价 app.js 里的全局 $）
new window.Function('window', 'document', '$', pickerSrc)(window, document, $);

let pass = 0, fail = 0;
const ok = (c, m, d) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m + (d ? ` — ${d}` : ''))); };
const hidden = $('newTaskScheduledAt');
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

console.log('[A] 编辑（退回 plan）态：回填已有 scheduledAt → 控件显示该值');
{
  // 模拟 openEditTask：设 hidden 为回填值（task.json 的 yyyy-MM-dd HH:mm:ss 经 toDatetimeLocal 转 local）
  const backfill = '2026-08-01T14:30';   // toDatetimeLocal('2026-08-01 14:30:00') 的结果
  hidden.value = backfill;
  window.__syncDtPicker();
  ok($('newTaskDtLabel').textContent.includes('2026-08-01 14:30'), '标签回填显示 2026-08-01 14:30', $('newTaskDtLabel').textContent);
}

console.log('[B] 打开弹层 → 点某一天 → hidden.value 与标签应更新为所选');
{
  click($('newTaskDtBtn'));                       // 打开
  ok($('newTaskDtPop').classList.contains('open'), '弹层已打开');
  const days = [...document.querySelectorAll('.dt-day:not(.other)')];
  ok(days.length > 0, `渲染出当月日格 ${days.length} 个`);
  // 选一个明确不同于回填(1 号)的日子——15 号
  const d15 = days.find((b) => b.dataset.d === '15');
  ok(!!d15, '找到 15 号日格');
  const before = hidden.value;
  click(d15);
  ok($('newTaskDtPop').classList.contains('open'), '选日期后弹层仍开着（cadd086：不自动关）');
  ok(hidden.value !== before, `选 15 号后 hidden.value 变化（before=${before} after=${hidden.value})`);
  ok(/^\d{4}-\d{2}-15T\d{2}:\d{2}$/.test(hidden.value), 'hidden.value 落到 15 号', hidden.value);
  ok($('newTaskDtLabel').textContent.includes('-15 '), '标签同步为 15 号', $('newTaskDtLabel').textContent);
}

console.log('[C] 改小时输入 → 已选日期下应改写 hidden.value 的时刻');
{
  const hInput = document.querySelector('.dt-h');
  ok(!!hInput, '找到小时输入框');
  hInput.value = '09';
  hInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  ok(/T09:/.test(hidden.value), '小时改 09 后 hidden.value 时刻为 09', hidden.value);
}

console.log('[D] 点「确定」→ 关闭弹层，选择保留');
{
  const doneBtn = document.querySelector('.dt-done');
  ok(!!doneBtn, '找到确定按钮');
  const kept = hidden.value;
  click(doneBtn);
  ok(!$('newTaskDtPop').classList.contains('open'), '确定后弹层关闭');
  ok(hidden.value === kept, '关闭后选择值保留', hidden.value);
}

console.log(`\n==== ${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'} : ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
