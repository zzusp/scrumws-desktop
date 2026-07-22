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
// modal 打开时暂停看板刷新 —— 详情由独立的 JSONL revision 轮询驱动；关闭时立即 refreshState + 重置计时
let modalOpen = false;
let modalPollTimer = null;
let modalPollTaskKey = null;
let stateTimer = null;
// 详情页只轮询轻量 revision（stat + 小型元数据），约 1 秒即可跟随 CLI 输出，正文变更后才读完整 JSONL。
const MODAL_POLL_MS = 1000;
// 外部 Codex Desktop 的占用探测无需随每次 revision 请求，独立低频收敛即可。
const MODAL_STATE_POLL_MS = 5000;
let modalLastStatePollAt = 0;
let modalPollBusy = false;
let lastModalRevision = null;

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
    // 已关闭的运行时既不展示也不请求账号用量；保留 CLI 版本、路径等诊断信息即可。
    const account = !enabled ? '' : runtime.id === 'claude' && runtime.capabilities?.accountUsage
      ? `<div class="rt-account"><div class="rt-account-head"><span class="rt-account-title">账号用量</span><span class="rt-account-note">由 ${escapeHtml(runtime.label || 'CLI')} 查询</span></div>${ccAccountUsageBarsHtml(runtime.claudeUsage, runtime.usagePoll)}</div>`
      : runtime.id === 'codex' && runtime.capabilities?.accountUsage
        ? `<div class="rt-account"><div class="rt-account-head"><span class="rt-account-title">账号用量</span><span class="rt-account-note">最近本机 session JSONL 记录</span></div>${codexAccountUsageBarsHtml(runtime.codexUsage)}</div>`
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
         <button type="button" class="rt-power-toggle${enabled ? ' is-on' : ''}" role="switch" aria-checked="${enabled ? 'true' : 'false'}" title="${enabled ? '关闭' : '开启'} ${escapeAttr(runtime.label || runtime.tool || '运行时')}" onclick="toggleProviderRuntime('${escapeAttr(runtime.id)}', ${enabled ? 'false' : 'true'})">
           <span class="rt-power-copy"><span>运行时</span><small>${enabled ? '已开启' : '已关闭'}</small></span>
           <span class="rt-switch" aria-hidden="true"><i></i></span>
         </button>
       </div>
     </div>`;
  }).join('');
  const claudeRuntime = runtimes.find((runtime) => runtime.id === 'claude') || rt;
  // ---- 用量汇总：Claude Code + Codex 的本机 session JSONL（7/15/30 天切换）----
  dailyUsageData = Array.isArray(rt.dailyUsage) ? rt.dailyUsage : null;
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
    renderDailyChart(dailyUsageData);
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

// ---- 用量汇总表格（全部本机 CLI 的每日 token，7/15/30 切换）+ 每日柱状图（Chart.js）----
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

// 近 7 天 token：恢复原来的「全局 / ScrumWS」覆盖式展示；来源 CLI 只在数据采集层合并，
// 不在趋势图按 Provider 拆柱，避免改变用户既有的阅读口径。
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
        { label: '全局', data: days.map((d) => d.total || 0), backgroundColor: `color-mix(in oklab, ${info} 32%, transparent)`, hoverBackgroundColor: `color-mix(in oklab, ${info} 48%, transparent)`, borderRadius: 4, grouped: false },
        { label: 'ScrumWS', data: days.map((d) => d.platform || 0), backgroundColor: brand, hoverBackgroundColor: `color-mix(in oklab, ${brand} 86%, black)`, borderRadius: 4, grouped: false },
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

// 执行 CLI 标识：任务的 provider 是唯一事实源；未带该字段的历史任务仍按 Claude 兼容。
// 不依赖运行时 catalog，避免看板首屏在 catalog 异步加载前显示空标签。
function cliLabel(provider) {
  const id = String(provider || 'claude').toLowerCase();
  return providerDef(id)?.label || (id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude Code' : id);
}
function cliTagHtml(t) {
  const id = String(t.provider || 'claude').toLowerCase();
  const cls = id === 'codex' ? 'tag-cyan' : 'tag-amber';
  return `<span class="tag ${cls}" title="CLI：${escapeAttr(cliLabel(id))}">${escapeHtml(cliLabel(id))}</span>`;
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

  // 只读 CLI 会话仍可查看执行详情；只限制续接/回复，不改变卡片点击路径。
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
        ${cliTagHtml(t)}
        <span style="flex:1"></span>
        <button class="btn card-menu-btn" title="操作" onclick="event.stopPropagation();openCardMenu(event,'${escapeAttr(t.taskKey)}','${section}')">···</button>
      </div>
    </div>
  `;
}

// 卡片操作按钮（收进「···」浮层菜单）：edit/desc + 按 section 的操作。菜单在卡片外浮层，按钮不需 stopPropagation。
function cardActionButtons(t, section) {
  // 被旁观的 CLI 会话（watchlist 出卡，带 t.cli）：processing 不给「中断」（不干预外部进程）、归档区给「从看板移除」。
  // 物化后的 CLI 任务无 t.cli，与其它来源一致（可中断 provider 子进程、归档区只取消归档）。
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
    const rmBtn = isObservedCli
      ? `<button class="btn" style="color:var(--coralT)" onclick="removeCliSession('${escapeAttr(t.meta?.sessionId || '')}')" title="从看板 watchlist 移除（不影响 CLI session 本体）">✕ 移除</button>`
      : `<button class="btn" style="color:var(--coralT)" onclick="deleteTaskAction('${_k}', true)" title="永久删除该归档任务包（不可恢复）">✕ 删除</button>`;
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

function openAkMenu(event, keyId) {
  const menu = $('cardMenu');
  const k = akKeysCache.find((item) => item.id === keyId);
  if (!menu || !k) return;
  menu.innerHTML = `
    <button class="btn" data-ak-edit="${escapeAttr(k.id)}">编辑</button>
    <button class="btn" data-ak-toggle="${escapeAttr(k.id)}" data-ak-to="${k.disabled ? '0' : '1'}">${k.disabled ? '启用' : '禁用'}</button>
    <button class="btn btn-danger" data-ak-del="${escapeAttr(k.id)}" data-ak-name="${escapeAttr(`${k.prefix}…（${k.label}）`)}">删除</button>`;
  menu.style.display = 'flex';
  const r = event.currentTarget.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(6, r.right - mw) + 'px';
  menu.style.top = Math.max(6, r.bottom + 4 + mh > window.innerHeight - 6 ? r.top - mh - 4 : r.bottom + 4) + 'px';
  menu.onclick = () => closeCardMenu();
  cardMenuCloser = (e) => { if (!menu.contains(e.target)) closeCardMenu(); };
  setTimeout(() => { document.addEventListener('mousedown', cardMenuCloser, true); window.addEventListener('scroll', closeCardMenu, true); }, 0);
}
window.openAkMenu = openAkMenu;

// ================= 看板筛选（来源 / CLI / 工作目录 / 关键字 / sessionId）=================
// 视图层筛选：状态存 boardFilter，renderLifecycle 渲染前按 matchesBoardFilter 过滤各桶（计数随之显可见数）。
// 来源 / 工作目录用自定义下拉（不用原生 select，选项面板对齐新建任务 .cwd-menu 范式），选项从真实任务数据动态取；
// 关键字 / sessionId 走子串匹配。
let boardFilter = { source: '', provider: '', cwd: '', keyword: '', sessionId: '' };
let boardSources = [], boardProviders = [], boardCwds = []; // 真实任务里出现过的来源 / CLI / 工作目录全集
let srcDD = null, providerDD = null, cwdDD = null;          // 三个自定义下拉实例（initBoardFilter 里建）

function cwdOf(t) { return t.cwd || t.cli?.cwd || ''; }

function matchesBoardFilter(t) {
  const f = boardFilter;
  if (f.source && (t.source || '') !== f.source) return false;
  if (f.provider && String(t.provider || 'claude').toLowerCase() !== f.provider) return false;
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
const providerDropItems = () => [{ value: '', label: '全部' }, ...boardProviders.map((p) => ({ value: p, label: cliLabel(p) }))];
const cwdDropItems = () => [{ value: '', label: '全部' }, ...boardCwds.map((c) => ({ value: c, label: c.length > 44 ? '…' + c.slice(-42) : c, title: c }))];

// 依真实数据刷新筛选选项数据源（选中项若已不存在则回落全部）；菜单是打开时现取，不必重建 DOM
function updateBoardFilterOptions(lifecycle) {
  const all = allLifecycleTasks(lifecycle);
  boardSources = [...new Set(all.map((t) => t.source).filter(Boolean))].sort();
  boardProviders = [...new Set(all.map((t) => String(t.provider || 'claude').toLowerCase()))].sort();
  boardCwds = [...new Set(all.map(cwdOf).filter(Boolean))].sort();
  if (boardFilter.source && !boardSources.includes(boardFilter.source)) boardFilter.source = '';
  if (boardFilter.provider && !boardProviders.includes(boardFilter.provider)) boardFilter.provider = '';
  if (boardFilter.cwd && !boardCwds.includes(boardFilter.cwd)) boardFilter.cwd = '';
  syncBoardFilterUi();
}

// 把 boardFilter 反映到面板 UI（下拉标签 / 输入框 / 激活数徽章）
function syncBoardFilterUi() {
  srcDD?.syncLabel();
  providerDD?.syncLabel();
  cwdDD?.syncLabel();
  const kw = $('fpKeyword'); if (kw && kw.value !== boardFilter.keyword) kw.value = boardFilter.keyword;
  const sid = $('fpSessionId'); if (sid && sid.value !== boardFilter.sessionId) sid.value = boardFilter.sessionId;
  const n = ['source', 'provider', 'cwd', 'keyword', 'sessionId'].filter((k) => boardFilter[k]).length;
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
  renderArchive(lifecycle);
}

// ---- 筛选面板交互（按钮开合 / 来源·工作目录自定义下拉 / 输入 / 清除 / 点外关闭）----
(function initBoardFilter() {
  const btn = $('boardFilterBtn');
  const panel = $('boardFilterPanel');
  if (!btn || !panel) return;
  let outsideCloser = null;
  const close = () => {
    panel.classList.remove('open'); btn.classList.remove('on');
    srcDD?.close(); providerDD?.close(); cwdDD?.close(); // 收面板时一并收内部下拉
    if (outsideCloser) { document.removeEventListener('mousedown', outsideCloser, true); outsideCloser = null; }
  };
  const open = () => {
    panel.classList.add('open'); btn.classList.add('on');
    outsideCloser = (e) => { if (!panel.contains(e.target) && !btn.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('mousedown', outsideCloser, true), 0);
  };
  btn.addEventListener('click', () => (panel.classList.contains('open') ? close() : open()));
  // 来源 / CLI / 工作目录：自定义下拉（选项面板同款），选项按真实数据现取
  srcDD = makeFilterDropdown({
    btnId: 'fpSourceBtn', menuId: 'fpSourceMenu', items: sourceDropItems,
    getValue: () => boardFilter.source, onPick: (v) => { boardFilter.source = v; applyBoardFilter(); },
  });
  providerDD = makeFilterDropdown({
    btnId: 'fpProviderBtn', menuId: 'fpProviderMenu', items: providerDropItems,
    getValue: () => boardFilter.provider, onPick: (v) => { boardFilter.provider = v; applyBoardFilter(); },
  });
  cwdDD = makeFilterDropdown({
    btnId: 'fpCwdBtn', menuId: 'fpCwdMenu', items: cwdDropItems,
    getValue: () => boardFilter.cwd, onPick: (v) => { boardFilter.cwd = v; applyBoardFilter(); },
  });
  $('fpKeyword')?.addEventListener('input', (e) => { boardFilter.keyword = e.target.value.trim(); applyBoardFilter(); });
  $('fpSessionId')?.addEventListener('input', (e) => { boardFilter.sessionId = e.target.value.trim(); applyBoardFilter(); });
  $('fpClear')?.addEventListener('click', () => {
    boardFilter = { source: '', provider: '', cwd: '', keyword: '', sessionId: '' };
    applyBoardFilter();
  });
})();

// ---- 归档：按工作目录分目录；二级目录内可按 provider / 来源 / 关键字筛选 ----
let archiveFilter = { provider: '', source: '', keyword: '' };
let archiveFilterAbort = null;
let archiveRootQuery = '';
function archiveBucketOf(t) {
  // 归档目录的一级维度就是任务实际工作目录；CLI 观察态回落 cli.cwd，无目录的历史任务单独归类。
  return String(t.cwd || t.cli?.cwd || '未设置工作目录').trim() || '未设置工作目录';
}
function archiveRouteBucket() {
  const match = /^#\/archive\/([^/?#]+)/.exec(location.hash || '');
  return match ? decodeURIComponent(match[1]) : null;
}
function archiveTaskTime(t) {
  return t.archivedAt || t.history?.findLast?.((h) => h.state === 'archived')?.at || t.resolvedAt || t.createdAt || '';
}
function archiveTaskMatches(t) {
  if (archiveFilter.provider && String(t.provider || 'claude').toLowerCase() !== archiveFilter.provider) return false;
  if (archiveFilter.source && String(t.source || '') !== archiveFilter.source) return false;
  const q = archiveFilter.keyword.trim().toLowerCase();
  return !q || [t.title, t.description, t.taskKey, t.meta?.sessionId].filter(Boolean).join(' ').toLowerCase().includes(q);
}
function archiveRootTaskMatches(t) {
  const q = archiveRootQuery.trim().toLowerCase();
  return !q || [t.title, t.description, t.taskKey, t.meta?.sessionId, archiveBucketOf(t), t.source, t.provider]
    .filter(Boolean).join(' ').toLowerCase().includes(q);
}
function archiveRootTaskHtml(task) {
  const title = task.title || task.taskKey;
  const bucket = archiveBucketOf(task);
  const when = archiveTaskTime(task);
  return `<button class="archive-recent-task" title="${escapeAttr(title)}" onclick="openTaskModal('${escapeAttr(task.taskKey)}')">
    <span class="archive-recent-top"><span class="archive-recent-title">${escapeHtml(title)}</span>${cliTagHtml(task)}</span>
    <span class="archive-recent-meta"><span title="${escapeAttr(bucket)}">${escapeHtml(bucket)}</span><span>${escapeHtml(fmtTime(when) || '时间未知')}</span></span>
  </button>`;
}
function renderArchive(lifecycle) {
  const target = $('archiveContent');
  if (!target) return;
  const tasks = Array.isArray(lifecycle?.archived) ? lifecycle.archived.slice() : [];
  const bucket = archiveRouteBucket();
  if (!bucket) {
    if (archiveFilterAbort) { archiveFilterAbort.abort(); archiveFilterAbort = null; }
    const folders = new Map();
    for (const task of tasks) {
      const key = archiveBucketOf(task);
      const current = folders.get(key) || { key, tasks: [], count: 0, newest: '' };
      current.tasks.push(task);
      current.count++;
      if (String(archiveTaskTime(task)) > String(current.newest)) current.newest = archiveTaskTime(task);
      folders.set(key, current);
    }
    const rows = [...folders.values()].sort((a, b) => String(b.newest).localeCompare(String(a.newest)) || a.key.localeCompare(b.key));
    const shownTasks = tasks.filter(archiveRootTaskMatches).sort((a, b) => String(archiveTaskTime(b)).localeCompare(String(archiveTaskTime(a))));
    const shownFolders = rows.filter((folder) => folder.tasks.some(archiveRootTaskMatches));
    const newest = rows[0]?.newest || '';
    const rootBody = archiveRootQuery.trim()
      ? (shownTasks.length
        ? `<div class="archive-search-result-head"><span>搜索结果</span><span class="tag tag-mut">${shownTasks.length} 项</span></div><div class="archive-search-results">${shownTasks.map(archiveRootTaskHtml).join('')}</div>`
        : '<div class="archive-empty">没有匹配的归档任务</div>')
      : `<div class="archive-root-layout">
          <section class="archive-directory-panel"><div class="archive-section-head"><div><h3>工作目录</h3><p>按最近归档排序</p></div><span class="tag tag-mut">${rows.length} 个目录</span></div>
            <div class="archive-folders">${rows.map((folder) => {
              const providers = [...new Set(folder.tasks.map((task) => String(task.provider || 'claude').toLowerCase()))].map(cliLabel).join(' · ');
              return `<button class="archive-folder" title="${escapeAttr(folder.key)}" onclick="openArchiveFolder('${encodeURIComponent(folder.key)}')"><span class="archive-folder-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6.5h6l1.6 2H20v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z"/><path d="M4 10h16"/></svg></span><span class="archive-folder-main"><span class="archive-folder-name">${escapeHtml(folder.key)}</span><span class="archive-folder-meta">${folder.count} 个任务 · ${escapeHtml(providers)}</span><span class="archive-folder-time">最近归档 ${escapeHtml(fmtTime(folder.newest) || '—')}</span></span><span class="archive-folder-arrow">›</span></button>`;
            }).join('')}</div>
          </section>
          <aside class="archive-recent-panel"><div class="archive-section-head"><div><h3>近期归档</h3><p>最近完成并收纳的任务</p></div></div><div class="archive-recent-list">${tasks.slice().sort((a, b) => String(archiveTaskTime(b)).localeCompare(String(archiveTaskTime(a)))).slice(0, 6).map(archiveRootTaskHtml).join('')}</div></aside>
        </div>`;
    target.innerHTML = `
      <section class="archive-hero"><div><span class="archive-eyebrow">ARCHIVE</span><h2>任务归档</h2><p>历史任务按工作目录沉淀；可跨目录检索，进入目录后恢复或永久删除。</p></div><div class="archive-stats"><span><b>${tasks.length}</b>归档任务</span><span><b>${rows.length}</b>工作目录</span><span><b>${escapeHtml(fmtTime(newest) || '—')}</b>最近归档</span></div></section>
      ${rows.length ? `<div class="archive-root-search"><span class="archive-search-icon">⌕</span><input class="field-input" id="archiveRootSearch" value="${escapeAttr(archiveRootQuery)}" placeholder="搜索所有归档任务：标题、描述、任务 ID、会话或工作目录"><button class="btn" id="archiveRootSearchClear" ${archiveRootQuery ? '' : 'disabled'}>清除</button></div>${archiveRootQuery ? `<div class="archive-search-scope">${shownFolders.length} 个工作目录中匹配</div>` : ''}${rootBody}` : '<div class="archive-empty">暂无已归档任务</div>'}`;
    const rootSearch = $('archiveRootSearch');
    if (rootSearch) {
      let composing = false;
      // 一级页需要按关键字即时换结果，但 renderArchive 会替换 input 节点；重绘后显式恢复光标。
      // 组合输入期间不重绘，避免中文输入法的候选词被中断。
      const refreshRootSearch = (input) => {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        archiveRootQuery = input.value;
        renderArchive(stateData?.lifecycle);
        const next = $('archiveRootSearch');
        if (!next) return;
        next.focus();
        next.setSelectionRange(Math.min(start, next.value.length), Math.min(end, next.value.length));
      };
      rootSearch.addEventListener('compositionstart', () => { composing = true; });
      rootSearch.addEventListener('compositionend', () => { composing = false; });
      rootSearch.addEventListener('input', (event) => {
        if (composing || event.isComposing) return;
        refreshRootSearch(event.currentTarget);
      });
    }
    $('archiveRootSearchClear')?.addEventListener('click', () => { archiveRootQuery = ''; renderArchive(stateData?.lifecycle); });
    return;
  }
  const inFolder = tasks.filter((task) => archiveBucketOf(task) === bucket).sort((a, b) => String(archiveTaskTime(b)).localeCompare(String(archiveTaskTime(a))));
  const providers = [...new Set(inFolder.map((t) => String(t.provider || 'claude').toLowerCase()))].sort();
  const sources = [...new Set(inFolder.map((t) => String(t.source || '')).filter(Boolean))].sort();
  if (archiveFilter.provider && !providers.includes(archiveFilter.provider)) archiveFilter.provider = '';
  if (archiveFilter.source && !sources.includes(archiveFilter.source)) archiveFilter.source = '';
  const shown = inFolder.filter(archiveTaskMatches);
  target.innerHTML = `
    <div class="archive-list-head"><button class="btn archive-back" onclick="openArchiveRoot()">‹ 目录</button><span class="archive-list-title">${escapeHtml(bucket)}</span><span class="tag tag-mut">${shown.length}/${inFolder.length}</span></div>
    <div class="archive-filter-row">
      <div class="fp-dd" id="archiveProviderDD"><button type="button" class="fp-dd-btn" id="archiveProviderBtn"><span class="fp-dd-label${archiveFilter.provider ? '' : ' dim'}">${escapeHtml(archiveFilter.provider ? cliLabel(archiveFilter.provider) : '全部 CLI')}</span><span class="fp-dd-caret">▾</span></button><div class="fp-dd-menu" id="archiveProviderMenu" role="listbox"></div></div>
      <div class="fp-dd" id="archiveSourceDD"><button type="button" class="fp-dd-btn" id="archiveSourceBtn"><span class="fp-dd-label${archiveFilter.source ? '' : ' dim'}">${escapeHtml(archiveFilter.source ? sourceLabel(archiveFilter.source) : '全部来源')}</span><span class="fp-dd-caret">▾</span></button><div class="fp-dd-menu" id="archiveSourceMenu" role="listbox"></div></div>
      <input class="field-input archive-query" id="archiveKeywordFilter" value="${escapeAttr(archiveFilter.keyword)}" placeholder="搜索标题、taskKey、session ID">
      <button class="btn" id="archiveFilterClear">清除</button>
    </div>
    ${shown.length ? `<div class="archive-list">${shown.map((task) => taskCardHtml(task, 'archived')).join('')}</div>` : '<div class="archive-empty">该目录中没有匹配的归档任务</div>'}`;
  if (archiveFilterAbort) archiveFilterAbort.abort();
  archiveFilterAbort = new AbortController();
  bindArchiveFilterDropdown({
    btnId: 'archiveProviderBtn', menuId: 'archiveProviderMenu', current: archiveFilter.provider,
    items: [{ value: '', label: '全部 CLI' }, ...providers.map((p) => ({ value: p, label: cliLabel(p) }))],
    onPick: (value) => { archiveFilter.provider = value; renderArchive(stateData?.lifecycle); },
  });
  bindArchiveFilterDropdown({
    btnId: 'archiveSourceBtn', menuId: 'archiveSourceMenu', current: archiveFilter.source,
    items: [{ value: '', label: '全部来源' }, ...sources.map((s) => ({ value: s, label: sourceLabel(s) }))],
    onPick: (value) => { archiveFilter.source = value; renderArchive(stateData?.lifecycle); },
  });
  const archiveKeywordInput = $('archiveKeywordFilter');
  if (archiveKeywordInput) {
    let composing = false;
    const refreshArchiveKeyword = (input) => {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      archiveFilter.keyword = input.value;
      renderArchive(stateData?.lifecycle);
      const next = $('archiveKeywordFilter');
      if (!next) return;
      next.focus();
      next.setSelectionRange(Math.min(start, next.value.length), Math.min(end, next.value.length));
    };
    archiveKeywordInput.addEventListener('compositionstart', () => { composing = true; });
    archiveKeywordInput.addEventListener('compositionend', () => { composing = false; });
    archiveKeywordInput.addEventListener('input', (event) => {
      if (composing || event.isComposing) return;
      refreshArchiveKeyword(event.currentTarget);
    });
  }
  $('archiveFilterClear')?.addEventListener('click', () => { archiveFilter = { provider: '', source: '', keyword: '' }; renderArchive(stateData?.lifecycle); });
}
function bindArchiveFilterDropdown({ btnId, menuId, current, items, onPick }) {
  // 二级归档页每次筛选都会重绘；这一轮由 renderArchive 创建的 signal 统一清理 document 监听。
  const signal = archiveFilterAbort.signal;
  const btn = $(btnId), menu = $(menuId);
  if (!btn || !menu) return;
  const render = () => {
    menu.innerHTML = items.map((item) => `<div class="fp-dd-item${item.value === current ? ' active' : ''}" role="option" data-value="${escapeAttr(item.value)}"><span class="fp-dd-path">${escapeHtml(item.label)}</span><span class="fp-dd-check">✓</span></div>`).join('');
  };
  const close = () => { menu.classList.remove('open'); btn.classList.remove('open'); };
  btn.addEventListener('click', () => {
    const open = !menu.classList.contains('open');
    document.querySelectorAll('#archiveContent .fp-dd-menu.open').forEach((el) => el.classList.remove('open'));
    document.querySelectorAll('#archiveContent .fp-dd-btn.open').forEach((el) => el.classList.remove('open'));
    if (open) { render(); menu.classList.add('open'); btn.classList.add('open'); }
  }, { signal });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-value]');
    if (!item) return;
    close(); onPick(item.dataset.value);
  }, { signal });
  document.addEventListener('mousedown', (event) => { if (!btn.contains(event.target) && !menu.contains(event.target)) close(); }, { capture: true, signal });
}
window.openArchiveRoot = () => { location.hash = '#/archive'; };
// 目录名先 encode 再写入 inline handler，避免 Windows 路径反斜杠被 JavaScript 字符串吞掉。
window.openArchiveFolder = (encodedBucket) => { location.hash = '#/archive/' + encodedBucket; };

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

// 删除从未执行的 plan 草稿，或永久删除已归档的任务包（均不可恢复）。
async function deleteTaskAction(taskKey, archived = false) {
  const ok = await customConfirm({
    title: archived ? '永久删除归档任务' : '移除任务',
    message: archived
      ? `永久删除归档任务 <code>${escapeHtml(taskKey)}</code> 的本地任务包。<br>不会删除 Claude/Codex 原始 JSONL，但该任务将无法从本应用恢复。<br><b>不可恢复。</b>`
      : `删除计划任务 <code>${escapeHtml(taskKey)}</code>（从未执行的草稿）。<br><b>不可恢复。</b>`,
    confirmText: archived ? '永久删除' : '移除',
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
let lastReplyFp = null;             // 回复框模式指纹：只在决定 composer 形态的字段变了才重装（否则每 tick 重装会清空用户正在输入的文本 + 抢焦点）

// 卡片点击入口：从归档进入详情时记住原二级目录，面包屑“返回”保持在该目录而不是跳回看板。
window.openTaskModal = (taskKey) => {
  const origin = location.hash || '#/board';
  const storageKey = `scrumws-task-return:${taskKey}`;
  try {
    if (origin.startsWith('#/archive')) sessionStorage.setItem(storageKey, origin);
    else sessionStorage.removeItem(storageKey);
  } catch { /* sessionStorage 不可用时退回看板 */ }
  location.hash = '#/task/' + encodeURIComponent(taskKey);
};

async function loadTaskDetail(taskKey) {
  modalOpen = true;
  modalPollTaskKey = taskKey;
  acknowledgeTask(taskKey);             // 看过即清「状态变更」更新点
  // processing / awaiting / done 都只从 provider JSONL 还原完整执行记录。
  // 标题现在渲染在右侧「任务信息」块内（renderTaskSide），详情页顶部 header 已移除（req4）
  $('modalBody').innerHTML = '<div style="color:var(--dim);padding:12px 0">正在读取 Agent 会话记录…</div>';
  lastModalRevision = null;
  modalLastStatePollAt = Date.now();
  try {
    const r = await api(`/api/worker-log?taskKey=${encodeURIComponent(taskKey)}`);
    if (!r.ok) {
      $('modalBody').innerHTML = `<div style="color:var(--coral)">${r.error}</div>`;
      return;
    }
    currentModalData = r;
    lastModalRevision = r.revision || null;
    renderModalBody();
    renderTaskSide(taskKey);
    updateReplyBoxAvailability(taskKey);
    ensureModalLive(taskKey);
  } catch (e) {
    $('modalBody').innerHTML = `<div style="color:var(--coral)">${e.message}</div>`;
  }
}

// 关闭详情页轮询——离开详情 / 切任务时用
function closeModalLive() {
  if (modalPollTimer) { clearInterval(modalPollTimer); modalPollTimer = null; }
  modalPollBusy = false;
}

function startModalPoll(taskKey) {
  if (modalPollTimer) clearInterval(modalPollTimer);
  modalPollTimer = setInterval(() => pollTaskDetail(taskKey), MODAL_POLL_MS);
}

// 详情页刷新总控：只保留 JSONL revision 轮询；内容变化时再读取并解析完整记录。
function ensureModalLive(taskKey) {
  closeModalLive();
  startModalPoll(taskKey);
}

// 详情页常驻轮询：高频请求只读取 JSONL stat revision；文件变化后才取完整记录。
// /api/state 独立低频刷新，避免其 3s 缓存被 1.5s 详情轮询持续击穿。
async function pollTaskDetail(taskKey) {
  if (!modalOpen || modalPollTaskKey !== taskKey) { closeModalLive(); return; }
  if (modalPollBusy) return;
  modalPollBusy = true;
  try {
    const now = Date.now();
    const shouldRefreshState = now - modalLastStatePollAt >= MODAL_STATE_POLL_MS;
    const [revision, nextState] = await Promise.all([
      api(`/api/worker-log/revision?taskKey=${encodeURIComponent(taskKey)}`),
      shouldRefreshState ? api('/api/state') : Promise.resolve(null),
    ]);
    if (!modalOpen || modalPollTaskKey !== taskKey) return;
    let shouldRenderSide = false;
    if (nextState) {
      stateData = nextState;
      modalLastStatePollAt = now;
      shouldRenderSide = true;
    }
    if (revision?.ok && revision.revision !== lastModalRevision) {
      const record = await api(`/api/worker-log?taskKey=${encodeURIComponent(taskKey)}`);
      if (!modalOpen || modalPollTaskKey !== taskKey) return;
      if (record?.ok) {
        currentModalData = record;
        lastModalRevision = record.revision || revision.revision;
        renderModalBody(true);
        shouldRenderSide = true;
      }
    }
    if (shouldRenderSide) {
      renderTaskSide(taskKey);
      const nextReplyFp = replyBoxFp(findTaskInState(taskKey));
      if (nextReplyFp !== lastReplyFp) updateReplyBoxAvailability(taskKey);
    }
  } catch { /* 网络抖一下别把 modal 打坏，静默继续 */ }
  finally { modalPollBusy = false; }
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

// ---- hash 路由：#/board · #/archive · #/dashboard · #/apikeys · #/workdirs · #/settings · #/task/<taskKey>（旧 /<tab> 后缀兼容忽略）----
// 详情页已归一：#/session/<id>（历史链接）重定向到其归属任务的 #/task/<taskKey>。
const ROUTE_VIEWS = ['board', 'archive', 'runtime', 'dashboard', 'apikeys', 'workdirs', 'settings', 'task'];
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
  else if (h.startsWith('#/workdirs')) view = 'workdirs';
  else if (h.startsWith('#/settings')) view = 'settings';

  const fullBleed = view === 'task';   // 满宽满高布局（pageWrap 外）
  for (const v of ROUTE_VIEWS) { const el = $(`view-${v}`); if (el) el.style.display = v === view ? (v === 'task' ? 'flex' : '') : 'none'; }
  $('pageWrap').style.display = fullBleed ? 'none' : '';
  document.querySelectorAll('.topnav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === view || (fullBleed && a.dataset.nav === 'board'));
  });

  // 离开详情页：停止 JSONL 轮询并刷新看板。
  if (view !== 'task' && modalOpen) {
    modalOpen = false;
    modalPollTaskKey = null;
    closeModalLive();
    $('modalReplyBox').style.display = 'none';
    refreshState();
    scheduleStateRefresh();
  }
  if (view === 'task' && taskKey) loadTaskDetail(taskKey);
  if (view === 'archive') renderArchive(stateData?.lifecycle);
  if (view === 'settings') refreshCloudStatus();
  if (view === 'apikeys') refreshApiKeys();
  if (view === 'workdirs') refreshWorkDirectories();
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
    t?.state, t?.source, !!t?.meta?.sessionId,
    !!t?.lease?.alive, !!t?.isArchive, t?.externalSession?.pid || null, t?.externalSession?.status || null, t?.cli?.archivedAt || null,
  ]);
}

// 取任务当前实际 model/effort：以最近一轮 JSONL 解析结果为准。
function currentActualModelEffort(taskKey) {
  const t = findTaskInState(taskKey);
  const rounds = (currentModalData?.rounds || []).filter((x) => !x.error);
  const lastOk = rounds[rounds.length - 1] || null;
  return { provider: t?.provider || 'claude', model: lastOk?.ccSummary?.model || lastOk?.systemInit?.model || null, effort: lastOk?.systemInit?.effort || t?.effort || null };
}

// ---- 轻量继续对话区：空闲 session 可回复；执行中只读；无 session 才显示首次重发/确认。 ----
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
  // queued 场景 = 新建入队 / 中断后回排队；lease 存活 = worker 在起，不给重发。
  const canRestart = !hasSid && ['awaiting-human', 'queued'].includes(t?.state) && !t?.lease?.alive && !t?.isArchive;
  const canReply = hasSid && !processing && !t?.isArchive && !t?.externalSession;

  box.style.display = 'block';
  toast.style.display = 'none';
  toast.classList.remove('err', 'ok');
  // 重置 body 显隐（默认全隐、按下面模式再打开）
  replyBody.style.display = 'none';
  restartBody.style.display = 'none';
  // 徽章 class 归零（保留 .tag 基类）
  stateTag.className = 'tag tag-mut';
  stateTag.style.background = '';
  stateTag.style.color = '';
  stateTag.style.display = '';
  hint.style.display = '';
  // 状态头默认显示；可回复时仅保留轻量输入框。
  if (stateTag.parentElement) stateTag.parentElement.style.display = '';
  // 清旧事件监听（防止上次 modal 的旧 handler 残留）
  send.onclick = null;
  restartBtn.onclick = null;
  text.onkeydown = null;
  text.oninput = null;
  // 本地其它客户端显式持有同一 session 时不允许并发写入；避免两个运行时进程竞争同一对话。
  if (t?.externalSession) {
    stateTag.className = 'tag tag-amber';
    if (t.externalSession.status === 'checking') {
      stateTag.textContent = '正在检查会话占用';
      hint.innerHTML = '正在确认 Codex CLI / Desktop 是否持有此 session…';
    } else if (t.externalSession.status === 'desktop') {
      stateTag.textContent = '已在 Codex Desktop 打开';
      hint.innerHTML = '该 session 已由正在运行的 <b>Codex Desktop</b> 托管· 请直接在 Desktop 原窗口回复；退出 Desktop 后即可在看板继续对话。';
    } else {
      stateTag.textContent = '会话已在其他客户端打开';
      hint.innerHTML = `该 session 正由其他客户端使用（pid=<b>${t.externalSession.pid}</b>）· 请直接在原窗口回复，关闭后即可在看板继续对话。`;
    }
    return;
  }

  if (canReply) {
    // observed CLI 首次回复会在后端先物化，再走与其它来源相同的一次性 resume。
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
    hint.innerHTML = '本轮正在执行；这里只轮询展示 JSONL，收敛后可继续回复';
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
    await refreshState();
    if (modalOpen && modalPollTaskKey === taskKey) {
      renderTaskSide(taskKey);
      updateReplyBoxAvailability(taskKey);
      showReplyToast('已发出；执行记录会随 JSONL 轮询更新', 'ok');
    }
  } catch (e) {
    showReplyToast(e.message, 'err');
  } finally {
    send.disabled = false; text.disabled = false; send.classList.remove('busy');
  }
}

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
  const localFileUrlFromMarkdownHref = (href) => {
    const raw = String(href ?? '').trim();
    if (!raw || /^file:/i.test(raw)) return /^file:/i.test(raw) ? raw : null;
    if (/^[a-z]:[\\/]/i.test(raw)) {
      const path = raw.replace(/\\/g, '/');
      return `file:///${path.split('/').map(encodeURIComponent).join('/')}`;
    }
    // marked 会把 Markdown 链接中的反斜杠当转义符，UNC 路径有时只剩一个反斜杠。
    if (/^\\+[^\\/]+[\\/]/.test(raw)) {
      const path = raw.replace(/\\/g, '/').replace(/^\/+/, '');
      return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
    }
    if (raw.startsWith('/')) return `file://${raw.split('/').map(encodeURIComponent).join('/')}`;
    return null;
  };
  const safeMarkdownHref = (href) => {
    const normalized = localFileUrlFromMarkdownHref(href) || String(href ?? '').trim();
    try { return encodeURI(normalized).replace(/%25/g, '%'); } catch { return null; }
  };
  window.marked.use({ renderer: {
    html: (t) => escapeHtml(typeof t === 'string' ? t : (t?.text ?? '')),
    // 所有消息链接都新开请求，由 Electron 主进程决定打开网页、本地文件或拒绝未知协议。
    link: (href, title, text) => {
      const safeHref = safeMarkdownHref(href);
      if (!safeHref) return text;
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(safeHref)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
    },
  } });
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

// Codex has no equivalent local /usage command in this integration.  Its
// rollout token_count events do carry the account rate-limit snapshot, so show
// that read-only value and make the freshness explicit instead of claiming it
// is a live API result.
function codexAccountUsageBarsHtml(cu) {
  if (!cu || cu.error === 'pending') return '<div class="cc-usage-note">用量加载中…（首次扫描本机 session JSONL）</div>';
  if (!cu.ok || !cu.primary) return '<div class="cc-usage-note">最近 session 未记录可用的账号限额</div>';
  const hours = cu.primary.windowMinutes ? (cu.primary.windowMinutes >= 1440 ? `${Math.round(cu.primary.windowMinutes / 1440)} 天` : `${Math.round(cu.primary.windowMinutes / 60)} 小时`) : '主额度';
  const secondary = cu.secondary ? ccUsageBarHtml('次级额度', cu.secondary) : '';
  const observed = cu.observedAt ? new Date(cu.observedAt).toLocaleString('zh-CN', { hour12: false }) : '—';
  const plan = cu.planType ? ` · ${escapeHtml(cu.planType)}` : '';
  return `<div class="cc-usage">${ccUsageBarHtml(hours, cu.primary)}${secondary}<div class="cc-usage-note" style="margin-top:10px">最近记录 ${escapeHtml(observed)}${plan} · 只读 session 记录，非实时查询</div></div>`;
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
  // 仅执行差异按 t.cli（被旁观 CLI）分支——其 processing 不干预外部进程、归档区额外「从看板移除」。
  const btns = [];
  const _bk = escapeAttr(t.taskKey);
  if (t.isArchive) {
    btns.push(`<button class="btn" onclick="unarchiveTaskAction('${_bk}')">↺ 取消归档</button>`);
    if (isObservedCli) btns.push(`<button class="btn btn-danger" onclick="removeCliSession('${escapeAttr(t.meta?.sessionId || '')}')">从看板移除</button>`);
    else btns.push(`<button class="btn btn-danger" onclick="deleteTaskAction('${_bk}', true)">永久删除</button>`);
  } else if (t.state === 'plan') {
    btns.push(`<button class="btn" style="color:var(--jade);border-color:color-mix(in oklab, var(--success) 40%, transparent)" onclick="approveTaskAction('${_bk}')">▶ 确认排队</button>`);
    btns.push(`<button class="btn" onclick="archiveTask('${_bk}')">归档</button>`);
  } else if (['queued', 'processing'].includes(t.state)) {
    if (!isObservedCli) btns.push(`<button class="btn btn-danger" onclick="cancelTaskAction('${_bk}')">中断</button>`);
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
// 旧 session journal 的 stream-json 输出不带 isMeta envelope，只能按内容识别，否则会被错渲成用户气泡。
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
  return `
    <div class="msg-user">
      <div class="msg-user-bubble" title="${escapeAttr(fmtTime(m.at))}">${bubble || '<em style="color:var(--dim)">(empty)</em>'}</div>
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
function akCopyIcon(copied = false) {
  return copied
    ? '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
}
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
    <thead><tr><th>密钥</th><th>来源</th><th>限制</th><th>最近活跃</th><th>状态</th><th>备注</th><th></th></tr></thead>
    <tbody>${keys.map((k) => `
      <tr>
        <td class="mono" title="创建于 ${escapeAttr(k.createdAt || '—')}"><div class="ak-key-cell"><span>${escapeHtml(k.prefix)}…</span><button class="btn ak-key-copy" data-ak-copy="${escapeAttr(k.id)}" ${k.plaintext ? '' : 'disabled'} title="${k.plaintext ? '复制原密钥明文' : '旧版本密钥未留存原文'}" aria-label="${k.plaintext ? '复制原密钥明文' : '旧版本密钥未留存原文'}">${akCopyIcon()}</button></div></td>
        <td class="mono">${escapeHtml(k.source)}</td>
        <td class="ak-policy-cell" style="font-size:11.5px" title="${escapeAttr(akPolicyTitle(k))}">${akPolicyCell(k)}</td>
        <td class="mono">${akLivenessCell(k)}</td>
        <td>${k.disabled ? '<span class="tag tag-amber">已禁用</span>' : '<span class="tag tag-jade">启用</span>'}</td>
        <td style="min-width:110px">${escapeHtml(k.label)}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn card-menu-btn" title="操作" onclick="event.stopPropagation();openAkMenu(event,'${escapeAttr(k.id)}')">···</button>
        </td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

// 新增/编辑共用弹窗（akModal）：标题、确定键文案、提示按模式切换；关闭即退出编辑态
function akFillForm(k) {
  $('akLabelInput').value = k.label;
  $('akSourceInput').value = k.source;
  $('akProviderInput').value = k.provider || 'claude';
  renderAkProviderPolicy(k.provider || 'claude', akPolicyPairs(k));
  $('akAllowQueued').checked = !!k.allowQueued;
}
function akClearForm() {
  $('akLabelInput').value = '';
  $('akSourceInput').value = '';
  $('akAllowQueued').checked = false;
  $('akProviderInput').value = 'claude';
  renderAkProviderPolicy('claude');
}

function akPolicyPairs(k) {
  if (Array.isArray(k?.allowedModelEfforts) && k.allowedModelEfforts.length) return k.allowedModelEfforts;
  const models = Array.isArray(k?.allowedModels) ? k.allowedModels : [];
  const efforts = Array.isArray(k?.allowedEfforts) ? k.allowedEfforts : [];
  return models.flatMap((model) => efforts.map((effort) => ({ model, effort })));
}
function renderAkProviderPolicy(provider, pairs = []) {
  const def = providerDef(provider) || providerDef('claude');
  const defaults = pairs.length ? pairs : [{ model: def.defaultModel, effort: def.defaultEffort }];
  $('akPoliciesBox').innerHTML = defaults.map((pair, index) => `
    <div data-ak-policy-row style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px;border:1px solid var(--hair);border-radius:var(--r-md);background:var(--card)">
      <span style="font:11px var(--mono);color:var(--dim);min-width:18px">${index + 1}</span>
      <select id="akPolicyModel${index}" data-ak-policy-model style="display:none"></select>
      <select id="akPolicyEffort${index}" data-ak-policy-effort style="display:none"></select>
      <div class="mes-wrap" id="akPolicyMesWrap${index}">
        <button type="button" class="mes-btn form-size" id="akPolicyMesBtn${index}" aria-haspopup="true" aria-expanded="false" title="选择 model 与 effort 档位">
          <span class="mes-btn-model"></span><span class="mes-btn-effort"></span><span class="mes-btn-caret" aria-hidden="true">▾</span>
        </button>
        <div class="mes-menu" id="akPolicyMesMenu${index}" role="menu"></div>
      </div>
      <button type="button" class="btn btn-danger" data-ak-policy-remove ${defaults.length === 1 ? 'disabled title="至少保留一条组合"' : ''}>移除</button>
    </div>`).join('');
  defaults.forEach((pair, index) => {
    const control = initModelEffortSelector({
      wrapId: `akPolicyMesWrap${index}`, btnId: `akPolicyMesBtn${index}`, menuId: `akPolicyMesMenu${index}`,
      modelSelectId: `akPolicyModel${index}`, effortSelectId: `akPolicyEffort${index}`,
      inScroll: true, allowDefaultModel: true,
    });
    control?.setProvider(def.id, String(pair.model ?? ''), String(pair.effort ?? ''));
  });
}
function akSelectedCwds() {
  return [...document.querySelectorAll('#akCwdsBox input:checked')].map((input) => input.value);
}
function renderAkWorkDirectories(selectedCwds = []) {
  const box = $('akCwdsBox');
  const hint = $('akCwdsHint');
  if (!box || !hint) return;
  const selected = new Set(selectedCwds.map((cwd) => String(cwd).toLowerCase()));
  const configured = Array.isArray(workDirectories) ? workDirectories : [];
  const unavailable = selectedCwds.filter((cwd) => !configured.some((item) => String(item).toLowerCase() === String(cwd).toLowerCase()));
  box.innerHTML = configured.map((cwd) => `<label class="ak-cwd-choice"><input type="checkbox" value="${escapeAttr(cwd)}"${selected.has(String(cwd).toLowerCase()) ? ' checked' : ''}><span class="ak-cwd-choice-body"><span class="ak-cwd-check" aria-hidden="true">✓</span><code>${escapeHtml(cwd)}</code></span></label>`).join('');
  if (!configured.length) {
    hint.innerHTML = '暂无可选目录。请先到 <a href="#/workdirs">工作目录</a> 菜单添加目录。';
  } else if (unavailable.length) {
    hint.textContent = `当前密钥有 ${unavailable.length} 个目录未在“工作目录”菜单配置；保存前请先添加或取消该目录。`;
    hint.style.color = 'var(--coral)';
  } else {
    hint.textContent = '任务 cwd 可使用所选目录及其子目录。';
    hint.style.color = 'var(--dim)';
  }
}
async function refreshAkWorkDirectories(selectedCwds = []) {
  const hint = $('akCwdsHint');
  if (hint) hint.textContent = '加载工作目录…';
  try {
    const r = await api('/api/work-directories');
    if (!r?.ok) throw new Error(r?.error || '加载失败');
    workDirectories = Array.isArray(r.directories) ? r.directories : [];
    renderAkWorkDirectories(selectedCwds);
  } catch (e) {
    if (hint) { hint.textContent = `工作目录加载失败：${e.message}`; hint.style.color = 'var(--coral)'; }
  }
}
async function akOpenModal(k) {
  akEditingId = k ? k.id : null;
  $('akModalTitle').textContent = k ? '编辑密钥' : '生成密钥';
  $('akCreateBtn').textContent = k ? '保存修改' : '生成密钥';
  $('akModalHint').textContent = k
    ? `正在编辑 ${k.prefix}…（密钥本体与使用记录不变，只改配置）· 至少配置一条模型 + effort 组合和一个工作目录`
    : '至少配置一条模型 + effort 组合和一个工作目录 · 省略 model 与 effort 时使用第一条组合，cwd 使用第一项';
  $('akCreateErr').style.display = 'none';
  if (k) akFillForm(k); else akClearForm();
  $('akModal').style.display = 'flex';
  await refreshAkWorkDirectories(k?.allowedCwds || []);
  setTimeout(() => { $('akLabelInput').focus(); }, 40);
}
function akCloseModal() {
  $('akModal').style.display = 'none';
  akEditingId = null;
}

// 策略列：紧凑摘要（详情进 title tooltip）；缺任一项 = 旧格式无策略钥，建任务会被拒（策略必选=无权限）
function akPolicyCell(k) {
  const pairs = akPolicyPairs(k);
  if (!pairs.length || !k.allowedCwds?.length) {
    return '<span class="tag tag-amber" title="旧格式密钥缺策略，建任务会被拒；请删除后重新生成">未配置（无权限）</span>';
  }
  const parts = [];
  parts.push(escapeHtml(providerDef(k.provider || 'claude')?.label || k.provider || 'Claude Code'));
  parts.push(`组合 ${pairs.length} 条`);
  parts.push(`目录 ${k.allowedCwds.length} 个`);
  if (k.allowQueued) parts.push('<span style="color:var(--amber)">直执</span>');
  return `<span class="ak-policy-lines">${parts.map((part) => `<span>${part}</span>`).join('')}</span>`;
}
function akPolicyTitle(k) {
  const lines = [];
  lines.push(`Provider：${providerDef(k.provider || 'claude')?.label || k.provider || 'Claude Code'}`);
  lines.push(`允许组合：${akPolicyPairs(k).length ? akPolicyPairs(k).map((pair) => `${pair.model || 'CLI 默认'} + ${pair.effort || '默认 effort'}`).join('；') : '（缺）'}`);
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
  initProviderPicker({ valueId: 'akProviderInput', btnId: 'akProviderBtn', menuId: 'akProviderMenu', pickerId: 'akProviderPicker' });
  createBtn.addEventListener('click', async () => {
    const err = $('akCreateErr');
    err.style.display = 'none';
    const label = $('akLabelInput').value.trim();
    const source = $('akSourceInput').value.trim();
    const provider = $('akProviderInput').value || 'claude';
    const allowedModelEfforts = [...document.querySelectorAll('[data-ak-policy-row]')].map((row) => ({
      model: row.querySelector('[data-ak-policy-model]')?.value ?? '',
      effort: row.querySelector('[data-ak-policy-effort]')?.value ?? '',
    }));
    const allowedCwds = akSelectedCwds();
    const allowQueued = $('akAllowQueued').checked;
    // 组合与目录必选：前端先拦一道，后端仍强制校验。
    if (!allowedModelEfforts.length || allowedModelEfforts.some((pair) => !pair.effort) || !allowedCwds.length) {
      // .form-err 类默认 display:none，必须显式 block（置 '' 只是清掉内联样式、等于仍隐藏）
      err.textContent = '策略必选：至少添加一条模型 + effort 组合，并选择一个工作目录（全不选 = 没有权限）';
      err.style.display = 'block';
      return;
    }
    createBtn.disabled = true;
    try {
      const isEdit = !!akEditingId;
      const r = await api(isEdit ? '/api/apikeys/update' : '/api/apikeys/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: akEditingId || undefined, label, source, provider, allowedModelEfforts, allowedCwds, allowQueued }),
      });
      if (!r.ok) { err.textContent = r.error || (isEdit ? '保存失败' : '生成失败'); err.style.display = 'block'; return; }
      akCloseModal();
      if (!isEdit) renderApiKeyPlaintext(r);   // 编辑不产新明文
      await refreshApiKeys();
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
    finally { createBtn.disabled = false; }
  });
  $('akNewBtn').addEventListener('click', () => { akOpenModal(null); });
  $('akProviderInput').addEventListener('change', () => renderAkProviderPolicy($('akProviderInput').value));
  $('akAddPolicyBtn').addEventListener('click', () => {
    const pairs = [...document.querySelectorAll('[data-ak-policy-row]')].map((row) => ({
      model: row.querySelector('[data-ak-policy-model]')?.value ?? '',
      effort: row.querySelector('[data-ak-policy-effort]')?.value ?? '',
    }));
    const def = providerDef($('akProviderInput').value) || providerDef('claude');
    pairs.push({ model: def.defaultModel, effort: def.defaultEffort });
    renderAkProviderPolicy($('akProviderInput').value, pairs);
  });
  $('akPoliciesBox').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-ak-policy-remove]');
    if (!remove) return;
    const pairs = [...document.querySelectorAll('[data-ak-policy-row]')].map((row) => ({
      model: row.querySelector('[data-ak-policy-model]')?.value ?? '',
      effort: row.querySelector('[data-ak-policy-effort]')?.value ?? '',
    }));
    const row = remove.closest('[data-ak-policy-row]');
    const index = [...document.querySelectorAll('[data-ak-policy-row]')].indexOf(row);
    if (pairs.length <= 1 || index < 0) return;
    pairs.splice(index, 1);
    renderAkProviderPolicy($('akProviderInput').value, pairs);
  });
  $('akModalCancelBtn').addEventListener('click', akCloseModal);
  $('akModalX').addEventListener('click', akCloseModal);
  $('akModal').addEventListener('click', (e) => { if (e.target === $('akModal')) akCloseModal(); });
  // 列表与浮层菜单统一走事件委托：refreshApiKeys 整块重渲染，按钮不逐个绑
  document.addEventListener('click', async (e) => {
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
        copyBtn.innerHTML = akCopyIcon(true);
        copyBtn.classList.add('copied');
        copyBtn.title = '已复制';
        copyBtn.setAttribute('aria-label', '已复制');
        setTimeout(() => {
          if (!copyBtn.isConnected) return;
          copyBtn.innerHTML = akCopyIcon();
          copyBtn.classList.remove('copied');
          copyBtn.title = '复制原密钥明文';
          copyBtn.setAttribute('aria-label', '复制原密钥明文');
        }, 1500);
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

// ---- 工作目录页（#/workdirs）：新建任务下拉的独立目录集合 ----
// 目录集合只写 runner-config.workDirectories；已有任务的 cwd / worktree / taskKey 完全不碰。
let workDirectories = [];
async function refreshWorkDirectories() {
  const box = $('workDirListBox');
  if (!box) return;
  try {
    const r = await api('/api/work-directories');
    if (!r?.ok) throw new Error(r?.error || '加载失败');
    workDirectories = Array.isArray(r.directories) ? r.directories : [];
    renderWorkDirectories();
  } catch (e) {
    box.innerHTML = `<div style="color:var(--coral);font-size:12.5px">加载失败：${escapeHtml(e.message)}</div>`;
  }
}
function renderWorkDirectories() {
  const box = $('workDirListBox');
  if (!box) return;
  if (!workDirectories.length) {
    box.innerHTML = '<div style="color:var(--dim);font-size:12.5px">暂无工作目录。添加后会出现在新建任务的目录下拉中。</div>';
    return;
  }
  box.innerHTML = `<div class="ak-table-wrap"><table class="ak-table"><thead><tr><th>目录路径</th><th style="width:88px">操作</th></tr></thead><tbody>${workDirectories.map((cwd, index) => `
    <tr><td><code style="font-family:var(--mono);font-size:11.5px;word-break:break-all">${escapeHtml(cwd)}</code></td><td><button class="btn btn-danger" data-workdir-remove="${index}">移除</button></td></tr>`).join('')}</tbody></table></div>`;
}
async function saveWorkDirectories(next, hint) {
  let r = null;
  try {
    r = await api('/api/work-directories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directories: next }),
    });
  } catch (e) { r = { ok: false, error: e.message }; }
  if (!r?.ok) {
    if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = r?.error || '保存失败'; }
    return false;
  }
  workDirectories = Array.isArray(r.directories) ? r.directories : [];
  renderWorkDirectories();
  // 已打开的新建任务弹窗时同步可选项，不改它正在填写的 cwd。
  loadNewTaskCwds();
  if (hint) { hint.style.color = 'var(--jade)'; hint.textContent = '已保存'; }
  return true;
}
function initWorkDirectoriesPage() {
  const input = $('workDirInput');
  const addBtn = $('workDirAddBtn');
  const browseBtn = $('workDirBrowseBtn');
  const list = $('workDirListBox');
  const hint = $('workDirHint');
  if (!input || !addBtn || !browseBtn || !list || !hint) return;
  const add = async () => {
    const cwd = input.value.trim();
    if (!cwd) { hint.style.color = 'var(--coral)'; hint.textContent = '请输入目录绝对路径，或点击“浏览”选择'; return; }
    addBtn.disabled = true;
    const saved = await saveWorkDirectories([...workDirectories, cwd], hint);
    if (saved) { input.value = ''; hint.textContent = '已添加（若选择的是 worktree，已保存其仓库根目录）'; }
    addBtn.disabled = false;
  };
  addBtn.addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  browseBtn.addEventListener('click', async () => {
    browseBtn.disabled = true;
    try {
      const r = await api('/api/pick-dir', { method: 'POST' });
      if (r.ok && r.dir) { input.value = r.dir; hint.style.color = 'var(--dim)'; hint.textContent = '已选择目录，点击“添加”保存'; }
      else if (!r.ok) { hint.style.color = 'var(--coral)'; hint.textContent = r.error || '目录选择失败'; }
    } catch (e) { hint.style.color = 'var(--coral)'; hint.textContent = e.message; }
    finally { browseBtn.disabled = false; }
  });
  list.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-workdir-remove]');
    if (!button) return;
    const index = Number(button.dataset.workdirRemove);
    if (!Number.isInteger(index) || !workDirectories[index]) return;
    button.disabled = true;
    const saved = await saveWorkDirectories(workDirectories.filter((_, i) => i !== index), hint);
    if (saved) hint.textContent = '已移除；已有任务保持不变';
    if (!saved) button.disabled = false;
  });
}
initWorkDirectoriesPage();

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
  loadNewTaskCwds();                       // 填充「工作目录」菜单维护的目录下拉
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

// 工作目录自定义下拉（不用原生 datalist）：只读「工作目录」菜单维护的列表。
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
    ? list.map((c) => `<div class="cwd-item" role="option" data-cwd="${escapeAttr(c.cwd)}"><span class="cwd-path" title="${escapeAttr(c.cwd)}">${escapeHtml(c.cwd)}</span><span class="cwd-src">已管理</span></div>`).join('')
    : `<div class="cwd-empty">${newTaskCwdOptions.length ? '无匹配目录' : '暂无工作目录 · 可直接填路径，或先到“工作目录”菜单添加'}</div>`;
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
    // queued → 已自动起 provider 会话执行：跳任务详情，后续由 JSONL 轮询展示。
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

// CLI 观察卡取消归档 / 取消完成：后端按来源分派；首次回复时会自动物化并 resume。
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
  { value: 'gpt-5.6-sol', name: 'gpt-5.6-sol', desc: 'Latest frontier agentic coding model.' },
  { value: 'gpt-5.6-terra', name: 'gpt-5.6-terra', desc: 'Balanced agentic coding model for everyday work.' },
  { value: 'gpt-5.6-luna', name: 'gpt-5.6-luna', desc: 'Fast and affordable agentic coding model.' },
  { value: 'gpt-5.5', name: 'gpt-5.5', desc: 'Frontier model for complex coding, research, and real-world work.' },
  { value: 'gpt-5.3-codex-spark', name: 'gpt-5.3-codex-spark', desc: 'Ultra-fast coding model.' },
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
  // Codex 新建任务只展示当前官方模型目录，避免“CLI 默认 / 自定义模型”混在受支持模型中。
  if (def?.allowCustomModel && def?.id !== 'codex') {
    items.unshift({ value: '', name: 'CLI 默认模型', desc: '使用本机 Codex 配置的默认模型' });
    items.push({ value: '__custom__', name: '自定义模型…', desc: '输入 Codex CLI 支持的模型 ID' });
  }
  return items.length ? items : [{ value: '', name: 'CLI 默认模型', desc: '' }];
}

function initProviderPicker({ valueId, btnId, menuId, pickerId, onChange = null }) {
  const value = $(valueId);
  const btn = $(btnId);
  const menu = $(menuId);
  const picker = $(pickerId);
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
    onChange?.(next.id);
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
let newTaskProviderCtl = null;
function initNewTaskProviderPicker() {
  return initProviderPicker({
    valueId: 'newTaskProvider', btnId: 'newTaskProviderBtn', menuId: 'newTaskProviderMenu', pickerId: 'newTaskProviderPicker',
    onChange: (provider) => {
      newTaskMesCtl?.setProvider(provider);
      syncNewTaskProviderCapabilities();
    },
  });
}
function providerEfforts(def) {
  const codex = {
    low: { name: 'Low', desc: 'Fast responses with lighter reasoning' },
    medium: { name: 'Medium', desc: 'Balances speed and reasoning depth for everyday tasks' },
    high: { name: 'High', desc: 'Greater reasoning depth for complex problems' },
    xhigh: { name: 'Extra high', desc: 'Extra high reasoning depth for complex problems' },
    max: { name: 'Max', desc: 'Maximum reasoning · consumes usage limits faster', more: true },
    ultra: { name: 'Ultra', desc: 'Ultra reasoning · consumes usage limits faster', more: true },
  };
  return (Array.isArray(def?.efforts) ? def.efforts : []).map((value) => ({
    value,
    ...(def?.id === 'codex' ? (codex[value] || { name: value }) : { name: value === 'xhigh' ? 'xHigh' : value.charAt(0).toUpperCase() + value.slice(1) }),
    isDefault: value === def?.defaultEffort,
    info: def?.id !== 'codex' && (value === 'max' || value === 'ultra') ? '最深推理 · 最慢、最耗额度' : '',
  }));
}

// 单实例初始化：modelSelectId / effortSelectId 是隐藏 select（value 载体，后端读它）。
// 回复条装配时按任务实际 model/effort 播种（见 __seedReplyModel）；新建表单播种默认值。
// inScroll=true：宿主在 overflow:auto 容器内（新建任务表单）——主菜单改 fixed 定位挂 viewport，按上下空间自动选方向。
function initModelEffortSelector({ wrapId, btnId, menuId, modelSelectId, effortSelectId, providerSelectId = null, inScroll = false, allowDefaultModel = false }) {
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
  let subEffort, subMoreReasoning, subModels, slotModelName, slotModelDesc, slotEffortVal;

  function rebuildMenu() {
    const directEfforts = efforts.filter((e) => !e.more);
    const deeperEfforts = efforts.filter((e) => e.more);
    const effortItems = directEfforts.map((e) => `
      <button type="button" class="mes-item" data-eff="${escapeAttr(e.value)}" role="menuitemradio">
        <span class="mes-item-lead"><span class="mes-item-copy"><span class="mes-item-name">${escapeHtml(e.name)}</span>${e.desc ? `<span class="mes-item-desc">${escapeHtml(e.desc)}</span>` : ''}</span>${e.isDefault ? '<span class="mes-item-default">默认</span>' : ''}${e.info ? `<span class="mes-item-info" title="${escapeAttr(e.info)}">ⓘ</span>` : ''}</span>
        <span class="mes-item-check" aria-hidden="true">✓</span>
      </button>`).join('');
    const moreEffortItems = deeperEfforts.map((e) => `
      <button type="button" class="mes-item" data-eff="${escapeAttr(e.value)}" role="menuitemradio">
        <span class="mes-item-lead"><span class="mes-item-copy"><span class="mes-item-name">${escapeHtml(e.name)}</span>${e.desc ? `<span class="mes-item-desc">${escapeHtml(e.desc)}</span>` : ''}</span></span>
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
      <div class="mes-sub" data-sub="effort"><div class="mes-sub-head">${escapeHtml(def?.id === 'codex' ? '推理更充分会更慢；选择 More reasoning 可用 Max / Ultra。' : EFFORT_HEAD)}</div>${effortItems}${deeperEfforts.length ? `<button type="button" class="mes-item mes-item-more" data-nav="more-reasoning"><span class="mes-item-lead"><span class="mes-item-copy"><span class="mes-item-name">More reasoning…</span><span class="mes-item-desc">Max and Ultra consume usage limits faster</span></span></span><span class="mes-row-arrow">›</span></button>` : ''}</div>
      <div class="mes-sub" data-sub="more-reasoning"><div class="mes-sub-head">More reasoning</div>${moreEffortItems}</div>
      <div class="mes-sub" data-sub="models">${modelItems}</div>`;
    subEffort = menu.querySelector('.mes-sub[data-sub="effort"]');
    subMoreReasoning = menu.querySelector('.mes-sub[data-sub="more-reasoning"]');
    subModels = menu.querySelector('.mes-sub[data-sub="models"]');
    slotModelName = menu.querySelector('[data-slot="model-name"]');
    slotModelDesc = menu.querySelector('[data-slot="model-desc"]');
    slotEffortVal = menu.querySelector('[data-slot="effort-val"]');
  }

  const curModel = () => models.find((m) => m.value === modelSel.value && m.value !== '__custom__')
    || (!modelSel.value && allowDefaultModel && Array.from(modelSel.options).some((option) => option.value === '') ? { value: '', name: 'CLI 默认模型', desc: '' } : null)
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
    subMoreReasoning?.querySelectorAll('.mes-item').forEach((it) => it.classList.toggle('active', it.dataset.eff === effortSel.value));
  }
  // 容忍不在下拉里的真实 model id（带版本/未知）：先补一个 <option>，否则原生 select 会把未知 value 吞成 ''
  const setModel = (v) => {
    if (!Array.from(modelSel.options).some((o) => o.value === v) && (v || allowDefaultModel)) modelSel.add(new Option(v || 'CLI 默认模型', v));
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
    subMoreReasoning?.classList.toggle('open', which === 'more-reasoning');
    const sub = which === 'effort' ? subEffort : which === 'models' ? subModels : subMoreReasoning;
    if (!sub) return;
    sub.classList.remove('flip');
    requestAnimationFrame(() => { if (sub.getBoundingClientRect().right > window.innerWidth - 8) sub.classList.add('flip'); });
  };
  const hideSub = () => { openSub = null; subEffort.classList.remove('open'); subModels.classList.remove('open'); subMoreReasoning?.classList.remove('open'); };

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
