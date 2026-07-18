// ScrumWS · 运行看板 · 前端交互
// 页面：任务看板（状态分区）· 归档 · 数据看板 · 设置（含平台守护 Runner Checker）
// 任务由外部来源经 CLI / API（/api/task/create）或看板「新建任务」按钮推入，落 plan/queued 桶

// 看板自动刷新间隔（本机偏好，设置页可调）：默认 15s，夹到 [5, 600] 秒
const REFRESH_MS_MIN = 5000, REFRESH_MS_MAX = 600000, REFRESH_MS_DEFAULT = 15000;
function loadRefreshMs() {
  const v = Number(localStorage.getItem('dash-refresh-ms'));
  return Number.isFinite(v) && v >= REFRESH_MS_MIN && v <= REFRESH_MS_MAX ? v : REFRESH_MS_DEFAULT;
}
let refreshStateMs = loadRefreshMs();

const $ = (id) => document.getElementById(id);

// ---- 明暗主题切换（head 内联脚本已在首帧前按 localStorage 设好 data-theme，这里只管按钮联动）----
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('dash-theme', theme);
  const btn = $('themeBtn');
  if (btn) { btn.textContent = theme === 'light' ? '🌙' : '☀️'; btn.title = theme === 'light' ? '切到暗色' : '切到亮色'; }
}
applyTheme(document.documentElement.dataset.theme || 'dark');
$('themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});
// 侧边栏折叠 / 展开 + 顶栏视图名同步由 index.html 尾部内联「壳层交互」脚本负责，此处不重复绑定（重复绑定会双触发折叠 → 净零失效）

// ---- 时钟 ----
function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('clock').textContent = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
tickClock(); setInterval(() => { tickClock(); tickLiveTimers(); }, 1000);

// ---- 状态 ----
let stateData = null;
let providerCatalog = [];
function providerDef(id) {
  const providerId = String(id || 'claude').toLowerCase();
  return providerCatalog.find((p) => p.id === providerId) || null;
}
async function ensureProviderCatalog() {
  if (providerCatalog.length) return providerCatalog;
  const stateProviders = Array.isArray(stateData?.runtime?.providers) ? stateData.runtime.providers : null;
  if (stateProviders?.length) { providerCatalog = stateProviders; return providerCatalog; }
  try {
    const r = await api('/api/providers');
    providerCatalog = Array.isArray(r) ? r : (Array.isArray(r?.providers) ? r.providers : []);
  } catch { providerCatalog = []; }
  return providerCatalog;
}
// modal 打开时暂停看板刷新 —— 用户焦点在 modal 上、看板轮询 5s 刷 detail；关闭时立即 refreshState + 重置计时
let modalOpen = false;
let modalPollTimer = null;
let modalPollTaskKey = null;
let modalSse = null;                // 详情页块级近实时 SSE（processing 时）；断了回落 5s 轮询
let stateTimer = null;
const MODAL_POLL_MS = 5000;

// ---- 任务「状态变更」标记 ----
// 记录每个任务上次「看过」时所处的分桶(section)；当前分桶与之不同 = 状态有更新，卡片显更新点。
// 首次见到的任务先记基线（不标记，避免首屏全亮）；用户点开卡片/编辑即视为看过、清标记。
let seenSections = {};
try { seenSections = JSON.parse(localStorage.getItem('seenSections') || '{}') || {}; } catch { seenSections = {}; }
function saveSeenSections() { try { localStorage.setItem('seenSections', JSON.stringify(seenSections)); } catch { } }
// 渲染前对所有任务补基线（新任务记当前 section，不算「更新」）；返回本次判定为「有更新」的 taskKey 集合
function reconcileSeenSections(lifecycle) {
  const updated = new Set();
  const sectionOf = (t, bucket) => (t.isArchive ? 'archived' : (t.state || bucket));
  const alive = new Set();
  for (const [bucket, list] of Object.entries(lifecycle || {})) {
    for (const t of list) {
      const sec = sectionOf(t, bucket);
      alive.add(t.taskKey);
      if (!(t.taskKey in seenSections)) seenSections[t.taskKey] = sec;   // 新任务：记基线
      else if (seenSections[t.taskKey] !== sec) updated.add(t.taskKey);  // 分桶变了：标更新
    }
  }
  // 清理已消失的任务，避免 localStorage 无限增长
  for (const k of Object.keys(seenSections)) if (!alive.has(k)) delete seenSections[k];
  saveSeenSections();
  return updated;
}
// 用户看过某任务：把基线更新到当前 section，清掉更新点
function acknowledgeTask(taskKey) {
  const t = findTaskInState(taskKey);
  if (!t) return;
  const sec = t.isArchive ? 'archived' : t.state;
  if (seenSections[taskKey] !== sec) {
    seenSections[taskKey] = sec;
    saveSeenSections();
    document.querySelector(`.taskcard[data-taskkey="${cssEscape(taskKey)}"] .update-dot`)?.remove();
  }
}
function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
let updatedTaskKeys = new Set();   // 本轮渲染判定为「有更新」的任务

// ---- API ----
async function api(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

// ---- 平台守护（设置页 Runner Checker）----
// 仅此一项 job（去派发器后调度器唯一的 job），直接铺在 sec-head 所在的 section 卡片里，不再多套一层卡片
function liveJobCardHtml(t, { mono, hint }) {
  const stateTag = t.running
    ? '<span class="tag tag-jade">Running</span>'
    : '<span class="tag tag-jade">Ready</span>';
  const lastTag = t.lastOutcome == null
    ? '<span class="tag tag-mut">last=—</span>'
    : t.lastOutcome === 'ok'
      ? '<span class="tag tag-mut">last=ok</span>'
      : `<span class="tag tag-amber" title="${escapeAttr(t.lastError || '')}">last=${escapeHtml(t.lastOutcome)}</span>`;
  const min = Math.max(1, Math.round((t.intervalSec || 60) / 60));
  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      ${stateTag}
      <span class="int-edit" style="margin-left:auto" title="调度节拍（分钟）">
        每 <input type="number" class="int-input" data-checker-interval min="1" max="60" step="1" value="${min}"> 分钟
      </span>
    </div>
    <div style="font-family:var(--mono);font-size:10.5px;color:var(--dim);margin-bottom:8px">${mono}</div>
    <div style="font-size:11px;color:var(--mut);line-height:1.55;margin-bottom:8px">${hint}</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:11px;color:var(--mut);font-family:var(--mono)">
      <span>心跳 <b style="color:var(--ink2)">${t.heartbeat}</b></span>
      ${lastTag}
    </div>
  `;
}

// 设置页：Runner Checker（平台内置 Node job，去派发器后调度器唯一的 job）
function renderChecker(checker) {
  const grid = $('checkerGrid');
  if (!grid || !checker) return;
  // 用户正在编辑节拍输入时不重画，避免轮询覆盖输入（同 syncMaxRunnersInput 的护栏）
  if (grid.querySelector('input[data-checker-interval]') === document.activeElement) return;
  grid.innerHTML = liveJobCardHtml(checker, {
    mono: 'platform/lib/jobs/runner-checker.js · 平台内置',
    hint: escapeHtml(checker.hint || ''),
  });
  bindCheckerInterval(grid);
}

// 平台守护节拍编辑：改值→POST /api/checker/interval（秒）；成功后 refreshState 重画回填最新值
function bindCheckerInterval(rootEl) {
  const inp = rootEl.querySelector('input[data-checker-interval]');
  if (!inp) return;
  inp.addEventListener('change', async () => {
    let min = Math.round(Number(inp.value));
    if (!Number.isFinite(min)) min = 1;
    min = Math.min(Math.max(min, 1), 60);
    try {
      const r = await api('/api/checker/interval', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intervalSec: min * 60 }),
      });
      if (r && r.ok === false) await customAlert({ title: '操作失败', message: escapeHtml(r.error || '未知错误') });
    } catch (e) {
      await customAlert({ title: '操作失败', message: escapeHtml(e.message) });
    }
    await refreshState();
  });
}


// ---- 面板：运行时（本机 Agent 执行环境 + 用量汇总）----
// 每次 /api/state 轮询都渲染（即使不在该视图，更新隐藏 DOM），进入 #/runtime 时即为最新。
function renderRuntime(rt) {
  const card = $('runtimeCard');
  const grid = $('usageGrid');
  if (!card || !grid) return;
  if (!rt) { card.innerHTML = '<div style="color:var(--dim);font-size:12.5px">运行时数据不可用</div>'; grid.innerHTML = ''; return; }
  // ---- provider 运行时卡片 ----
  const plat = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[rt.platform] || rt.platform || '—';
  const kv = (k, v, title) => `<div class="rt-kv"><span class="k">${k}</span><span class="v"${title ? ` title="${escapeAttr(title)}"` : ''}>${v}</span></div>`;
  const dim = (t) => `<span style="color:var(--dim)">${t}</span>`;
  const runtimes = Array.isArray(rt.providers) && rt.providers.length ? rt.providers : [rt];
  card.innerHTML = runtimes.map((runtime) => {
    const enabled = runtime.enabled !== false;
    const online = runtime.online;
    const statusCls = !enabled ? 'off' : online == null ? 'detecting' : online ? 'on' : 'off';
    const statusTxt = !enabled ? '已关闭' : online == null ? '检测中…' : online ? '在线' : '离线';
    const dotCls = !enabled || online === false ? 'rt-off' : online == null ? 'rt-detecting' : 'rt-on';
    const account = runtime.capabilities?.accountUsage
      ? `<div class="rt-account"><div class="rt-account-head"><span class="rt-account-title">账号用量</span><span class="rt-account-note">由 ${escapeHtml(runtime.label || 'CLI')} 查询</span></div>${ccAccountUsageBarsHtml(runtime.claudeUsage, runtime.usagePoll)}</div>`
      : `<div class="rt-account"><div class="rt-account-head"><span class="rt-account-title">账号用量</span><span class="rt-account-note">该运行时暂不提供账号级用量</span></div></div>`;
    return `
    <div class="rt-panel">
      <div class="rt-badge"><svg viewBox="0 0 24 24"><rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg></div>
      <div class="rt-info">
        <div class="rt-name">${escapeHtml(runtime.label || runtime.tool || 'Agent')}<span class="rt-status ${statusCls}"><span class="rt-dot ${dotCls}"></span>${statusTxt}</span></div>
        <div class="rt-kvs">
          ${kv('主机', escapeHtml(rt.host || '—'))}
          ${kv('平台', escapeHtml(plat))}
          ${kv('版本', runtime.version ? escapeHtml(runtime.version) : dim('未知'))}
           ${kv('路径', runtime.binPath ? escapeHtml(runtime.binPath) : dim('—'), runtime.binPath || '')}
         </div>
         ${account}
       </div>
       <div class="rt-actions">
         <button type="button" class="btn rt-toggle${enabled ? ' stop' : ''}" onclick="toggleProviderRuntime('${escapeAttr(runtime.id)}', ${enabled ? 'false' : 'true'})">${enabled ? '关闭运行时' : '开启运行时'}</button>
       </div>
     </div>`;
  }).join('');
  const claudeRuntime = runtimes.find((runtime) => runtime.id === 'claude') || rt;
  // ---- 用量汇总：CC 全局每日 token 表格（7/15/30 天切换）----
  dailyUsageData = Array.isArray(claudeRuntime.dailyUsage) ? claudeRuntime.dailyUsage : null;
  renderUsageTable();
  // ---- 原账号用量卡改为全运行时新建任务折线图；账号用量已嵌入对应运行时卡。 ----
  const taskCreatedGrid = $('taskCreatedGrid');
  if (taskCreatedGrid) {
    taskCreatedGrid.innerHTML = `<div class="du-wrap"><div class="du-canvas-box"><canvas id="taskCreatedChart"></canvas></div></div>`;
    renderTaskCreatedChart(rt.dailyCreated);
  }
  const ccGrid = $('ccUsageGrid');
  if (ccGrid) {
    ccGrid.innerHTML = `<div class="du-wrap"><div class="du-canvas-box"><canvas id="duChart"></canvas></div></div>`;
    renderDailyChart(claudeRuntime.dailyUsage);
  }
}

window.toggleProviderRuntime = async (provider, enabled) => {
  try {
    const result = await api(`/api/providers/${encodeURIComponent(provider)}/enabled`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!enabled }),
    });
    if (!result?.ok) return customAlert({ title: '运行时设置失败', message: escapeHtml(result?.error || '未知错误') });
    await refreshState();
  } catch (error) {
    customAlert({ title: '运行时设置失败', message: escapeHtml(error.message) });
  }
};

// ---- 用量汇总表格（CC 全局每日 token，7/15/30 切换）+ 每日柱状图（Chart.js）----
let dailyUsageData = null;    // 最近一次近 30 天每日用量（tab 切换复用同一份，不重新请求）
let usageTableDays = 7;       // 表格维度：7 / 15 / 30
let duChartInstance = null;   // Chart.js 实例（重渲染前 destroy 防泄漏）
let taskCreatedChartInstance = null;

// 用量汇总表格：CC 全局每天 input/output/cache/total（token），末行合计 + 7/15/30 天 tab
function renderUsageTable() {
  const grid = $('usageGrid');
  if (!grid) return;
  const tabs = [7, 15, 30].map((n) => `<button class="du-tab${usageTableDays === n ? ' on' : ''}" data-days="${n}">最近 ${n} 天</button>`).join('');
  if (!dailyUsageData) {
    grid.innerHTML = `<div class="du-tabs">${tabs}</div><div style="color:var(--dim);font-size:12.5px;padding:16px 0">用量加载中…（首次扫描本地会话，30 天约需几秒）</div>`;
    bindUsageTabs();
    return;
  }
  const rows = dailyUsageData.slice(-usageTableDays);
  const sum = rows.reduce((a, d) => ({ input: a.input + d.input, output: a.output + d.output, cache: a.cache + d.cache, total: a.total + d.total }), { input: 0, output: 0, cache: 0, total: 0 });
  const wd = ['日', '一', '二', '三', '四', '五', '六'];
  const body = rows.slice().reverse().map((d) => {   // 新→旧展示
    const wday = '周' + wd[new Date(d.date + 'T00:00:00').getDay()];
    return `<tr${d.total === 0 ? ' class="du-tr-empty"' : ''}>`
      + `<td class="du-td-date">${d.date.slice(5)} <span style="color:var(--dim)">${wday}</span></td>`
      + `<td>${compactTokens(d.input)}</td><td>${compactTokens(d.output)}</td><td>${compactTokens(d.cache)}</td>`
      + `<td class="du-td-total">${compactTokens(d.total)}</td></tr>`;
  }).join('');
  grid.innerHTML = `<div class="du-tabs">${tabs}</div>`
    + `<div class="du-table-wrap"><table class="du-table">`
    + `<thead><tr><th>日期</th><th>输入</th><th>输出</th><th>缓存</th><th>总计</th></tr></thead>`
    + `<tbody>${body}</tbody>`
    + `<tfoot><tr><td>合计 · ${rows.length} 天</td><td>${compactTokens(sum.input)}</td><td>${compactTokens(sum.output)}</td><td>${compactTokens(sum.cache)}</td><td class="du-td-total">${compactTokens(sum.total)}</td></tr></tfoot>`
    + `</table></div>`;
  bindUsageTabs();
}
function bindUsageTabs() {
  document.querySelectorAll('#usageGrid .du-tab').forEach((b) => {
    b.addEventListener('click', () => { usageTableDays = Number(b.dataset.days); renderUsageTable(); });
  });
}

// 账号卡右侧柱状图（Chart.js）：近 7 天，全局浅色柱 + scrumws 深色子集覆盖（两 dataset grouped:false 重叠）。
function renderDailyChart(daily) {
  const canvas = document.getElementById('duChart');
  if (!canvas) return;
  const days = Array.isArray(daily) ? daily.slice(-7) : null;
  if (!days || !days.length || !window.Chart) {
    if (duChartInstance) { duChartInstance.destroy(); duChartInstance = null; }
    return;   // 无数据/库未就绪：留空 canvas，下次 /api/state 有数据再画
  }
  const css = getComputedStyle(document.documentElement);
  const info = css.getPropertyValue('--info').trim() || '#3b82f6';
  const brand = css.getPropertyValue('--brand').trim() || '#2563eb';
  const ink = css.getPropertyValue('--dim').trim() || '#8a8a8a';
  const wd = ['日', '一', '二', '三', '四', '五', '六'];
  const labels = days.map((d) => '周' + wd[new Date(d.date + 'T00:00:00').getDay()]);
  if (duChartInstance) duChartInstance.destroy();
  duChartInstance = new window.Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        // 子集覆盖：全局(浅)先画，scrumws(深)后画叠在其上；不用 order（避免图例被 order 重排），靠 dataset 顺序自然覆盖。
        // hoverBackgroundColor 必须显式给：否则 Chart.js 用内部 color helper 从 backgroundColor 派生 hover 色，
        // 但它解析不了 CSS color-mix() 字符串（canvas 能渲染、解析器不能）→ fallback 成黑色。
        { label: '全局', data: days.map((d) => d.total), backgroundColor: `color-mix(in oklab, ${info} 32%, transparent)`, hoverBackgroundColor: `color-mix(in oklab, ${info} 48%, transparent)`, borderRadius: 4, grouped: false },
        { label: 'scrumws', data: days.map((d) => d.platform), backgroundColor: brand, hoverBackgroundColor: `color-mix(in oklab, ${brand} 86%, black)`, borderRadius: 4, grouped: false },
      ],
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, padding: 12, font: { size: 11 }, color: ink } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${compactTokens(c.parsed.y)} token` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: ink, font: { size: 11 } } },
        y: { beginAtZero: true, ticks: { color: ink, font: { size: 10 }, maxTicksLimit: 5, callback: (v) => compactTokens(v) }, grid: { color: `color-mix(in oklab, ${ink} 16%, transparent)` } },
      },
    },
  });
}

function renderTaskCreatedChart(rows) {
  const canvas = $('taskCreatedChart');
  const days = Array.isArray(rows) ? rows.slice(-7) : null;
  if (!canvas || !days?.length || !window.Chart) {
    if (taskCreatedChartInstance) { taskCreatedChartInstance.destroy(); taskCreatedChartInstance = null; }
    return;
  }
  const css = getComputedStyle(document.documentElement);
  const brand = css.getPropertyValue('--brand').trim() || '#2563eb';
  const ink = css.getPropertyValue('--dim').trim() || '#8a8a8a';
  const wd = ['日', '一', '二', '三', '四', '五', '六'];
  if (taskCreatedChartInstance) taskCreatedChartInstance.destroy();
  taskCreatedChartInstance = new window.Chart(canvas, {
    type: 'line',
    data: {
      labels: days.map((d) => '周' + wd[new Date(d.date + 'T00:00:00').getDay()]),
      datasets: [{
        label: '新建任务', data: days.map((d) => d.total), borderColor: brand,
        backgroundColor: `color-mix(in oklab, ${brand} 16%, transparent)`, fill: true,
        tension: .32, pointRadius: 3, pointHoverRadius: 4, borderWidth: 2,
      }],
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `新建 ${c.parsed.y} 个任务` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: ink, font: { size: 11 } } },
        y: { beginAtZero: true, ticks: { precision: 0, color: ink, font: { size: 10 }, maxTicksLimit: 5 }, grid: { color: `color-mix(in oklab, ${ink} 16%, transparent)` } },
      },
    },
  });
}

// ---- 面板 ② 任务生命周期 ----
// 把毫秒时长格式化为「Xh Ym / Xm Ys / Xs」
function fmtDuration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

// 每步耗时：亚秒精度（fmtDuration 到秒会把 20ms 的工具显示成 0s）
function fmtStepDur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtDuration(ms);
}

// 进行中步骤 live 跳秒：扫详情流里带 data-since 的元素，每秒刷新（跨 SSE 重画存活，元素每次重建）
function tickLiveTimers() {
  const now = Date.now();
  document.querySelectorAll('.cc-live-timer[data-since]').forEach((el) => {
    const t = Number(el.getAttribute('data-since'));
    if (t) el.textContent = '· ' + fmtDuration(now - t);
  });
}

// 来源展示名（筛选面板 chip + 卡片标签同一套）：chat→dws（钉钉工具链）、cli→CLI、manual→Manual（req5 首字母大写），其余原样。
function sourceLabel(source) {
  return source === 'chat' ? 'dws'
    : source === 'cli' ? 'CLI'
    : source === 'manual' ? 'Manual'
    : source === 'issue' ? 'issue'
    : (source || '?');
}

// 来源标签（卡片左下角 + 详情页「任务信息」状态标签前，同一套）：chat 链走 dws（钉钉工具链），
// 会话细分（self/group/dm）看底部 taskKey 短码；issue / cli 独立，其余显 source 名。
function sourceTagHtml(t) {
  return t.source === 'chat'
    ? '<span class="tag tag-cyan">dws</span>'
    : t.source === 'issue'
      ? '<span class="tag tag-amber">issue</span>'
      : t.source === 'cli'
        ? '<span class="tag" style="background:var(--brandS);color:var(--brand)">CLI</span>'
        : '<span class="tag tag-mut">' + escapeHtml(sourceLabel(t.source)) + '</span>';
}

// 卡片上半部分只保留：任务标题 + 工作目录 + 最后一次活动时间（req2）；其余状态/耗时/描述/意图/失败原因都进详情页。
function taskCardHtml(t, section) {
  // 工作目录跨来源统一取（CLI 在 t.cli.cwd，看板任务在 t.cwd）
  const cwdVal = t.cwd || t.cli?.cwd || null;
  const cwdShort = cwdVal ? (cwdVal.length > 40 ? '…' + cwdVal.slice(-38) : cwdVal) : '—';
  const cwdLine = `<div class="card-sub" title="${escapeAttr(cwdVal || '')}">${escapeHtml(cwdShort)}</div>`;

  // 最后一次活动时间（后端统一 lastActivityAgo，与卡片排序同源；缺失优雅降级为 —）
  const actLine = `<div class="card-status" title="${escapeAttr(t.lastActivityAt || '')}">最后活动 ${escapeHtml(t.lastActivityAgo || '—')}</div>`;

  // 标题：优先 customTitle > 第一条真人 cc: > taskKey
  const titleText = t.title || t.taskKey;
  const titleShort = titleText.length > 60 ? titleText.slice(0, 60) + '…' : titleText;
  // 状态变更标记：本轮判定「有更新」的任务，标题前显一个更新点（点开卡片/编辑即清）
  const updateDot = updatedTaskKeys.has(t.taskKey) ? '<span class="update-dot" title="任务状态有更新"></span>' : '';

  // 卡片点击：plan 态弹编辑弹窗（任务未开始，不进详情页）；其余进详情页
  const cardClick = section === 'plan'
    ? `openEditTask('${escapeAttr(t.taskKey)}')`
    : `openTaskModal('${escapeAttr(t.taskKey)}')`;

  return `
    <div class="taskcard" data-taskkey="${escapeAttr(t.taskKey)}" onclick="${cardClick}">
      <div class="card-title" title="${escapeAttr(titleText)}">${updateDot}${escapeHtml(titleShort)}</div>
      ${cwdLine}
      ${actLine}
      <div class="card-foot">
        ${sourceTagHtml(t)}
        <span style="flex:1"></span>
        <button class="btn card-menu-btn" title="操作" onclick="event.stopPropagation();openCardMenu(event,'${escapeAttr(t.taskKey)}','${section}')">···</button>
      </div>
    </div>
  `;
}

// 卡片操作按钮（收进「···」浮层菜单）：edit/desc + 按 section 的操作。菜单在卡片外浮层，按钮不需 stopPropagation。
function cardActionButtons(t, section) {
  // 被旁观的 CLI 会话（watchlist 出卡，带 t.cli）：processing 不给「中断」（不干预终端进程）、归档区给「从看板移除」。
  // 物化后的 CLI 任务无 t.cli，与其它来源一致（可中断 Mode B 会话、归档区只取消归档）。按 t.cli 判、不按 source（任务来源不变量）。
  const isObservedCli = !!t.cli;
  const isReadOnlyCli = isObservedCli && t.provider === 'codex';
  const isPlan = section === 'plan';
  const _k = escapeAttr(t.taskKey);
  const descBtn = `<button class="btn" onclick="editTaskDesc('${_k}')" title="自己看的备注，不发给 Agent">✎ 描述</button>`;
  const editBtn = `<button class="btn" onclick="openEditTask('${_k}')" title="编辑任务（标题 / prompt / 模型 / 工作目录 / 描述）">✎ 编辑</button>`;
  const removeBtn = `<button class="btn" style="color:var(--coralT)" onclick="deleteTaskAction('${_k}')" title="删除该计划任务（不可恢复）">✕ 移除</button>`;
  const archiveBtn = `<button class="btn" onclick="archiveTask('${_k}')" title="收进已归档区">▾ 归档</button>`;
  const unarchiveBtn = `<button class="btn" onclick="unarchiveTaskAction('${_k}')" title="取消归档，回落自动判态">↺ 取消归档</button>`;
  const completeBtn = `<button class="btn" style="color:var(--jade)" onclick="completeTaskAction('${_k}')" title="人工确认已完成 → 移入 done">✓ 完成</button>`;
  const uncompleteBtn = `<button class="btn" style="color:var(--mut)" onclick="uncompleteTaskAction('${_k}')" title="取消完成，退回 awaiting-human">↺ 取消完成</button>`;
  // 退回计划（awaiting-human/done → plan）：改配置/改期后再执行，确认执行会续上之前的对话。所有来源一视同仁——
  // CLI 会话点此会先物化成一等托管任务再落 plan（source 仍 'cli'，仅元数据；见 README「任务来源不变量」）
  const toPlanBtn = `<button class="btn" style="color:var(--cyan)" onclick="moveToPlanAction('${_k}')" title="退回计划桶：可编辑配置/改期后重新执行，续上之前的对话（--resume）">↩ 退回计划</button>`;

  const lead = isPlan ? editBtn : descBtn;
  let actionBtn = '';
  if (section === 'plan') {
    // 跑过的（从 待人工/完成 退回来的、有 sessionId）不给「移除」——会毁掉可 --resume 的执行记录，改「归档」
    const tailBtn = t.meta?.sessionId ? archiveBtn : removeBtn;
    actionBtn = `<button class="btn" style="color:var(--jade)" onclick="approveTaskAction('${_k}')">▶ 排队</button>${tailBtn}`;
  } else if (section === 'processing') {
    actionBtn = isObservedCli ? '' : `<button class="btn" style="color:var(--coralT)" onclick="cancelTaskAction('${_k}')">■ 中断</button>`;
  } else if (section === 'queued') {
    actionBtn = `<button class="btn" style="color:var(--coralT)" onclick="cancelTaskAction('${_k}')">■ 中断</button>`;
  } else if (section === 'awaiting-human') {
    actionBtn = completeBtn + (isReadOnlyCli ? '' : toPlanBtn) + archiveBtn;
  } else if (section === 'done') {
    actionBtn = uncompleteBtn + (isReadOnlyCli ? '' : toPlanBtn) + archiveBtn;
  } else if (section === 'archived') {
    const rmBtn = isObservedCli ? `<button class="btn" style="color:var(--coralT)" onclick="removeCliSession('${escapeAttr(t.meta?.sessionId || '')}')" title="从看板 watchlist 移除（不影响 CLI session 本体）">✕ 移除</button>` : '';
    actionBtn = unarchiveBtn + rmBtn;
  }
  return lead + actionBtn;
}

// ---- 卡片「···」操作浮层菜单 ----
// 单例浮层（在 index.html #cardMenu），点「···」时按任务填充按钮并定位；点菜单内按钮/点外部/滚动都关闭。
let cardMenuCloser = null;
function closeCardMenu() {
  const menu = $('cardMenu');
  if (menu) menu.style.display = 'none';
  if (cardMenuCloser) { document.removeEventListener('mousedown', cardMenuCloser, true); window.removeEventListener('scroll', closeCardMenu, true); cardMenuCloser = null; }
}
function openCardMenu(event, taskKey, section) {
  const menu = $('cardMenu');
  const t = findTaskInState(taskKey);
  if (!menu || !t) return;
  menu.innerHTML = cardActionButtons(t, section);
  menu.style.display = 'flex';
  // 定位在「···」按钮下方右对齐，越界则贴边
  const r = event.currentTarget.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.right - mw;
  let top = r.bottom + 4;
  if (left < 6) left = 6;
  if (top + mh > window.innerHeight - 6) top = r.top - mh - 4;   // 下方放不下 → 翻到上方
  menu.style.left = Math.max(6, left) + 'px';
  menu.style.top = Math.max(6, top) + 'px';
  // 点菜单内任意按钮后关闭（按钮各自的 onclick 已先执行）；点外部/滚动也关闭
  menu.onclick = () => closeCardMenu();
  cardMenuCloser = (e) => { if (!menu.contains(e.target)) closeCardMenu(); };
  setTimeout(() => { document.addEventListener('mousedown', cardMenuCloser, true); window.addEventListener('scroll', closeCardMenu, true); }, 0);
}
window.openCardMenu = openCardMenu;

// ================= 看板筛选（来源 / 工作目录 / 关键字 / sessionId）=================
// 视图层筛选：状态存 boardFilter，renderLifecycle 渲染前按 matchesBoardFilter 过滤各桶（计数随之显可见数）。
// 来源 / 工作目录用自定义下拉（不用原生 select，选项面板对齐新建任务 .cwd-menu 范式），选项从真实任务数据动态取；
// 关键字 / sessionId 走子串匹配。
let boardFilter = { source: '', cwd: '', keyword: '', sessionId: '' };
let boardSources = [], boardCwds = [];   // 真实任务里出现过的来源 / 工作目录全集（下拉选项数据源）
let srcDD = null, cwdDD = null;           // 两个自定义下拉实例（initBoardFilter 里建）

function cwdOf(t) { return t.cwd || t.cli?.cwd || ''; }

function matchesBoardFilter(t) {
  const f = boardFilter;
  if (f.source && (t.source || '') !== f.source) return false;
  if (f.cwd && cwdOf(t) !== f.cwd) return false;
  if (f.keyword) {
    const hay = [t.title, t.taskKey, t.description].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(f.keyword.toLowerCase())) return false;
  }
  if (f.sessionId) {
    const ids = [t.meta?.sessionId, t.mbSessionId, t.taskKey].filter(Boolean).join(' ').toLowerCase();
    if (!ids.includes(f.sessionId.toLowerCase())) return false;
  }
  return true;
}

function allLifecycleTasks(lifecycle) {
  return [lifecycle.plan, lifecycle.queued, lifecycle.processing, lifecycle.awaitingHuman, lifecycle.done, lifecycle.archived]
    .filter(Boolean).flat();
}

// 自定义筛选下拉工厂（来源 / 工作目录共用一套；选项面板 = .fp-dd-menu，菜单每次打开按 items() 现取，选项永远最新）
function makeFilterDropdown({ btnId, menuId, items, getValue, onPick }) {
  const btn = $(btnId), menu = $(menuId);
  if (!btn || !menu) return null;
  const labelEl = btn.querySelector('.fp-dd-label');
  let outside = null;
  const close = () => {
    menu.classList.remove('open'); btn.classList.remove('open');
    if (outside) { document.removeEventListener('mousedown', outside, true); outside = null; }
  };
  const render = () => {
    const cur = getValue();
    const list = items();
    menu.innerHTML = list.length
      ? list.map((it) => `<div class="fp-dd-item${it.value === cur ? ' active' : ''}" role="option" data-val="${escapeAttr(it.value)}"><span class="fp-dd-path" title="${escapeAttr(it.title || it.label)}">${escapeHtml(it.label)}</span><span class="fp-dd-check">✓</span></div>`).join('')
      : `<div class="cwd-empty">暂无可选项</div>`;
  };
  const open = () => {
    render(); menu.classList.add('open'); btn.classList.add('open');
    outside = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  };
  btn.addEventListener('click', () => (menu.classList.contains('open') ? close() : open()));
  menu.addEventListener('click', (e) => {
    const it = e.target.closest('.fp-dd-item'); if (!it) return;
    onPick(it.dataset.val); close();
  });
  const syncLabel = () => {
    const cur = getValue();
    const found = items().find((i) => i.value === cur);
    labelEl.textContent = found ? found.label : '全部';
    labelEl.title = found ? (found.title || found.label) : '';
    labelEl.classList.toggle('dim', !cur);
  };
  return { syncLabel, close };
}

const sourceDropItems = () => [{ value: '', label: '全部' }, ...boardSources.map((s) => ({ value: s, label: sourceLabel(s) }))];
const cwdDropItems = () => [{ value: '', label: '全部' }, ...boardCwds.map((c) => ({ value: c, label: c.length > 44 ? '…' + c.slice(-42) : c, title: c }))];

// 依真实数据刷新筛选选项数据源（选中项若已不存在则回落全部）；菜单是打开时现取，不必重建 DOM
function updateBoardFilterOptions(lifecycle) {
  const all = allLifecycleTasks(lifecycle);
  boardSources = [...new Set(all.map((t) => t.source).filter(Boolean))].sort();
  boardCwds = [...new Set(all.map(cwdOf).filter(Boolean))].sort();
  if (boardFilter.source && !boardSources.includes(boardFilter.source)) boardFilter.source = '';
  if (boardFilter.cwd && !boardCwds.includes(boardFilter.cwd)) boardFilter.cwd = '';
  syncBoardFilterUi();
}

// 把 boardFilter 反映到面板 UI（下拉标签 / 输入框 / 激活数徽章）
function syncBoardFilterUi() {
  srcDD?.syncLabel();
  cwdDD?.syncLabel();
  const kw = $('fpKeyword'); if (kw && kw.value !== boardFilter.keyword) kw.value = boardFilter.keyword;
  const sid = $('fpSessionId'); if (sid && sid.value !== boardFilter.sessionId) sid.value = boardFilter.sessionId;
  const n = ['source', 'cwd', 'keyword', 'sessionId'].filter((k) => boardFilter[k]).length;
  const badge = $('filterBadge');
  if (badge) { badge.textContent = String(n); badge.style.display = n ? 'inline-flex' : 'none'; }
}

// 筛选变更后重渲看板（复用最近一次 /api/state 数据，不重新拉取）
function applyBoardFilter() {
  syncBoardFilterUi();
  if (stateData?.lifecycle) renderLifecycle(stateData.lifecycle);
}

function renderLifecycle(lifecycle) {
  closeCardMenu();                                       // 重绘前收起可能残留的「···」浮层菜单
  updatedTaskKeys = reconcileSeenSections(lifecycle);   // 状态变更标记：先补基线、算出本轮「有更新」的任务
  updateBoardFilterOptions(lifecycle);                  // 依真实数据刷新筛选选项（来源 / 工作目录）
  const map = {
    'plan': lifecycle.plan,
    'queued': lifecycle.queued,
    'processing': lifecycle.processing,
    'awaiting-human': lifecycle.awaitingHuman,
    'done': lifecycle.done,
  };
  for (const [name, tasks] of Object.entries(map)) {
    const shown = tasks.filter(matchesBoardFilter);     // 视图层筛选：计数与卡片均按可见任务
    $(`count-${name}`).textContent = shown.length;
    const list = $(`list-${name}`);
    if (shown.length === 0) {
      list.innerHTML = `<div style="color:var(--dim);font-size:12px;padding:6px 0">空</div>`;
    } else {
      list.innerHTML = shown.map((t) => taskCardHtml(t, name)).join('');
    }
  }
  const archShown = lifecycle.archived.filter(matchesBoardFilter);
  $('count-archived').textContent = archShown.length;
  const arch = $('list-archived');
  if (archShown.length === 0) {
    arch.innerHTML = `<div style="color:var(--dim);font-size:12px;padding:6px 0">空</div>`;
  } else {
    arch.innerHTML = archShown.map((t) => taskCardHtml(t, 'archived')).join('');
  }
}

// ---- 筛选面板交互（按钮开合 / 来源·工作目录自定义下拉 / 输入 / 清除 / 点外关闭）----
(function initBoardFilter() {
  const btn = $('boardFilterBtn');
  const panel = $('boardFilterPanel');
  if (!btn || !panel) return;
  let outsideCloser = null;
  const close = () => {
    panel.classList.remove('open'); btn.classList.remove('on');
    srcDD?.close(); cwdDD?.close();   // 收面板时一并收内部下拉
    if (outsideCloser) { document.removeEventListener('mousedown', outsideCloser, true); outsideCloser = null; }
  };
  const open = () => {
    panel.classList.add('open'); btn.classList.add('on');
    outsideCloser = (e) => { if (!panel.contains(e.target) && !btn.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('mousedown', outsideCloser, true), 0);
  };
  btn.addEventListener('click', () => (panel.classList.contains('open') ? close() : open()));
  // 来源 / 工作目录：自定义下拉（选项面板同款），选项按真实数据现取
  srcDD = makeFilterDropdown({
    btnId: 'fpSourceBtn', menuId: 'fpSourceMenu', items: sourceDropItems,
    getValue: () => boardFilter.source, onPick: (v) => { boardFilter.source = v; applyBoardFilter(); },
  });
  cwdDD = makeFilterDropdown({
    btnId: 'fpCwdBtn', menuId: 'fpCwdMenu', items: cwdDropItems,
    getValue: () => boardFilter.cwd, onPick: (v) => { boardFilter.cwd = v; applyBoardFilter(); },
  });
  $('fpKeyword')?.addEventListener('input', (e) => { boardFilter.keyword = e.target.value.trim(); applyBoardFilter(); });
  $('fpSessionId')?.addEventListener('input', (e) => { boardFilter.sessionId = e.target.value.trim(); applyBoardFilter(); });
  $('fpClear')?.addEventListener('click', () => {
    boardFilter = { source: '', cwd: '', keyword: '', sessionId: '' };
    applyBoardFilter();
  });
})();

$('archivedHeader').addEventListener('click', () => {
  const list = $('list-archived');
  const caret = $('archivedCaret');
  const isOpen = list.style.display !== 'none';
  list.style.display = isOpen ? 'none' : 'flex';
  caret.textContent = isOpen ? '▸' : '▾';
});

// ---- 自定义 confirm 弹窗（替代原生 confirm，Promise-based）----
// message 支持简单 HTML 内联标签（<b>/<code>/<br>）——调用侧只塞可信文案，别拼用户输入
function customConfirm({ title, message, confirmText = '确认', cancelText = '取消', tone = 'primary' }) {
  return new Promise((resolve) => {
    const modal = $('confirmModal');
    const titleEl = $('confirmTitle');
    const bodyEl = $('confirmBody');
    const ok = $('confirmOk');
    const cancel = $('confirmCancel');
    titleEl.textContent = title || '确认';
    // message 允许行内 HTML（<b>/<code>/<br>）——渲染富文本；调用方保证不拼用户输入即可
    // 包一层 confirm-text：动态串（如 escapeHtml(e.message)）里的真 \n 靠它断行
    bodyEl.innerHTML = `<div class="confirm-text">${message || ''}</div>`;
    ok.textContent = confirmText;
    cancel.textContent = cancelText;
    ok.className = 'btn ' + (tone === 'danger' ? 'btn-danger' : 'btn-primary');
    modal.style.display = 'flex';
    const cleanup = () => {
      modal.style.display = 'none';
      ok.onclick = null; cancel.onclick = null; modal.onclick = null;
      document.removeEventListener('keydown', keyHandler, true);
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(true); }
    };
    ok.onclick = () => { cleanup(); resolve(true); };
    cancel.onclick = () => { cleanup(); resolve(false); };
    modal.onclick = (e) => { if (e.target === modal) { cleanup(); resolve(false); } };
    document.addEventListener('keydown', keyHandler, true);
    setTimeout(() => ok.focus(), 40);
  });
}

// 提示弹窗（无取消键，复用 confirmModal；替代浏览器原生 alert）——message 同样支持行内 HTML，调用侧对动态串 escapeHtml
function customAlert({ title = '提示', message, tone = 'danger' }) {
  return new Promise((resolve) => {
    const modal = $('confirmModal');
    const ok = $('confirmOk');
    const cancel = $('confirmCancel');
    $('confirmTitle').textContent = title;
    $('confirmBody').innerHTML = `<div class="confirm-text">${message || ''}</div>`;
    ok.textContent = '知道了';
    ok.className = 'btn ' + (tone === 'danger' ? 'btn-danger' : 'btn-primary');
    cancel.style.display = 'none';
    modal.style.display = 'flex';
    const cleanup = () => {
      modal.style.display = 'none';
      cancel.style.display = '';   // 恢复，下次 customConfirm 还要用
      ok.onclick = null; modal.onclick = null;
      document.removeEventListener('keydown', keyHandler, true);
      resolve();
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); cleanup(); }
    };
    ok.onclick = cleanup;
    modal.onclick = (e) => { if (e.target === modal) cleanup(); };
    document.addEventListener('keydown', keyHandler, true);
    setTimeout(() => ok.focus(), 40);
  });
}

// 文本输入弹窗（复用 confirmModal；Ctrl+Enter/保存键提交、Esc/取消键返回 null）
function customPrompt({ title, message = '', initial = '', placeholder = '', maxlength = 2000 }) {
  return new Promise((resolve) => {
    const modal = $('confirmModal');
    const card = modal.querySelector('.confirm-card');
    const ok = $('confirmOk');
    const cancel = $('confirmCancel');
    $('confirmTitle').textContent = title || '输入';
    $('confirmBody').innerHTML = `
      ${message ? `<div class="prompt-msg">${message}</div>` : ''}
      <textarea id="confirmPromptInput" class="prompt-input" rows="2" maxlength="${maxlength}" placeholder="${escapeAttr(placeholder)}">${escapeHtml(initial)}</textarea>
      <div class="prompt-hint">
        <span>Ctrl+Enter 保存 · Esc 取消</span>
        <span id="promptCount" class="prompt-count"></span>
      </div>`;
    if (card) card.style.maxWidth = '520px';
    ok.textContent = '保存';
    ok.className = 'btn btn-primary';
    cancel.textContent = '取消';
    modal.style.display = 'flex';
    const input = $('confirmPromptInput');
    const countEl = $('promptCount');
    const updCount = () => { countEl.textContent = `${input.value.length} / ${maxlength}`; };
    // 自适应高度：默认 3 行紧凑，内容多就撑高（封顶 320px 再滚动）——不再用固定 6 行占位制造空白
    const autoGrow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 320) + 'px'; };
    updCount();
    autoGrow();
    input.addEventListener('input', () => { updCount(); autoGrow(); });
    const cleanup = () => {
      modal.style.display = 'none';
      if (card) card.style.maxWidth = '';
      ok.onclick = null; cancel.onclick = null; modal.onclick = null;
      document.removeEventListener('keydown', keyHandler, true);
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(null); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cleanup(); resolve(input.value); }
      // 普通 Enter 在 textarea 里换行，不拦截
    };
    ok.onclick = () => { cleanup(); resolve(input.value); };
    cancel.onclick = () => { cleanup(); resolve(null); };
    modal.onclick = (e) => { if (e.target === modal) { cleanup(); resolve(null); } };
    document.addEventListener('keydown', keyHandler, true);
    setTimeout(() => { input.focus(); input.selectionStart = input.value.length; }, 40);
  });
}

// 编辑任务描述（统一入口：任务卡 📝 按钮 / 描述行、弹窗概览 tab 编辑键；纯用户备注不进 prompt）
async function editTaskDesc(taskKey) {
  const t = findTaskInState(taskKey);
  const v = await customPrompt({
    title: '任务描述',
    message: '<span style="color:var(--mut);font-size:11px">自己看的备注 · 不会发给 Agent · 清空保存 = 删除</span>',
    initial: t?.description || '',
    placeholder: '记录任务背景 / 想达成什么 / 归档前的进展…',
  });
  if (v === null) return;
  try {
    const r = await api(`/api/task/describe?taskKey=${encodeURIComponent(taskKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: v }),
    });
    if (!r.ok) { customAlert({ title: '保存描述失败', message: escapeHtml(r.error) }); return; }
    await refreshState();
    if (modalOpen && modalPollTaskKey === taskKey) { renderModalBody(true); renderTaskSide(taskKey); }
  } catch (e) { customAlert({ title: '保存描述失败', message: escapeHtml(e.message) }); }
}
window.editTaskDesc = editTaskDesc;

// ---- 归档 ----
async function archiveTask(taskKey) {
  const ok = await customConfirm({
    title: '归档任务包',
    message: `将 <code>${escapeHtml(taskKey)}</code> move 到 <code>runner-archive/</code>。<br>不删除、可从归档区恢复。`,
    confirmText: '归档',
    tone: 'primary',
  });
  if (!ok) return;
  try {
    const r = await api(`/api/archive?taskKey=${encodeURIComponent(taskKey)}`, { method: 'POST' });
    if (!r.ok) { customAlert({ title: '归档失败', message: escapeHtml(r.error) }); return; }
    await refreshState();
  } catch (e) { customAlert({ title: '归档失败', message: escapeHtml(e.message) + '<br><span style="color:var(--mut);font-size:11px">Failed to fetch 一般是看板后端没在跑，重启 dashboard 后重试</span>' }); }
}
window.archiveTask = archiveTask;

async function cancelTaskAction(taskKey) {
  const ok = await customConfirm({
    title: '中断任务',
    message: `强杀 worker 进程、state 改为 <code>awaiting-human</code>（outcome=cancelled）。<br>已产生的副作用（commit / 发出的消息）<b>不会回滚</b>。<br>之后可在 detail 里继续对话恢复（<code>--resume</code>）、或直接归档清走。<br><br>目标：<code>${escapeHtml(taskKey)}</code>`,
    confirmText: '中断任务',
    tone: 'danger',
  });
  if (!ok) return;
  try {
    const r = await api(`/api/task/cancel?taskKey=${encodeURIComponent(taskKey)}`, { method: 'POST' });
    if (!r.ok) { customAlert({ title: '中断失败', message: escapeHtml(r.error) }); return; }
    await refreshState();
  } catch (e) { customAlert({ title: '中断失败', message: escapeHtml(e.message) }); }
}
window.cancelTaskAction = cancelTaskAction;

// awaiting-human → done：人工确认任务已完成（标 resolvedBy=user 记录"谁收的"，卡片不再显标签）
async function completeTaskAction(taskKey) {
  const ok = await customConfirm({
    title: '确认完成',
    message: `人工判定 <code>${escapeHtml(taskKey)}</code> 已完成 → 移入 <code>done</code>。<br>之后如需继续，在详情里继续对话即可重新排队执行。`,
    confirmText: '确认完成',
    tone: 'primary',
  });
  if (!ok) return;
  try {
    const r = await api(`/api/task/complete?taskKey=${encodeURIComponent(taskKey)}`, { method: 'POST' });
    if (!r.ok) { customAlert({ title: '确认完成失败', message: escapeHtml(r.error) }); return; }
    await refreshState();
    if (modalOpen && modalPollTaskKey === taskKey) renderTaskSide(taskKey);
  } catch (e) { customAlert({ title: '确认完成失败', message: escapeHtml(e.message) }); }
}
window.completeTaskAction = completeTaskAction;

// plan → queued 的用户确认（立即 spawn）
async function approveTaskAction(taskKey) {
  const ok = await customConfirm({
    title: '确认排队',
    message: `任务从 <code>plan</code> 进入 <code>queued</code> 并立即 spawn worker 执行。<br><br>目标：<code>${escapeHtml(taskKey)}</code>`,
    confirmText: '确认排队',
    tone: 'primary',
  });
  if (!ok) return;
  try {
    const r = await api(`/api/task/approve?taskKey=${encodeURIComponent(taskKey)}`, { method: 'POST' });
    if (!r.ok) { customAlert({ title: '确认排队失败', message: escapeHtml(r.error) }); return; }
    await refreshState();
  } catch (e) { customAlert({ title: '确认排队失败', message: escapeHtml(e.message) }); }
}
window.approveTaskAction = approveTaskAction;

// 移除 plan 态任务（删除计划草稿，不可恢复）
async function deleteTaskAction(taskKey) {
  const ok = await customConfirm({
    title: '移除任务',
    message: `删除计划任务 <code>${escapeHtml(taskKey)}</code>（从未执行的草稿）。<br><b>不可恢复。</b>`,
    confirmText: '移除',
    tone: 'danger',
  });
  if (!ok) return;
  try {
    const r = await api(`/api/task/delete?taskKey=${encodeURIComponent(taskKey)}`, { method: 'POST' });
    if (!r.ok) { customAlert({ title: '移除失败', message: escapeHtml(r.error) }); return; }
    await refreshState();
  } catch (e) { customAlert({ title: '移除失败', message: escapeHtml(e.message) }); }
}
window.deleteTaskAction = deleteTaskAction;

// awaiting-human / done → plan：退回计划桶。关空转会话 + 保留 sessionId，编辑/改期后确认执行会 --resume 续上之前的对话
async function moveToPlanAction(taskKey) {
  const ok = await customConfirm({
    title: '退回计划',
    message: `将 <code>${escapeHtml(taskKey)}</code> 退回 <code>plan</code> 桶。<br>可编辑配置（模型 / 目录 / effort / 定时…）后再执行；<b>确认执行时会续上之前的对话</b>（<code>--resume</code>）。<br>当前若有空转会话会被关闭。`,
    confirmText: '退回计划',
    tone: 'primary',
  });
  if (!ok) return;
  try {
    const r = await api(`/api/task/to-plan?taskKey=${encodeURIComponent(taskKey)}`, { method: 'POST' });
    if (!r.ok) { customAlert({ title: '退回计划失败', message: escapeHtml(r.error || '未知错误') }); return; }
    await refreshState();
    if (modalOpen && modalPollTaskKey === taskKey) renderTaskSide(taskKey);
  } catch (e) { customAlert({ title: '退回计划失败', message: escapeHtml(e.message) }); }
}
window.moveToPlanAction = moveToPlanAction;

// ---- 任务详情页（单一对话流 + 右侧信息栏）----
let currentModalData = null;
let lastModalFp = null;             // poll 内容指纹：没新内容不重画 DOM（保住滚动位置和 details 展开态）
let lastReplyFp = null;             // 回复框模式指纹：只在决定 composer 形态的字段变了才重装（否则每 tick 重装会清空用户正在输入的文本 + 抢焦点）

// 卡片点击入口：统一进详情 #/task/<key>。详情内部按任务是否有活 Mode B 会话分派——
// 有活会话 → 连 live SSE（逐字 / 权限 / 打断）；无 → 读磁盘 jsonl 只读历史 + 回复框。
window.openTaskModal = (taskKey) => { location.hash = '#/task/' + encodeURIComponent(taskKey); };

async function loadTaskDetail(taskKey) {
  modalOpen = true;
  modalPollTaskKey = taskKey;
  acknowledgeTask(taskKey);             // 看过即清「状态变更」更新点
  const t = findTaskInState(taskKey);
  // 分派：有活 Mode B 会话 → 详情接 live SSE（逐字 / 权限卡 / 打断，渲染进 #modalBody + renderTaskSide + composer）；
  // 无活会话 → 读磁盘 jsonl 只读历史（processing 时块级 SSE 兜底）。二者对同一次详情加载互斥。
  if (t?.mbSessionId) {
    closeModalLive();
    currentModalData = null;
    renderTaskSide(taskKey);            // 先出侧栏，body 由 loadSession 连上后渲染
    startModalPoll(taskKey);            // 常驻轮询：live 模式下 stateData 也要保鲜，侧栏 state/耗时 不滞后
    loadSession(t.mbSessionId);
    return;
  }
  if (mb) mbDetach();                    // 从 live 任务切到只读任务：断开旧 live SSE
  // 标题现在渲染在右侧「任务信息」块内（renderTaskSide），详情页顶部 header 已移除（req4）
  $('modalBody').innerHTML = '<div style="color:var(--dim);padding:12px 0">正在读取 Agent 会话记录…</div>';
  lastModalFp = null;
  try {
    const r = await api(`/api/worker-log?taskKey=${encodeURIComponent(taskKey)}`);
    if (!r.ok) {
      $('modalBody').innerHTML = `<div style="color:var(--coral)">${r.error}</div>`;
      return;
    }
    currentModalData = r;
    renderModalBody();
    renderTaskSide(taskKey);
    // 回复框显示/禁用判据：需有 meta.sessionId + state ≠ processing
    updateReplyBoxAvailability(taskKey);
    // processing 任务：块级近实时 SSE（in-flight jsonl 一变就推）；断了回落 5s 轮询
    ensureModalLive(taskKey);
  } catch (e) {
    $('modalBody').innerHTML = `<div style="color:var(--coral)">${e.message}</div>`;
  }
}

// worker-log 内容指纹（block 级，与服务端 wlFingerprint 对齐）：消息条数会漏"同消息新增 content
// block"，改按 content block 计数 —— 否则处理中逐块增长不重画。
function modalContentFp(r, stateStr, histLen) {
  const rounds = r.rounds || [];
  return JSON.stringify([
    rounds.length,
    rounds.map((x) => (x.messages || []).reduce((n, m) => n + (m.content ? m.content.length : 0), 0)),
    r.hasInflight, stateStr, histLen,
  ]);
}

// 只关块级 SSE（消息体近实时通道），保留常驻轮询继续刷侧栏卡片
function closeModalSse() {
  if (modalSse) { try { modalSse.close(); } catch { /* ignore */ } modalSse = null; }
}
// 关闭详情页所有实时通道（SSE + 常驻轮询）——离开详情 / 切任务时用
function closeModalLive() {
  closeModalSse();
  if (modalPollTimer) { clearInterval(modalPollTimer); modalPollTimer = null; }
}

function startModalPoll(taskKey) {
  if (modalPollTimer) clearInterval(modalPollTimer);
  modalPollTimer = setInterval(() => pollTaskDetail(taskKey), MODAL_POLL_MS);
}

// 详情页刷新总控：无条件起常驻轮询（任何状态都刷「任务信息卡 + state」，补上 modal 打开期间被门控的
// 看板主轮询）；processing 任务再叠加块级 SSE 做消息体近实时（此时轮询只刷侧栏、不重复拉 worker-log）。
function ensureModalLive(taskKey) {
  closeModalLive();
  startModalPoll(taskKey);   // 常驻：侧栏卡片稳定刷（heartbeat/耗时/state/工作时长/git 不再滞后）
  const t = findTaskInState(taskKey);
  if (t?.state !== 'processing' || typeof EventSource === 'undefined') return;   // 非 processing / 无 SSE：只靠轮询
  const es = new EventSource(`/api/worker-log/stream?taskKey=${encodeURIComponent(taskKey)}`);
  modalSse = es;
  es.onmessage = (ev) => {
    if (!modalOpen || modalPollTaskKey !== taskKey) { closeModalLive(); return; }
    let payload = null;
    try { payload = JSON.parse(ev.data); } catch { return; }
    if (payload && payload.ok) applyStreamedWorkerLog(taskKey, payload);
  };
  es.addEventListener('done', () => { closeModalSse(); pollTaskDetail(taskKey); });   // SSE 收敛：只关 SSE，轮询继续刷卡
  es.onerror = () => { closeModalSse(); };   // SSE 掉线：回落常驻轮询兜底拉 worker-log
}

// 消费 SSE 推来的 worker-log：消息流立即用推送数据渲染（不阻塞），侧栏卡片同步一次
async function applyStreamedWorkerLog(taskKey, r) {
  currentModalData = r;
  const histLen = (findTaskInState(taskKey)?.history || []).length;
  const fp = modalContentFp(r, r.state, histLen);
  if (fp !== lastModalFp) { lastModalFp = fp; renderModalBody(true); }
  try {
    stateData = await api('/api/state');
    if (Array.isArray(stateData?.runtime?.providers) && stateData.runtime.providers.length) {
      providerCatalog = stateData.runtime.providers;
      newTaskProviderCtl?.refresh();
    }
    if (!modalOpen || modalPollTaskKey !== taskKey) return;
    renderTaskSide(taskKey);
    updateReplyBoxAvailability(taskKey);
    const t = findTaskInState(taskKey);
    if (t && t.state !== 'processing') closeModalSse();   // 收敛：只关 SSE，常驻轮询继续刷卡
  } catch { /* state 抖动：忽略，下一帧再同步 */ }
}

// 详情页常驻轮询（任何状态/模式一 tick 一刷）：拉 state 刷「任务信息卡」——侧栏无滚动/展开态，
// 每 tick 直接重画拿最新 heartbeat/耗时/state/工作时长/git，不再受消息指纹门控而滞后。
// 非 live 的 processing 任务且无块级 SSE 时，顺带拉 worker-log 兜底刷消息体（指纹变才重画，保滚动）。
async function pollTaskDetail(taskKey) {
  if (!modalOpen || modalPollTaskKey !== taskKey) { closeModalLive(); return; }
  try {
    stateData = await api('/api/state');
    if (!modalOpen || modalPollTaskKey !== taskKey) return;
    const t = findTaskInState(taskKey);
    // 会话变活（queued 自动起会话 / CLI 收养 / 续接）→ 切 live 模式重新分派（会重挂 SSE + 常驻轮询）
    if (t?.mbSessionId && !mb) { loadTaskDetail(taskKey); return; }
    // 侧栏卡片每 tick 重画（与消息体解耦：这是"刷新不及时"的根因）
    renderTaskSide(taskKey);
    // 回复框仅在 composer 形态变了才重装（否则会清空用户正在输入的文本 / 抢焦点）
    if (replyBoxFp(t) !== lastReplyFp) updateReplyBoxAvailability(taskKey);
    // 消息体：live 会话由 mb SSE 维护、块级 SSE 在跑时交给 SSE；非 live 且刚进 processing 且没挂 SSE →
    // 升级到块级 SSE 做近实时（覆盖"打开时还是 queued、看着看着起跑"的场景）；无 SSE 环境则轮询兜底拉 worker-log
    if (!mb && !modalSse && t?.state === 'processing') {
      if (typeof EventSource !== 'undefined') { ensureModalLive(taskKey); return; }
      const r = await api(`/api/worker-log?taskKey=${encodeURIComponent(taskKey)}`);
      if (r.ok) {
        currentModalData = r;
        const fp = modalContentFp(r, t.state, (t.history || []).length);
        if (fp !== lastModalFp) { lastModalFp = fp; renderModalBody(true); }
      }
    }
  } catch { /* 网络抖一下别把 modal 打坏，静默继续 */ }
}

// 在 stateData 里找当前任务（跨所有分区，包括 archived）
function findTaskInState(taskKey) {
  if (!stateData?.lifecycle) return null;
  for (const bucket of Object.values(stateData.lifecycle)) {
    for (const t of bucket) if (t.taskKey === taskKey) return t;
  }
  return null;
}

// 重命名任务（req4 方案2：任务信息里标题旁 ✎ → customPrompt 模态输入，不被 5s 轮询重画打断）
async function renameTaskPrompt(taskKey) {
  const t = findTaskInState(taskKey);
  const v = await customPrompt({
    title: '重命名任务',
    message: '<span style="color:var(--mut);font-size:11px">留空保存 = 清除自定义标题、恢复默认</span>',
    initial: t?.title || taskKey,
    placeholder: '输入新的任务标题…',
    maxlength: 200,
  });
  if (v === null) return;
  try {
    // CLI 会话无 task.json，走 watchlist 改名接口；看板任务走 task.json 接口。两端均收 body {title}
    // 统一走 /api/task/rename，后端 renameTask 按来源分派（看板任务写 task.json / CLI 写 watchlist）——前端不选端点
    const r = await api(`/api/task/rename?taskKey=${encodeURIComponent(taskKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: v.trim() }),
    });
    if (!r.ok) { customAlert({ title: '重命名失败', message: escapeHtml(r.error) }); return; }
    await refreshState();
    if (modalOpen && modalPollTaskKey === taskKey) renderTaskSide(taskKey);
  } catch (e) { customAlert({ title: '重命名失败', message: escapeHtml(e.message) }); }
}
window.renameTaskPrompt = renameTaskPrompt;

// 状态徽章色调映射（与 taskCardHtml 对齐）
const STATE_TAG = {
  plan:           { cls: 'tag-cyan',  label: 'plan' },
  queued:         { cls: 'tag-mut',   label: 'queued' },
  processing: { cls: 'tag-amber', label: 'processing' },
  done:           { cls: 'tag-jade',  label: 'done' },
  'awaiting-human': { cls: 'tag-coral', label: 'awaiting' },
  cancelled:      { cls: 'tag-coral', label: 'cancelled' },   // 仅旧归档数据显示兼容；2026-07-10 起中断写 awaiting-human
};
function stateTagHtml(state) {
  const m = STATE_TAG[state] || { cls: 'tag-mut', label: state || '?' };
  return `<span class="tag ${m.cls}" style="font-size:10px">${escapeHtml(m.label)}</span>`;
}

// 滚到真正底部：innerHTML 后同帧读 scrollHeight，常因等宽字体/折叠块/代码块布局尚未稳定而少滚几行
// → 下一帧 requestAnimationFrame 布局稳定后再补一次，确保停在最新内容处（进详情/追尾都用）。
function scrollBodyToEnd(body) {
  if (!body) return;
  body.scrollTop = body.scrollHeight;
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}

// keepScroll=true（poll 重画）保住滚动位置；首次打开滚到底部显示最新消息
function renderModalBody(keepScroll = false) {
  if (!currentModalData) return;
  const body = $('modalBody');
  // 详情页左侧中部是独立滚动容器
  const prevScroll = body.scrollTop;
  // 追尾判定：poll 重画前若已贴底（距底 <60px），重画后继续贴底跟最新消息
  const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  const html = renderDetailTab(currentModalData);
  body.innerHTML = html || '<div style="color:var(--dim);padding:12px 0">无数据</div>';
  // 首次打开 → 滚到底（最新消息在下面）；poll 重画 → 贴底则追尾、否则保持用户当前位置
  if (keepScroll && !wasAtBottom) body.scrollTop = prevScroll;   // 用户上滚看历史 → 原位保持
  else scrollBodyToEnd(body);                                     // 首次打开 / 追尾贴底 → 滚到真正底部（含下一帧补滚）
}

// stateData 里按 mbSessionId 反查任务 key（旧 #/session/<id> 链接重定向用）
function findTaskKeyBySession(sid) {
  if (!stateData?.lifecycle) return null;
  for (const bucket of Object.values(stateData.lifecycle)) {
    for (const t of bucket) if (t.mbSessionId === sid) return t.taskKey;
  }
  return null;
}

// ---- hash 路由：#/board · #/archive · #/dashboard · #/settings · #/task/<taskKey>（旧 /<tab> 后缀兼容忽略）----
// 详情页已归一：#/session/<id>（历史链接）重定向到其归属任务的 #/task/<taskKey>。
const ROUTE_VIEWS = ['board', 'archive', 'runtime', 'dashboard', 'apikeys', 'settings', 'task'];
function router() {
  const h = location.hash || '#/board';
  let view = 'board';
  let taskKey = null;
  const mTask = /^#\/task\/([^/]+)(?:\/(?:overview|detail|timeline))?$/.exec(h);
  const mSession = /^#\/session\/([^/]+)$/.exec(h);
  if (mSession) {
    // 旧会话链接 → 重定向到归属任务详情（找不到归属则回看板）
    const owner = findTaskKeyBySession(decodeURIComponent(mSession[1]));
    location.hash = owner ? '#/task/' + encodeURIComponent(owner) : '#/board';
    return;
  }
  if (mTask) {
    view = 'task';
    taskKey = decodeURIComponent(mTask[1]);
  } else if (h.startsWith('#/archive')) view = 'archive';
  else if (h.startsWith('#/runtime')) view = 'runtime';
  else if (h.startsWith('#/dashboard')) view = 'dashboard';
  else if (h.startsWith('#/apikeys')) view = 'apikeys';
  else if (h.startsWith('#/settings')) view = 'settings';

  const fullBleed = view === 'task';   // 满宽满高布局（pageWrap 外）
  for (const v of ROUTE_VIEWS) { const el = $(`view-${v}`); if (el) el.style.display = v === view ? (v === 'task' ? 'flex' : '') : 'none'; }
  $('pageWrap').style.display = fullBleed ? 'none' : '';
  document.querySelectorAll('.topnav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === view || (fullBleed && a.dataset.nav === 'board'));
  });

  // 离开详情页：停详情实时通道（SSE + 兜底轮询）+ 断开 live 会话前端 SSE（后端进程继续跑）+ 刷看板重置计时
  if (view !== 'task' && modalOpen) {
    modalOpen = false;
    modalPollTaskKey = null;
    closeModalLive();
    if (mb) mbDetach();
    $('modalReplyBox').style.display = 'none';
    refreshState();
    scheduleStateRefresh();
  }
  if (view === 'task' && taskKey) loadTaskDetail(taskKey);
  if (view === 'settings') refreshCloudStatus();
  if (view === 'apikeys') refreshApiKeys();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);

// 任务详情页左右分栏拖拽调宽：拖 #detailResizer 改 .detail-side 宽度，夹在 [280, 容器宽-360] 之间
// （给左侧正文留至少 360px），记 localStorage 跨会话保留上次拖到的宽度。
const DETAIL_SIDE_W_MIN = 280;
(function initDetailResizer() {
  const resizer = $('detailResizer'), side = $('taskSide'), container = $('view-task');
  if (!resizer || !side || !container) return;
  const saved = Number(localStorage.getItem('dash-detail-side-w'));
  if (Number.isFinite(saved) && saved >= DETAIL_SIDE_W_MIN) side.style.width = saved + 'px';
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const max = Math.max(DETAIL_SIDE_W_MIN, rect.width - 360);   // 左侧正文至少留 360px
    const w = Math.min(max, Math.max(DETAIL_SIDE_W_MIN, rect.right - e.clientX));
    side.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.userSelect = '';
    localStorage.setItem('dash-detail-side-w', String(parseInt(side.style.width, 10) || 420));
  });
})();

// 决定 composer 形态的字段集指纹：常驻轮询据此判定"要不要重装回复框"——只有这些变了才重装，
// 否则每 tick 重装会清空用户正在输入的文本 + 抢焦点（CLI 空闲 / 可对话分支会 text.value='' + focus）。
function replyBoxFp(t) {
  return JSON.stringify([
    t?.state, t?.mbSessionId || null, t?.source, !!t?.meta?.sessionId,
    !!t?.lease?.alive, !!t?.isArchive, t?.cli?.attachedPid || null, t?.cli?.archivedAt || null,
  ]);
}

// 取任务「当前实际」model/effort：live 会话读 mb.info（后端序列化即带 model/effort）；否则读详情末轮 systemInit/ccSummary.model + t.effort
function currentActualModelEffort(taskKey) {
  const t = findTaskInState(taskKey);
  if (t?.mbSessionId && mb && mb.id === t.mbSessionId && mb.info) {
    return { provider: mb.info.provider || t?.provider || 'claude', model: mb.info.model || null, effort: mb.info.effort || t?.effort || null };
  }
  const rounds = (currentModalData?.rounds || []).filter((x) => !x.error);
  const lastOk = rounds[rounds.length - 1] || null;
  return { provider: t?.provider || 'claude', model: lastOk?.ccSummary?.model || lastOk?.systemInit?.model || null, effort: t?.effort || null };
}

// ---- 继续对话区：三态状态机（可对话 / 处理中 / 需重发 / 不可用）----
// 每次 open modal 都会调；状态徽章 + 说明 + 输入区 / 重发区之间切换
function updateReplyBoxAvailability(taskKey) {
  const box = $('modalReplyBox');
  const stateTag = $('modalReplyState');
  const hint = $('modalReplyHint');
  const modelSel = $('modalReplyModel');
  const replyBody = $('modalReplyBody');
  const restartBody = $('modalRestartBody');
  const send = $('modalReplySend');
  const text = $('modalReplyText');
  const countEl = $('modalReplyCount');
  const restartBtn = $('modalRestartBtn');
  const toast = $('modalReplyErr');
  const t = findTaskInState(taskKey);
  const taskProvider = providerDef(t?.provider || 'claude');
  const providerBadge = $('modalReplyProvider');
  if (providerBadge) providerBadge.textContent = taskProvider?.label || t?.provider || 'Claude Code';
  lastReplyFp = replyBoxFp(t);   // 每次装配都刷新基线，常驻轮询据此判定后续是否需要重装
  const hasSid = !!(t?.meta?.sessionId);
  const processing = t?.state === 'processing';
  // 被旁观的 CLI 会话（watchlist 出卡，带 t.cli 详情）走「收养续接」分支；物化后的 CLI 任务无 t.cli，与其它来源
  // 一样走托管任务的统一回复路径（sendReply → --resume）。按「有无 t.cli」而非按 source 判（任务来源不变量）。
  const isObservedCli = !!t?.cli;
  // queued 场景 = 新建入队 / 中断后回排队；由用户从看板拉起（重新发起）；lease 存活 = worker 在起，不给重发
  const canRestart = !hasSid && ['awaiting-human', 'queued'].includes(t?.state) && !t?.lease?.alive && !t?.isArchive;
  const canReply = hasSid && !processing && !isObservedCli;

  box.style.display = 'block';
  toast.style.display = 'none';
  toast.classList.remove('err', 'ok');
  // 重置 body 显隐（默认全隐、按下面模式再打开）
  replyBody.style.display = 'none';
  restartBody.style.display = 'none';
  // 徽章 class 归零（保留 .tag 基类）
  stateTag.className = 'tag tag-mut';
  stateTag.style.display = '';
  hint.style.display = '';
  // 状态头默认显示；实时会话（Mode B）分支会隐藏整条（见下方 mbSessionId 分支）
  if (stateTag.parentElement) stateTag.parentElement.style.display = '';
  // 清旧事件监听（防止上次 modal 的旧 handler 残留）
  send.onclick = null;
  restartBtn.onclick = null;
  text.onkeydown = null;
  text.oninput = null;
  const interruptBtn = $('modalReplyInterrupt');
  if (interruptBtn) { interruptBtn.style.display = 'none'; interruptBtn.onclick = null; }

  // 有活 Mode B 会话 → 实时 composer：常开输入 + 打断 + 发送走 mbSend；处理中也能插话/打断（D-c，去掉旧"处理中禁发"）。
  // 不清空 text.value（本函数可能在 live 中多次调，保住用户正在输入的内容）。
  if (t?.mbSessionId) {
    replyBody.style.display = 'flex';
    text.disabled = false; send.disabled = false;
    // 实时会话不显示状态头（"生成中·可插话/打断 / 看板持有的实时会话… / token 读数"整条去掉）——直接常开输入 + 打断
    if (stateTag.parentElement) stateTag.parentElement.style.display = '';
    stateTag.style.display = 'none';
    hint.style.display = 'none';
    if (mb && mb.id === t.mbSessionId) {
      const running = mb.state === 'running' || mb.state === 'starting';
      // 打断只在「正在生成」时有意义：非 running 用 display 隐藏（而非灰化占位），一轮收敛即消失。
      if (interruptBtn) { interruptBtn.style.display = running ? '' : 'none'; interruptBtn.onclick = () => mbInterrupt(); }
    }
    updateReplyCount(text.value.length, countEl);
    if (typeof window.__seedReplyModel === 'function') { const me = currentActualModelEffort(taskKey); window.__seedReplyModel(me.provider, me.model, me.effort); }
    send.onclick = () => mbSend();
    text.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); mbSend(); } };
    text.oninput = () => updateReplyCount(text.value.length, countEl);
    return;
  }

  // 被旁观的 CLI 会话三态：终端占用 → 只读；正在算 → 等；空闲无进程 → 收养续接成 live（--resume）
  if (isObservedCli) {
    stateTag.className = 'tag';
    stateTag.style.background = 'var(--brandS)';
    stateTag.style.color = 'var(--brand)';
    if (t?.provider === 'codex') {
      stateTag.textContent = 'CLI · 只读观察';
      hint.innerHTML = '该 Codex CLI 会话仅在看板展示运行信息和状态，请在原终端里继续对话。';
      return;
    }
    const attachedPid = t.cli?.attachedPid;
    if (attachedPid) {
      stateTag.textContent = 'CLI · 终端占用';
      hint.innerHTML = `该 session 有终端进程在占用（pid=<b>${attachedPid}</b>${t.cli?.attachedStatus ? ` · ${escapeHtml(t.cli.attachedStatus)}` : ''}），请直接在那个<b>终端窗口</b>里回复。`;
      return;
    }
    if (t.state === 'processing') {
      stateTag.textContent = 'CLI · 处理中';
      hint.innerHTML = 'session 正在算（可能是上一条看板回复在跑）· 等它收敛后可继续发';
      return;
    }
    // 空闲且无占用：开放 composer，发消息 = 收养成 Mode B 实时会话并把消息作为首条发出（--resume + 全部历史），跳会话视图
    stateTag.textContent = 'CLI · 可续接对话';
    hint.innerHTML = '终端已关闭 · 发消息将在看板<b>续接成实时会话</b>（带全部历史，可连续多轮）';
    replyBody.style.display = 'flex';
    text.disabled = false; send.disabled = false;
    text.value = '';
    updateReplyCount(0, countEl);
    if (typeof window.__seedReplyModel === 'function') { const me = currentActualModelEffort(taskKey); window.__seedReplyModel(me.provider, me.model, me.effort); }
    send.onclick = () => sendCliContinue(taskKey);
    text.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendCliContinue(taskKey); } };
    text.oninput = () => updateReplyCount(text.value.length, countEl);
    setTimeout(() => text.focus(), 60);
    return;
  }

  if (canReply) {
    // 隐掉状态头（「可继续对话 / 同 session --resume，cache_read 命中省 token」提示）——直接常开输入即可，无需这条说明
    if (stateTag.parentElement) stateTag.parentElement.style.display = '';
    stateTag.style.display = 'none';
    hint.style.display = 'none';
    replyBody.style.display = 'flex';   // composer 是 flex-direction:column
    text.disabled = false; send.disabled = false;
    text.value = '';
    updateReplyCount(0, countEl);
    if (typeof window.__seedReplyModel === 'function') { const me = currentActualModelEffort(taskKey); window.__seedReplyModel(me.provider, me.model, me.effort); }
    send.onclick = () => sendReply(taskKey);
    text.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(taskKey); } };
    text.oninput = () => updateReplyCount(text.value.length, countEl);
    // modal 打开后自动聚焦，直接可输入
    setTimeout(() => text.focus(), 60);
    return;
  }
  if (processing) {
    stateTag.className = 'tag tag-amber';
    stateTag.textContent = '处理中';
    hint.innerHTML = '任务正在跑（<b>state=processing</b>）· 等 worker 收尾后可继续对话';
    return;
  }
  if (t?.state === 'plan' && !t?.isArchive) {
    stateTag.className = 'tag tag-cyan';
    stateTag.textContent = '待确认';
    // 退回来的 plan 任务（有 meta.sessionId）：确认排队会 --resume 续上之前的对话；全新草稿则从头执行
    hint.innerHTML = hasSid
      ? '任务处于 <b>plan</b>（计划中）· 确认排队后会<b>续上之前的对话</b>（<b>--resume</b>）执行；可先编辑配置 / 改期'
      : '任务处于 <b>plan</b>（计划中）· 确认排队后才会执行；可先在概览里补充任务描述';
    restartBody.style.display = 'flex';
    restartBtn.onclick = () => approveTaskAction(taskKey);
    restartBtn.disabled = false;
    restartBtn.textContent = '▶ 确认排队';
    return;
  }
  if (canRestart) {
    stateTag.className = 'tag tag-coral';
    stateTag.textContent = '需重新发起';
    hint.innerHTML = `任务无 <b>meta.sessionId</b>（runner 未起飞或未跑到落 sessionId）· 无法 --resume`;
    restartBody.style.display = 'flex';
    restartBtn.onclick = () => restartTaskAction(taskKey);
    restartBtn.disabled = false;
    restartBtn.textContent = '↻ 重新发起';
    return;
  }
  // 兜底：done/archived 无 sid、或其他非典型状态 —— 只显徽章 + 说明，无输入
  stateTag.className = 'tag tag-mut';
  stateTag.textContent = '不可对话';
  hint.textContent = t?.isArchive
    ? '任务已归档、只读'
    : `state=${t?.state || '?'} · 无 meta.sessionId 无法 --resume`;
}

// 显示 toast（复用错误/成功浮层，class 切换颜色）
function showReplyToast(msg, kind = 'err') {
  const toast = $('modalReplyErr');
  toast.textContent = msg;
  toast.classList.remove('err', 'ok');
  toast.classList.add(kind === 'ok' ? 'ok' : 'err');
  toast.style.display = 'block';
}

// composer 底部字数计数联动（>1000 字变琥珀色作为软提醒；不做硬限制，后端不设上限）
function updateReplyCount(n, el) {
  if (!el) el = $('modalReplyCount');
  if (!el) return;
  el.textContent = `${n} 字`;
  el.classList.toggle('warn', n > 1000);
}

async function restartTaskAction(taskKey) {
  const ok = await customConfirm({
    title: '重新发起任务',
    message: `state 归零到 <code>queued</code>、立即 spawn 对应 source 的 worker 一次。<br>原任务包保留、<code>outcomeDetail.failureReason</code> 清空、追加 <code>history {by:user-restart}</code>。<br><br>目标：<code>${escapeHtml(taskKey)}</code>`,
    confirmText: '重新发起',
    tone: 'primary',
  });
  if (!ok) return;
  const btn = $('modalRestartBtn');
  if (btn) { btn.disabled = true; btn.textContent = '发起中…'; }
  try {
    const r = await api(`/api/task/restart?taskKey=${encodeURIComponent(taskKey)}`, { method: 'POST' });
    if (!r.ok) { showReplyToast('重新发起失败：' + (r.error || '未知错误'), 'err'); return; }
    showReplyToast(`已重新发起（${r.worker || 'worker'}）· 10s 后自动刷新看板与 detail`, 'ok');
    setTimeout(async () => { await refreshState(); loadTaskDetail(taskKey); }, 10000);
  } catch (e) {
    showReplyToast('重新发起失败：' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ 重新发起'; }
  }
}
window.restartTaskAction = restartTaskAction;

// ===== 添加本地文件（新建任务 / 详情回复共用）=====
// 取路径的文件名（Windows/Posix 分隔符都吃）
function baseName(p) { return String(p || '').split(/[\\/]/).pop() || String(p || ''); }
// 与后端 session-manager.appendAttachments 同款拼接格式（乐观回显用），改格式需两处同步。
function attachSuffix(text, files) {
  const list = (files || []).map((f) => String(f || '').trim()).filter(Boolean);
  if (!list.length) return String(text || '');
  return `${String(text || '')}\n\n[附加本地文件 · 请用 Read 工具读取]\n${list.map((f) => `- ${f}`).join('\n')}`;
}
// 附件管理器：维护一组绝对路径，「+」按钮调 /api/pick-file（Electron 多选）追加，chip 可删。
function makeAttachController({ btnId, boxId }) {
  let files = [];
  function render() {
    const box = $(boxId);
    if (!box) return;
    if (!files.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'flex';
    box.innerHTML = files.map((p, i) =>
      `<span class="attach-chip" title="${escapeAttr(p)}"><span class="ac-name">${escapeHtml(baseName(p))}</span><span class="ac-x" data-i="${i}" role="button" aria-label="移除">×</span></span>`
    ).join('');
    box.querySelectorAll('.ac-x').forEach((x) => x.addEventListener('click', () => {
      files.splice(Number(x.dataset.i), 1); render();
    }));
  }
  async function pick() {
    const btn = $(btnId);
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/pick-file', { method: 'POST' });
      if (r && r.ok && Array.isArray(r.files)) {
        for (const f of r.files) if (f && !files.includes(f)) files.push(f);
        render();
      } else if (r && r.ok === false && r.error) {
        customAlert({ title: '添加文件', message: escapeHtml(r.error) });
      }
    } catch (e) {
      customAlert({ title: '添加文件失败', message: escapeHtml(e.message) });
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  const btn0 = $(btnId);
  if (btn0) btn0.addEventListener('click', pick);
  return {
    get: () => files.slice(),
    set: (arr) => { files = (Array.isArray(arr) ? arr : []).map((f) => String(f || '').trim()).filter(Boolean); render(); },
    clear: () => { files = []; render(); },
  };
}
const replyAttachCtl = makeAttachController({ btnId: 'modalReplyAttachBtn', boxId: 'modalReplyAttach' });
const newTaskAttachCtl = makeAttachController({ btnId: 'newTaskAttachBtn', boxId: 'newTaskAttach' });

async function sendReply(taskKey) {
  const text = $('modalReplyText');
  const send = $('modalReplySend');
  const model = $('modalReplyModel').value;
  const effort = $('modalReplyEffort').value;   // req3：per-reply effort 覆盖（仅 --resume 重挂新会话时生效）
  const msg = text.value.trim();
  const attachments = replyAttachCtl.get();
  if (!msg) { showReplyToast('消息不能为空', 'err'); return; }
  send.disabled = true; text.disabled = true; send.classList.add('busy');
  try {
    const body = { message: msg };
    if (model) body.model = model;
    if (effort) body.effort = effort;
    if (attachments.length) body.attachments = attachments;
    const r = await api(`/api/task/reply?taskKey=${encodeURIComponent(taskKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { showReplyToast(r.error || '未知错误', 'err'); return; }
    text.value = '';
    replyAttachCtl.clear();
    updateReplyCount(0);
    // reply 走 --resume 重挂了一个绑定该任务的 Mode B 会话（后端已 seed 历史 + 这条回复）。
    // 立即刷 state 让 mbSessionId 现身、重载详情进 live（连 SSE 回放 seed → 历史 + 这条继续即时可见），
    // 不再死等 10s（旧 setTimeout 期间消息不显示 + 页面冻在旧只读历史，体验差）。
    await refreshState();
    if (modalOpen && modalPollTaskKey === taskKey) loadTaskDetail(taskKey);
  } catch (e) {
    showReplyToast(e.message, 'err');
  } finally {
    send.disabled = false; text.disabled = false; send.classList.remove('busy');
  }
}

// CLI 会话「发送消息」= 收养成 Mode B 实时会话并把这条消息作为首条发出（--resume + 全部历史），跳会话视图。
// 消息不塞进 adopt（createSession(prompt) 走 sendUserMessage 不进 transcript、视图看不到）——改为收养后由
// 会话视图 synced 时 mbSend 乐观回显发出，保证消息可见。pendingCliMessage 只在收养成功后置、消费一次即清。
let pendingCliMessage = null;
// 收养 CLI session 成 Mode B live 会话：taskKey 透传绑该任务，msg 不塞进 adopt 而是置 pendingCliMessage，
// 详情连上 live 会话 synced 后经 mbSend 乐观回显发出（保证可见），再跳详情进 live。
// 续接（sendCliContinue）与 rewind（先截断再收养）共用。返回 api 结果（{ok} 或 {ok:false,error}）。
async function adoptCliToLive({ taskKey, sessionId, msg, model, effort }) {
  const body = { sessionId, taskKey };
  if (model) body.model = model;
  if (effort) body.effort = effort;
  const r = await api('/api/session/adopt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) return r;
  pendingCliMessage = msg;                                    // 详情连上 live 会话 synced 后自动发出
  await refreshState();                                       // 让 mbSessionId 现身，详情才能分派到 live
  const target = '#/task/' + encodeURIComponent(taskKey);
  if (location.hash === target) loadTaskDetail(taskKey);      // 已在该详情：hash 不变，直接重载进 live
  else location.hash = target;                                // 否则触发 router → loadTaskDetail
  return { ok: true };
}
async function sendCliContinue(taskKey) {
  const text = $('modalReplyText');
  const send = $('modalReplySend');
  const model = $('modalReplyModel').value;
  const effort = $('modalReplyEffort').value;
  const msg = text.value.trim();
  if (!msg) { showReplyToast('消息不能为空', 'err'); return; }
  const t = findTaskInState(taskKey);
  const sessionId = t?.meta?.sessionId;
  if (!sessionId) { showReplyToast('该会话无 sessionId，无法续接', 'err'); return; }
  if (t?.state === 'processing') { showReplyToast('会话仍在运行——先退出终端再续接，避免两个进程同写一个会话', 'err'); return; }
  send.disabled = true; text.disabled = true; send.classList.add('busy');
  try {
    const r = await adoptCliToLive({ taskKey, sessionId, msg, model, effort });
    if (!r.ok) { showReplyToast(r.error || '未知错误', 'err'); return; }
  } catch (e) {
    showReplyToast(e.message, 'err');
  } finally {
    send.disabled = false; text.disabled = false; send.classList.remove('busy');
  }
}
window.sendCliContinue = sendCliContinue;

// ---- Escape helpers ----
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
// 用户消息展示前剥掉钉钉链的指令前缀（cc: 是 dws 群聊的触发词，任务视图里不出现这种用法）
function stripDirectivePrefix(s) { return String(s || '').replace(/^\s*cc[:：]\s*/i, ''); }

// 详情流 assistant 文本按 markdown 渲染，但绝不透传原始 HTML：模型偶发把工具调用输出成文本
// （court<invoke name=…><parameter…>），marked v9 默认原样吐 HTML → 浏览器当标签吞内容 / 破版 / XSS。
// 覆写 renderer.html 把裸 HTML 转义成字面量显示，markdown（粗体/表格/代码）不受影响。
if (window.marked?.use) {
  window.marked.use({ renderer: { html: (t) => escapeHtml(typeof t === 'string' ? t : (t?.text ?? '')) } });
}

// ---- Claude Code 账号级用量渲染（数据经官方 CLI /usage 查得，见后端 claude-usage.js）----
// 距刷新剩余（resetsAt=epoch ms → 「1d 22h 后刷新 / 3h 20m 后刷新 / 12m 后刷新 / 即将刷新」）
function fmtResetIn(resetsAt) {
  const ms = new Date(resetsAt) - Date.now();
  if (!isFinite(ms) || ms <= 0) return '即将刷新';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h 后刷新`;
  if (h > 0) return `${h}h ${m}m 后刷新`;
  return `${m}m 后刷新`;
}
// 单条滚动窗横条：label + 距刷新剩余 + 进度条 + N% used。缺 pct 不渲染。填充分档：≥80% 红、≥50% 琥珀、否则绿。
function ccUsageBarHtml(label, win) {
  if (!win || win.pct == null) return '';
  const pct = Math.max(0, Math.min(100, Number(win.pct)));
  const fillBase = pct >= 80 ? 'var(--destructive)' : pct >= 50 ? 'var(--warning)' : 'var(--success)';
  const fill = `color-mix(in oklab, ${fillBase} 62%, transparent)`;
  const reset = win.resetsAt ? fmtResetIn(win.resetsAt) : (win.resets || '');   // 解析出时间戳走倒计时；否则回退原串
  return `
    <div class="cc-bar">
      <div class="cc-bar-left">
        <div class="cc-bar-label">${escapeHtml(label)}</div>
        ${reset ? `<div class="cc-bar-reset">${escapeHtml(reset)}</div>` : ''}
      </div>
      <div class="cc-bar-track"><div class="cc-bar-fill" style="width:${pct}%;background:${fill}"></div></div>
      <div class="cc-bar-pct">${pct.toFixed(0)}% used</div>
    </div>`;
}
// 用量主体：5 小时（会话）/ 7 天（本周）两条；未就绪 / 非订阅 / 失败各自提示
function ccUsageBody(cu) {
  if (!cu || cu.error === 'pending') return '<div class="cc-usage-note">用量加载中…（首次经 CLI 查约 10s）</div>';
  if (!cu.ok) return `<div class="cc-usage-note">用量不可用（${escapeHtml(cu.error || 'unknown')}）</div>`;
  if (!cu.subscription) return '<div class="cc-usage-note">当前非订阅账号，无 5h / 7d 滚动窗用量</div>';
  const bars = ccUsageBarHtml('5 小时', cu.session) + ccUsageBarHtml('7 天', cu.weekAll);
  return bars || '<div class="cc-usage-note">暂无滚动窗用量</div>';
}
// 账号用量卡内容（session 5h / 本周 7d 滚动窗，复用 ccUsageBarHtml）+ 刷新脚注。
// 数据来自 /api/state 的 runtime.claudeUsage + usagePoll。
function ccAccountUsageBarsHtml(cu, pollInfo) {
  const poll = pollInfo || {};
  const intervalMin = poll.intervalSec ? Math.round(poll.intervalSec / 60) : 10;
  const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const lastTxt = poll.lastRunAt ? hhmm(poll.lastRunAt) : '—';
  const foot = `<div class="cc-usage-note" style="margin-top:10px">上次刷新 ${lastTxt} · 基准约 ${intervalMin} 分钟、随机抖动拉取${poll.lastOk === false ? ' · <span style="color:var(--coral)">上次拉取失败</span>' : ''}</div>`;
  return `<div class="cc-usage">${ccUsageBody(cu)}${foot}</div>`;
}

// token 压缩显示（对齐 renderRuntime 的 compact：百万级用 K/M/B）
function compactTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// Agent 卡片：provider / session / 模型；Claude 独有能力按 catalog 显示，不为 Codex 伪造等价能力。
function agentCardHtml(t, model) {
  const kv = (k, v) => `<div class="side-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const provider = t.provider || 'claude';
  const def = providerDef(provider);
  const sessionId = t.meta?.sessionId || null;
  const modelVal = model && model !== '—' ? (t.effort ? `${model} · ${t.effort}` : model) : (t.effort ? `CLI 默认 · ${t.effort}` : 'CLI 默认');
  // 账号用量：读 /api/state 已缓存的 runtime.claudeUsage（订阅账号才有 session/本周），无则不显示
  const cu = stateData?.runtime?.claudeUsage;
  const usageHtml = provider === 'claude' && cu && cu.ok && cu.subscription ? ccUsageBody(cu) : '';
  return `
    <div class="side-block">
      <h3>${escapeHtml(def?.label || provider)}</h3>
      ${kv('session', sessionId ? escapeHtml(sessionId) : '<span style="color:var(--dim)">—</span>')}
      ${kv('模型', escapeHtml(modelVal))}
      ${def?.capabilities?.dynamicWorkflow && t.dynamicWorkflow != null ? kv('动态工作流', t.dynamicWorkflow ? '<span style="color:var(--jade)">开</span>' : '关') : ''}
      ${usageHtml ? `<div class="cc-usage">${usageHtml}</div>` : ''}
    </div>`;
}

// ---- 上下文用量环形（详情页底栏 model 控件右侧）：已用上下文 / 该模型真实上下文窗口 ----
// 上限取真实值——不按 model 名硬编码，走 /api/model-context（后端问 Anthropic Models API 的 max_input_tokens）。
// 上下文窗口是 model 静态属性 → 前端按 model 缓存 6h；上限未拿到时环形留灰、tooltip 标「上限未知」，不编造分母。
const modelCtxCache = {};        // model → { at, maxInputTokens|null, error }
const modelCtxInflight = {};     // model → true（并发去重）
const MODEL_CTX_TTL = 6 * 60 * 60000;
function ensureModelCtxLimit(model, taskKey) {
  if (!model || model === '—') return;
  const hit = modelCtxCache[model];
  if (hit && Date.now() - hit.at < MODEL_CTX_TTL) return;   // 新鲜：不重复拉
  if (modelCtxInflight[model]) return;
  modelCtxInflight[model] = true;
  api('/api/model-context?model=' + encodeURIComponent(model)).then((r) => {
    modelCtxCache[model] = { at: Date.now(), maxInputTokens: (r && r.ok) ? r.maxInputTokens : null, error: r && r.error };
    if (modalOpen && modalPollTaskKey === taskKey) syncContextRing(taskKey);   // 上限到货重画环形
  }).catch(() => { modelCtxCache[model] = { at: Date.now(), maxInputTokens: null, error: 'fetch-failed' }; })
    .finally(() => { delete modelCtxInflight[model]; });
}
// 环形 tooltip 专用紧凑单位（306.4K / 1.0M）：一位小数、观感优先；精确值放行内 title 悬浮可见。
// 不复用 compactTokens（其 M 为两位小数「1.00M」且被运行时聚合/CC 卡片共用，改它会波及别处）。
function fmtCtxTok(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function ctxTipRow(k, v, title) { return `<div class="ctx-tip-row"><span>${k}</span><span${title ? ` title="${escapeAttr(title)}"` : ''}>${v}</span></div>`; }
// 环形 + hover 明细。半径 8 → 周长 2π·8≈50.27；进度弧用 dashoffset 收缩，≥80% 红 / ≥50% 琥珀 / 否则绿（对齐用量条）
function contextRingHtml(ctxSize, model, limInfo) {
  const C = 50.27;
  const limit = (limInfo && limInfo.maxInputTokens) ? limInfo.maxInputTokens : null;
  let color = 'var(--mut)', off = C, pctTxt = '·', arc = '', ariaPct = '上限未知';
  if (limit) {
    const pct = Math.max(0, Math.min(100, ctxSize / limit * 100));
    color = pct >= 80 ? 'var(--coral)' : pct >= 50 ? 'var(--amber)' : 'var(--jade)';
    off = C * (1 - pct / 100);
    pctTxt = (pct > 0 && pct < 10) ? pct.toFixed(1) + '%' : pct.toFixed(0) + '%';
    ariaPct = pctTxt;
    arc = `<circle cx="10" cy="10" r="8" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 10 10)"/>`;
  }
  const rows = [`<div class="ctx-tip-title">上下文用量</div>`];
  if (limit) {
    rows.push(`<div class="ctx-tip-big"><span style="color:${color}">${pctTxt}</span> <span class="ctx-tip-dim">已用</span></div>`);
    const remain = Math.max(0, limit - ctxSize);
    rows.push(ctxTipRow('已用', fmtCtxTok(ctxSize), ctxSize.toLocaleString('en-US')));
    rows.push(ctxTipRow('上限', fmtCtxTok(limit), limit.toLocaleString('en-US')));
    rows.push(ctxTipRow('剩余', fmtCtxTok(remain), remain.toLocaleString('en-US')));
    rows.push(ctxTipRow('模型', escapeHtml(model)));
    rows.push(`<div class="ctx-tip-note">上限为该模型真实上下文窗口（Anthropic Models API）</div>`);
  } else {
    rows.push(ctxTipRow('已用', fmtCtxTok(ctxSize), ctxSize.toLocaleString('en-US')));
    rows.push(ctxTipRow('模型', escapeHtml(model)));
    const why = (limInfo && limInfo.error) ? `上限获取失败（${escapeHtml(limInfo.error)}）` : '上限获取中…';
    rows.push(`<div class="ctx-tip-note">${why}</div>`);
  }
  return `
    <div class="ctx-ring" tabindex="0" aria-label="上下文用量 ${ariaPct}">
      <svg class="ctx-ring-svg" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8" fill="none" stroke="var(--hair2)" stroke-width="2.5"/>
        ${arc}
      </svg>
      <span class="ctx-ring-pct"${limit ? ` style="color:${color}"` : ''}>${pctTxt}</span>
      <div class="ctx-ring-tip">${rows.join('')}</div>
    </div>`;
}
// 用 currentModalData 末轮的 contextSize + 会话真实 model 刷新环形；无上下文数据则清空容器（保留其 margin-right:auto 布局位）
function syncContextRing(taskKey) {
  const wrap = document.getElementById('modalCtxRing');
  if (!wrap) return;
  const task = findTaskInState(taskKey);
  if ((task?.provider || 'claude') !== 'claude') { wrap.innerHTML = ''; return; }
  const rounds = (currentModalData?.rounds || []).filter((x) => !x.error);
  const lastOk = rounds[rounds.length - 1] || null;
  const ctxSize = lastOk?.ccSummary?.contextSize;
  const model = lastOk?.ccSummary?.model || lastOk?.systemInit?.model || null;
  if (ctxSize == null || !model) { wrap.innerHTML = ''; return; }
  ensureModelCtxLimit(model, taskKey);
  wrap.innerHTML = contextRingHtml(ctxSize, model, modelCtxCache[model]);
}

// ---- 右侧信息栏：任务信息 kv / 描述 / 快捷操作（参考 detail-side）----
function renderTaskSide(taskKey) {
  const el = $('taskSide');
  if (!el) return;
  const t = findTaskInState(taskKey);
  const r = currentModalData;
  if (!t) { el.innerHTML = ''; return; }
  const rounds = (r?.rounds || []).filter((x) => !x.error);
  const meta = t.meta || {};
  const lastOk = rounds[rounds.length - 1] || null;
  // 被旁观的 CLI 会话（带 t.cli）：processing 不给「中断」、归档区给「从看板移除」。物化后无 t.cli，与其它来源一致。
  const isObservedCli = !!t.cli;
  // 模型/cwd/git/工作时长/最近活动：CLI 与看板任务统一从详情 round 取（readWorkerLog 对两类同构产出）——不按来源分叉
  const model = lastOk?.ccSummary?.model || lastOk?.systemInit?.model || t.model || t.meta?.model || '—';
  const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
  const kv = (k, v) => `<div class="side-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const tags = [
    sourceTagHtml(t),                                   // 卡片左下角同款来源标签，放状态标签前
    stateTagHtml(t.state),
    t.outcome === 'cancelled' ? '<span class="tag tag-coral">用户中断</span>' : '',
    t.isArchive ? '<span class="tag tag-mut">已归档</span>' : '',
    r?.hasInflight ? '<span class="tag tag-amber" style="animation:pulse 1.6s infinite">● 实时</span>' : '',
  ].filter(Boolean).join(' ');
  const failureHtml = t.outcomeDetail?.failureReason
    ? `<div style="margin-top:10px;padding:8px 10px;border:1px solid color-mix(in oklab, var(--destructive) 35%, transparent);border-radius:8px;background:color-mix(in oklab, var(--destructive) 8%, transparent);color:var(--coralT);font-size:11.5px;line-height:1.6">${escapeHtml(t.outcomeDetail.failureReason)}</div>`
    : '';
  const commentHtml = t.business?.commentUrl
    ? `<div style="margin-top:10px;font-size:12px"><a href="${escapeAttr(t.business.commentUrl)}" target="_blank" style="color:var(--cyan)">↗ 已发 issue 评论</a></div>`
    : '';
  // 快捷操作（与看板卡片同一套全局动作，按状态统一）：完成/取消完成/归档/取消归档 对所有来源一致；
  // 仅执行差异按 t.cli（被旁观 CLI）分支——其 processing 不干预终端进程、归档区额外「从看板移除」。
  const btns = [];
  const _bk = escapeAttr(t.taskKey);
  if (t.isArchive) {
    btns.push(`<button class="btn" onclick="unarchiveTaskAction('${_bk}')">↺ 取消归档</button>`);
    if (isObservedCli) btns.push(`<button class="btn btn-danger" onclick="removeCliSession('${escapeAttr(t.meta?.sessionId || '')}')">从看板移除</button>`);
  } else if (t.state === 'plan') {
    btns.push(`<button class="btn" style="color:var(--jade);border-color:color-mix(in oklab, var(--success) 40%, transparent)" onclick="approveTaskAction('${_bk}')">▶ 确认排队</button>`);
    btns.push(`<button class="btn" onclick="archiveTask('${_bk}')">归档</button>`);
  } else if (['queued', 'processing'].includes(t.state)) {
    // live 会话已收敛（idle/closed）但任务 state 还没轮询刷成 awaiting-human 的空窗期，不再显示「中断」——
    // 与「打断」同源于 mb.state，result 一到即随 mbSyncLiveHead→renderTaskSide 一起隐藏，不必等 5s 轮询。
    // 非 live 任务（无 mb / 不匹配）→ liveRunning 恒真，按 t.state 原逻辑显示，不受影响。
    const liveRunning = !mb || mb.id !== t.mbSessionId || mb.state === 'running' || mb.state === 'starting';
    if (!isObservedCli && liveRunning) btns.push(`<button class="btn btn-danger" onclick="cancelTaskAction('${_bk}')">中断</button>`);
  } else if (t.state === 'awaiting-human') {
    btns.push(`<button class="btn" style="color:var(--jade);border-color:color-mix(in oklab, var(--success) 40%, transparent)" onclick="completeTaskAction('${_bk}')">✓ 完成</button>`);
    btns.push(`<button class="btn" style="color:var(--cyan)" onclick="moveToPlanAction('${_bk}')">↩ 退回计划</button>`);
    btns.push(`<button class="btn" onclick="archiveTask('${_bk}')">归档</button>`);
  } else if (t.state === 'done') {
    btns.push(`<button class="btn" onclick="uncompleteTaskAction('${_bk}')">↺ 取消完成</button>`);
    btns.push(`<button class="btn" style="color:var(--cyan)" onclick="moveToPlanAction('${_bk}')">↩ 退回计划</button>`);
    btns.push(`<button class="btn" onclick="archiveTask('${_bk}')">归档</button>`);
  }
  const descText = t.description || '';
  // 工作时长：claude 实际在算的时长（区别于创建→结束墙钟）；CLI 单 round、看板任务多 round，累加逻辑通用。
  // 优先 ccSummary.workMs（turn_duration 累加，无 rounds.jsonl 也有值）；退回本轮 startedAt→endedAt 墙钟。
  let workMs = 0;
  (r?.rounds || []).forEach((rd) => {
    let d = rd.ccSummary?.workMs || 0;
    if (!d && rd.startedAt && rd.endedAt) {
      const w = new Date(rd.endedAt) - new Date(rd.startedAt);
      if (w > 0 && !isNaN(w)) d = w;
    }
    workMs += d;
  });
  // 动态：state 流转时间线（参考 cloud-team 右侧 timeline：竖线 + 彩点 + 间隔耗时）
  const TL_DOT = { plan: 'var(--dim)', queued: 'var(--mut)', processing: 'var(--amber)', done: 'var(--cyan)', 'awaiting-human': 'var(--coral)', cancelled: 'var(--coral)' };
  const history = Array.isArray(t.history) ? t.history : [];
  // 倒叙展示（最新在上）：先按时间序算好每条的 +delta（距上一条更早状态的间隔，语义不变），再整体 reverse
  const tlHtml = history.map((h, i) => {
    let deltaTxt = '';
    if (i > 0 && history[i - 1].at && h.at) {
      const d = new Date(h.at) - new Date(history[i - 1].at);
      if (d > 0 && !isNaN(d)) deltaTxt = ` · +${fmtDuration(d)}`;
    }
    return `
      <div class="tl-item">
        <span class="tl-dot" style="border-color:${TL_DOT[h.state] || 'var(--hair2)'}"></span>
        <div class="tl-body">
          <div class="tl-text">${escapeHtml(h.state)}${h.by ? ` <span style="color:var(--dim)">by ${escapeHtml(h.by)}</span>` : ''}</div>
          <div class="tl-meta">${escapeHtml(h.at || '')}${deltaTxt}</div>
        </div>
      </div>`;
  }).reverse().join('');
  // 统一字段值：所有任务「任务信息」按同一字段集展示，共有字段（cwd/git/最近活动）一律取自详情 round
  // （readWorkerLog 对 CLI/看板任务同构产出）+ t.cli/t.cwd 兜底，不按来源分叉；
  // 权限模式/后台任务/jsonl大小是 CLI 会话独有真实数据，按 t.cli 存在性显（看板任务无 → 不显/—）。
  const rtCwds = [...new Set((r?.rounds || []).map((x) => x?.cwd || x?.systemInit?.cwd).filter(Boolean))];
  const rtCwd = rtCwds[rtCwds.length - 1] || null;
  const cwdVal = rtCwd || t.cli?.cwd || t.cwd || '—';
  // worktree 任务：实际运行目录（rtCwd/meta.worktreeDir）是隔离出来的 worktree 目录，与 task.cwd 配的工作目录不是一回事，
  // 拆两行分别展示，避免「cwd」这一行看着像工作目录、实为 worktree 目录的误导。非 worktree 任务仍只有一个目录，维持单行。
  const baseCwdVal = t.cwd || t.cli?.cwd || '—';
  const worktreeDirVal = t.worktree ? (t.worktreeDir || rtCwd || '（首轮起会话时新建）') : null;
  const gitVal = lastOk?.gitBranch || t.cli?.gitBranch || '—';
  const permMode = (t.cli?.mode && t.cli.mode !== 'normal') ? t.cli.mode : null;   // CLI 非 normal 权限模式才显
  const bgTasks = Number(t.backgroundTaskCount) || 0;   // 统一后台维度：>0 = 主进程让出后仍有后台任务在跑（subagent / 后台命令 / Monitor）
  const jsonlVal = t.cli?.jsonlBytes ? (t.cli.jsonlBytes / 1024 / 1024).toFixed(2) + ' MB' : '—';
  const lastActive = t.lease?.heartbeatAt || meta.lastRoundAt || t.resolvedAt || '—';
  const sideTitle = t.title || t.taskKey;
  const canRename = !t.isArchive;   // 非归档任务可重命名：统一走 /api/task/rename，后端按来源分派（看板任务写 task.json / CLI 写 watchlist）
  el.innerHTML = `
    <div class="side-block">
      <h3>任务信息</h3>
      <div class="side-title-row">
        <span class="side-title" title="${escapeAttr(sideTitle)}">${escapeHtml(sideTitle)}</span>
        ${canRename ? `<button class="btn side-edit" title="重命名任务" onclick="renameTaskPrompt('${escapeAttr(t.taskKey)}')">✎</button>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:10px 0">${tags}</div>
      ${kv('taskKey', escapeHtml(t.taskKey))}
      ${t.worktree
        ? `${kv('工作目录', escapeHtml(baseCwdVal))}${kv('worktree 目录', escapeHtml(worktreeDirVal))}`
        : kv('cwd', escapeHtml(cwdVal))}
      ${kv('git', escapeHtml(gitVal))}
      ${t.scheduledAt ? kv('定时执行', `<span style="color:var(--amber)">${escapeHtml(t.scheduledAt)}</span>`) : ''}
      ${t.worktree ? kv('worktree 分支', escapeHtml(t.worktreeBranch || (t.baseBranch ? `基于 ${t.baseBranch}` : '开启'))) : ''}
      ${permMode ? kv('权限模式', escapeHtml(permMode)) : ''}
      ${bgTasks > 0 ? kv('后台任务', `<span style="color:var(--amber)">${bgTasks} 个运行中（主进程已让出，等后台完成）</span>`) : ''}
      ${/* turns / jsonl 大小 暂不在此展示（数据保留于 meta.numTurns / jsonlVal，待定放置位置）*/''}
      ${kv('创建', escapeHtml(t.createdAt || '—'))}
      ${kv('最近活动', escapeHtml(lastActive))}
      ${kv('总耗时', fmtDuration(t.durationMs))}
      ${kv('工作时长', workMs > 0 ? fmtDuration(workMs) : '—')}
      ${failureHtml}
      ${commentHtml}
    </div>
    ${agentCardHtml(t, model)}
    <div class="side-block">
      <h3>任务描述 <button class="btn" style="margin-left:auto;font-size:10px;padding:1px 9px" onclick="editTaskDesc('${escapeAttr(t.taskKey)}')">✎ 编辑</button></h3>
      ${descText
        ? `<div style="font-size:12.5px;color:var(--ink2);line-height:1.7;white-space:pre-wrap;word-break:break-word">${escapeHtml(descText)}</div>`
        : '<div style="font-size:11.5px;color:var(--dim)">暂无 · 自己看的备注，不会发给 Agent</div>'}
    </div>
    ${btns.length ? `<div class="side-block"><h3>操作</h3><div class="side-actions">${btns.join('')}</div></div>` : ''}
    ${tlHtml ? `<div class="side-block"><h3>动态</h3><div class="timeline">${tlHtml}</div></div>` : ''}
  `;
  // 面包屑末级同步任务标题（详情页 header 已移除，标题改在此块内展示 · req4）
  const crumbLast = document.getElementById('crumbLast');
  if (crumbLast) crumbLast.textContent = sideTitle;
  // 底栏上下文用量环形：每次侧栏刷新（轮询 / live 同步）都同步一次，跟随 contextSize 变化
  syncContextRing(taskKey);
}

function renderDetailTab(r, liveMb) {
  const rounds = r.rounds || [];
  if (rounds.length === 0) return '<div style="color:var(--dim);padding:12px 0">无会话数据</div>';
  const parts = [];
  rounds.forEach((round) => {
    if (round.error) {
      parts.push(`<div style="border:1px solid var(--hair);border-radius:10px;padding:12px 14px;background:var(--card2);margin-bottom:12px;color:var(--coral)">${escapeHtml(round.error)}</div>`);
      return;
    }
    const ccs = round.humanCc || [];
    const msgs = round.messages || [];
    // tool_result 按 tool_use_id 建索引——CC 终端风格：结果渲染在对应 ⏺ 工具行下方的 ⎿ 处
    const resultById = {};
    msgs.forEach((m) => {
      if (m.role === 'user') (m.content || []).forEach((c) => { if (c.type === 'tool_result' && c.tool_use_id) resultById[c.tool_use_id] = c; });
    });
    // 显示单元：assistant 消息 + 含真实 text 的 user 消息；纯 tool_result 的 user 消息已被配对消费
    const units = [];
    msgs.forEach((m) => {
      if (m.role === 'assistant') units.push({ m, kind: 'a' });
      else if (m.role === 'user' && (m.content || []).some((c) => c.type === 'text' && c.text)) units.push({ m, kind: 'u' });
    });
    // 本轮用户消息（chat drain 每轮可能有新消息，留在流内对应位置；展示剥指令前缀）
    if (ccs.length > 0) {
      parts.push(ccs.map((cc) => `
        <div class="msg-user">
          <div class="msg-user-bubble" title="${escapeAttr(fmtTime(cc.at))}">${escapeHtml(stripDirectivePrefix(cc.text))}</div>
        </div>`).join(''));
    }
    parts.push(renderCcFlow(units, resultById, false, round.inflight));
    // 整轮工作时长：优先 ccSummary.workMs（turn_duration 累加 = claude 实际在算的时长，
    // 不含用户输入间隔）；无 turn_duration 数据时退回墙钟（rounds.jsonl 起止 → 消息首尾时间戳）
    let roundDur = round.ccSummary?.workMs || null;
    if (!roundDur) {
      if (round.startedAt && round.endedAt) roundDur = new Date(round.endedAt) - new Date(round.startedAt);
      else {
        const ats = msgs.map((m) => m.at).filter(Boolean);
        if (ats.length >= 2) roundDur = new Date(ats[ats.length - 1]) - new Date(ats[0]);
      }
    }
    const durTxt = (roundDur > 0 && !isNaN(roundDur)) ? `Worked for ${fmtDuration(roundDur)} in total${round.inflight ? '（进行中）' : ''}` : '';
    if (liveMb && round.inflight) {
      // 实时会话进行中：本轮统计汇总不显示，改由 mbRenderBody 底部 mbStatus 实时状态行承载
    } else if (durTxt) {
      parts.push(`<div class="cc-dur cc-dur-total"><span>✻</span><span>${durTxt}</span></div>`);
    }
  });
  return parts.join('');
}

// Workflow（动态工作流）入参两形：首发 {script:<整段 JS 源码>}，迭代 / 续跑 {scriptPath, resumeFromRunId?}。
// 走默认的 JSON.stringify 会把整段脚本源码糊进摘要行（实测前 90 字全是 meta 头），故单独取名：
// 源码里按 CC 约定的 `export const meta = { name, description }` 提取；只有 scriptPath 时退到文件名
// （CC 落盘名为 <name>-<runId>.js）。两者都取不到只出「工作流」，不拿源码片段硬凑。
function workflowArgSummary(i) {
  // 从 meta 块起非贪婪找首个该键 → 不会被脚本正文里别处的 name/description 骗到
  const inMeta = (key) => {
    const m = String(i.script || '').match(
      new RegExp(`export\\s+const\\s+meta\\s*=\\s*\\{[\\s\\S]*?\\b${key}\\s*:\\s*['"]([^'"]+)['"]`));
    return m ? m[1] : '';
  };
  let name = inMeta('name');
  if (!name && i.scriptPath) {
    name = String(i.scriptPath).split(/[\\/]/).pop().replace(/-wf_[^.]*(?=\.js$)/i, '').replace(/\.js$/i, '');
  }
  const bits = [name || '工作流'];
  const desc = inMeta('description');
  if (desc) bits.push(desc);
  if (i.resumeFromRunId) bits.push(`续跑 ${i.resumeFromRunId}`);
  return bits.join(' · ');
}

// 时间格式化
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 消息路由：user 里全是 tool_result → tool turn（淡内嵌容器，语义是"机器输出"不是"用户说话"）
// ==== 详情流消息渲染：Claude Code 终端风格 ====
// ⏺ 正文（markdown）· ⏺ 工具名(参数摘要) + ⎿ 结果首行摘要（点开看完整入参 / 全文输出）· ✻ Thinking 低调折叠
function toolArgSummary(c) {
  const i = c.input || {};
  let s;
  switch (c.name) {
    case 'Bash': case 'PowerShell': s = i.command; break;
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': s = i.file_path; break;
    case 'Grep': case 'Glob': s = i.pattern; break;
    case 'Task': case 'Agent': s = i.description || i.prompt; break;
    case 'Workflow': s = workflowArgSummary(i); break;
    case 'TodoWrite': s = `${(i.todos || []).length} todos`; break;
    case 'TaskCreate': s = `✚ ${i.subject || i.description || ''}`; break;
    case 'TaskUpdate': s = `↻ #${i.taskId || '?'} → ${i.status || i.subject || '?'}`; break;
    case 'TaskList': s = 'list tasks'; break;
    case 'AskUserQuestion': s = i.questions?.[0]?.question || 'ask user'; break;
    case 'ToolSearch': s = i.query; break;
    case 'ExitPlanMode': s = (i.plan || '').split(/\r?\n/).find((l) => l.trim()) || 'submit plan'; break;
    case 'WebFetch': s = i.url; break;
    case 'WebSearch': s = i.query; break;
    case 'Skill': s = i.skill; break;
    default: s = JSON.stringify(i);
  }
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}

function toolResultText(c) {
  if (!c) return '';
  if (typeof c.content === 'string') return c.content;
  if (Array.isArray(c.content)) return c.content.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n');
  return c.content == null ? '' : JSON.stringify(c.content);
}

function renderCcTool(c, result, inflight) {
  const name = escapeHtml(c.name || 'Tool');
  const arg = escapeHtml(toolArgSummary(c));
  // 每步耗时：tool_use._ts → tool_result._ts（完成，亚秒精度）；进行中轮里未完成的工具 → live 跳秒
  const useTs = c._ts ? new Date(c._ts).getTime() : null;
  let durBadge = '';
  if (result && useTs && result._ts) {
    const d = new Date(result._ts).getTime() - useTs;
    if (d >= 0) durBadge = `<span class="cc-step-dur" style="color:var(--dim);margin-left:6px;font-size:10.5px" title="本步耗时 tool_use→tool_result">· ${fmtStepDur(d)}</span>`;
  } else if (!result && inflight && useTs) {
    durBadge = `<span class="cc-step-dur cc-live-timer" data-since="${useTs}" style="color:var(--amber);margin-left:6px;font-size:10.5px" title="进行中，已用时">· ${fmtDuration(Date.now() - useTs)}</span>`;
  }
  // 入参展开区：Edit 渲染成 old/new diff 色块；Workflow 的 script 直接出源码；其余美化 JSON
  let inputBody;
  if (c.name === 'Edit' && c.input?.old_string != null) {
    inputBody = `<pre class="diff-old">${escapeHtml(String(c.input.old_string).slice(0, 2000))}</pre><pre class="diff-new">${escapeHtml(String(c.input.new_string ?? '').slice(0, 2000))}</pre>`;
  } else if (c.name === 'Workflow' && c.input?.script) {
    // 编排脚本是整段 JS，JSON.stringify 后换行全成字面 \n 挤成一行、没法读 → 原样出源码
    const src = String(c.input.script);
    inputBody = `<pre class="cc-pre">${escapeHtml(src.slice(0, 8000))}${src.length > 8000 ? '\n…(截断)' : ''}</pre>`;
  } else {
    inputBody = `<pre class="cc-pre">${escapeHtml(JSON.stringify(c.input || {}, null, 2).slice(0, 4000))}</pre>`;
  }
  // 结果区：TodoWrite 直接渲染任务清单（含 activeForm 优先）；其余首行摘要 + 展开全文；无 result = 进行中
  // CC 官方约定：in_progress 状态显示 activeForm（现在进行式），其他状态显示 content（祈使式）
  let resHtml;
  if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) {
    resHtml = `<div class="cc-todo">${c.input.todos.map((td) => {
      const done = td.status === 'completed';
      const active = td.status === 'in_progress';
      const mark = done ? '✓' : active ? '●' : '○';
      const cls = done ? 'done' : active ? 'doing' : '';
      const label = active && td.activeForm ? td.activeForm : (td.content || '');
      return `<div class="cc-todo-item ${cls}">${mark} ${escapeHtml(label)}</div>`;
    }).join('')}</div>`;
  } else if (result) {
    const txt = toolResultText(result);
    const lines = txt.split(/\r?\n/);
    const first = (lines.find((l) => l.trim()) || '(no output)').trim();
    const sum = first.length > 110 ? first.slice(0, 110) + '…' : first;
    const more = lines.length > 1 ? ` <span class="cc-more">(+${lines.length - 1} 行)</span>` : '';
    resHtml = `
      <details class="cc-exp${result.is_error ? ' err' : ''}">
        <summary>${escapeHtml(sum)}${more}</summary>
        <pre class="cc-pre">${escapeHtml(txt.slice(0, 20000))}${txt.length > 20000 ? '\n…(截断)' : ''}</pre>
      </details>`;
  } else {
    resHtml = '<span class="cc-more">运行中…</span>';
  }
  return `
    <div class="cc-tool">
      <div class="cc-line">
        <span class="cc-dot${result?.is_error ? ' err' : ''}">⏺</span>
        <details class="cc-exp cc-head">
          <summary><span class="cc-name">${name}</span><span class="cc-args">(${arg})</span>${durBadge}</summary>
          ${inputBody}
        </details>
      </div>
      <div class="cc-res">
        <span class="cc-elbow">⎿</span>
        <div class="cc-res-body">${resHtml}</div>
      </div>
    </div>`;
}

function renderCcThink(c) {
  const text = String(c.thinking || c.text || '');
  if (!text) return '';
  return `<div class="cc-think"><details class="cc-exp"><summary>✻ Thinking · ${text.length}c</summary><div class="cc-think-body">${escapeHtml(text)}</div></details></div>`;
}

// ==== 工作块折叠（学 CC 终端）：两段正文之间的连续工具活动折叠成一行汇总 ====
// "Searched for 1 pattern, read 2 files, ran 3 shell commands"，点开平铺各工具行
function toolGroupSummary(tools) {
  const catOf = (name) => {
    switch (name) {
      case 'Read': return 'read';
      case 'Bash': case 'PowerShell': return 'shell';
      case 'Grep': case 'Glob': return 'search';
      case 'Edit': case 'Write': case 'NotebookEdit': return 'edit';
      case 'WebFetch': case 'WebSearch': return 'web';
      case 'Task': case 'Agent': return 'agent';
      case 'Workflow': return 'workflow';
      case 'TodoWrite': return 'todo';
      case 'TaskCreate': case 'TaskUpdate': case 'TaskList': return 'task';
      case 'ExitPlanMode': return 'plan';
      case 'AskUserQuestion': return 'ask';
      default: return 'tool';
    }
  };
  const counts = new Map();   // Map 保持插入序 → 汇总句按首次出现顺序
  tools.forEach((c) => { const k = catOf(c.name); counts.set(k, (counts.get(k) || 0) + 1); });
  const phrase = (k, n) => {
    const s = n > 1 ? 's' : '';
    switch (k) {
      case 'read': return `read ${n} file${s}`;
      case 'shell': return `ran ${n} shell command${s}`;
      case 'search': return `searched for ${n} pattern${s}`;
      case 'edit': return `edited ${n} file${s}`;
      case 'web': return `fetched ${n} web page${s}`;
      case 'agent': return `launched ${n} agent${s}`;
      case 'workflow': return `launched ${n} workflow${s}`;
      case 'todo': return 'updated todos';
      case 'task': return `updated ${n} task${s}`;
      case 'plan': return 'submitted plan';
      case 'ask': return 'asked user';
      default: return `called ${n} tool${s}`;
    }
  };
  const sentence = [...counts.entries()].map(([k, n]) => phrase(k, n)).join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// 把过滤后的显示单元展开成块序列并渲染：text/user/meta 平铺，连续 tool+thinking 聚成折叠工作组
function renderCcFlow(units, resultById, forceOpen, inflight) {
  const blocks = [];
  units.forEach((u) => {
    if (u.kind === 'u') {
      // 分派（学 claude-code-session/server/lib/system-tags.ts 与 web/MessageBubble.tsx）：
      //   1. SYSTEM_TAG_RE / CC_SYNTHETIC_RE / INJECTED_RETRY_RE / INTERRUPT_RE / TASK_NOTIFICATION_RE /
      //      SKILL_BODY_RE 命中 → 归 Claude Code 运行输出（左侧细line）：<local-command-*> + <system-reminder> +
      //      CC/runner 注入的工具重试消息 + 用户打断标记 + 后台任务通知 + Skill 注入的技能正文（都非真人发送）
      //   2. CMD_HEAD_RE 命中 → 提取 <command-args> body 当用户真实 prompt；无 args → 整条跳过（/clear /model）
      //   3. 兜底 isMeta 字段 → 同上归运行输出（磁盘路径的 caveat/system-reminder/Skill 正文走这条）
      //   4. 否则 → 正常 user 气泡（右侧只放真人真实发送的消息）
      const text = (u.m.content || []).map((c) => (c.type === 'text' ? String(c.text || '') : '')).join('\n');
      if (LOCAL_CMD_CAVEAT_RE.test(text)) return;   // 跑本地命令注入的 caveat 样板(+命令块) → 纯运行噪声，整条不显示
      if (SYSTEM_TAG_RE.test(text) || CC_SYNTHETIC_RE.test(text) || INJECTED_RETRY_RE.test(text) || INTERRUPT_RE.test(text) || TASK_NOTIFICATION_RE.test(text) || SKILL_BODY_RE.test(text)) {
        blocks.push({ t: 'meta', m: u.m });
      } else if (CMD_HEAD_RE.test(text)) {
        const argsBody = pickCommandArgs(text);
        if (argsBody) {
          // 用 args body 替换 content，走正常 user 渲染 —— 这就是"用户真实 prompt"
          blocks.push({ t: 'user', m: { ...u.m, content: [{ type: 'text', text: argsBody }] } });
        }
        // args 为空（/clear、/model 等元数据调用）→ 完全跳过，不 push
      } else if (u.m.isMeta) {
        blocks.push({ t: 'meta', m: u.m });
      } else {
        blocks.push({ t: 'user', m: u.m });
      }
      return;
    }
    (u.m.content || []).forEach((c) => {
      if (c.type === 'text' && c.text) blocks.push({ t: 'text', c });
      else if (c.type === 'thinking' && (c.thinking || c.text)) blocks.push({ t: 'think', c });
      else if (c.type === 'tool_use') blocks.push({ t: 'tool', c, res: resultById[c.id] });
    });
  });
  const out = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.t === 'meta') { out.push(renderMetaTurn(b.m)); i++; continue; }
    if (b.t === 'user') { out.push(renderUserTurn(b.m)); i++; continue; }
    if (b.t === 'text') {
      out.push(`<div class="cc-line cc-text"><span class="cc-dot">⏺</span><div class="md-body" style="flex:1;min-width:0">${window.marked.parse(String(b.c.text))}</div></div>`);
      i++; continue;
    }
    // 连续 tool/think 段
    let j = i;
    while (j < blocks.length && (blocks[j].t === 'tool' || blocks[j].t === 'think')) j++;
    const group = blocks.slice(i, j);
    const tools = group.filter((x) => x.t === 'tool');
    const inner = group.map((x) => (x.t === 'tool' ? renderCcTool(x.c, x.res, inflight) : renderCcThink(x.c))).join('');
    if (tools.length < 2) {
      out.push(inner);   // 单个工具不折叠，平铺更省一次点击
    } else {
      const hasErr = tools.some((x) => x.res?.is_error);
      out.push(`
        <details class="cc-group"${forceOpen ? ' open' : ''}>
          <summary><span class="cc-dot${hasErr ? ' err' : ''}">⏺</span><span class="cc-gsum">${escapeHtml(toolGroupSummary(tools.map((x) => x.c)))}</span>${hasErr ? ' <span style="color:var(--coralT);font-size:12px">(有失败)</span>' : ''}</summary>
          <div class="cc-gbody">${inner}</div>
        </details>`);
    }
    i = j;
  }
  return out.join('');
}

// 非真人消息（<local-command-*> / <system-reminder> / <caveat> / jsonl.isMeta / CC·runner 注入的工具重试）
// → 作为「Claude Code 端运行输出」左对齐细line 展示：跟在执行流里，读作运行时提示/错误，
// 既不是用户气泡（右侧只放真人消息），也不再用之前那条居中的 system 分隔线。
// 这类消息（工具调用失败重试等）需要用户注意，故与错误同色——红：点用 cc-dot.err(--coral)、正文用 --coralT。
// 命令 XML 由 renderCcFlow 前置分派处理（args body 变正常 user；无 args 命令直接跳过）。
function renderMetaTurn(m) {
  const text = (m.content || []).map((c) => (c.type === 'text' ? String(c.text || '') : '')).join('\n');
  // 后台任务通知：只留 <summary>（+ Monitor 的 <event>），并用后台维度的琥珀色——它不是异常，
  // 与其余 meta（工具重试 / 打断 / system-reminder，珊瑚色 = 异常）区分开。
  const notif = pickTaskNotification(text);
  // 剥 XML tag 只留内容：<local-command-stdout>Enabled plan mode</local-command-stdout> → Enabled plan mode
  const stripped = notif ?? text.replace(/<\/?(?:local-command-[a-z-]+|system-reminder|caveat)>/gi, '').trim();
  const trimmed = (stripped || text).replace(/\s+/g, ' ').trim();
  const short = trimmed.length > 300 ? trimmed.slice(0, 300) + '…' : trimmed;
  if (!short) return '';
  const tone = notif ? 'var(--amber)' : 'var(--coralT)';
  return `
    <div class="cc-line cc-sysnote" title="${escapeAttr(fmtTime(m.at))}">
      <span class="cc-dot${notif ? '' : ' err'}"${notif ? ' style="color:var(--amber)"' : ''}>⏺</span>
      <div style="flex:1;min-width:0;font-size:12px;color:${tone};line-height:1.6;white-space:pre-wrap;word-break:break-word">${escapeHtml(short)}</div>
    </div>`;
}

// 学 claude-code-session/server/lib/system-tags.ts：
// SYSTEM_TAG_RE 匹配"纯 system 注入"消息 → 归 Claude Code 运行输出（左侧细line，不是用户气泡）：
//   - <local-command-*>（stdout / stderr / caveat）
//   - <system-reminder>
//   - <caveat>（legacy 命名）
// CMD_HEAD_RE 匹配斜杠命令消息 → 提取 <command-args> body 当"用户真实 prompt"，无 args 则整条跳过
//   - CC 认定：斜杠命令是用户驱动的，args body 就是用户的实际 prompt，不该额外加胶囊
//   - /clear、/model 之类无 args 命令 → 跳过不显示（视觉噪声）
const SYSTEM_TAG_RE = /^\s*<(local-command|system-reminder|caveat)/i;
const CMD_HEAD_RE = /^\s*<command-(?:name|message|args)>/;
// 跑本地命令时 CC 注入的 caveat 样板（"Caveat: The messages below were generated by the user while running local commands…"）
// —— 连同它携带的命令块都是纯运行噪声、无对话价值，整条不显示（分派处直接跳过，见 renderCcFlow）。
const LOCAL_CMD_CAVEAT_RE = /^\s*(?:<local-command-caveat>\s*)?Caveat: The messages below were generated by the user while running local commands\b/i;
// 非真人发送、但以 role:user 混进 transcript 的「工具重试」注入消息 —— 都不是用户说的话，
// 归 Claude Code 运行输出（renderMetaTurn 左侧细line），绝不能当用户气泡展示在右侧。
//   1. CC_SYNTHETIC_RE：CC 自身在工具调用解析失败时注入的重试提示。
//   2. INJECTED_RETRY_RE：本看板 runner 的「泄漏空转」自动重试（见 task-runner.js isLeakedToolTurn 里
//      sendUserMessage 的原文）——模型把 tool_use 输出成了文本、没真执行，runner 补一条让它用结构化工具重发。
//   3. INTERRUPT_RE：用户打断某轮时 CC 注入的 role:user 标记（[Request interrupted by user] / …for tool use）——
//      是"打断"这一运行事件的记录、不是用户说的话，绝不能当用户气泡（还会误带上「改写重跑」按钮）。
//   4. SKILL_BODY_RE：Skill 加载时 CC 注入的技能正文（首行恒为 "Base directory for this skill: <path>"，
//      跟在 Skill 工具的 ⎿ "Launching skill: X" 回执之后）——是被塞进上下文的技能说明、不是真人发的话。
//      磁盘 jsonl 里它带 isMeta:true（靠下面的 isMeta 分支即可归位）；但 live 流不带 isMeta envelope，
//      只能按这个稳定首行识别，否则被错渲成右侧用户气泡。
//      （注：⎿ "Launching skill: X" 那行回执本身是结构化 tool_result，已被 units 过滤配对，不经这里。）
// 磁盘 jsonl 里 CC 那条带 isMeta:true（disk 路径靠 isMeta 也能归位），但 runner 注入的这条 isMeta 缺失、
// 且 Mode B live 的 stream-json 输出根本不带 isMeta envelope，两路都只能按内容识别，否则被错渲成用户气泡。
const CC_SYNTHETIC_RE = /^\s*Your tool call was malformed and could not be parsed\. Please retry\.\s*$/;
const INJECTED_RETRY_RE = /把工具调用输出成了文本[\s\S]*请用结构化工具重新发起这次调用/;
const INTERRUPT_RE = /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/;
//   4. TASK_NOTIFICATION_RE：后台任务（后台命令 / Monitor / subagent）起止时 CC 注入的通知——CC 用 role:user
//      注入它来唤醒让出的主进程续跑，故它形如用户消息但绝非用户所说。同样归运行输出。
const TASK_NOTIFICATION_RE = /^\s*<task-notification>/;

// task-notification 只留人话：<summary> 是给人看的那句（"Background command "X" completed (exit code 0)"），
// <event> 是 Monitor 每条事件的正文（有则并显）；task-id / tool-use-id / output-file 是机器字段，
// 对读对话的人是噪音。取不到 summary（形态变了）→ 返回 null，退回按原文显示，不静默吞消息。
function pickTaskNotification(text) {
  if (!TASK_NOTIFICATION_RE.test(text)) return null;
  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
  if (!summary) return null;
  const event = text.match(/<event>([\s\S]*?)<\/event>/)?.[1]?.trim();
  return event ? `${summary} — ${event}` : summary;
}
const SKILL_BODY_RE = /^\s*Base directory for this skill:\s*\S/;
function pickCommandArgs(text) {
  if (!CMD_HEAD_RE.test(text)) return null;
  const m = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  return (m?.[1] ?? '').trim();
}

// 原地 rewind：改写某条历史 user 消息并从那里重新执行（对齐 CC 交互 double-Esc rewind：同一 session、同一张卡片；
// 被截掉的原时间线直接丢弃、不备份）。统一入口覆盖观察态 CLI + 托管任务，后端截断 jsonl 后按 hosted 分派重跑：
//   · hosted=false（观察态 cli 会话）→ 前端收养成 Mode B live 会话、把改写后的消息从截断处叶子重跑（同「续接」路径）。
//   · hosted=true（托管任务）→ 后端已 park 空转会话 + 截断 + --resume 重跑，前端刷 state 让新 mbSessionId 现身进 live。
window.rewindMessage = async (uuid) => {
  const taskKey = modalPollTaskKey;
  if (!taskKey) return;
  // 从当前详情数据里找原文，预填编辑框
  let original = '';
  for (const rd of currentModalData?.rounds || []) {
    const m = (rd.messages || []).find((x) => x.uuid === uuid);
    if (m) { original = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'); break; }
  }
  const v = await customPrompt({
    title: '改写并从这里重新执行（rewind）',
    message: '<span style="color:var(--mut);font-size:11px">同一会话内 rewind：这条消息及之后的时间线被<b>替换</b>为你改写的内容重跑（原时间线丢弃，同 CC 交互的 rewind）。</span>',
    initial: original,
    placeholder: '改写这条消息…',
  });
  if (v === null || !v.trim()) return;
  try {
    // 后端截断 jsonl 到目标消息之前，返回 { hosted, sid? }
    const r = await api('/api/task/rewind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskKey, uuid, message: v.trim() }),
    });
    if (!r.ok) { customAlert({ title: 'rewind 失败', message: escapeHtml(r.error || '未知错误') }); return; }
    if (r.hosted) {
      // 托管任务：后端已 --resume 重跑 → 刷 state 让新 mbSessionId 现身、重载详情进 live（历史(截断后)+改写消息即时可见）
      await refreshState();
      if (modalOpen && modalPollTaskKey === taskKey) loadTaskDetail(taskKey);
    } else {
      // 观察态 CLI：截断后收养成 Mode B live 会话，把改写后的消息作新一轮从截断处重跑
      const rr = await adoptCliToLive({ taskKey, sessionId: r.sid, msg: v.trim() });
      if (!rr.ok) { customAlert({ title: 'rewind 后续接失败（jsonl 已截断，可在卡片里直接续接重发）', message: escapeHtml(rr.error || '未知错误') }); return; }
    }
  } catch (e) { customAlert({ title: 'rewind 失败', message: escapeHtml(e.message) }); }
};

// User turn（worker 外壳给 claude 的 prompt 模板，不是真人发送的 cc:；真人 cc: 在会话卡顶部单独展示）
function renderUserTurn(m) {
  const textParts = (m.content || []).map((c) => {
    if (c.type === 'text') return String(c.text || '');
    return `[${c.type}]`;
  });
  const text = textParts.join('\n\n');
  // 精确高亮：只把 currentModalData 里真人 cc: 的原文（去掉 cc: 前缀）在 prompt 里出现的位置高亮
  // prompt 模板本身不含真人 cc: 全文，一般不会命中；未来若 worker 把 cc: 内嵌到 prompt，这里自动生效
  const humanCcTexts = (currentModalData?.rounds || [])
    .flatMap((r) => (r.humanCc || []).map((cc) => String(cc.text || '').replace(/^\s*cc[:：]\s*/i, '').trim()))
    .filter((s) => s.length >= 4);
  let escaped = escapeHtml(text);
  for (const ccText of humanCcTexts) {
    const esc = escapeHtml(ccText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    escaped = escaped.replace(new RegExp(esc, 'g'), (m0) => `<mark style="background:color-mix(in oklab, var(--success) 25%, transparent);color:var(--ink);padding:1px 4px;border-radius:3px">${m0}</mark>`);
  }
  const bubble = text.length > 800
    ? `<details><summary style="cursor:pointer;list-style:none;white-space:pre-wrap;word-break:break-word;line-height:1.7"><span style="color:var(--amber);font-size:10.5px;font-family:var(--mono);margin-right:6px;background:var(--amberS);padding:1px 6px;border-radius:4px">▸ prompt 模板 · ${text.length}c</span></summary><div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--hair);white-space:pre-wrap;word-break:break-word">${escaped}</div></details>`
    : escaped;
  // 改写重跑按钮：消息有 uuid（观察态 cli 走 watchlist sid、托管任务走 meta.sessionId，两路 rewindTaskMessage 统一处理）+
  // 该任务有可 rewind 的会话（t.cli 观察态 ∪ 有 meta.sessionId 的托管任务）+ 非归档。uuid 只在磁盘/seed 消息上有，
  // live 流的最新消息无 uuid（不给按钮，本也不该 rewind 刚发的消息）。不按 source 前缀特判——按真实能力门控。
  const _rwT = findTaskInState(modalPollTaskKey);
  const canRewind = m.uuid && !!(_rwT?.cli || _rwT?.meta?.sessionId) && !_rwT?.isArchive
    && !!providerDef(_rwT?.provider || 'claude')?.capabilities?.rewind;
  const rewindBtn = canRewind
    ? `<div class="msg-rewind"><button class="btn" style="font-size:10px;padding:2px 9px;color:var(--dim)" onclick="rewindMessage('${escapeAttr(m.uuid)}')" title="改写这条消息并从这里重跑（这条及之后的时间线被替换，原时间线丢弃）">⑂ 改写重跑</button></div>`
    : '';
  return `
    <div class="msg-user">
      <div class="msg-user-bubble" title="${escapeAttr(fmtTime(m.at))}">${bubble || '<em style="color:var(--dim)">(empty)</em>'}</div>
      ${rewindBtn}
    </div>
  `;
}

// ---- 刷新 ----
async function refreshState() {
  try {
    stateData = await api('/api/state');
    renderChecker(stateData.checker);
    renderRuntime(stateData.runtime);
    renderLifecycle(stateData.lifecycle);
    syncModelLimitsInput();
    syncMaxRunnersInput();
    syncUsagePollInput();
    // 云端连线状态跟着看板节拍刷（心跳/对账时间要动）。未连接时不刷：那时区块里是三个输入框，
    // 重渲染会把用户正在填的值抹掉——只在进设置页 / 连接 / 断开时才重建表单。
    if (cloudOnSettings() && cloudStatus?.enrolled) refreshCloudStatus();
  } catch (e) { console.error('state error:', e); }
}

// 自动刷新间隔（设置页）：改值即存本机 + 重排计时器；打开详情时轮询仍由 modalOpen 门控暂停
(function initAutoRefreshInput() {
  const inp = $('autoRefreshSecInput');
  if (!inp) return;
  inp.value = String(Math.round(refreshStateMs / 1000));
  inp.addEventListener('change', () => {
    let sec = Math.round(Number(inp.value));
    if (!Number.isFinite(sec)) sec = REFRESH_MS_DEFAULT / 1000;
    sec = Math.min(Math.max(sec, REFRESH_MS_MIN / 1000), REFRESH_MS_MAX / 1000);
    inp.value = String(sec);
    refreshStateMs = sec * 1000;
    localStorage.setItem('dash-refresh-ms', String(refreshStateMs));
    scheduleStateRefresh();
  });
})();

// 设置页模型上下文上限：从 state 回填「生效映射」（编辑中不覆盖），保存走 /api/config/model-limits。
// 详情页上下文环形的分母改读此映射（内置默认 + 用户覆盖），不再打 /v1/models。
function syncModelLimitsInput() {
  const inp = $('modelLimitsInput');
  if (!inp || inp === document.activeElement || inp.dataset.dirty === '1') return;   // 编辑中不回填
  const map = stateData?.runnerConfig?.modelContextLimits || {};
  inp.value = JSON.stringify(map, null, 2);
}
{
  const inp = $('modelLimitsInput');
  const btn = $('modelLimitsSaveBtn');
  const hint = $('modelLimitsSaveHint');
  if (inp) inp.addEventListener('input', () => { inp.dataset.dirty = '1'; if (hint) hint.textContent = ''; });
  if (btn) btn.addEventListener('click', async () => {
    let map;
    try { map = JSON.parse(inp.value || '{}'); } catch { if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = 'JSON 格式错误'; } return; }
    btn.disabled = true; if (hint) { hint.style.color = 'var(--dim)'; hint.textContent = '保存中…'; }
    try {
      const r = await api('/api/config/model-limits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelContextLimits: map }) });
      if (r.ok) {
        delete inp.dataset.dirty;
        if (hint) { hint.style.color = 'var(--jade)'; hint.textContent = '已保存 · 详情页上下文环形改用此上限'; }
        refreshState();
      } else if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = r.error || '保存失败'; }
    } catch { if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = '保存失败'; } }
    finally { btn.disabled = false; }
  });
}

// 设置页账号用量刷新间隔：从 state 回填「基准」间隔（编辑中不覆盖），保存走 /api/usage-poll/interval（分钟→秒）。
// 实际每次拉取在此基准上叠加随机抖动（后端 claude-usage.js），避免固定心跳被风控识别。
function syncUsagePollInput() {
  const inp = $('usagePollMinInput');
  if (!inp || inp === document.activeElement || inp.dataset.dirty === '1') return;
  const sec = stateData?.runnerConfig?.usagePollSec ?? 600;
  inp.value = String(Math.round(sec / 60));
}
{
  const inp = $('usagePollMinInput');
  const btn = $('usagePollSaveBtn');
  const hint = $('usagePollSaveHint');
  if (inp) inp.addEventListener('input', () => { inp.dataset.dirty = '1'; if (hint) hint.textContent = ''; });
  if (btn) btn.addEventListener('click', async () => {
    let min = Math.round(Number(inp.value));
    if (!Number.isFinite(min)) min = 10;
    min = Math.min(Math.max(min, 2), 60);
    inp.value = String(min);
    btn.disabled = true; if (hint) { hint.style.color = 'var(--dim)'; hint.textContent = '保存中…'; }
    try {
      const r = await api('/api/usage-poll/interval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalSec: min * 60 }) });
      if (r.ok) {
        delete inp.dataset.dirty;
        if (hint) { hint.style.color = 'var(--jade)'; hint.textContent = `已保存 · 基准每 ${min} 分钟（随机抖动）`; }
        refreshState();
      } else if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = r.error || '保存失败'; }
    } catch { if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = '保存失败'; } }
    finally { btn.disabled = false; }
  });
}

// 设置页 processing 并发上限：从 state 回填（编辑中不覆盖），保存走 /api/config/max-runners
function syncMaxRunnersInput() {
  const inp = $('maxRunnersInput');
  if (!inp || inp === document.activeElement || inp.dataset.dirty === '1') return;
  inp.value = String(stateData?.runnerConfig?.maxConcurrentRunners ?? 5);
}
{
  const inp = $('maxRunnersInput');
  const btn = $('maxRunnersSaveBtn');
  const hint = $('maxRunnersSaveHint');
  if (inp) inp.addEventListener('input', () => { inp.dataset.dirty = '1'; if (hint) hint.textContent = ''; });
  if (btn) btn.addEventListener('click', async () => {
    let max = Math.round(Number(inp.value));
    if (!Number.isFinite(max)) max = 5;
    max = Math.min(Math.max(max, 0), 50);
    inp.value = String(max);
    btn.disabled = true; if (hint) { hint.style.color = 'var(--dim)'; hint.textContent = '保存中…'; }
    try {
      const r = await api('/api/config/max-runners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max }) });
      if (r.ok) {
        delete inp.dataset.dirty;
        if (hint) { hint.style.color = 'var(--jade)'; hint.textContent = max === 0 ? '已保存 · 不限并发' : `已保存 · 最多 ${max} 个同时执行`; }
        refreshState();
      } else if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = r.error || '保存失败'; }
    } catch { if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = '保存失败'; } }
    finally { btn.disabled = false; }
  });
}

// ---- API 密钥页（#/apikeys）：外部任务通道 /api/external/* 的鉴权凭据管理 ----
// 明文只在 create 响应里出现一次：渲染进一次性提示框（复制按钮 + curl 示例），刷新/切页即不可再取。
// 编辑 = 回填表单改配置（POST update，密钥本体不变）；复制 = 按现有配置克隆（明文不可复原，生成的是新钥）。
let akKeysCache = [];      // 最近一次列表（编辑/复制回填用）
let akEditingId = null;    // 非 null = 表单处于「编辑」模式，提交走 update
async function refreshApiKeys() {
  const box = $('akListBox');
  if (!box) return;
  let r;
  try { r = await api('/api/apikeys'); } catch { box.innerHTML = '<div style="color:var(--coral);font-size:12.5px">加载失败（后端未响应）</div>'; return; }
  const keys = r.keys || [];
  akKeysCache = keys;
  if (!keys.length) {
    box.innerHTML = '<div style="color:var(--dim);font-size:12.5px">还没有密钥 · 用上方表单生成第一把</div>';
    return;
  }
  box.innerHTML = `<div class="ak-table-wrap"><table class="ak-table">
    <thead><tr><th>密钥</th><th>来源</th><th>备注</th><th>限制</th><th>最近活跃</th><th>状态</th><th></th></tr></thead>
    <tbody>${keys.map((k) => `
      <tr>
        <td class="mono" title="仅前缀，明文不可再取 · 创建于 ${escapeAttr(k.createdAt || '—')}">${escapeHtml(k.prefix)}…</td>
        <td class="mono">${escapeHtml(k.source)}</td>
        <td style="min-width:110px">${escapeHtml(k.label)}</td>
        <td style="font-size:11.5px;min-width:150px" title="${escapeAttr(akPolicyTitle(k))}">${akPolicyCell(k)}</td>
        <td class="mono">${akLivenessCell(k)}</td>
        <td>${k.disabled ? '<span class="tag tag-amber">已禁用</span>' : '<span class="tag tag-jade">启用</span>'}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn" data-ak-edit="${escapeAttr(k.id)}" title="修改此密钥的备注/来源/策略（密钥本体不变）">编辑</button>
          <button class="btn" data-ak-copy="${escapeAttr(k.id)}" ${k.plaintext ? '' : 'disabled'} title="${k.plaintext ? '复制原密钥明文到剪贴板' : '该密钥创建于明文不留存的旧版本，无法复制原文'}">复制</button>
          <button class="btn" data-ak-toggle="${escapeAttr(k.id)}" data-ak-to="${k.disabled ? '0' : '1'}">${k.disabled ? '启用' : '禁用'}</button>
          <button class="btn btn-danger" data-ak-del="${escapeAttr(k.id)}" data-ak-name="${escapeAttr(`${k.prefix}…（${k.label}）`)}">删除</button>
        </td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

// 新增/编辑共用弹窗（akModal）：标题、确定键文案、提示按模式切换；关闭即退出编辑态
function akFillForm(k) {
  $('akLabelInput').value = k.label;
  $('akSourceInput').value = k.source;
  $('akProviderInput').value = k.provider || 'claude';
  renderAkProviderPolicy(k.provider || 'claude', k.allowedModels || [], k.allowedEfforts || []);
  $('akCwdsInput').value = k.allowedCwds.join('\n');
  $('akAllowQueued').checked = !!k.allowQueued;
}
function akClearForm() {
  $('akLabelInput').value = '';
  $('akSourceInput').value = '';
  $('akCwdsInput').value = '';
  $('akAllowQueued').checked = false;
  $('akProviderInput').value = 'claude';
  renderAkProviderPolicy('claude');
}

function renderAkProviderPolicy(provider, selectedModels = [], selectedEfforts = []) {
  const def = providerDef(provider) || providerDef('claude');
  const models = providerModels(def).filter((m) => m.value !== '__custom__');
  $('akModelsBox').innerHTML = models.map((m) => `<label><input type="checkbox" value="${escapeAttr(m.value)}"${selectedModels.includes(m.value) ? ' checked' : ''}> ${escapeHtml(m.name)}</label>`).join('')
    + (def?.allowCustomModel ? `<label style="margin-top:5px">自定义模型（每行一个）<textarea id="akCustomModels" class="field-input mono" rows="2" placeholder="gpt-5.4">${escapeHtml(selectedModels.filter(Boolean).join('\n'))}</textarea></label>` : '');
  $('akEffortsBox').innerHTML = providerEfforts(def).map((e) => `<label><input type="checkbox" value="${escapeAttr(e.value)}"${selectedEfforts.includes(e.value) ? ' checked' : ''}> ${escapeHtml(e.name)}</label>`).join('');
}
function akOpenModal(k) {
  akEditingId = k ? k.id : null;
  $('akModalTitle').textContent = k ? '编辑密钥' : '生成密钥';
  $('akCreateBtn').textContent = k ? '保存修改' : '生成密钥';
  $('akModalHint').textContent = k
    ? `正在编辑 ${k.prefix}…（密钥本体与使用记录不变，只改配置）· 策略三项必选（全不选 = 没有权限）`
    : '策略三项必选（全不选 = 没有权限）· 请求省略对应字段时取第一个勾选项 / 第一行为该密钥默认';
  $('akCreateErr').style.display = 'none';
  if (k) akFillForm(k); else akClearForm();
  $('akModal').style.display = 'flex';
  setTimeout(() => { $('akLabelInput').focus(); }, 40);
}
function akCloseModal() {
  $('akModal').style.display = 'none';
  akEditingId = null;
}

// 策略列：紧凑摘要（详情进 title tooltip）；缺任一项 = 旧格式无策略钥，建任务会被拒（策略必选=无权限）
function akPolicyCell(k) {
  if (!k.allowedModels?.length || !k.allowedEfforts?.length || !k.allowedCwds?.length) {
    return '<span class="tag tag-amber" title="旧格式密钥缺策略，建任务会被拒；请删除后重新生成">未配置（无权限）</span>';
  }
  const parts = [];
  parts.push(escapeHtml(providerDef(k.provider || 'claude')?.label || k.provider || 'Claude Code'));
  const modelNames = k.allowedModels.map((model) => model || 'CLI 默认');
  parts.push(`模型 ${modelNames.length === 1 ? escapeHtml(modelNames[0].replace(/^claude-/, '')) : modelNames.length + ' 个'}`);
  parts.push(`effort ${k.allowedEfforts.length === 1 ? escapeHtml(k.allowedEfforts[0]) : k.allowedEfforts.length + ' 档'}`);
  parts.push(`目录 ${k.allowedCwds.length} 个`);
  if (k.allowQueued) parts.push('<span style="color:var(--amber)">直执</span>');
  return parts.join(' · ');
}
function akPolicyTitle(k) {
  const lines = [];
  lines.push(`Provider：${providerDef(k.provider || 'claude')?.label || k.provider || 'Claude Code'}`);
  lines.push(`可用模型：${k.allowedModels?.length ? k.allowedModels.map((m) => m || 'CLI 默认').join(', ') : '（缺）'}`);
  lines.push(`可用 effort：${k.allowedEfforts?.length ? k.allowedEfforts.join(', ') : '（缺）'}`);
  lines.push(`可访问目录：${k.allowedCwds?.length ? k.allowedCwds.join('；') : '（缺）'}`);
  lines.push(`直接执行：${k.allowQueued ? '允许（plan:false 直进 queued）' : '不允许（只能建 plan 任务）'}`);
  return lines.join('\n');
}
// 活跃列：lastUsedAt（含 heartbeat 刷新）5 分钟内 → 绿点在线；否则灰点 + 时间
function akLivenessCell(k) {
  if (!k.lastUsedAt) return '<span style="color:var(--dim)">—</span>';
  const t = new Date(String(k.lastUsedAt).replace(' ', 'T'));
  const fresh = !isNaN(t) && Date.now() - t.getTime() < 5 * 60 * 1000;
  const dot = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px;background:${fresh ? 'var(--jade, #2e9e6b)' : 'var(--dim)'}"></span>`;
  return `${dot}${escapeHtml(k.lastUsedAt)}`;
}

function renderApiKeyPlaintext(created) {
  const box = $('akPlainBox');
  if (!box) return;
  const curl = [
    `curl -s -X POST http://127.0.0.1:${location.port || 8799}/api/external/task/create \\`,
    `  -H 'Authorization: Bearer ${created.plaintext}' -H 'Content-Type: application/json' \\`,
    `  -d '{"title":"标题","prompt":"给 Agent 的指令","externalKey":"来源侧唯一事件id"}'`,
  ].join('\n');
  box.style.display = '';
  box.innerHTML = `
    <div class="ak-plain">
      <span style="font-size:11.5px;color:var(--amber);white-space:nowrap;font-weight:600">新密钥</span>
      <code id="akPlainText">${escapeHtml(created.plaintext)}</code>
      <button class="btn" id="akCopyBtn" style="margin-left:auto;white-space:nowrap">复制</button>
    </div>
    <div style="margin-top:8px;font-size:11px;color:var(--mut)">来源 <code>${escapeHtml(created.key.source)}</code> · 发起端调用示例（externalKey 为幂等键，同键不重复建任务）：</div>
    <pre style="margin-top:6px;padding:10px 12px;background:var(--card);border:1px solid var(--hair);border-radius:var(--r-md);overflow-x:auto;font-family:var(--mono);font-size:11px;line-height:1.6">${escapeHtml(curl)}</pre>`;
  $('akCopyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(created.plaintext); $('akCopyBtn').textContent = '已复制'; } catch { /* 剪贴板不可用则手动选中复制 */ }
  });
}

function initApiKeysPage() {
  const createBtn = $('akCreateBtn');
  if (!createBtn) return;
  createBtn.addEventListener('click', async () => {
    const err = $('akCreateErr');
    err.style.display = 'none';
    const label = $('akLabelInput').value.trim();
    const source = $('akSourceInput').value.trim();
    const provider = $('akProviderInput').value || 'claude';
    const allowedModels = [...document.querySelectorAll('#akModelsBox input:checked')].map((x) => x.value);
    for (const model of ($('akCustomModels')?.value || '').split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean)) {
      if (!allowedModels.includes(model)) allowedModels.push(model);
    }
    const allowedEfforts = [...document.querySelectorAll('#akEffortsBox input:checked')].map((x) => x.value);
    const allowedCwds = $('akCwdsInput').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const allowQueued = $('akAllowQueued').checked;
    // 策略三项必选（全不选 = 没有权限）：前端先拦一道，后端仍强制校验
    if (!allowedModels.length || !allowedEfforts.length || !allowedCwds.length) {
      // .form-err 类默认 display:none，必须显式 block（置 '' 只是清掉内联样式、等于仍隐藏）
      err.textContent = '策略必选：可用模型、可用 effort、可访问目录都至少选/填一项（全不选 = 没有权限）';
      err.style.display = 'block';
      return;
    }
    createBtn.disabled = true;
    try {
      const isEdit = !!akEditingId;
      const r = await api(isEdit ? '/api/apikeys/update' : '/api/apikeys/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: akEditingId || undefined, label, source, provider, allowedModels, allowedEfforts, allowedCwds, allowQueued }),
      });
      if (!r.ok) { err.textContent = r.error || (isEdit ? '保存失败' : '生成失败'); err.style.display = 'block'; return; }
      akCloseModal();
      if (!isEdit) renderApiKeyPlaintext(r);   // 编辑不产新明文
      await refreshApiKeys();
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
    finally { createBtn.disabled = false; }
  });
  $('akNewBtn').addEventListener('click', () => akOpenModal(null));
  $('akProviderInput').addEventListener('change', () => renderAkProviderPolicy($('akProviderInput').value));
  $('akModalCancelBtn').addEventListener('click', akCloseModal);
  $('akModalX').addEventListener('click', akCloseModal);
  $('akModal').addEventListener('click', (e) => { if (e.target === $('akModal')) akCloseModal(); });
  // 列表操作走事件委托：refreshApiKeys 整块重渲染，行内按钮不逐个绑
  $('akListBox').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-ak-edit]');
    const copyBtn = e.target.closest('[data-ak-copy]');
    const toggleBtn = e.target.closest('[data-ak-toggle]');
    const delBtn = e.target.closest('[data-ak-del]');
    if (editBtn) {
      const k = akKeysCache.find((x) => x.id === editBtn.dataset.akEdit);
      if (k) akOpenModal(k);
      return;
    }
    if (copyBtn) {
      // 复制 = 原密钥明文进剪贴板（列表数据已带明文）
      const k = akKeysCache.find((x) => x.id === copyBtn.dataset.akCopy);
      if (!k?.plaintext) return;
      try {
        await navigator.clipboard.writeText(k.plaintext);
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
      } catch {
        // 剪贴板不可用（如无焦点）：弹窗展示原文手动复制
        customAlert({ title: '密钥原文（手动复制）', message: `<code style="word-break:break-all">${escapeHtml(k.plaintext)}</code>` });
      }
      return;
    }
    if (toggleBtn) {
      const r = await api('/api/apikeys/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: toggleBtn.dataset.akToggle, disabled: toggleBtn.dataset.akTo === '1' }),
      });
      if (!r.ok) customAlert({ title: '操作失败', message: escapeHtml(r.error) });
      await refreshApiKeys();
      return;
    }
    if (delBtn) {
      const ok = await customConfirm({
        title: '删除密钥',
        message: `删除 <code>${escapeHtml(delBtn.dataset.akName)}</code>。<br><b>不可恢复</b>，在用它的发起端会立即开始收 401。<br>已建的任务不受影响。`,
        confirmText: '删除',
        tone: 'danger',
      });
      if (!ok) return;
      const r = await api('/api/apikeys/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: delBtn.dataset.akDel }),
      });
      if (!r.ok) customAlert({ title: '删除失败', message: escapeHtml(r.error) });
      await refreshApiKeys();
    }
  });
}
initApiKeysPage();

// ---- 设置页「云端」区块 ----
// 三个输入缺一不可：注册密钥答「这台机器有资格加入这个云端吗」（实例级、一把管全体），配对码答
// 「这台机器是谁的」（绑机器主人）——少了配对码云端就定不了 machine 归属。注册密钥用完即弃，
// 本地不存，所以「已连接」面板里没有它这一行可展示。
// join token 只是「一次贴三样」的输入法糖：**就地在浏览器拆包**填进输入框（让用户看见将要连的 URL
// 再点连接），不发给任何服务端；解析失败一律静默不填，手打三个字段的路径永远可用。
function parseJoinToken(s) {
  const t = String(s || '').trim();
  if (!t.startsWith('swjt_')) return null;
  try {
    const o = JSON.parse(decodeURIComponent(escape(atob(
      t.slice(5).replace(/-/g, '+').replace(/_/g, '/')))));   // base64url → base64 → utf8
    if (o?.v !== 1 || !o.url || !o.rk || !o.code) return null;
    return { cloudUrl: String(o.url), registrationKey: String(o.rk), code: String(o.code) };
  } catch { return null; }
}

let cloudStatus = null;
const cloudOnSettings = () => (location.hash || '').indexOf('#/settings') === 0;
// ISO-8601 → 本机时间文案（云端与 connector 都用 ISO 传时间，展示时才本地化）
function cloudTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let cloudRemoteCfg = null;   // /api/cloud/remote-config 的 {cloudRemoteControl, cloudAllowedCwds}（远程控制闸门 + 云端派活共用白名单）
let cloudDispatchCfg = null; // /api/cloud/dispatch-config 的 {acceptAutoRun}（云端派活自动执行闸门档位）

async function refreshCloudStatus() {
  try {
    cloudStatus = await api('/api/cloud/status');
    cloudRemoteCfg = await api('/api/cloud/remote-config');
    cloudDispatchCfg = await api('/api/cloud/dispatch-config');
  } catch { return; }
  renderCloud();
}

function renderCloud() {
  const box = $('cloudBox');
  if (!box || !cloudStatus) return;
  const s = cloudStatus;
  // 白名单编辑中不重建（重渲染会抹掉正在编辑的值）——对齐 modelLimits 等输入的「编辑中不回填」约定
  const editingTa = $('cloudCwdsInput');
  if (editingTa && (editingTa === document.activeElement || editingTa.dataset.dirty === '1')) return;
  const err = s.lastError
    ? `<div style="margin-top:8px;font-size:11.5px;color:var(--coral);word-break:break-all">${escapeHtml(s.lastError)}</div>`
    : '';

  if (s.enrolled) {
    const hbTag = s.lastHeartbeatOk === true ? '<span class="tag tag-jade">已连接</span>'
      : s.lastHeartbeatOk === false ? '<span class="tag tag-amber">心跳异常</span>'
        : '<span class="tag tag-mut">等待首次心跳</span>';
    // 远程控制（手机中继）子区块：开关 + cwd 白名单 + 中继连接状态（connectorStatus().remoteControl）
    const rc = s.remoteControl || {};
    const cfg = (cloudRemoteCfg && cloudRemoteCfg.ok) ? cloudRemoteCfg : { cloudRemoteControl: !!rc.enabled, cloudAllowedCwds: [] };
    const relayTag = !cfg.cloudRemoteControl ? '<span class="tag tag-mut">中继关闭</span>'
      : rc.connected ? '<span class="tag tag-jade">中继已连接</span>'
        : '<span class="tag tag-amber">中继未连接</span>';
    const rcErr = cfg.cloudRemoteControl && rc.lastError
      ? `<div style="margin-top:6px;font-size:11px;color:var(--coral);word-break:break-all">${escapeHtml(rc.lastError)}</div>` : '';
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        ${hbTag}
        <button class="btn" id="cloudUnenrollBtn" style="margin-left:auto" title="停止上报并清除本机的云端绑定（保留机器身份，重连仍是同一台机器）">断开</button>
      </div>
      <div style="font-family:var(--mono);font-size:10.5px;color:var(--dim);line-height:1.9;word-break:break-all">
        <div>workspace <b style="color:var(--ink2)">${escapeHtml(s.workspaceName || '—')}</b></div>
        <div>cloudUrl ${escapeHtml(s.cloudUrl || '—')}</div>
        <div>machineId ${escapeHtml(s.machineId || '—')}</div>
        <div>machineUid ${escapeHtml(s.machineUid || '—')}</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;font-size:11px;color:var(--mut);font-family:var(--mono)">
        <span>最近心跳 <b style="color:var(--ink2)">${cloudTime(s.lastHeartbeatAt)}</b></span>
        <span>最近对账 <b style="color:var(--ink2)">${cloudTime(s.lastReconcileAt)}</b></span>
        <span>最近取件 <b style="color:var(--ink2)">${cloudTime(s.lastIntentAt)}</b></span>
        <span>上轮推送 <b style="color:var(--ink2)">${s.lastPushed}</b></span>
        <span>已同步 <b style="color:var(--ink2)">${s.syncedCount}</b> 张卡</span>
      </div>
      <div style="border-top:1px solid var(--hair);margin-top:12px;padding-top:10px">
        <div class="field">
          <span class="f-label">云端派活自动执行（同事 / 自己在云端建的任务下发到本机时，要不要不问就直接跑）</span>
          <select id="cloudAutoRunSelect" class="field-input">
            <option value="off">off · 一切云端任务都落「计划」，要本地点确认才跑（最保守）</option>
            <option value="owner-only">owner-only · 我自己派的直接跑，同事派的要本地确认（默认）</option>
            <option value="on">on · 任何人派的都直接跑</option>
          </select>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
          <span id="cloudAutoRunHint" style="font-size:11.5px;color:var(--dim)"></span>
        </div>
        <div style="margin-top:8px;font-size:11px;color:var(--dim);line-height:1.7">
          真正的遏制是下方 cwd 白名单，不是这个档位 —— 白名单为空时三档行为一样（云端任务一律拒收）。
        </div>
      </div>
      <div style="border-top:1px solid var(--hair);margin-top:12px;padding-top:10px">
        <div class="field">
          <span class="f-label">云端可派活的 cwd 白名单（云端下发意图 / 手机远程新建 共用 · 每行一个绝对路径 · 前缀匹配 · 空 = 一律拒绝）</span>
          <textarea id="cloudCwdsInput" class="field-input mono" rows="3" spellcheck="false" placeholder="D:\\project\\foo"></textarea>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:10px;margin-bottom:8px">
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer">
            <input type="checkbox" id="cloudRemoteToggle"${cfg.cloudRemoteControl ? ' checked' : ''}>
            远程控制（手机控制台经云端中继访问本机）
          </label>
          ${relayTag}
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
          <button class="btn" id="cloudCwdsSaveBtn">保存白名单</button>
          <span id="cloudRemoteHint" style="font-size:11.5px;color:var(--dim)"></span>
        </div>
        ${rcErr}
      </div>
      ${err}`;
    // 自动执行档位：即时保存（change 即写），避免 15s 轮询重渲染把未保存的选择抹掉（对齐远程控制开关的即时保存）
    const autoSel = $('cloudAutoRunSelect');
    if (autoSel) {
      autoSel.value = (cloudDispatchCfg && cloudDispatchCfg.ok && cloudDispatchCfg.acceptAutoRun) || 'owner-only';
      autoSel.addEventListener('change', async () => {
        const h = $('cloudAutoRunHint');
        let r = null;
        try {
          r = await api('/api/cloud/dispatch-config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ acceptAutoRun: autoSel.value }),
          });
        } catch { r = { ok: false, error: '保存失败' }; }
        if (r?.ok) { cloudDispatchCfg = r; if (h) { h.style.color = 'var(--jade)'; h.textContent = '已保存 · 下一次下发即生效'; } }
        else if (h) { h.style.color = 'var(--coral)'; h.textContent = r?.error || '保存失败'; }
      });
    }
    // 白名单回填走 .value（不走模板字符串，避免路径里的反斜杠/引号被 HTML 转义搅坏）
    const ta = $('cloudCwdsInput');
    if (ta) ta.value = (Array.isArray(cfg.cloudAllowedCwds) ? cfg.cloudAllowedCwds : []).join('\n');
    ta?.addEventListener('input', () => { ta.dataset.dirty = '1'; const h = $('cloudRemoteHint'); if (h) h.textContent = ''; });
    const saveRemote = async (on) => {
      const cloudAllowedCwds = (ta?.value || '').split('\n').map((l) => l.trim()).filter(Boolean);
      let r = null;
      try {
        r = await api('/api/cloud/remote-config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cloudRemoteControl: on, cloudAllowedCwds }),
        });
      } catch { r = { ok: false, error: '保存失败' }; }
      if (r?.ok) {
        if (ta) delete ta.dataset.dirty;
        cloudRemoteCfg = r;
        renderCloud();   // 用刚保存的配置重绘（开关/中继标签即时对齐；connector 15s 内完成实际起停）
        const h = $('cloudRemoteHint');
        if (h) { h.style.color = 'var(--jade)'; h.textContent = on ? '已保存 · 15s 内建立中继连接' : '已保存 · 远程控制关闭，15s 内断开中继'; }
      } else {
        const h = $('cloudRemoteHint');
        if (h) { h.style.color = 'var(--coral)'; h.textContent = r?.error || '保存失败'; }
      }
    };
    $('cloudRemoteToggle')?.addEventListener('change', (e) => saveRemote(!!e.target.checked));
    $('cloudCwdsSaveBtn')?.addEventListener('click', () => saveRemote(!!$('cloudRemoteToggle')?.checked));
    $('cloudUnenrollBtn')?.addEventListener('click', async () => {
      const yes = await customConfirm({
        title: '断开云端连接',
        message: '本机将停止上报，云端稍后把这台机器标为<b>离线</b>。<br>已上报的任务历史不会删除；重新连接需要再贴一次注册密钥与配对码。',
        confirmText: '断开', tone: 'danger',
      });
      if (!yes) return;
      try { await api('/api/cloud/unenroll', { method: 'POST' }); } catch { /* 断开失败下面刷新会照出来 */ }
      refreshCloudStatus();
    });
    return;
  }

  box.innerHTML = `
    <div class="field" style="margin-bottom:10px">
      <span class="f-label">粘贴 join token（可选 · 自动填下面三项；纯本地拆包，不发给任何服务端）</span>
      <input type="text" id="cloudJoinToken" class="field-input mono" autocomplete="off" spellcheck="false" placeholder="swjt_…">
    </div>
    <label class="field" style="margin-bottom:10px">
      <span class="f-label">云端 URL</span>
      <input type="text" id="cloudUrlInput" class="field-input mono" autocomplete="off" spellcheck="false" placeholder="https://cloud.example.com:8790">
    </label>
    <div class="field" style="margin-bottom:10px">
      <span class="f-label">注册密钥（管理员给 · 只在连接这一次用，本地不保存）</span>
      <span style="display:flex;gap:8px">
        <input type="password" id="cloudRkInput" class="field-input mono" style="flex:1" autocomplete="off" spellcheck="false" placeholder="swrk_…">
        <button type="button" class="btn" id="cloudRkToggle" style="flex:none">显示</button>
      </span>
    </div>
    <label class="field" style="margin-bottom:10px">
      <span class="f-label">配对码（云端「添加机器」现生成 · 10 分钟内有效、只能用一次）</span>
      <input type="text" id="cloudCodeInput" class="field-input mono" maxlength="8" autocomplete="off" spellcheck="false" placeholder="7K3M9QXB">
    </label>
    <div style="display:flex;align-items:center;gap:10px">
      <button class="btn btn-primary" id="cloudEnrollBtn">连接</button>
      <span id="cloudEnrollHint" style="font-size:11.5px;color:var(--dim)"></span>
    </div>
    ${err}`;

  const jt = $('cloudJoinToken'), urlI = $('cloudUrlInput'), rkI = $('cloudRkInput'), codeI = $('cloudCodeInput');
  const btn = $('cloudEnrollBtn'), hint = $('cloudEnrollHint'), toggle = $('cloudRkToggle');

  jt?.addEventListener('input', () => {
    const p = parseJoinToken(jt.value);
    if (!p) return;                       // 解析失败静默不填
    urlI.value = p.cloudUrl;
    rkI.value = p.registrationKey;
    codeI.value = p.code;
    if (hint) { hint.style.color = 'var(--dim)'; hint.textContent = '已从 join token 填好三项，确认 URL 后点连接'; }
  });
  toggle?.addEventListener('click', () => {
    const show = rkI.type === 'password';
    rkI.type = show ? 'text' : 'password';
    toggle.textContent = show ? '隐藏' : '显示';
  });
  btn?.addEventListener('click', async () => {
    const cloudUrl = urlI.value.trim(), registrationKey = rkI.value.trim(), code = codeI.value.trim();
    if (!cloudUrl || !registrationKey || !code) {
      if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = '云端 URL / 注册密钥 / 配对码 三者均必填'; }
      return;
    }
    btn.disabled = true;
    if (hint) { hint.style.color = 'var(--dim)'; hint.textContent = '连接中…'; }
    let r = null;
    try {
      r = await api('/api/cloud/enroll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudUrl, registrationKey, code }),
      });
    } catch { r = { ok: false, error: '连接失败' }; }
    finally { btn.disabled = false; }
    if (r?.ok) {
      // 成功即清空四个框：注册密钥与配对码用完即弃，别留在 DOM 里
      jt.value = ''; urlI.value = ''; rkI.value = ''; codeI.value = '';
      refreshCloudStatus();
      return;
    }
    // 失败只清密钥与配对码（都是一次性的，重试要重贴），URL 留着省得重打
    rkI.value = ''; codeI.value = ''; jt.value = '';
    if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = r?.error || '连接失败'; }
  });
}

// ---- 新建任务 Modal（同一弹窗兼作 plan 任务「编辑」：editingTaskKey 非空即编辑模式）----
const NEWTASK_HEAD = '新建任务';
const NEWTASK_HINT = 'source=manual · taskKey 自动生成（manual:mYYYYMMDDHHMMSS-NNN）· 默认存为 plan，在看板确认或到点定时后才执行';
let editingTaskKey = null;   // null=新建；非空=正在编辑该 plan 任务，提交走 /api/task/edit
$('newTaskBtn').addEventListener('click', () => {
  editingTaskKey = null;
  $('newTaskModal').querySelector('.modal-head h2').textContent = NEWTASK_HEAD;
  $('newTaskModal').querySelector('.modal-hint').textContent = NEWTASK_HINT;
  $('newTaskSubmit').textContent = '提交';
  $('newTaskModal').style.display = 'flex';
  $('newTaskTitle').value = '';
  $('newTaskPrompt').value = '';
  $('newTaskDesc').value = '';
  $('newTaskCwd').value = '';              // 工作目录（可选）
  loadNewTaskCwds();                       // 填充「已有工作目录」下拉（现有任务 cwd + 近期 CLI session cwd）
  newTaskProviderCtl?.setProvider(newTaskProviderCtl?.preferredProvider() || 'claude');
  syncNewTaskProviderCapabilities();
  resetNewTaskExtras();                    // req4/5/6：定时 / worktree / 动态工作流 归默认
  refreshWorktreeUi('');                   // 无 cwd → 隐藏 worktree 区
  $('newTaskErr').style.display = 'none';
  $('newTaskWarn').style.display = 'none';
  setTimeout(() => $('newTaskTitle').focus(), 100);
});

// req4/5/6 表单附加字段归默认（新建打开时调）
function resetNewTaskExtras() {
  $('newTaskScheduledAt').value = '';
  window.__syncDtPicker?.();                    // 同步日历选择器显示为「留空」
  $('newTaskWorktree').checked = true;         // req5：支持 worktree 时默认开启
  $('newTaskDynamicWorkflow').checked = false; // req6：默认关闭
  setDirWorktreeLocked(false);                 // 新建：工作目录 / worktree 可编辑
  newTaskAttachCtl.clear();                    // 附加本地文件归空
}

// 退回来的、有会话记录的 plan 任务：锁定 工作目录 / worktree / 基分支（改了会让确认执行的 --resume 找不到原会话）。
// 前端禁用输入 + 显示锁定说明（后端 editTask 也会保原值兜底）。
function setDirWorktreeLocked(locked) {
  for (const id of ['newTaskCwd', 'newTaskCwdCaret', 'newTaskCwdBrowse', 'newTaskWorktree', 'newTaskBaseBranch', 'newTaskBranchCaret']) {
    const el = $(id); if (el) el.disabled = !!locked;
  }
  newTaskProviderCtl?.setLocked(locked);
  const hint = $('newTaskDirLockHint');
  if (hint) hint.style.display = locked ? 'block' : 'none';
}

// plan 任务「编辑」：复用新建弹窗，先拉 /api/task/detail 回填，提交走 /api/task/edit（仅 plan 可编辑）
async function openEditTask(taskKey) {
  let r;
  try { r = await api(`/api/task/detail?taskKey=${encodeURIComponent(taskKey)}`); }
  catch (e) { return customAlert({ title: '打不开编辑', message: escapeHtml(e.message) }); }
  if (!r || !r.ok) return customAlert({ title: '打不开编辑', message: escapeHtml(r?.error || '读取任务失败') });
  acknowledgeTask(taskKey);             // 看过即清「状态变更」更新点
  editingTaskKey = taskKey;
  $('newTaskModal').querySelector('.modal-head h2').textContent = '编辑任务';
  $('newTaskModal').querySelector('.modal-hint').textContent = `source=${r.source} · ${taskKey} · plan 态可编辑；prompt 是确认排队后真正发给 Agent 的指令`;
  $('newTaskSubmit').textContent = '保存';
  $('newTaskModal').style.display = 'flex';
  $('newTaskTitle').value = r.title || '';
  $('newTaskPrompt').value = r.prompt || '';
  $('newTaskDesc').value = r.description || '';
  $('newTaskCwd').value = r.cwd || '';
  loadNewTaskCwds();
  newTaskMesCtl?.setProvider(r.provider || 'claude', r.model, r.effort);
  syncNewTaskProviderCapabilities();
  $('newTaskScheduledAt').value = toDatetimeLocal(r.scheduledAt || '');   // req4
  window.__syncDtPicker?.();                                              // 同步日历选择器显示
  $('newTaskDynamicWorkflow').checked = r.dynamicWorkflow === true;       // req6
  newTaskAttachCtl.set(r.attachments || []);                             // 回填附加本地文件
  // req5：git 探测后回填 worktree 勾选 + 签出分支（默认开启沿用旧值；旧 plan 无该字段则默认开）
  refreshWorktreeUi(r.cwd || '', { worktree: r.worktree !== false, baseBranch: r.baseBranch || '' });
  // 退回来的、有会话记录的任务：锁定 工作目录 / worktree（续对话须保持原运行目录）
  setDirWorktreeLocked(!!r.resumeLocked);
  $('newTaskErr').style.display = 'none';
  $('newTaskWarn').style.display = 'none';
  setTimeout(() => $('newTaskPrompt').focus(), 100);
}
window.openEditTask = openEditTask;

// req3/req1：工作目录 自定义下拉（不用原生 datalist）+ 浏览按钮
let newTaskCwdOptions = [];
async function loadNewTaskCwds() {
  try { newTaskCwdOptions = (await api('/api/task/cwds'))?.cwds || []; }
  catch { newTaskCwdOptions = []; }
  renderCwdMenu();
}
function renderCwdMenu() {
  const menu = $('newTaskCwdMenu');
  if (!menu) return;
  const q = ($('newTaskCwd').value || '').trim().toLowerCase();
  const list = newTaskCwdOptions.filter((c) => !q || c.cwd.toLowerCase().includes(q));
  menu.innerHTML = list.length
    ? list.map((c) => `<div class="cwd-item" role="option" data-cwd="${escapeAttr(c.cwd)}"><span class="cwd-path" title="${escapeAttr(c.cwd)}">${escapeHtml(c.cwd)}</span><span class="cwd-src">${c.source === 'task' ? '任务' : 'CLI'}</span></div>`).join('')
    : `<div class="cwd-empty">${newTaskCwdOptions.length ? '无匹配目录' : '暂无已用过的目录 · 直接填路径或点「浏览」'}</div>`;
}
function closeCwdMenu() { $('newTaskCwdMenu')?.classList.remove('open'); }
function openCwdMenu() { renderCwdMenu(); $('newTaskCwdMenu')?.classList.add('open'); }
(function initCwdCombo() {
  const input = $('newTaskCwd'), menu = $('newTaskCwdMenu'), caret = $('newTaskCwdCaret'), combo = $('newTaskCwdCombo');
  if (!input || !menu || !caret || !combo) return;
  caret.addEventListener('click', () => (menu.classList.contains('open') ? closeCwdMenu() : openCwdMenu()));
  input.addEventListener('focus', openCwdMenu);
  input.addEventListener('input', () => { renderCwdMenu(); menu.classList.add('open'); });
  input.addEventListener('change', () => refreshWorktreeUi(input.value));   // req5：手填/回车后探测 git
  menu.addEventListener('mousedown', (e) => {   // mousedown 先于 input blur，避免选中前菜单被关
    const item = e.target.closest('.cwd-item');
    if (!item) return;
    e.preventDefault();
    input.value = item.dataset.cwd;
    closeCwdMenu();
    refreshWorktreeUi(input.value);   // req5：选目录即探测 git
  });
  document.addEventListener('click', (e) => { if (!combo.contains(e.target)) closeCwdMenu(); });
})();

// req5：签出基分支行与 worktree 勾选相互独立、不再联动显隐（不勾选 worktree 也能单独设签出基分支）

// req5：探测工作目录是否 git 项目 → 切 worktree 区显隐 + 填签出分支下拉。opts 用于编辑回填(worktree/baseBranch)。
let newTaskBranchOptions = [];   // [{branch, isCurrent}] —— 可筛选下拉数据源
async function refreshWorktreeUi(cwd, opts) {
  const row = $('newTaskWorktreeRow');
  const c = String(cwd || '').trim();
  if (!c) { row.style.display = 'none'; return; }
  let r = null;
  try {
    r = await api('/api/git/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: c }) });
  } catch { r = null; }
  if (($('newTaskCwd').value || '').trim() !== c) return;   // 期间又改了目录 → 丢弃这次结果（防竞态）
  if (!r || !r.ok || !r.isGit) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  const branches = r.branches || [];
  const cur = r.currentBranch || '';
  newTaskBranchOptions = branches.map((b) => ({ branch: b, isCurrent: b === cur }));
  const want = (opts && opts.baseBranch) || cur || branches[0] || '';
  $('newTaskBaseBranch').value = want;
  renderBranchMenu();
  if (opts && typeof opts.worktree === 'boolean') $('newTaskWorktree').checked = opts.worktree;
}

// req1：签出基分支 可筛选下拉（复用 cwd-combo 样式；输入即筛，选中写回 input.value）
// filter=true 按 input.value 过滤（用户在输入）；否则全列（打开下拉时——避免被已选中的默认分支值过滤成只剩自己）
function renderBranchMenu(filter) {
  const menu = $('newTaskBaseBranchMenu');
  if (!menu) return;
  const q = filter ? ($('newTaskBaseBranch').value || '').trim().toLowerCase() : '';
  const list = newTaskBranchOptions.filter((o) => !q || o.branch.toLowerCase().includes(q));
  menu.innerHTML = list.length
    ? list.map((o) => `<div class="cwd-item" role="option" data-branch="${escapeAttr(o.branch)}"><span class="cwd-path" title="${escapeAttr(o.branch)}">${escapeHtml(o.branch)}</span>${o.isCurrent ? '<span class="cwd-src">当前</span>' : ''}</div>`).join('')
    : `<div class="cwd-empty">${newTaskBranchOptions.length ? '无匹配分支 · 按输入值作基分支' : '无本地分支 · 基于 HEAD 新建'}</div>`;
}
function closeBranchMenu() { $('newTaskBaseBranchMenu')?.classList.remove('open'); }
function openBranchMenu() { renderBranchMenu(false); $('newTaskBaseBranchMenu')?.classList.add('open'); }
(function initBranchCombo() {
  const input = $('newTaskBaseBranch'), menu = $('newTaskBaseBranchMenu'), caret = $('newTaskBranchCaret'), combo = $('newTaskBranchCombo');
  if (!input || !menu || !caret || !combo) return;
  caret.addEventListener('click', (e) => { e.preventDefault(); menu.classList.contains('open') ? closeBranchMenu() : openBranchMenu(); });
  input.addEventListener('focus', openBranchMenu);
  input.addEventListener('input', () => { renderBranchMenu(true); menu.classList.add('open'); });
  menu.addEventListener('mousedown', (e) => {   // mousedown 先于 blur，避免选中前菜单被关
    const item = e.target.closest('.cwd-item');
    if (!item) return;
    e.preventDefault();
    input.value = item.dataset.branch;
    closeBranchMenu();
  });
  document.addEventListener('click', (e) => { if (!combo.contains(e.target)) closeBranchMenu(); });
})();

// scheduledAt 本地串 'yyyy-MM-dd HH:mm:ss' ↔ datetime-local 'yyyy-MM-ddTHH:mm' 互转
function toDatetimeLocal(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : '';
}
function toLocalStamp(dtLocal) {
  const m = String(dtLocal || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:00` : '';
}

// req2：定时执行 自定义日历时间选择器（向上弹出，替代原生 datetime-local）。
// 隐藏 input#newTaskScheduledAt 作 value 载体（yyyy-MM-ddTHH:mm），submit/edit 复用 toLocalStamp/toDatetimeLocal。
(function initDtPicker() {
  const wrap = $('newTaskDtWrap'), btn = $('newTaskDtBtn'), pop = $('newTaskDtPop'),
    label = $('newTaskDtLabel'), clearBtn = $('newTaskDtClear'), hidden = $('newTaskScheduledAt');
  if (!wrap || !btn || !pop || !hidden) return;
  const p = (n) => String(n).padStart(2, '0');
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  let viewY, viewM, sel = null, h = 9, mi = 0, scrollHost = null;

  function syncFromHidden() {
    const m = String(hidden.value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    const now = new Date();
    if (m) { sel = { y: +m[1], m: +m[2] - 1, d: +m[3] }; h = +m[4]; mi = +m[5]; }
    else { sel = null; h = 9; mi = 0; }
    viewY = sel ? sel.y : now.getFullYear();
    viewM = sel ? sel.m : now.getMonth();
    renderLabel();
    if (pop.classList.contains('open')) renderPop();
  }
  function renderLabel() {
    if (sel) { label.textContent = `${sel.y}-${p(sel.m + 1)}-${p(sel.d)} ${p(h)}:${p(mi)}`; label.classList.remove('dim'); clearBtn.style.display = ''; }
    else { label.textContent = '留空 = 不定时'; label.classList.add('dim'); clearBtn.style.display = 'none'; }
  }
  function commit() {
    hidden.value = sel ? `${sel.y}-${p(sel.m + 1)}-${p(sel.d)}T${p(h)}:${p(mi)}` : '';
    renderLabel();
  }
  function renderPop() {
    const startWd = new Date(viewY, viewM, 1).getDay();
    const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    const daysPrev = new Date(viewY, viewM, 0).getDate();
    const today = new Date();
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const n = i - startWd + 1;
      let y = viewY, mo = viewM, d = n, other = false;
      if (n < 1) { mo = viewM - 1; d = daysPrev + n; other = true; if (mo < 0) { mo = 11; y = viewY - 1; } }
      else if (n > daysInMonth) { mo = viewM + 1; d = n - daysInMonth; other = true; if (mo > 11) { mo = 0; y = viewY + 1; } }
      const isSel = sel && sel.y === y && sel.m === mo && sel.d === d;
      const isToday = today.getFullYear() === y && today.getMonth() === mo && today.getDate() === d;
      cells += `<button type="button" class="dt-day${other ? ' other' : ''}${isToday ? ' today' : ''}${isSel ? ' sel' : ''}" data-y="${y}" data-m="${mo}" data-d="${d}">${d}</button>`;
    }
    pop.innerHTML = `
      <div class="dt-cal-head">
        <button type="button" class="dt-nav" data-nav="-1">‹</button>
        <span class="dt-cal-title">${viewY}年${viewM + 1}月</span>
        <button type="button" class="dt-nav" data-nav="1">›</button>
      </div>
      <div class="dt-grid dt-wd">${WD.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="dt-grid dt-days">${cells}</div>
      <div class="dt-time">
        <span class="dt-time-label">时间</span>
        <input type="number" class="dt-h" min="0" max="23" value="${p(h)}"> :
        <input type="number" class="dt-m" min="0" max="59" value="${p(mi)}">
      </div>
      <div class="dt-foot">
        <button type="button" class="dt-preset" data-preset="clear">清除</button>
        <button type="button" class="dt-preset" data-preset="now1h">1 小时后</button>
        <button type="button" class="btn btn-primary dt-done">确定</button>
      </div>`;
  }
  function openPop() {
    renderPop();
    // fixed 定位挂 viewport（dt-pop 在可滚动 modal 内，absolute 会被裁剪）。先显示再量高，按上下可用空间择向弹出并夹在视口内——
    // 矮屏 / 定时字段贴视口下缘时上弹会算出负偏移把日历顶到屏外（曾导致「选日期无效」，无法点到日格/确定）。
    pop.style.position = 'fixed';
    pop.style.width = '268px';
    pop.style.left = '0px'; pop.style.top = '0px'; pop.style.bottom = 'auto';
    pop.classList.add('open'); btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const ph = pop.offsetHeight, gap = 6, pad = 8;
    // 上方空间够就上弹（保持原视觉），否则下弹；再统一夹进视口，保证整个弹层可见可点
    let top = (r.top >= ph + gap || r.top >= window.innerHeight - r.bottom) ? r.top - ph - gap : r.bottom + gap;
    top = Math.max(pad, Math.min(top, window.innerHeight - ph - pad));
    const left = Math.max(pad, Math.min(r.left, window.innerWidth - 268 - pad));
    pop.style.top = top + 'px'; pop.style.left = left + 'px';
    scrollHost = closestScrollable(wrap);
    if (scrollHost) scrollHost.addEventListener('scroll', closePop, { passive: true });
    window.addEventListener('resize', closePop);
  }
  // 最近的可滚动祖先（按计算样式判，兼容 class 定义的 overflow——modal-card 的滚动即由 CSS 类给）
  function closestScrollable(el) {
    for (let n = el && el.parentElement; n; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return n;
    }
    return null;
  }
  function closePop() {
    if (!pop.classList.contains('open')) return;
    pop.classList.remove('open'); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
    pop.style.cssText = '';
    if (scrollHost) { scrollHost.removeEventListener('scroll', closePop); scrollHost = null; }
    window.removeEventListener('resize', closePop);
  }
  btn.addEventListener('click', (e) => {
    if (e.target === clearBtn) { e.stopPropagation(); sel = null; commit(); closePop(); return; }
    pop.classList.contains('open') ? closePop() : openPop();
  });
  // 选日期/翻月/预设只更新弹层内容、不关弹窗（确认/清除/点外部才关）。renderPop 会重建 innerHTML 使被点元素
  // 脱离 pop，若不抑制，下面 document 级 outside-close 会因 pop.contains(脱离的 e.target)=false 而误关 → 置位跳过本次。
  let suppressOutside = false;
  pop.addEventListener('click', (e) => {
    suppressOutside = true;
    const nav = e.target.closest('[data-nav]');
    if (nav) { viewM += +nav.dataset.nav; if (viewM < 0) { viewM = 11; viewY--; } else if (viewM > 11) { viewM = 0; viewY++; } renderPop(); return; }
    const day = e.target.closest('.dt-day');
    if (day) { sel = { y: +day.dataset.y, m: +day.dataset.m, d: +day.dataset.d }; viewY = sel.y; viewM = sel.m; commit(); renderPop(); return; }
    const preset = e.target.closest('[data-preset]');
    if (preset) {
      if (preset.dataset.preset === 'clear') { sel = null; commit(); closePop(); }
      else { const t = new Date(Date.now() + 3600000); sel = { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() }; h = t.getHours(); mi = t.getMinutes(); viewY = sel.y; viewM = sel.m; commit(); renderPop(); }
      return;
    }
    if (e.target.closest('.dt-done')) closePop();
  });
  pop.addEventListener('input', (e) => {
    if (e.target.classList.contains('dt-h')) { h = Math.max(0, Math.min(23, parseInt(e.target.value, 10) || 0)); if (sel) commit(); }
    else if (e.target.classList.contains('dt-m')) { mi = Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)); if (sel) commit(); }
  });
  document.addEventListener('click', (e) => {
    if (suppressOutside) { suppressOutside = false; return; }   // 本次点击落在 pop 内，跳过 outside-close
    if (!wrap.contains(e.target) && !pop.contains(e.target)) closePop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  window.__syncDtPicker = syncFromHidden;
  syncFromHidden();
})();

// req3：浏览按钮 → 系统目录选择（桌面端 Electron dialog；web 模式回退提示手填）
$('newTaskCwdBrowse').addEventListener('click', async () => {
  const btn = $('newTaskCwdBrowse');
  const errBox = $('newTaskErr');
  btn.disabled = true;
  try {
    const r = await api('/api/pick-dir', { method: 'POST' });
    if (r.ok && r.dir) { $('newTaskCwd').value = r.dir; closeCwdMenu(); refreshWorktreeUi(r.dir); }
    else if (!r.ok && r.error) { errBox.textContent = r.error; errBox.style.display = 'block'; }
  } catch (e) {
    errBox.textContent = e.message; errBox.style.display = 'block';
  } finally { btn.disabled = false; }
});
window.closeNewTaskModal = () => {
  $('newTaskModal').style.display = 'none';
  editingTaskKey = null;   // 关闭即回落新建模式基线，下次「新建」打开干净
  newTaskAttachCtl.clear();   // 附加本地文件归空
};
$('newTaskSubmit').addEventListener('click', async () => {
  const title = $('newTaskTitle').value.trim();
  const prompt = $('newTaskPrompt').value.trim();
  const description = $('newTaskDesc').value.trim();
  const cwd = $('newTaskCwd').value.trim();
  const provider = $('newTaskProvider').value || 'claude';
  const model = $('newTaskModel').value;
  const effort = $('newTaskEffort').value;                          // req3
  const scheduledAt = toLocalStamp($('newTaskScheduledAt').value);  // req4
  const dynamicWorkflow = providerDef(provider)?.capabilities?.dynamicWorkflow && $('newTaskDynamicWorkflow').checked;
  // req5：worktree 仅在 git 目录（worktree 区可见）且勾选时生效；签出基分支与 worktree 勾选无关，独立生效
  // （不勾选 worktree 时，签出基分支表示直接在工作目录本身签出该分支并拉取最新代码后工作）
  const worktreeVisible = $('newTaskWorktreeRow').style.display !== 'none';
  const worktree = worktreeVisible && $('newTaskWorktree').checked;
  const baseBranch = worktreeVisible ? ($('newTaskBaseBranch').value || '') : '';
  const attachments = newTaskAttachCtl.get();   // 附加本地文件：随任务发给 Agent
  const errBox = $('newTaskErr');
  const warnBox = $('newTaskWarn');
  errBox.style.display = 'none';
  warnBox.style.display = 'none';
  if (!title) { errBox.textContent = 'Title 必填'; errBox.style.display = 'block'; return; }
  if (!prompt) { errBox.textContent = 'Prompt 必填'; errBox.style.display = 'block'; return; }
  const editing = editingTaskKey;
  const btn = $('newTaskSubmit');
  btn.disabled = true; btn.textContent = editing ? '保存中…' : '提交中…';
  try {
    // 编辑模式：改写 plan 任务 task.json（不 spawn、留在 plan 待确认），刷新看板即回原位
    if (editing) {
      const r = await api(`/api/task/edit?taskKey=${encodeURIComponent(editing)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, prompt, provider, model, description, cwd, effort, scheduledAt, worktree, baseBranch, dynamicWorkflow, attachments }),
      });
      if (!r.ok) { errBox.textContent = r.error || '未知错误'; errBox.style.display = 'block'; return; }
      closeNewTaskModal();
      await refreshState();
      return;
    }
    // req2：新建任务默认进 plan 桶（plan:true 固定）
    const r = await api('/api/task/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, prompt, provider, model, description, plan: true, cwd, effort, scheduledAt, worktree, baseBranch, dynamicWorkflow, attachments }),
    });
    if (!r.ok) {
      errBox.textContent = r.error || '未知错误';
      errBox.style.display = 'block';
      return;
    }
    closeNewTaskModal();
    // queued → 已自动起会话执行：跳任务详情 #/task/<key>，详情见 mbSessionId 自动进 live（逐字 / 权限 / 打断）。
    // plan → 待确认，留在看板由用户「确认执行」。
    if (r.sessionUiId && r.taskKey) { await refreshState(); location.hash = '#/task/' + encodeURIComponent(r.taskKey); }
    else await refreshState();
  } catch (e) {
    errBox.textContent = e.message;
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = editing ? '保存' : '提交';
  }
});

// ---- 添加本机 CLI 会话 Modal ----
$('addCliBtn').addEventListener('click', () => {
  $('addCliModal').style.display = 'flex';
  $('addCliSearch').value = '';
  $('addCliErr').style.display = 'none';
  loadRecentCli();
  setTimeout(() => $('addCliSearch').focus(), 100);
});
window.closeAddCliModal = () => { $('addCliModal').style.display = 'none'; };

// 默认列表：近 30min 活跃 session（无需关键字）
async function loadRecentCli() {
  const results = $('addCliResults');
  results.innerHTML = '<div style="color:var(--dim);font-size:12.5px;padding:14px;text-align:center">加载近 30 分钟活跃会话…</div>';
  try {
    const r = await api('/api/cli/recent?within=30&limit=30&provider=all');
    if (!r.ok) { results.innerHTML = `<div style="color:var(--coral);font-size:12px;padding:14px;text-align:center">${escapeHtml(r.error || '加载失败')}</div>`; return; }
    if (!r.candidates?.length) {
      results.innerHTML = '<div style="color:var(--dim);font-size:12.5px;padding:14px;text-align:center">近 30 分钟内没有活跃的 CLI 会话<br>可用上方搜索按关键字 / sid 前缀查更早的</div>';
      return;
    }
    results.innerHTML = '<div style="font-size:10.5px;color:var(--dim);padding:8px 12px 4px;font-family:var(--mono)">近 30 分钟活跃 · ' + r.candidates.length + ' 个（按最近活动倒序）</div>'
      + r.candidates.map((c) => renderCliCandidateRow(c)).join('');
  } catch (e) {
    results.innerHTML = `<div style="color:var(--coral);font-size:12px;padding:14px;text-align:center">${escapeHtml(e.message)}</div>`;
  }
}

async function doCliSearch() {
  const q = $('addCliSearch').value.trim();
  const errBox = $('addCliErr');
  const results = $('addCliResults');
  errBox.style.display = 'none';
  if (!q) { errBox.textContent = '关键字或 sid 前缀不能为空'; errBox.style.display = 'block'; return; }
  results.innerHTML = '<div style="color:var(--dim);font-size:12.5px;padding:14px;text-align:center">搜索中…</div>';
  try {
    const r = await api('/api/cli/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, limit: 30, provider: 'all' }),
    });
    if (!r.ok) { errBox.textContent = r.error || '搜索失败'; errBox.style.display = 'block'; results.innerHTML = ''; return; }
    if (!r.candidates?.length) {
      results.innerHTML = '<div style="color:var(--dim);font-size:12.5px;padding:14px;text-align:center">无匹配 · 换关键字或扩大 sid 前缀试试</div>';
      return;
    }
    results.innerHTML = r.candidates.map((c) => renderCliCandidateRow(c)).join('');
  } catch (e) {
    errBox.textContent = e.message; errBox.style.display = 'block'; results.innerHTML = '';
  }
}
$('addCliSearchBtn').addEventListener('click', doCliSearch);
$('addCliSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doCliSearch(); } });

// 命中片段高亮：逐段转义后把关键词包 <mark>（大小写不敏感），复用会话内高亮的视觉风格
function highlightKeywords(text, keywords) {
  const kws = (keywords || []).filter(Boolean);
  if (!kws.length) return escapeHtml(text);
  const re = new RegExp('(' + kws.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index))
      + `<mark style="background:color-mix(in oklab, var(--success) 25%, transparent);color:var(--ink);padding:0 2px;border-radius:3px">${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++;   // 防零宽匹配死循环
  }
  return out + escapeHtml(text.slice(last));
}

function renderCliCandidateRow(c) {
  const short = c.sid.slice(0, 8);
  const msg = c.firstUserMsg ? escapeHtml(c.firstUserMsg) : '<span style="color:var(--dim);font-style:italic">（无真人 user message · 可能是 subagent 会话）</span>';
  // 关键字搜索命中片段：单独一行展示命中词 + 前后上下文，高亮命中词（sid 前缀搜索 / 无命中文本时不展示）
  const matchLine = c.matchSnippet
    ? `<div style="font-size:11.5px;color:var(--mut);line-height:1.6;background:var(--card2);border-radius:6px;padding:5px 9px;word-break:break-word"><span style="color:var(--dim);font-size:10px;font-family:var(--mono);margin-right:7px">匹配</span>${highlightKeywords(c.matchSnippet, c.matchKeywords)}</div>`
    : '';
  const btn = c.alreadyAdded
    ? '<span class="tag tag-jade" style="margin-left:auto;flex:none">已在看板</span>'
    : `<button class="btn btn-primary" style="font-size:11px;padding:5px 12px;margin-left:auto;flex:none" onclick="addCliFromSearch('${escapeAttr(c.sid)}','${escapeAttr(c.provider || 'claude')}')">+ 添加</button>`;
  return `
    <div style="padding:10px 12px;border-bottom:1px solid var(--hair);display:flex;flex-direction:column;gap:4px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-family:var(--mono);font-size:11.5px;color:var(--brand);font-weight:600">${short}</span>
        <span class="tag" style="font-size:9px;padding:2px 6px">${escapeHtml(providerDef(c.provider || 'claude')?.label || c.provider || 'CLI')}</span>
        <span style="font-family:var(--mono);font-size:10.5px;color:var(--dim)">${escapeHtml(c.cwd || c.projectDir || '—')}</span>
        <span style="font-family:var(--mono);font-size:10.5px;color:var(--dim);margin-left:auto">${c.mtime} · ${c.sizeMb} MB</span>
      </div>
      <div style="font-size:12.5px;color:var(--ink2);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(c.firstUserMsg || '')}">${msg}</div>
      ${matchLine}
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:10.5px;color:var(--dim);font-family:var(--mono)">git: ${escapeHtml(c.gitBranch || '—')}</span>
        ${btn}
      </div>
    </div>
  `;
}

window.addCliFromSearch = async (sid, provider = 'claude') => {
  const errBox = $('addCliErr');
  try {
    const r = await api('/api/cli/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, provider }),
    });
    if (!r.ok) { errBox.textContent = r.error || '添加失败'; errBox.style.display = 'block'; return; }
    await refreshState();
    // 刷新列表 alreadyAdded 态：有关键字→重搜；否则刷新近 30min 默认列表
    if ($('addCliSearch').value.trim()) doCliSearch(); else loadRecentCli();
  } catch (e) { errBox.textContent = e.message; errBox.style.display = 'block'; }
};

// S10 收养：终端起的 CLI 会话 → 看板 Mode B 交互会话（--resume 续接，带全部历史）
// 取消归档 / 取消完成：统一端点（/api/unarchive、/api/task/uncomplete），后端按来源分派——所有来源同一入口
window.unarchiveTaskAction = async (taskKey) => {
  try {
    const r = await api(`/api/unarchive?taskKey=${encodeURIComponent(taskKey)}`, { method: 'POST' });
    if (!r.ok) { customAlert({ title: '取消归档失败', message: escapeHtml(r.error || '未知错误') }); return; }
    await refreshState();
    if (modalOpen && modalPollTaskKey === taskKey) renderTaskSide(taskKey);
  } catch (e) { customAlert({ title: '取消归档失败', message: escapeHtml(e.message) }); }
};

window.uncompleteTaskAction = async (taskKey) => {
  try {
    const r = await api(`/api/task/uncomplete?taskKey=${encodeURIComponent(taskKey)}`, { method: 'POST' });
    if (!r.ok) { customAlert({ title: '取消完成失败', message: escapeHtml(r.error || '未知错误') }); return; }
    await refreshState();
    if (modalOpen && modalPollTaskKey === taskKey) renderTaskSide(taskKey);
  } catch (e) { customAlert({ title: '取消完成失败', message: escapeHtml(e.message) }); }
};

window.removeCliSession = async (sid) => {
  if (!sid) return;
  const ok = await customConfirm({
    title: '从看板移除 CLI 会话？',
    message: `sid = <code>${escapeHtml(sid)}</code>\n\n只从 watchlist 移除卡片，不影响 CLI session 本体（jsonl 保留）。`,
    confirmText: '移除',
    tone: 'danger',
  });
  if (!ok) return;
  try {
    const r = await api('/api/cli/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid }),
    });
    if (!r.ok) { customAlert({ title: '移除失败', message: escapeHtml(r.error || '未知错误') }); return; }
    // 若当前在详情页看的是它，跳回看板
    if (location.hash.startsWith(`#/task/cli:${sid.slice(0, 8)}`)) location.hash = '#/board';
    await refreshState();
  } catch (e) { customAlert({ title: '移除失败', message: escapeHtml(e.message) }); }
};

// ---- provider 驱动的模型·effort 合并选择器 ----
// provider catalog 是模型/effort 白名单的唯一来源；这里仅保留 Claude 模型的友好显示文案。
const CLAUDE_MODEL_META = [
  { value: 'claude-opus-4-8',           name: 'Opus 4.8',  desc: '旗舰推理 · 全局默认' },
  { value: 'claude-fable-5',            name: 'Fable 5',   desc: '最强推理 · 高于 Opus · issue 分析默认', badge: '配额 2×' },
  { value: 'claude-opus-4-7',           name: 'Opus 4.7',  desc: '上一代旗舰' },
  { value: 'claude-sonnet-5',           name: 'Sonnet 5',  desc: '平衡 · 中等速度与推理' },
  { value: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', desc: '最快 · 最省 token' },
];
const CODEX_MODEL_META = [
  { value: 'gpt-5.6', name: 'GPT-5.6', desc: '当前旗舰 Codex 模型' },
  { value: 'gpt-5.5', name: 'GPT-5.5', desc: '高能力代码与推理' },
  { value: 'gpt-5.4', name: 'GPT-5.4', desc: '稳定的通用编码模型' },
  { value: 'gpt-5.4-mini', name: 'GPT-5.4 mini', desc: '更快、更轻量的任务' },
];
// 容错映射：实测 CC 上报 model 即这些干净短 id，偶发带 -YYYYMMDD 后缀 → 归一到 BASE_MODELS 的 canonical value；认不出保留原值（诚实显示，不回落）
function normalizeModelValue(raw) {
  if (!raw) return '';
  const strip = (s) => s.replace(/-\d{6,}$/, '');
  const hit = CLAUDE_MODEL_META.find((m) => m.value === raw)
    || CLAUDE_MODEL_META.find((m) => strip(m.value) === strip(raw) || raw.startsWith(strip(m.value)));
  return hit ? hit.value : raw;
}
const EFFORT_HEAD = '更高档位推理更充分，但更慢、也更快消耗额度。';

function providerModels(def) {
  const values = Array.isArray(def?.models) ? def.models : [];
  const modelMeta = def?.id === 'codex' ? CODEX_MODEL_META : CLAUDE_MODEL_META;
  const items = values.map((value) => modelMeta.find((m) => m.value === value)
    || { value, name: value, desc: '' });
  if (def?.allowCustomModel) {
    items.unshift({ value: '', name: 'CLI 默认模型', desc: '使用本机 Codex 配置的默认模型' });
    items.push({ value: '__custom__', name: '自定义模型…', desc: '输入 Codex CLI 支持的模型 ID' });
  }
  return items.length ? items : [{ value: '', name: 'CLI 默认模型', desc: '' }];
}

let newTaskProviderCtl = null;
function initNewTaskProviderPicker() {
  const value = $('newTaskProvider');
  const btn = $('newTaskProviderBtn');
  const menu = $('newTaskProviderMenu');
  const picker = $('newTaskProviderPicker');
  if (!value || !btn || !menu || !picker) return null;
  const name = btn.querySelector('.provider-btn-name');
  const meta = btn.querySelector('.provider-btn-meta');
  let open = false;
  const definitions = () => providerCatalog.length ? providerCatalog : [
    { id: 'claude', label: 'Claude Code', command: 'claude', enabled: true },
    { id: 'codex', label: 'Codex', command: 'codex', enabled: true },
  ];
  const current = () => definitions().find((item) => item.id === value.value) || definitions()[0];
  const syncButton = () => {
    const selected = current();
    if (!selected) return;
    name.textContent = selected.label || selected.id;
    meta.textContent = selected.enabled === false ? `${selected.command || selected.id} · 已关闭` : (selected.command || selected.id);
    btn.disabled = btn.dataset.locked === '1';
  };
  const render = () => {
    const selected = value.value;
    menu.innerHTML = definitions().map((item) => {
      const enabled = item.enabled !== false;
      const caps = item.capabilities || {};
      const desc = enabled
        ? `${item.command || item.id} · ${caps.approvals ? '支持审批' : '无审批'}${caps.interrupt ? ' · 可打断' : ''}`
        : '运行时已关闭，开启后可新建会话';
      return `<button type="button" class="provider-option" role="option" data-provider="${escapeAttr(item.id)}" aria-selected="${item.id === selected}"${enabled ? '' : ' disabled'}>
        <span class="provider-option-copy"><span class="provider-option-name">${escapeHtml(item.label || item.id)}</span><span class="provider-option-desc">${escapeHtml(desc)}</span></span>
        <span class="provider-option-state">${enabled ? (item.online === false ? 'CLI 离线' : '可用') : '已关闭'}</span><span class="provider-option-mark">✓</span>
      </button>`;
    }).join('');
    syncButton();
  };
  const close = () => {
    if (!open) return;
    open = false; menu.classList.remove('open'); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); menu.style.cssText = '';
  };
  const openMenu = () => {
    if (btn.disabled) return;
    const rect = btn.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    open = true; render(); menu.classList.add('open'); btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
  };
  const setProvider = (id, { allowDisabled = false } = {}) => {
    const next = definitions().find((item) => item.id === id);
    if (!next || (!allowDisabled && next.enabled === false)) return false;
    value.value = next.id;
    render();
    value.dispatchEvent(new Event('change'));
    newTaskMesCtl?.setProvider(next.id);
    syncNewTaskProviderCapabilities();
    return true;
  };
  btn.addEventListener('click', (event) => { event.stopPropagation(); open ? close() : openMenu(); });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-provider]');
    if (!item || item.disabled) return;
    setProvider(item.dataset.provider); close(); btn.focus();
  });
  document.addEventListener('click', (event) => { if (open && !picker.contains(event.target) && !menu.contains(event.target)) close(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && open) { close(); btn.focus(); } });
  render();
  return {
    setProvider,
    refresh: render,
    setLocked(locked) { btn.dataset.locked = locked ? '1' : ''; syncButton(); if (locked) close(); },
    preferredProvider() { return definitions().find((item) => item.enabled !== false)?.id || value.value; },
  };
}
function providerEfforts(def) {
  return (Array.isArray(def?.efforts) ? def.efforts : []).map((value) => ({
    value,
    name: value === 'xhigh' ? 'xHigh' : value.charAt(0).toUpperCase() + value.slice(1),
    isDefault: value === def?.defaultEffort,
    info: value === 'max' || value === 'ultra' ? '最深推理 · 最慢、最耗额度' : '',
  }));
}

// 单实例初始化：modelSelectId / effortSelectId 是隐藏 select（value 载体，后端读它）。
// 回复条装配时按任务实际 model/effort 播种（见 __seedReplyModel）；新建表单播种默认值。
// inScroll=true：宿主在 overflow:auto 容器内（新建任务表单）——主菜单改 fixed 定位挂 viewport，按上下空间自动选方向。
function initModelEffortSelector({ wrapId, btnId, menuId, modelSelectId, effortSelectId, providerSelectId = null, inScroll = false }) {
  const wrap = $(wrapId), btn = $(btnId), menu = $(menuId);
  const modelSel = $(modelSelectId), effortSel = $(effortSelectId);
  if (!wrap || !btn || !menu || !modelSel || !effortSel) return null;
  const btnModel = btn.querySelector('.mes-btn-model');
  const btnEffort = btn.querySelector('.mes-btn-effort');

  const providerSel = providerSelectId ? $(providerSelectId) : null;
  let def = providerDef(providerSel?.value || 'claude') || {
    id: 'claude', label: 'Claude Code', models: CLAUDE_MODEL_META.map((m) => m.value), efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: 'claude-opus-4-8', defaultEffort: 'xhigh', allowCustomModel: false,
  };
  let models = providerModels(def);
  let efforts = providerEfforts(def);
  let subEffort, subModels, slotModelName, slotModelDesc, slotEffortVal;

  function rebuildMenu() {
    const effortItems = efforts.map((e) => `
      <button type="button" class="mes-item" data-eff="${escapeAttr(e.value)}" role="menuitemradio">
        <span class="mes-item-lead"><span class="mes-item-name">${escapeHtml(e.name)}</span>${e.isDefault ? '<span class="mes-item-default">默认</span>' : ''}${e.info ? `<span class="mes-item-info" title="${escapeAttr(e.info)}">ⓘ</span>` : ''}</span>
        <span class="mes-item-check" aria-hidden="true">✓</span>
      </button>`).join('');
    const modelItems = models.map((m) => `
      <button type="button" class="mes-item" data-model="${escapeAttr(m.value)}" role="menuitemradio">
        <span class="mes-item-lead"><span class="mes-item-name">${escapeHtml(m.name)}</span>${m.badge ? `<span class="mes-item-tag">${escapeHtml(m.badge)}</span>` : ''}</span>
        <span class="mes-item-check" aria-hidden="true">✓</span>
      </button>`).join('');
    menu.innerHTML = `
      <div class="mes-main">
        <button type="button" class="mes-row mes-row-model" data-nav="models"><span class="mes-row-main"><span class="mes-row-name" data-slot="model-name"></span><span class="mes-row-desc" data-slot="model-desc"></span></span><span class="mes-check on" aria-hidden="true">✓</span></button>
        <div class="mes-hair"></div>
        <button type="button" class="mes-row mes-row-nav" data-nav="effort"><span class="mes-row-label">Effort</span><span class="mes-row-val" data-slot="effort-val"></span><span class="mes-row-arrow" aria-hidden="true">›</span></button>
        <button type="button" class="mes-row mes-row-nav" data-nav="models"><span class="mes-row-label">更多模型</span><span class="mes-row-arrow" aria-hidden="true">›</span></button>
      </div>
      <div class="mes-sub" data-sub="effort"><div class="mes-sub-head">${escapeHtml(EFFORT_HEAD)}</div>${effortItems}</div>
      <div class="mes-sub" data-sub="models">${modelItems}</div>`;
    subEffort = menu.querySelector('.mes-sub[data-sub="effort"]');
    subModels = menu.querySelector('.mes-sub[data-sub="models"]');
    slotModelName = menu.querySelector('[data-slot="model-name"]');
    slotModelDesc = menu.querySelector('[data-slot="model-desc"]');
    slotEffortVal = menu.querySelector('[data-slot="effort-val"]');
  }

  const curModel = () => models.find((m) => m.value === modelSel.value && m.value !== '__custom__')
    || (modelSel.value ? { value: modelSel.value, name: modelSel.value, desc: '' } : models.find((m) => m.value === '') || models[0]);
  const curEffort = () => efforts.find((e) => e.value === effortSel.value) || efforts[0] || { value: '', name: '—' };

  function render() {
    const m = curModel(), e = curEffort();
    slotModelName.textContent = m.name;
    slotModelDesc.textContent = m.desc || '';
    slotModelDesc.style.display = m.desc ? '' : 'none';
    slotEffortVal.textContent = e.name;
    btnModel.textContent = m.name;
    btnEffort.textContent = e.name;
    subModels.querySelectorAll('.mes-item').forEach((it) => it.classList.toggle('active', it.dataset.model === modelSel.value));
    subEffort.querySelectorAll('.mes-item').forEach((it) => it.classList.toggle('active', it.dataset.eff === effortSel.value));
  }
  // 容忍不在下拉里的真实 model id（带版本/未知）：先补一个 <option>，否则原生 select 会把未知 value 吞成 ''
  const setModel = (v) => {
    if (v && !Array.from(modelSel.options).some((o) => o.value === v)) modelSel.add(new Option(v, v));
    modelSel.value = v; render();
  };
  const setEffort = (v) => { effortSel.value = v; render(); };
  const setProvider = (provider, model, effort) => {
    def = providerDef(provider) || def;
    if (providerSel) providerSel.value = def.id;
    models = providerModels(def);
    efforts = providerEfforts(def);
    modelSel.innerHTML = models.filter((m) => m.value !== '__custom__').map((m) => `<option value="${escapeAttr(m.value)}">${escapeHtml(m.name)}</option>`).join('');
    effortSel.innerHTML = efforts.map((e) => `<option value="${escapeAttr(e.value)}">${escapeHtml(e.name)}</option>`).join('');
    rebuildMenu();
    setModel(model != null ? model : def.defaultModel);
    setEffort(effort || def.defaultEffort);
  };
  rebuildMenu();
  setProvider(def.id, modelSel.value || def.defaultModel, effortSel.value || def.defaultEffort);

  // 二级飞出：右侧展开，getBoundingClientRect 溢出右边界则翻左（.flip）
  let openSub = null;
  const showSub = (which) => {
    if (openSub === which) return;
    openSub = which;
    subEffort.classList.toggle('open', which === 'effort');
    subModels.classList.toggle('open', which === 'models');
    const sub = which === 'effort' ? subEffort : subModels;
    sub.classList.remove('flip');
    requestAnimationFrame(() => { if (sub.getBoundingClientRect().right > window.innerWidth - 8) sub.classList.add('flip'); });
  };
  const hideSub = () => { openSub = null; subEffort.classList.remove('open'); subModels.classList.remove('open'); };

  let scrollHost = null;
  const closeMenu = () => {
    menu.classList.remove('open'); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
    hideSub();
    if (inScroll) {
      menu.style.cssText = '';
      if (scrollHost) { scrollHost.removeEventListener('scroll', closeMenu); scrollHost = null; }
      window.removeEventListener('resize', closeMenu);
    }
  };
  const openMenu = () => {
    if (inScroll) {
      const r = btn.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < 300 && r.top > spaceBelow;
      menu.style.position = 'fixed';
      menu.style.left = r.left + 'px';
      menu.style.bottom = openUp ? (window.innerHeight - r.top + 6) + 'px' : 'auto';
      menu.style.top = openUp ? 'auto' : (r.bottom + 6) + 'px';
      scrollHost = wrap.closest('[style*="overflow-y:auto"], [style*="overflow-y: auto"]');
      if (scrollHost) scrollHost.addEventListener('scroll', closeMenu, { passive: true });
      window.addEventListener('resize', closeMenu);
    }
    menu.classList.add('open'); btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
  };

  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.contains('open') ? closeMenu() : openMenu(); });
  // 悬停导航行 → 展开对应二级面板（进入面板内部不改变，picks/外点/Esc 才关）
  menu.addEventListener('mouseover', (e) => { const nav = e.target.closest('[data-nav]'); if (nav) showSub(nav.dataset.nav); });
  menu.addEventListener('click', (e) => {
    const effItem = e.target.closest('[data-eff]');
    if (effItem) { setEffort(effItem.dataset.eff); closeMenu(); btn.focus(); return; }
    const mdlItem = e.target.closest('[data-model]');
    if (mdlItem) {
      if (mdlItem.dataset.model === '__custom__') {
        closeMenu();
        customPrompt({ title: '自定义模型', message: '输入本机 Codex CLI 支持的模型 ID', initial: modelSel.value, placeholder: '例如 gpt-5.4' })
          .then((value) => { if (value != null && value.trim()) setModel(value.trim()); });
      } else { setModel(mdlItem.dataset.model); closeMenu(); btn.focus(); }
      return;
    }
    const nav = e.target.closest('[data-nav]');   // 键盘/点击可达：点导航行也展开
    if (nav) showSub(nav.dataset.nav);
  });
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('open') && !wrap.contains(e.target) && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')) { closeMenu(); btn.focus(); }
  });
  providerSel?.addEventListener('change', () => setProvider(providerSel.value));
  return { setProvider, setModel, setEffort };
}

let replyMesCtl = null;
function initReplyModelSelector() {
  replyMesCtl = initModelEffortSelector({
    wrapId: 'modalReplyMesWrap', btnId: 'modalReplyMesBtn', menuId: 'modalReplyMesMenu',
    modelSelectId: 'modalReplyModel', effortSelectId: 'modalReplyEffort', inScroll: false,
  });
  // 装配 composer 时按任务当前实际 model/effort 播种（不再显示「继承」占位）——发送时带的实际值 == 不带时后端继承的同一值，语义等价
  window.__seedReplyModel = (provider, model, effort) => {
    const def = providerDef(provider) || providerDef('claude');
    replyMesCtl?.setProvider(def?.id || 'claude', def?.id === 'claude' ? normalizeModelValue(model) : model, effort);
    const badge = $('modalReplyProvider');
    if (badge) badge.textContent = def?.label || provider || 'Claude Code';
  };
}

let newTaskMesCtl = null;
function initNewTaskModelSelector() {
  newTaskMesCtl = initModelEffortSelector({
    wrapId: 'newTaskMesWrap', btnId: 'newTaskMesBtn', menuId: 'newTaskMesMenu',
    modelSelectId: 'newTaskModel', effortSelectId: 'newTaskEffort', providerSelectId: 'newTaskProvider', inScroll: true,
  });
  $('newTaskProvider')?.addEventListener('change', syncNewTaskProviderCapabilities);
}

function syncNewTaskProviderCapabilities() {
  const def = providerDef($('newTaskProvider')?.value || 'claude');
  const field = $('newTaskWorkflowField');
  const input = $('newTaskDynamicWorkflow');
  const supported = !!def?.capabilities?.dynamicWorkflow;
  if (field) field.style.display = supported ? '' : 'none';
  if (input && !supported) input.checked = false;
}

// 计时器重排（modal 关闭时 / 改间隔时调用即可按最新间隔重新计时；modal 打开期间轮询由 modalOpen 门控跳过）
function scheduleStateRefresh() {
  if (stateTimer) clearInterval(stateTimer);
  stateTimer = setInterval(() => { if (!modalOpen) refreshState(); }, refreshStateMs);
}

// ==== Mode B 交互会话（S5：看板持有的 claude 会话 · 逐字 / 权限确认 / 打断）====
let mb = null;   // { id, sse, transcript:[], liveText, perms:[], info, state, syncing }

// 交互会话不再有独立视图——统一渲染进任务详情 #/task/<key>（loadTaskDetail 见 mbSessionId 时调本函数）。
// 逐字 / 权限卡 / 打断 / 状态行渲染进 #modalBody；会话状态并入右侧 renderTaskSide；composer 走 #modalReplyBox。

// 只关前端 SSE，不 close 后端进程（离开详情 / 切任务时用；会话继续跑，再进来重连回放）
function mbDetach() {
  mbStopStatusTimer();
  if (mbFlushRaf) { cancelAnimationFrame(mbFlushRaf); mbFlushRaf = null; }
  if (mb?.sse) { try { mb.sse.close(); } catch { /* ignore */ } }
  mb = null;
  // 后台任务栏属于会话——离开详情/切任务必须清掉，否则残留在下一个任务上
  const bg = $('modalBgTasks');
  if (bg) { bg.style.display = 'none'; bg.innerHTML = ''; }
}

function loadSession(id) {
  if (mb && mb.id === id && mb.sse) return;   // 已在该会话，避免重复连
  mbDetach();
  mb = { id, sse: null, transcript: [], liveText: '', perms: [], info: {}, state: 'starting', syncing: true, liveUsage: null, turnStartedAt: null, gerundSeed: 0, bgTasks: [], bgOutFor: null };
  $('modalBody').innerHTML = '<div style="color:var(--dim);padding:12px 0">连接实时会话…</div>';
  mbSyncLiveHead();
  const es = new EventSource(`/api/session/stream?id=${encodeURIComponent(id)}`);
  mb.sse = es;
  // info 里带后台任务当前全表：transcript 有上限（会 shift 丢头），万一回放里已无 background_tasks_changed
  // 事件，仍能据此还原；回放中若有更新的该事件会覆盖它（回放尾 = 最新态）。
  es.addEventListener('info', (e) => {
    try {
      mb.info = JSON.parse(e.data); mb.state = mb.info.state || mb.state;
      if (Array.isArray(mb.info.backgroundTasks)) mb.bgTasks = mb.info.backgroundTasks;
      mbSyncLiveHead();
    } catch { /* ignore */ }
  });
  es.addEventListener('synced', () => {
    mb.syncing = false; mbRenderBody(); mbSyncLiveHead(); mbRenderBgTasks();
    updateReplyBoxAvailability(modalPollTaskKey);   // 装配 live composer（常开输入 + 打断 + mbSend）
    // 从 CLI 详情「发送消息」收养而来：历史回放完成后自动发出用户那条消息（mbSend 乐观回显 → 可见）
    if (pendingCliMessage) { const m = pendingCliMessage; pendingCliMessage = null; $('modalReplyText').value = m; mbSend(); }
  });
  es.onmessage = (e) => { let o; try { o = JSON.parse(e.data); } catch { return; } mbOnEvent(o); };
  // EventSource 断线自动重连；重连后服务端会重发 info + 回放 transcript
}

function mbOnEvent(ev) {
  if (!mb) return;
  switch (ev.type) {
    case 'message_delta': {
      if (!mb.liveUsage) mb.liveUsage = { up: 0, outChars: 0, outReal: null, active: true, thinking: false };
      if (ev.blockType === 'text') mb.liveText += ev.delta || '';
      mb.liveUsage.thinking = ev.blockType === 'thinking';
      mb.liveUsage.outChars += String(ev.delta || '').length;
      if (!mb.turnStartedAt) { mb.turnStartedAt = Date.now(); mb.gerundSeed = Math.floor(Math.random() * MB_GERUNDS.length); }
      mbScheduleLive();
      return;
    }
    case 'message':
      mb.transcript.push(ev);
      if (ev.message?.role === 'assistant') {
        mb.liveText = '';
        const u = ev.message.usage;
        if (u) {
          if (!mb.liveUsage) mb.liveUsage = { up: 0, outChars: 0, outReal: null, active: true, thinking: false };
          mb.liveUsage.up = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          mb.liveUsage.outReal = u.output_tokens ?? null;
        }
      }
      if (!mb.syncing) mbRenderBody();
      return;
    case 'turn_usage': {
      const u = ev.usage || {};
      if (!mb.liveUsage) mb.liveUsage = { up: 0, outChars: 0, outReal: null, active: true, thinking: false };
      mb.liveUsage.up = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      mb.liveUsage.outReal = u.output_tokens ?? mb.liveUsage.outReal;
      mb.info.lastUsage = { ...u, contextWindow: ev.contextWindow ?? null };
      if (!mb.syncing) mbUpdateLiveTokens();
      return;
    }
    case 'turn_completed':
      mb.liveText = ''; mb.state = 'idle'; mb.turnStartedAt = null;
      if (mb.liveUsage) { mb.liveUsage.active = false; mb.liveUsage.thinking = false; }
      if (!mb.syncing) { mbRenderBody(); mbSyncLiveHead(); }
      return;
    case 'session_initialized':
      if (ev.sessionId) { mb.info.sessionId = ev.sessionId; mb.info.claudeSessionId = ev.provider === 'claude' ? ev.sessionId : null; }
      if (ev.provider) mb.info.provider = ev.provider;
      if (ev.model != null) mb.info.model = ev.model;
      mb.state = 'running'; if (!mb.syncing) mbSyncLiveHead(); return;
    case 'background_tasks':
      mb.bgTasks = Array.isArray(ev.tasks) ? ev.tasks : []; if (!mb.syncing) mbRenderBgTasks(); return;
    case 'approval_requested':
      mb.perms.push({ requestId: ev.requestId, kind: ev.kind, toolName: ev.toolName || 'Tool', input: ev.input || {}, questions: ev.questions || null });
      if (!mb.syncing) mbRenderBody(); return;
    case 'approval_resolved':
      mb.perms = mb.perms.filter((p) => p.requestId !== ev.requestId); if (!mb.syncing) mbRenderBody(); return;
    case 'closed': mb.state = 'closed'; if (!mb.syncing) { mbSyncLiveHead(); mbRenderBody(); } return;
    case 'error': mb.state = 'error'; mb.lastError = ev.error; if (!mb.syncing) mbSyncLiveHead(); return;
    default: return;
  }
}

// ---- 后台任务栏（消息流与发送区之间）----
// 数据源：CC 的 system/background_tasks_changed 全量推送（见 session-manager）。不反读 jsonl、不扫进程——
// 那两条路要么漏（subagent 没有独立进程、subagent 起的后台任务不进主 jsonl）、要么得靠猜。
// task_type 取值见 CC 的 Task.ts；Monitor 与后台命令同为 local_bash（事件不带 kind，无法再细分），
// 二者的 description 已足够区分，不强行猜。
const MB_TASK_KIND = {
  local_bash: '后台命令',
  local_agent: 'subagent',
  remote_agent: '云端会话',
  in_process_teammate: '队友',
  local_workflow: '工作流',
  monitor_mcp: 'Monitor',
  dream: 'dream',
};

function mbRenderBgTasks() {
  const el = $('modalBgTasks');
  if (!el) return;
  const tasks = (mb?.bgTasks || []).filter((t) => t && t.task_id);
  if (!tasks.length) { el.style.display = 'none'; el.innerHTML = ''; mb && (mb.bgOutFor = null); return; }
  el.style.display = '';
  const rows = tasks.map((t) => {
    const kind = MB_TASK_KIND[t.task_type] || t.task_type || '任务';
    const open = mb.bgOutFor === t.task_id;
    return `<div class="bg-task-row">
      <span class="bg-task-kind">${escapeHtml(kind)}</span>
      <span class="bg-task-desc" title="${escapeAttr(t.description || t.task_id)}">${escapeHtml(t.description || t.task_id)}</span>
      <button type="button" class="bg-task-act" onclick="mbToggleTaskOutput('${escapeAttr(t.task_id)}')">${open ? '收起' : '查看'}</button>
      <button type="button" class="bg-task-act danger" onclick="mbStopTask('${escapeAttr(t.task_id)}')">停止</button>
    </div>${open ? `<pre class="bg-task-out" id="mbTaskOut">加载中…</pre>` : ''}`;
  }).join('');
  el.innerHTML = `<div class="bg-tasks-inner">
    <div class="bg-tasks-head"><b>后台任务 ${tasks.length}</b><span>主进程已让出，等它们完成</span></div>
    ${rows}
  </div>`;
  if (mb.bgOutFor) mbLoadTaskOutput(mb.bgOutFor);
}

function mbToggleTaskOutput(taskId) {
  if (!mb) return;
  mb.bgOutFor = mb.bgOutFor === taskId ? null : taskId;
  mbRenderBgTasks();
}

async function mbLoadTaskOutput(taskId) {
  const pre = $('mbTaskOut');
  if (!pre || !mb) return;
  try {
    const j = await api(`/api/session/task-output?id=${encodeURIComponent(mb.id)}&taskId=${encodeURIComponent(taskId)}`);
    if (!j.ok) { pre.textContent = j.error || '读取失败'; return; }
    pre.textContent = (j.truncated ? '…（只显示尾部）\n' : '') + (j.text || '（暂无输出）');
    pre.scrollTop = pre.scrollHeight;
  } catch (e) { pre.textContent = `读取失败：${e.message}`; }
}

// 停后台任务：走 CC 的 stop_task 控制请求（与 TaskStopTool 同一条 stopTask）。停掉后 CC 会推
// background_tasks_changed（移除）→ 栏自动更新，这里不做乐观摘除。
async function mbStopTask(taskId) {
  if (!mb) return;
  try {
    const j = await api(`/api/session/stop-task?id=${encodeURIComponent(mb.id)}&taskId=${encodeURIComponent(taskId)}`, { method: 'POST' });
    if (!j.ok) toast(`停止失败：${j.error}`);
  } catch (e) { toast(`停止失败：${e.message}`); }
}
window.mbToggleTaskOutput = mbToggleTaskOutput;
window.mbStopTask = mbStopTask;

// 把 Mode B settled 事件转成 renderDetailTab 认识的 rounds 形状（复用工具/思考/token/每步计时渲染）。
// stream-json 的 assistant 事件是增量（同 message.id 拆成 thinking/text/tool_use 各一条）——按 id 合并，
// 与 Mode A parseCcSession 同语义，否则消息被拆开、tool_use 与 usage 对不上。
function mbToRounds() {
  const messages = [];
  let curAsst = null;
  for (const ev of mb.transcript) {
    if (ev.type === 'message' && ev.message?.role === 'assistant') {
      const mid = ev.message.id || null;
      if (curAsst && mid && curAsst._mid === mid) {
        for (const c of ev.message.content || []) {
          const dup = curAsst.content.find((x) => x.type === c.type &&
            (x.text === c.text || (x.name && x.name === c.name && JSON.stringify(x.input) === JSON.stringify(c.input))));
          if (!dup) curAsst.content.push(c);
        }
        if (ev.message.usage) curAsst.usage = ev.message.usage;
      } else {
        curAsst = { role: 'assistant', _mid: mid, at: (ev.message.content || [])[0]?._ts || null, content: [...(ev.message.content || [])], usage: ev.message.usage || null, model: ev.message.model || null };
        messages.push(curAsst);
      }
    } else if (ev.type === 'message' && ev.message?.role === 'user') {
      curAsst = null;
      let content = ev.message.content;
      if (typeof content === 'string') content = [{ type: 'text', text: content }];
      // uuid / isMeta：seed 的历史消息带（ccMessagesToModeBSeed 透传磁盘 uuid + isMeta）→ 详情可「改写重跑」、
      // caveat/system-reminder/Skill 注入正文能归运行输出；live 流的新消息两者都不带（stream-json 无此 envelope），
      // 那条路靠 renderCcFlow 的内容识别兜（SKILL_BODY_RE 等）。此处绝不能硬编 isMeta:false 覆盖 seed 的真值。
      messages.push({ role: 'user', at: (content || [])[0]?._ts || null, uuid: ev.uuid || null, content: content || [], isMeta: !!ev.isMeta });
    }
  }
  const inflight = mb.state === 'running' || mb.state === 'starting';
  // 侧栏「任务信息」字段：live 会话不走 /api/worker-log，这里补齐 worker-log round 同款字段——
  // cwd 取 session info（Session.cwd）；gitBranch 扫 transcript 事件（仿 logs.js）；
  // 工作时长 Mode B jsonl 无 turn_duration → 每轮墙钟（user→本轮末 assistant 的 _ts 差）累加，不含用户输入间隔。
  let gitBranch = mb.info?.gitBranch || null;   // resume/收养源分支（session info 带）；live 流事件通常不带 gitBranch
  for (const ev of mb.transcript) { if (ev.gitBranch) gitBranch = ev.gitBranch; }
  let workMs = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user' || !messages[i].at) continue;
    const start = new Date(messages[i].at).getTime();
    let end = null;
    for (let j = i + 1; j < messages.length && messages[j].role !== 'user'; j++) if (messages[j].at) end = new Date(messages[j].at).getTime();
    if (end && end > start) workMs += end - start;
  }
  // 上下文用量：末条带 usage 的 assistant 消息 input+cache（= 模型本轮读入的上下文总量，与 Mode A logs.js 同口径）
  const lastAsstU = [...messages].reverse().find((m) => m.role === 'assistant' && m.usage)?.usage;
  const contextSize = lastAsstU
    ? (lastAsstU.input_tokens || 0) + (lastAsstU.cache_read_input_tokens || 0) + (lastAsstU.cache_creation_input_tokens || 0)
    : null;
  return [{
    round: 1, sessionId: mb.info?.sessionId || mb.info?.claudeSessionId || null, inflight, messages,
    cwd: mb.info?.cwd || null, gitBranch,
    ccSummary: { model: mb.info?.model || null, workMs: workMs > 0 ? workMs : null, contextSize },
    humanCc: [],
  }];
}

// live 会话状态并入右侧任务信息块（renderTaskSide 读 currentModalData 展示 live 轮次/token/● 实时）+
// 同步打断按钮 disabled 与 composer 状态徽章。不再有独立会话头部 / 结束会话按钮（D-b：生命周期由任务态驱动）。
function mbSyncLiveHead() {
  if (!mb) return;
  if (modalPollTaskKey) renderTaskSide(modalPollTaskKey);
  // 打断按钮用 display 即时显隐（result → mb.state=idle 即隐藏），与 updateReplyBoxAvailability 装配逻辑一致。
  const ib = $('modalReplyInterrupt'); if (ib) ib.style.display = (mb.state === 'running' || mb.state === 'starting') ? '' : 'none';
  const st = $('modalReplyState');
  if (st && mb.id && findTaskInState(modalPollTaskKey)?.mbSessionId === mb.id) {
    st.className = 'tag ' + (mb.state === 'running' ? 'tag-amber' : 'tag-jade');
    st.textContent = mb.state === 'running' ? '生成中 · 可插话/打断' : '实时会话 · 可继续';
  }
  mbUpdateLiveTokens();
}

// 实时 token 读数：上行(input+cache) message_start 即知真值；下行生成中按累计 delta 字符估算(~)、
// 末尾 message_delta 给真值。CC 只在末尾发一次 message_delta —— 逐 token 增长不可得（两次实测证伪）。
function mbUpdateLiveTokens() {
  const el = document.getElementById('mbLiveTokens'); if (!el) return;
  const u = mb && mb.liveUsage;
  if (!u) { el.textContent = ''; return; }
  const down = u.outReal != null ? Number(u.outReal).toLocaleString('en-US')
    : '~' + Math.ceil(u.outChars / 4).toLocaleString('en-US');
  el.textContent = `↑ ${Number(u.up).toLocaleString('en-US')} / ↓ ${down}${u.active ? ' · 生成中' : ''}`;
}

// 实时活动状态行（Claude Code 风格）：✻ Gerund…（Ns · ↓ tokens[· thinking with X effort]）
// 数据源：turnStartedAt 计时 · liveUsage 下行(生成中 ~估算 / 末尾真值) · liveUsage.thinking(thinking_delta)
//   · effort 来自 mb.info.effort（spawn 时 --effort 传入、经 s.info() 回传；收养会话未指定则省略档位）。
const MB_GLYPHS = ['✻', '✳', '✽', '✢', '·', '✢', '✽', '✳'];
const MB_GERUNDS = ['Accomplishing', 'Actualizing', 'Baking', 'Brewing', 'Churning', 'Cogitating', 'Computing', 'Conjuring', 'Crafting', 'Divining', 'Drizzling', 'Effecting', 'Forging', 'Germinating', 'Hatching', 'Herding', 'Ideating', 'Incubating', 'Manifesting', 'Marinating', 'Moseying', 'Mulling', 'Noodling', 'Percolating', 'Pondering', 'Processing', 'Puzzling', 'Reticulating', 'Ruminating', 'Shucking', 'Simmering', 'Smooshing', 'Spinning', 'Stewing', 'Synthesizing', 'Transmuting', 'Vibing', 'Whirring', 'Working', 'Wrangling'];
let mbStatusTimer = null;
let mbStatusTick = 0;

function mbFmtK(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); }

function mbStatusParts() {
  const u = mb && mb.liveUsage;
  const elapsed = (mb && mb.turnStartedAt) ? Math.max(0, Math.floor((Date.now() - mb.turnStartedAt) / 1000)) : 0;
  const glyph = MB_GLYPHS[mbStatusTick % MB_GLYPHS.length];
  const gerund = MB_GERUNDS[((mb?.gerundSeed || 0) + Math.floor(elapsed / 5)) % MB_GERUNDS.length];
  let downTxt = '0';
  if (u) {
    if (u.outReal != null) downTxt = mbFmtK(u.outReal);
    else if (u.outChars) downTxt = '~' + mbFmtK(Math.ceil(u.outChars / 4));
  }
  const eff = mb && mb.info && mb.info.effort;
  const think = (u && u.thinking) ? (eff ? ` · thinking with ${eff} effort` : ' · thinking') : '';
  return { glyph, rest: `${gerund}… (${elapsed}s · ↓ ${downTxt} tokens${think})` };
}
// glyph 每 300ms 循环切换，各装饰符号渲染宽度不一；用固定宽度 span 居中包裹，避免其后文本左右抖动
function mbStatusHtml() { const { glyph, rest } = mbStatusParts(); return `<span class="mb-glyph">${glyph}</span> ${escapeHtml(rest)}`; }

function mbTick() {
  if (!mb || (mb.state !== 'running' && mb.state !== 'starting')) { mbStopStatusTimer(); return; }
  mbStatusTick++;
  const el = document.getElementById('mbStatus');
  if (el) el.innerHTML = mbStatusHtml();
}
function mbStartStatusTimer() { if (!mbStatusTimer) mbStatusTimer = setInterval(mbTick, 300); }
function mbStopStatusTimer() { if (mbStatusTimer) { clearInterval(mbStatusTimer); mbStatusTimer = null; } }

function mbRenderBody() {
  if (!mb) return;
  const body = $('modalBody'); if (!body) return;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  const rounds = mbToRounds();
  // 供右侧 renderTaskSide 读 live 轮次/token/● 实时（live 模式不走 /api/worker-log，currentModalData 由此喂）
  currentModalData = { rounds, hasInflight: mb.state === 'running' || mb.state === 'starting' };
  syncContextRing(modalPollTaskKey);   // 底栏上下文环形跟随 live 上下文变化（多数 live 事件只走 mbRenderBody，不经 renderTaskSide）
  let html = rounds[0].messages.length ? renderDetailTab({ rounds }, true) : '<div style="color:var(--dim);padding:12px 0">等待 Agent 响应…</div>';
  if (mb.liveText) html += `<div class="cc-line cc-text"><span class="cc-dot">⏺</span><div class="mb-live" id="mbLive">${escapeHtml(mb.liveText)}</div></div>`;
  const running = mb.state === 'running' || mb.state === 'starting';
  if (running) html += `<div class="cc-dur cc-dur-total mb-status" id="mbStatus">${mbStatusHtml()}</div>`;
  for (const p of mb.perms) {
    html += ((p.kind === 'request_user_input' || p.toolName === 'AskUserQuestion') && (Array.isArray(p.questions) || Array.isArray(p.input?.questions)))
      ? mbAskCardHtml(p)
      : `<div class="perm-card">
      <div class="pc-tool">🔐 Agent 请求使用工具 <span style="color:var(--amber)">${escapeHtml(p.toolName)}</span></div>
      <pre>${escapeHtml(JSON.stringify(p.input, null, 2).slice(0, 2000))}</pre>
      <div class="pc-actions">
        <button class="btn btn-primary" onclick="mbRespond('${escapeAttr(p.requestId)}', true)">允许</button>
        <button class="btn btn-danger" onclick="mbRespond('${escapeAttr(p.requestId)}', false)">拒绝</button>
      </div></div>`;
  }
  body.innerHTML = html;
  if (atBottom) scrollBodyToEnd(body);   // 含下一帧补滚：进 live 详情大段历史一次性渲染，布局稳定后才到真正底部
  if (running) mbStartStatusTimer(); else mbStopStatusTimer();
}

// S8：AskUserQuestion 交互卡 —— 渲染问题 + 选项（单选 radio / 多选 checkbox），提交回传 answers
function mbAskCardHtml(p) {
  const qs = p.questions || p.input.questions || [];
  const body = qs.map((q, qi) => {
    const multi = !!q.multiSelect;
    const opts = (q.options || []).map((o) => `
      <label class="ask-opt">
        <input type="${multi ? 'checkbox' : 'radio'}" name="q${qi}" value="${escapeAttr(o.label)}">
        <span class="ask-opt-label">${escapeHtml(o.label)}</span>
        ${o.description ? `<span class="ask-opt-desc">${escapeHtml(o.description)}</span>` : ''}
      </label>`).join('');
    return `<div class="ask-q" data-q="${escapeAttr(q.question)}">
      ${q.header ? `<span class="ask-qhead">${escapeHtml(q.header)}</span>` : ''}
      <div class="ask-qtext">${escapeHtml(q.question)}${multi ? ' <span class="ask-multi">(可多选)</span>' : ''}</div>
      <div class="ask-opts">${opts}</div>
    </div>`;
  }).join('');
  return `<div class="perm-card ask-card" data-req="${escapeAttr(p.requestId)}">
    <div class="pc-tool">💬 Agent 想问你</div>
    ${body}
    <div class="pc-actions">
      <button class="btn btn-primary" onclick="mbSubmitAnswers('${escapeAttr(p.requestId)}')">提交</button>
      <button class="btn" onclick="mbRespond('${escapeAttr(p.requestId)}', false)">跳过</button>
    </div></div>`;
}

// 收集 AskUserQuestion 选择 → answers{问题:选项(多选逗号分隔)} → 走 /respond 的 answers 通道
window.mbSubmitAnswers = (requestId) => {
  if (!mb) return;
  const card = document.querySelector(`.ask-card[data-req="${requestId}"]`);
  if (!card) return;
  const answers = {};
  card.querySelectorAll('.ask-q').forEach((qel) => {
    const q = qel.getAttribute('data-q');
    const checked = [...qel.querySelectorAll('input:checked')].map((i) => i.value);
    if (checked.length) answers[q] = checked.join(', ');
  });
  if (!Object.keys(answers).length) { customAlert({ title: '请先选择', message: '至少选一个选项再提交' }); return; }
  mb.perms = mb.perms.filter((x) => x.requestId !== requestId);
  mbRenderBody();
  api(`/api/session/respond?id=${encodeURIComponent(mb.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, allow: true, answers }) })
    .catch((e) => customAlert({ title: '提交失败', message: escapeHtml(e.message) }));
};

// 逐字增量：只改 #mbLive 文本，不整刷（不存在则整刷一次建出来）
// 高频 text_delta / token 增量合批到下一帧统一落地：原来每条 delta 都整写 DOM + 读 scrollHeight（强制同步 reflow），
// 逐 token 推送下主线程被占满，正文与底部状态行一起卡顿。改为只标脏 + rAF，DOM 落地每帧至多一次、reflow 每帧至多一次。
let mbFlushRaf = null;
function mbScheduleLive() {
  if (mbFlushRaf || !mb || mb.syncing) return;
  mbFlushRaf = requestAnimationFrame(mbFlushLive);
}
function mbFlushLive() {
  mbFlushRaf = null;
  if (!mb) return;
  const el = document.getElementById('mbLive');
  if (!el) { if (mb.liveText) mbRenderBody(); return; }   // #mbLive 未建且有正文：整刷建结构；轮末 liveText 已清空则 no-op，免全量重渲染
  el.textContent = mb.liveText;
  mbUpdateLiveTokens();
  const body = $('modalBody');
  if (body && body.scrollHeight - body.scrollTop - body.clientHeight < 120) body.scrollTop = body.scrollHeight;
}

async function mbSend() {
  if (!mb) return;
  const ta = $('modalReplyText'); const msg = ta.value.trim();
  if (!msg) return;
  const attachments = replyAttachCtl.get();   // 读附件（发送成功后清空）
  ta.value = ''; updateReplyCount(0);
  mb.transcript.push({ type: 'user', message: { role: 'user', content: attachSuffix(msg, attachments) } });   // 乐观回显（含附件路径，与后端 transcript 一致）
  mb.turnStartedAt = Date.now(); mb.gerundSeed = Math.floor(Math.random() * MB_GERUNDS.length); mb.liveUsage = null;   // 从发送即开始计时（CC 风格）
  mb.state = 'running'; mbRenderBody(); mbSyncLiveHead();
  // 绑定「文件任务」（有任务包）→ /api/task/reply（内部 sendUserMessage + 置任务 state=processing + lease）；
  // 被旁观 / 收养但未物化的 CLI 会话（board 卡带 t.cli，无 runner-state 包）与未绑定会话 → 直接发到 live 会话
  // stdin（/api/session/send）。关键：未物化 cli:* 不能走 /api/task/reply——那会进 replyToTask 的观察侧 replyCliSession
  //（已废弃 ps1），既撞不到活的 runner、guard 又会误判终端占用而拒发。物化后的 cli 任务有包、无 t.cli → 走 task/reply。
  const tk = mb.info?.taskKey;
  const useTaskReply = tk && !findTaskInState(tk)?.cli;
  const payload = { message: msg };
  if (attachments.length) payload.attachments = attachments;   // 附加本地文件：后端拼进文本尾部让 Agent 读取
  const r = useTaskReply
    ? await api(`/api/task/reply?taskKey=${encodeURIComponent(tk)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch((e) => ({ ok: false, error: e.message }))
    : await api(`/api/session/send?id=${encodeURIComponent(mb.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) customAlert({ title: '发送失败', message: escapeHtml(r.error || '') });
  else replyAttachCtl.clear();
}
window.mbRespond = async (requestId, allow) => {
  if (!mb) return;
  mb.perms = mb.perms.filter((p) => p.requestId !== requestId);
  mbRenderBody();
  const r = await api(`/api/session/respond?id=${encodeURIComponent(mb.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, allow }) }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) customAlert({ title: (allow ? '允许' : '拒绝') + '失败', message: escapeHtml(r.error || '') });
};
// 打断当前轮（interrupt control_request）；由 live 模式 composer 的「■ 打断」按钮调用
// （按钮显隐/绑定在 updateReplyBoxAvailability 的 live 分支装配）。无「结束会话」入口（D-b：生命周期随任务态）。
window.mbInterrupt = () => { if (mb) api(`/api/session/interrupt?id=${encodeURIComponent(mb.id)}`, { method: 'POST' }).catch(() => {}); };

// ---- init ----
refreshState().then(async () => {
  await ensureProviderCatalog();
  initReplyModelSelector();
  newTaskProviderCtl = initNewTaskProviderPicker();
  initNewTaskModelSelector();
  // 老式深链接 ?task=<key>&tab=<tab> 兼容 → 转成 hash 路由
  const q = new URLSearchParams(location.search);
  const deepTask = q.get('task');
  if (deepTask) {
    const tab = q.get('tab');
    history.replaceState(null, '', location.pathname);
    location.hash = '#/task/' + encodeURIComponent(deepTask) + (tab && ['overview', 'detail', 'timeline'].includes(tab) ? '/' + tab : '');
    // hash 变化会触发 hashchange → router
    return;
  }
  router();   // 初始路由（含刷新时停留在任意 hash 页）
});
scheduleStateRefresh();
