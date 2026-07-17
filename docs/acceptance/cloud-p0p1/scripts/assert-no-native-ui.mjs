// 断言 cloud/public 里没有浏览器原生组件：<select> / alert() / confirm() / prompt()。
//
// 为什么不直接 grep：本仓的注释里**大量出现**这些字样（正是在解释「为什么不用它们」），
// 裸 grep 会数出一堆命中，既证明不了违规、也证明不了合规 —— 必须先剥注释再断言，否则是个假证据。
//
// 用法：node assert-no-native-ui.mjs        退出码 0 = 干净，1 = 有违规
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './env.mjs';

const DIR = path.join(REPO_ROOT, 'cloud/public');

/**
 * 剥 JS 注释 —— **按行**判定，不做字符级词法分析。
 * 第一版写的是字符级扫描（跟踪引号），被自检当场证伪：它不认识**正则字面量**，
 * app.js:12 的 `.replace(/[&<>"']/g, …)` 里那个 `"` 会把扫描器带进「字符串模式」，
 * 之后整个文件的注释判定全部错位 —— 于是既漏报又误报。
 * 换成按行后：整行注释（// 开头 / 块注释区间内）剥掉，**代码行一律保留**。
 * 误差方向是故意选的：行尾注释（`code(); // 别用 alert()`）会被当成真调用**误报**，
 * 即「宁可假警报也不假放行」—— 断言脚本漏报等于没有。
 */
function stripJsComments(src) {
  let inBlock = false;
  return src.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) { inBlock = false; return line.slice(line.indexOf('*/') + 2); }
      return '';
    }
    if (t.startsWith('//')) return '';
    if (t.startsWith('/*')) {
      if (t.includes('*/')) return line.slice(line.indexOf('*/') + 2);
      inBlock = true;
      return '';
    }
    return line;
  }).join('\n');
}
const stripHtmlComments = (src) => src.replace(/<!--[\s\S]*?-->/g, '');

/** .html 里既有标记也有内联 <script>/<style> —— 两种注释都要剥。 */
function stripAll(file, src) {
  return file.endsWith('.html')
    ? stripJsComments(stripHtmlComments(src))
    : stripJsComments(src);
}

const RULES = [
  { name: '<select>', re: /<select\b/gi, why: '原生 select 的展开态由操作系统绘制，暗色主题下会露出 Windows 白底列表' },
  { name: 'alert()', re: /(^|[^.\w$])alert\s*\(/g, why: '系统对话框：排版/配色全无，且阻塞主线程 → 用 UI.toast' },
  { name: 'confirm()', re: /(^|[^.\w$])confirm\s*\(/g, why: '同上 → 用 UI.modal / UI.confirmDanger' },
  { name: 'prompt()', re: /(^|[^.\w$])prompt\s*\(/g, why: '同上 → 用自研表单' },
];

const files = fs.readdirSync(DIR).filter((f) => /\.(html|js)$/.test(f)).sort();
let bad = 0;
console.log(`扫描 cloud/public/（${files.length} 个文件）：${files.join(' ')}\n`);

for (const rule of RULES) {
  const hits = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
    const code = stripAll(f, raw);
    // 行号按剥注释后的文本算意义不大 —— 命中就把上下文原样打出来，人能直接核
    for (const m of code.matchAll(rule.re)) {
      hits.push(`${f}: …${code.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}…`);
    }
  }
  bad += hits.length;
  const raws = files.reduce((n, f) => n + [...fs.readFileSync(path.join(DIR, f), 'utf8').matchAll(rule.re)].length, 0);
  console.log(`${hits.length === 0 ? '✅' : '❌'} ${rule.name.padEnd(10)} 剥注释后 ${hits.length} 处` +
    `（裸 grep 会数出 ${raws} 处 —— 差额全是解释「为何不用它」的注释）`);
  if (hits.length) { console.log('   ' + rule.why); hits.forEach((h) => console.log('   ❌ ' + h)); }
}

// 反证：确保剥注释的实现本身没把代码也剥掉（否则「0 命中」是假的）
const uiCode = stripAll('ui.js', fs.readFileSync(path.join(DIR, 'ui.js'), 'utf8'));
const sane = ['function dropdown', "setAttribute('role', 'listbox')", 'aria-expanded', 'function toast']
  .filter((s) => uiCode.includes(s));
console.log(`\n剥注释器自检：ui.js 剥后仍含 ${sane.length}/4 个关键代码片段 ${sane.length === 4 ? '✅' : '❌ 剥过头了，上面的 0 命中不可信'}`);
if (sane.length !== 4) bad++;

console.log(bad ? `\n❌ 有 ${bad} 处违规` : '\n✅ cloud/public 无任何浏览器原生组件');
process.exit(bad ? 1 : 0);
