// 验证「详情里的 workflow 展示」两条改动，全部用真实 jsonl 字节（不手搓 fixture）：
//   A. collect-cli.countRunningBackgroundTasks 认得 Workflow 后台启动（侧栏「后台任务 N 个运行中」）
//   B. app.js 的 toolArgSummary 对 Workflow 出工作流名而非整段脚本源码（消息流 ⏺ 行）
//
// 语料：cli:66b52133 会话（真实跑过 3 次 Workflow）。跑法：
//   node docs/acceptance/workflow-detail-display/scripts/verify-workflow-display.mjs
// 换语料：传 --jsonl <path>。带 --check 只自检环境（零副作用，不写任何文件）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { countRunningBackgroundTasks } from '../../../../platform/lib/collect-cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const jsonlArg = argv[argv.indexOf('--jsonl') + 1];
const JSONL = argv.includes('--jsonl') ? jsonlArg : path.join(
  os.homedir(), '.claude/projects',
  'D--project-scrumws-desktop--claude-worktrees-cloud-control-plane',
  '66b52133-bae7-4f2c-bdcf-34fe03a01cc4.jsonl',
);
const APP_JS = path.join(REPO, 'platform/public/app.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); }
};

// ---- 环境自检 ----
for (const [label, p] of [['会话 jsonl', JSONL], ['app.js', APP_JS]]) {
  if (!fs.existsSync(p)) { console.error(`[check] 缺 ${label}: ${p}`); process.exit(2); }
  console.log(`[check] ${label} ok (${fs.statSync(p).size} bytes) ${p}`);
}
if (CHECK_ONLY) { console.log('[check] 自检通过，未执行验证'); process.exit(0); }

// ---- 从真实 jsonl 抽 Workflow 启动行 + 其终态通知行，原样组成最小语料 ----
// 只做「按行筛选」，不改字节：被测函数看到的仍是 CC 真实落盘结构。
const lines = fs.readFileSync(JSONL, 'utf8').split(/\r?\n/).filter(Boolean);
const wfLaunches = [];   // { toolUseId, at, input }
const keep = [];
const tuInput = new Map();   // tool_use_id → Workflow 入参（在 assistant 行上）
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  for (const b of (o.message?.content || [])) {
    if (b?.type === 'tool_use' && b.name === 'Workflow') tuInput.set(b.id, b.input || {});
  }
}
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  const r = o.toolUseResult;
  if (r && typeof r === 'object' && r.taskType === 'local_workflow') {
    const id = (o.message?.content || []).find((b) => b?.type === 'tool_result')?.tool_use_id;
    wfLaunches.push({ toolUseId: id, at: Date.parse(o.timestamp), runId: r.runId, input: tuInput.get(id) || {} });
    keep.push(line);
    continue;
  }
  // 终态通知：只留与 workflow 启动配平的那些
  const txt = o.type === 'user' && typeof o.message?.content === 'string' ? o.message.content
    : o.type === 'attachment' && o.attachment?.commandMode === 'task-notification' ? o.attachment.prompt
    : o.type === 'queue-operation' && typeof o.content === 'string' ? o.content : null;
  if (txt && txt.includes('<task-notification>')) keep.push(line);
}
console.log(`\n[语料] Workflow 启动 ${wfLaunches.length} 次：`);
wfLaunches.forEach((w) => console.log(`   ${new Date(w.at).toISOString()}  ${w.toolUseId}  runId=${w.runId}  入参键=[${Object.keys(w.input)}]`));
if (wfLaunches.length < 3) { console.error('语料不含 3 次 Workflow 启动，无法验证'); process.exit(2); }

// 按时刻回放：jsonl 是 append-only，「T 时刻的文件」= 所有 timestamp ≤ T 的行。必须这么截——
// 否则未来才发生的启动行也在文件里，被计成「当前在跑」（第一版就栽在这，L1 时刻实得 2）。
const tmp = path.join(os.tmpdir(), `wf-verify-${process.pid}.jsonl`);
const countAt = (T) => {
  const upto = keep.filter((line) => { try { return Date.parse(JSON.parse(line).timestamp) <= T; } catch { return false; } });
  fs.writeFileSync(tmp, upto.join('\n'), 'utf8');
  return countRunningBackgroundTasks(tmp, T);
};

// ---- A. 后台任务计数 ----
// 三次启动的真实时间线（见上面打印）：
//   L1 无终态通知 → 过 15min BG_STALE_MS 兜底剔除
//   L2 有 <status>failed> 通知 → 通知后即配平
//   L3 无终态通知 → 同 L1
const [L1, L2, L3] = wfLaunches;
const MIN = 60 * 1000;
console.log('\n[A] countRunningBackgroundTasks 认 Workflow 后台启动');
ok('L1 启动后 1min → 计入 1', countAt(L1.at + MIN) === 1, `实得 ${countAt(L1.at + MIN)}`);
ok('L1 前一刻 → 0（启动才计，不凭空冒出）', countAt(L1.at - MIN) === 0, `实得 ${countAt(L1.at - MIN)}`);
ok('L2 启动后 1min → 计入 1（L1 已过 15min 死线剔除）', countAt(L2.at + MIN) === 1, `实得 ${countAt(L2.at + MIN)}`);
ok('L2 终态 failed 通知后 → 配平归 0', countAt(L2.at + 7 * MIN) === 0, `实得 ${countAt(L2.at + 7 * MIN)}`);
ok('L3 启动后 1min → 计入 1', countAt(L3.at + MIN) === 1, `实得 ${countAt(L3.at + MIN)}`);
ok('L3 过 15min 死线 → 兜底剔除归 0', countAt(L3.at + 20 * MIN) === 0, `实得 ${countAt(L3.at + 20 * MIN)}`);

// ---- B. 消息流 ⏺ 行的入参摘要 ----
// 整份 app.js 丢进 vm 跑（被测的就是仓库里那份源码，不切片、不复制粘贴）。它是浏览器脚本，顶层会摸
// DOM/定时器 → 用宽容 stub 兜住；即便顶层某句仍抛，函数声明在执行前已提升进 context，照样可调。
// （不切片是因为按花括号配对切会被正则里的 \{ 和模板串 ${} 骗到，第一版就栽在这。）
const ctx = vm.createContext({});
const anything = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive || k === 'then' ? undefined : anything),
  apply: () => anything, construct: () => anything, has: () => true,
});
for (const k of ['window', 'document', 'location', 'navigator', 'localStorage', 'EventSource', 'fetch', 'WebSocket']) ctx[k] = anything;
for (const k of ['setInterval', 'setTimeout', 'clearInterval', 'clearTimeout', 'addEventListener', 'requestAnimationFrame']) ctx[k] = () => 0;
ctx.console = console; ctx.globalThis = ctx;
try {
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), ctx, { filename: 'app.js' });
} catch (e) {
  console.log(`   （app.js 顶层在 vm 里跑到 DOM 相关处停下：${e.message} —— 函数已提升，不影响下面的纯函数断言）`);
}
for (const fn of ['toolArgSummary', 'workflowArgSummary']) {
  if (typeof ctx[fn] !== 'function') { console.error(`app.js 未定义 ${fn}（提升后仍取不到），验证中止`); process.exit(2); }
}
const call = (input) => ctx.toolArgSummary({ name: 'Workflow', input });

console.log('\n[B] toolArgSummary(Workflow) 出工作流名而非脚本源码');
const s1 = call(L1.input), s2 = call(L2.input), s3 = call(L3.input);
console.log(`   L1 {script}                     → ${s1}`);
console.log(`   L2 {scriptPath}                 → ${s2}`);
console.log(`   L3 {scriptPath,resumeFromRunId} → ${s3}`);
ok('L1 首发 {script} → 取 meta.name', s1.startsWith('cloud-p0p1'), `实得「${s1}」`);
ok('L1 带上 meta.description', s1.includes('P0+P1'), `实得「${s1}」`);
ok('L2 仅 {scriptPath} → 从文件名还原名、剥掉 -wf_ 后缀与 .js', s2 === 'cloud-p0p1', `实得「${s2}」`);
ok('L3 续跑 → 标出 resumeFromRunId', s3.includes('续跑') && s3.includes(L3.input.resumeFromRunId), `实得「${s3}」`);
// 负对照：改动前走 default 分支 JSON.stringify(input)，摘要行全是转义后的脚本源码
const before = JSON.stringify(L1.input).slice(0, 90);
ok('负对照：改动前摘要确实是脚本源码 JSON（证明本条改动有效）',
  before.includes('{"script":"export const meta') && !s1.includes('export const meta'),
  `改动前=「${before}」 改动后=「${s1}」`);
// 退化护栏：摘要不该把整段源码塞进来
ok('摘要长度受控（≤90，不夹带源码）', s1.length <= 90 && !s1.includes('\\n'), `长度 ${s1.length}「${s1}」`);

fs.unlinkSync(tmp);
console.log(`\n==== ${fail === 0 ? 'ALL PASS' : 'FAILED'} : ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
