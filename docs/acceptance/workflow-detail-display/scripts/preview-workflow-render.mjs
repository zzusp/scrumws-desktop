// 生成 workflow 详情渲染预览页：真 CSS（index.html 的 <style>）+ 真 app.js（renderCcTool）+ 真数据
// （cli:66b52133 会话 jsonl 里的 Workflow tool_use / tool_result），用来肉眼核对「⏺ 行是工作流名而非
// 整段脚本源码」。不起服务、不碰用户 8799 桌面 app。
//
//   node docs/acceptance/workflow-detail-display/scripts/preview-workflow-render.mjs [--out <html>]
// 再用 Edge/Chrome 无头截图（--headless --screenshot=<png> <html>）。--check 只自检、不写文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
// 默认写临时目录：这页把整份 CSS + 脚本源码内联进去有 80K+，且随时可再生成 → 不入库，
// 入库的只有它的截图（round-1/workflow-detail-render.png）。
const OUT = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1])
  : path.join(os.tmpdir(), 'workflow-detail-render.html');

const INDEX = path.join(REPO, 'platform/public/index.html');
const APP = path.join(REPO, 'platform/public/app.js');
const JSONL = path.join(os.homedir(), '.claude/projects',
  'D--project-scrumws-desktop--claude-worktrees-cloud-control-plane',
  '66b52133-bae7-4f2c-bdcf-34fe03a01cc4.jsonl');

for (const [label, p] of [['index.html', INDEX], ['app.js', APP], ['会话 jsonl', JSONL]]) {
  if (!fs.existsSync(p)) { console.error(`[check] 缺 ${label}: ${p}`); process.exit(2); }
}
console.log('[check] 三份输入齐备');
if (CHECK_ONLY) { console.log('[check] 自检通过，未写文件'); process.exit(0); }

// 真 CSS：index.html 的内联 <style> 原样取出
const css = [...fs.readFileSync(INDEX, 'utf8').matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
if (!css.includes('cc-tool')) { console.error('取到的 CSS 里没有 .cc-tool 规则，预览无意义'); process.exit(2); }

// 真数据：把三次 Workflow 调用连同各自 tool_result 取出
const lines = fs.readFileSync(JSONL, 'utf8').split(/\r?\n/).filter(Boolean);
const uses = [], results = new Map();
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  for (const b of (o.message?.content || [])) {
    if (b?.type === 'tool_use' && b.name === 'Workflow') uses.push({ ...b, _ts: o.timestamp });
    if (b?.type === 'tool_result') results.set(b.tool_use_id, { ...b, _ts: o.timestamp });
  }
}
if (!uses.length) { console.error('该会话没有 Workflow 调用'); process.exit(2); }
const cases = uses.map((u) => ({ use: u, res: results.get(u.id) || null }));
console.log(`[数据] Workflow 调用 ${cases.length} 条：${cases.map((c) => Object.keys(c.use.input).join('+')).join(' / ')}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<title>workflow 详情渲染</title><style>${css}</style>
<style>body{padding:20px;background:var(--bg)}h3{font:600 13px/1.6 system-ui;color:var(--mut);margin:18px 0 6px}
 .wrap{max-width:900px}</style></head><body><div class="wrap" id="out">渲染中…</div>
<script src="${'file:///' + APP.replace(/\\/g, '/')}"></script>
<script>
const CASES = ${JSON.stringify(cases)};
const box = document.getElementById('out');
box.innerHTML = CASES.map((c, n) => {
  const keys = Object.keys(c.use.input).join(' + ');
  return '<h3>#' + (n + 1) + ' 入参 {' + keys + '}</h3>' + renderCcTool(c.use, c.res, false);
}).join('');
// 详情默认折叠；截图要看到入参区/结果区内容 → 第 1 条展开
box.querySelectorAll('.cc-tool')[0]?.querySelectorAll('details').forEach((d) => { d.open = true; });
document.title = 'ready';
</script></body></html>`, 'utf8');
console.log(`[产物] ${OUT}`);
