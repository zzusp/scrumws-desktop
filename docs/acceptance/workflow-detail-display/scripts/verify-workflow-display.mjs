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

const [L1, L2, L3] = wfLaunches;
const MIN = 60 * 1000;
const tmp = path.join(os.tmpdir(), `wf-verify-${process.pid}.jsonl`);

// ---- A. 后台任务计数 ----
// workflow 的死线锚点是 transcriptDir 的最后活动时刻（见 collect-cli lastActivityMs），它是**实时文件系统
// 状态**——直接拿真语料做时间旅行不可复现（那个 dir 现在还在被真会话写）。故这里用真实启动行做骨架、
// 只重写 timestamp 与 transcriptDir 两个字段，把 dir 指向自建临时目录、mtime 由测试设定 → 判据可控可复现。
// 结构仍是 CC 真实落盘的那一行，不是手搓的假 JSON。
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-dirs-'));
let seq = 0;
// 造一个「最后活动在 idleMin 分钟前」的 transcriptDir；idleMin=null → 目录不存在（取不到活动时刻）
const makeDir = (idleMin, now) => {
  const d = path.join(stage, `wf-${++seq}`);
  if (idleMin === null) return d;                       // 故意不建 → readdir 抛 → lastActivityMs=0
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'agent-x.jsonl');
  fs.writeFileSync(f, '{}', 'utf8');
  const t = new Date(now - idleMin * MIN);
  fs.utimesSync(f, t, t);
  return d;
};
// 用 L1 的真实启动行改写 timestamp / transcriptDir；再按需附上它的终态通知行
const scenario = ({ launchedMinAgo, idleMin, now, withTerminalNotif = false }) => {
  const o = JSON.parse(keep.find((l) => JSON.parse(l).toolUseResult?.taskType === 'local_workflow'));
  o.timestamp = new Date(now - launchedMinAgo * MIN).toISOString();
  o.toolUseResult.transcriptDir = makeDir(idleMin, now);
  const lines = [JSON.stringify(o)];
  if (withTerminalNotif) {
    const id = (o.message.content.find((b) => b.type === 'tool_result') || {}).tool_use_id;
    lines.push(JSON.stringify({ type: 'user', timestamp: new Date(now - 1 * MIN).toISOString(),
      message: { role: 'user', content: `<task-notification><task-id>x</task-id><tool-use-id>${id}</tool-use-id><status>completed</status></task-notification>` } }));
  }
  fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
  return countRunningBackgroundTasks(tmp, now);
};

const NOW = Date.now();
console.log('\n[A] countRunningBackgroundTasks 认 Workflow（死线锚点 = transcriptDir 最后活动）');
ok('A1 刚启动 1min、dir 刚写过 → 计入 1',
  scenario({ launchedMinAgo: 1, idleMin: 0, now: NOW }) === 1, '应为 1');
ok('A2 启动 98min 前、dir 1min 前仍在写 → 计入 1（长工作流不误杀）',
  scenario({ launchedMinAgo: 98, idleMin: 1, now: NOW }) === 1, '应为 1 —— 这条正是现场 cli:66b52133 的形态');
ok('A3 启动 98min 前、dir 静默 30min → 剔除归 0（会话崩溃后自然收敛）',
  scenario({ launchedMinAgo: 98, idleMin: 30, now: NOW }) === 0, '应为 0');
ok('A4 dir 取不到（字段坏 / 目录没了）→ 退回按启动时刻比死线，98min 前 → 0',
  scenario({ launchedMinAgo: 98, idleMin: null, now: NOW }) === 0, '应为 0');
ok('A5 dir 取不到但刚启动 1min → 仍计入 1（不因取不到就误杀）',
  scenario({ launchedMinAgo: 1, idleMin: null, now: NOW }) === 1, '应为 1');
ok('A6 终态通知已到 → 归 0（配平优先，哪怕 dir 还在被写）',
  scenario({ launchedMinAgo: 98, idleMin: 0, now: NOW, withTerminalNotif: true }) === 0, '应为 0');

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

// GRP-1 工作块折叠汇总。真实语料里三次 Workflow 都单独成组（renderCcFlow 对 <2 个工具平铺不折叠）→
// 页面上根本不出汇总句，故这条只能在单测里覆盖：Workflow 与别的工具连续时才进折叠组。
console.log('\n[C] toolGroupSummary 认 Workflow');
const gsum = ctx.toolGroupSummary([{ name: 'Workflow', input: L1.input }, { name: 'Bash', input: { command: 'ls' } }]);
console.log(`   [Workflow, Bash] → ${gsum}`);
// 大小写不敏感：汇总句首字母会被 toolGroupSummary 大写（"Launched 1 workflow, ran 1 shell command"）
ok('GRP-1 汇总句出现 launched 1 workflow（不再是 called N tools）',
  /launched 1 workflow\b/i.test(gsum) && !/called \d+ tool/i.test(gsum), `实得「${gsum}」`);
const gsum2 = ctx.toolGroupSummary([{ name: 'Workflow', input: L1.input }, { name: 'Workflow', input: L2.input }]);
ok('GRP-2 复数正确（launched 2 workflows）', /launched 2 workflows/i.test(gsum2), `实得「${gsum2}」`);

fs.unlinkSync(tmp);
console.log(`\n==== ${fail === 0 ? 'ALL PASS' : 'FAILED'} : ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
