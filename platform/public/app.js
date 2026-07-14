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

// ---- 平台守护卡（设置页 Runner Checker）----
// 卡片 HTML（去派发器后仅 Runner Checker 用）：项目固有调度常开不可停，节拍以分钟为单位可编辑
function liveJobCardHtml(t, { title, mono, hint }) {
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
    <div style="border:1px solid var(--hair);border-radius:11px;padding:14px 16px;background:var(--card2)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        ${title}
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
    </div>
  `;
}

// 设置页：平台守护卡（Runner Checker —— 平台内置 Node job，去派发器后调度器唯一的 job）
function renderChecker(checker) {
  const grid = $('checkerGrid');
  if (!grid || !checker) return;
  // 用户正在编辑节拍输入时不重画，避免轮询覆盖输入（同 syncProxyInput 的护栏）
  if (grid.querySelector('input[data-checker-interval]') === document.activeElement) return;
  grid.innerHTML = liveJobCardHtml(checker, {
    title: `<div style="font-weight:600;font-size:13px;color:var(--ink2)">${escapeHtml(checker.label)}</div>`,
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


// ---- 面板：运行时（本机 Claude Code 执行环境 + 用量汇总；参考 multica Runtime Panel）----
// 每次 /api/state 轮询都渲染（即使不在该视图，更新隐藏 DOM），进入 #/runtime 时即为最新。
function renderRuntime(rt) {
  const card = $('runtimeCard');
  const grid = $('usageGrid');
  if (!card || !grid) return;
  if (!rt) { card.innerHTML = '<div style="color:var(--dim);font-size:12.5px">运行时数据不可用</div>'; grid.innerHTML = ''; return; }
  // 大数压缩：token 计数动辄百万，stat tile 用 K/M/B 更易读
  const compact = (n) => {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  };
  // ---- 运行时卡片 ----
  const online = rt.online;
  const statusCls = online == null ? 'detecting' : online ? 'on' : 'off';
  const statusTxt = online == null ? '检测中…' : online ? '在线' : '离线';
  const dotCls = online == null ? 'rt-detecting' : online ? 'rt-on' : 'rt-off';
  const s = rt.sessions || {};
  const plat = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[rt.platform] || rt.platform || '—';
  const kv = (k, v, title) => `<div class="rt-kv"><span class="k">${k}</span><span class="v"${title ? ` title="${escapeAttr(title)}"` : ''}>${v}</span></div>`;
  const dim = (t) => `<span style="color:var(--dim)">${t}</span>`;
  card.innerHTML = `
    <div class="rt-panel">
      <div class="rt-badge"><svg viewBox="0 0 24 24"><rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg></div>
      <div class="rt-info">
        <div class="rt-name">${escapeHtml(rt.tool || 'Claude Code')}<span class="rt-status ${statusCls}"><span class="rt-dot ${dotCls}"></span>${statusTxt}</span></div>
        <div class="rt-kvs">
          ${kv('主机', escapeHtml(rt.host || '—'))}
          ${kv('平台', escapeHtml(plat))}
          ${kv('版本', rt.version ? escapeHtml(rt.version) : dim('未知'))}
          ${kv('路径', rt.binPath ? escapeHtml(rt.binPath) : dim('—'), rt.binPath || '')}
        </div>
      </div>
      <div class="rt-sessions">
        <div class="rt-sess-num">${s.total ?? 0}</div>
        <div class="rt-sess-label">活跃会话</div>
        <div class="rt-sess-sub">板内 ${s.board ?? 0} · 终端 ${s.cli ?? 0}</div>
      </div>
    </div>`;
  // ---- 用量 stat tiles ----
  const u = rt.usage || {};
  const tiles = [
    { label: '总成本', val: '$' + (u.totalCostUsd || 0).toFixed(4), color: 'var(--brand)' },
    { label: '输入 tokens', val: compact(u.inputTokens || 0), color: 'var(--info)' },
    { label: '输出 tokens', val: compact(u.outputTokens || 0), color: 'var(--success)' },
    { label: '缓存读命中', val: compact(u.cacheReadTokens || 0), color: 'var(--warning)' },
  ];
  const sub = `覆盖 ${u.tasksWithUsage || 0} 个已执行任务 · 累计 ${u.rounds || 0} 轮 · ${u.numTurns || 0} turns`
    + (u.cliCount ? ` · ${u.cliCount} 个 CLI 会话无 token 计量` : '');
  grid.innerHTML =
    `<div class="stat-grid">${tiles.map((t) => `<div class="stat-tile"><div class="stat-val">${t.val}</div><div class="stat-label">${escapeHtml(t.label)}</div><div class="stat-accent" style="background:${t.color}"></div></div>`).join('')}</div>`
    + `<div class="stat-sub">${escapeHtml(sub)}</div>`;
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

// 来源标签（卡片左下角 + 详情页「任务信息」状态标签前，同一套）：chat 链走 dws（钉钉工具链），
// 会话细分（self/group/dm）看底部 taskKey 短码；issue / cli 独立，其余显 source 名。
function sourceTagHtml(t) {
  return t.source === 'chat'
    ? '<span class="tag tag-cyan">dws</span>'
    : t.source === 'issue'
      ? '<span class="tag tag-amber">issue</span>'
      : t.source === 'cli'
        ? '<span class="tag" style="background:var(--brandS);color:var(--brand)">CLI</span>'
        : '<span class="tag tag-mut">' + (t.source || '?') + '</span>';
}

function taskCardHtml(t, section) {
  const cost = t.meta?.totalCostUsd ? '$' + t.meta.totalCostUsd.toFixed(4) : '';
  const rounds = t.meta?.rounds ? `${t.meta.rounds} 轮` : '';
  const totalDur = fmtDuration(t.durationMs);
  // 统一后台维度徽章（runner/cli 同源 t.backgroundAgentCount）：主进程让出后仍在跑的后台 agent 数
  const bgBadge = t.backgroundAgentCount > 0 ? ` · <span style="color:var(--amber)">后台×${t.backgroundAgentCount}</span>` : '';

  // 卡片副信息统一为「主状态行 + 副行」结构，所有来源（分身 / CLI）在同一分桶显示一致，字段缺失优雅降级。
  // 工作目录跨来源统一取（CLI 在 t.cli.cwd，分身在 t.cwd）→ 作为所有卡片一致的副行。
  const cwdVal = t.cwd || t.cli?.cwd || null;
  const cwdShort = cwdVal ? (cwdVal.length > 40 ? '…' + cwdVal.slice(-38) : cwdVal) : '';
  const cwdLine = cwdVal ? `<div class="card-sub" title="${escapeAttr(cwdVal)}">${escapeHtml(cwdShort)}</div>` : '';

  let mainLine = '', mainCls = 'card-status', extra = cwdLine;
  if (section === 'plan') {
    mainLine = `待确认 · 建于 ${escapeHtml(t.createdAt || t.enteredAt || '—')}`;
  } else if (section === 'queued') {
    const age = t.queuedAgeMin;
    if (age != null && age > 2) mainCls = 'card-status warn';
    mainLine = `排队 ${age ?? '?'}min · 总耗时 ${totalDur}`;
  } else if (section === 'processing') {
    const durMin = t.lease?.durationMin ?? '?';
    mainLine = `运行 ${durMin}min · 心跳 ${t.lease?.heartbeatAgo || '—'} · 总耗时 ${totalDur}${bgBadge}`;
    // AI 意图（仅分身有）优先占副行，工作目录跟其后
    if (t.lease?.intent) extra = `<div class="card-sub" style="color:var(--ink2);white-space:normal">${escapeHtml(t.lease.intent)}</div>${cwdLine}`;
  } else if (section === 'done') {
    mainLine = `${t.resolvedAgo || '—'} · 耗时 ${totalDur}${rounds ? ' · ' + rounds : ''}${cost ? ' · ' + cost : ''}`;
  } else if (section === 'awaiting-human') {
    // 失败/中断（带 failureReason/outcome）→ 红字原因占副行；否则副行显工作目录
    mainLine = `${t.resolvedAgo || '待处理'} · 耗时 ${totalDur}`;
    const failReason = t.outcomeDetail?.failureReason || t.outcome;
    if (failReason) {
      const short = failReason.length > 60 ? failReason.slice(0, 60) + '…' : failReason;
      extra = `<div class="card-sub" style="color:var(--coral)" title="${escapeAttr(failReason)}">${escapeHtml(short)}</div>`;
    }
  } else {   // archived 及其他终态
    mainLine = `${t.resolvedAgo || '—'} · 耗时 ${totalDur}`;
  }
  const statusLine = `<div class="${mainCls}">${mainLine}</div>${extra}`;

  const sourceTag = sourceTagHtml(t);
  const isPlan = section === 'plan';

  // 任务描述（用户备注）：有则显示一行截断，点击直接编辑（plan 态点击进整任务编辑，与「✎ 编辑」按钮一致）
  const descLine = t.description
    ? `<div style="font-size:11px;color:var(--ink2);margin-top:6px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" title="点击编辑${isPlan ? '任务' : '描述'}：${escapeAttr(t.description)}" onclick="event.stopPropagation();${isPlan ? 'openEditTask' : 'editTaskDesc'}('${escapeAttr(t.taskKey)}')"><span style="color:var(--dim)">✎</span> ${escapeHtml(t.description)}</div>`
    : '';

  // 标题：优先 customTitle > 第一条真人 cc: > taskKey
  const titleText = t.title || t.taskKey;
  const titleShort = titleText.length > 60 ? titleText.slice(0, 60) + '…' : titleText;
  // 状态变更标记：本轮判定「有更新」的任务，标题前显一个更新点（点开卡片/编辑即清）
  const updateDot = updatedTaskKeys.has(t.taskKey) ? '<span class="update-dot" title="任务状态有更新"></span>' : '';

  // 卡片点击：plan 态弹编辑弹窗（任务未开始，不进详情页）；其余进详情页
  const cardClick = isPlan
    ? `openEditTask('${escapeAttr(t.taskKey)}')`
    : `openTaskModal('${escapeAttr(t.taskKey)}')`;

  return `
    <div class="taskcard" data-taskkey="${escapeAttr(t.taskKey)}" data-source="${escapeAttr(t.source || '')}" onclick="${cardClick}">
      <div style="font-weight:600;font-size:13px;color:var(--ink);line-height:1.45;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all" title="${escapeAttr(titleText)}">${updateDot}${escapeHtml(titleShort)}</div>
      ${statusLine}
      ${descLine}
      <div class="card-foot">
        ${sourceTag}
        <span style="flex:1"></span>
        <button class="btn card-menu-btn" title="操作" onclick="event.stopPropagation();openCardMenu(event,'${escapeAttr(t.taskKey)}','${section}')">···</button>
      </div>
    </div>
  `;
}

// 卡片操作按钮（收进「···」浮层菜单）：edit/desc + 按 section 的操作。菜单在卡片外浮层，按钮不需 stopPropagation。
function cardActionButtons(t, section) {
  const isCli = t.source === 'cli';
  const isPlan = section === 'plan';
  const _k = escapeAttr(t.taskKey);
  const descBtn = `<button class="btn" onclick="editTaskDesc('${_k}')" title="自己看的备注，不发给 claude">✎ 描述</button>`;
  const editBtn = `<button class="btn" onclick="openEditTask('${_k}')" title="编辑任务（标题 / prompt / 模型 / 工作目录 / 描述）">✎ 编辑</button>`;
  const removeBtn = `<button class="btn" style="color:var(--coralT)" onclick="deleteTaskAction('${_k}')" title="删除该计划任务（不可恢复）">✕ 移除</button>`;
  const archiveBtn = `<button class="btn" onclick="archiveTask('${_k}')" title="收进已归档区">▾ 归档</button>`;
  const unarchiveBtn = `<button class="btn" onclick="unarchiveTaskAction('${_k}')" title="取消归档，回落自动判态">↺ 取消归档</button>`;
  const completeBtn = `<button class="btn" style="color:var(--jade)" onclick="completeTaskAction('${_k}')" title="人工确认已完成 → 移入 done">✓ 完成</button>`;
  const uncompleteBtn = `<button class="btn" style="color:var(--mut)" onclick="uncompleteTaskAction('${_k}')" title="取消完成，退回 awaiting-human">↺ 取消完成</button>`;

  const lead = isPlan ? editBtn : descBtn;
  let actionBtn = '';
  if (section === 'plan') {
    actionBtn = `<button class="btn" style="color:var(--jade)" onclick="approveTaskAction('${_k}')">▶ 排队</button>${removeBtn}`;
  } else if (section === 'processing') {
    actionBtn = isCli ? '' : `<button class="btn" style="color:var(--coralT)" onclick="cancelTaskAction('${_k}')">■ 中断</button>`;
  } else if (section === 'queued') {
    actionBtn = `<button class="btn" style="color:var(--coralT)" onclick="cancelTaskAction('${_k}')">■ 中断</button>`;
  } else if (section === 'awaiting-human') {
    actionBtn = completeBtn + archiveBtn;
  } else if (section === 'done') {
    actionBtn = uncompleteBtn + archiveBtn;
  } else if (section === 'archived') {
    const rmBtn = isCli ? `<button class="btn" style="color:var(--coralT)" onclick="removeCliSession('${escapeAttr(t.meta?.sessionId || '')}')" title="从看板 watchlist 移除（不影响 CLI session 本体）">✕ 移除</button>` : '';
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

function renderLifecycle(lifecycle) {
  closeCardMenu();                                       // 重绘前收起可能残留的「···」浮层菜单
  updatedTaskKeys = reconcileSeenSections(lifecycle);   // 状态变更标记：先补基线、算出本轮「有更新」的任务
  const map = {
    'plan': lifecycle.plan,
    'queued': lifecycle.queued,
    'processing': lifecycle.processing,
    'awaiting-human': lifecycle.awaitingHuman,
    'done': lifecycle.done,
  };
  for (const [name, tasks] of Object.entries(map)) {
    $(`count-${name}`).textContent = tasks.length;
    const list = $(`list-${name}`);
    if (tasks.length === 0) {
      list.innerHTML = `<div style="color:var(--dim);font-size:12px;padding:6px 0">空</div>`;
    } else {
      list.innerHTML = tasks.map((t) => taskCardHtml(t, name)).join('');
    }
  }
  $('count-archived').textContent = lifecycle.archived.length;
  const arch = $('list-archived');
  if (lifecycle.archived.length === 0) {
    arch.innerHTML = `<div style="color:var(--dim);font-size:12px;padding:6px 0">空</div>`;
  } else {
    arch.innerHTML = lifecycle.archived.map((t) => taskCardHtml(t, 'archived')).join('');
  }
}

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
    bodyEl.innerHTML = message || '';
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
    $('confirmBody').innerHTML = message || '';
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
      ${message ? `<div style="margin-bottom:10px;line-height:1.6">${message}</div>` : ''}
      <textarea id="confirmPromptInput" class="prompt-input" rows="2" maxlength="${maxlength}" placeholder="${escapeAttr(placeholder)}">${escapeHtml(initial)}</textarea>
      <div style="display:flex;align-items:center;margin-top:7px;font-size:10.5px;color:var(--dim);font-family:var(--mono)">
        <span>Ctrl+Enter 保存 · Esc 取消</span>
        <span id="promptCount" style="margin-left:auto;font-variant-numeric:tabular-nums"></span>
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
    message: '<span style="color:var(--mut);font-size:11px">自己看的备注 · 不会发给 claude · 清空保存 = 删除</span>',
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
  $('modalBody').innerHTML = '<div style="color:var(--dim);padding:12px 0">正在拼 CC jsonl…</div>';
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
    // CLI 会话无 task.json，走 watchlist 改名接口；分身走 task.json 接口。两端均收 body {title}
    // 统一走 /api/task/rename，后端 renameTask 按来源分派（分身写 task.json / CLI 写 watchlist）——前端不选端点
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
const ROUTE_VIEWS = ['board', 'archive', 'runtime', 'dashboard', 'settings', 'task'];
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
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);

// 决定 composer 形态的字段集指纹：常驻轮询据此判定"要不要重装回复框"——只有这些变了才重装，
// 否则每 tick 重装会清空用户正在输入的文本 + 抢焦点（CLI 空闲 / 可对话分支会 text.value='' + focus）。
function replyBoxFp(t) {
  return JSON.stringify([
    t?.state, t?.mbSessionId || null, t?.source, !!t?.meta?.sessionId,
    !!t?.lease?.alive, !!t?.isArchive, t?.cli?.attachedPid || null, t?.cli?.archivedAt || null,
  ]);
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
  lastReplyFp = replyBoxFp(t);   // 每次装配都刷新基线，常驻轮询据此判定后续是否需要重装
  const hasSid = !!(t?.meta?.sessionId);
  const processing = t?.state === 'processing';
  const isCli = t?.source === 'cli';
  // queued 场景 = 新建入队 / 中断后回排队；由用户从看板拉起（重新发起）；lease 存活 = worker 在起，不给重发
  const canRestart = !hasSid && ['awaiting-human', 'queued'].includes(t?.state) && !t?.lease?.alive && !t?.isArchive;
  const canReply = hasSid && !processing && !isCli;

  box.style.display = 'block';
  toast.style.display = 'none';
  toast.classList.remove('err', 'ok');
  // 重置 body 显隐（默认全隐、按下面模式再打开）
  replyBody.style.display = 'none';
  restartBody.style.display = 'none';
  // 徽章 class 归零（保留 .tag 基类）
  stateTag.className = 'tag tag-mut';
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
    if (stateTag.parentElement) stateTag.parentElement.style.display = 'none';
    if (mb && mb.id === t.mbSessionId) {
      const running = mb.state === 'running' || mb.state === 'starting';
      // 打断只在「正在生成」时有意义：非 running 用 display 隐藏（而非灰化占位），一轮收敛即消失。
      if (interruptBtn) { interruptBtn.style.display = running ? '' : 'none'; interruptBtn.onclick = () => mbInterrupt(); }
    }
    updateReplyCount(text.value.length, countEl);
    send.onclick = () => mbSend();
    text.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); mbSend(); } };
    text.oninput = () => updateReplyCount(text.value.length, countEl);
    return;
  }

  // CLI 会话三态：终端占用 → 只读；正在算 → 等；空闲无进程 → 可从看板回复（headless --resume）
  if (isCli) {
    stateTag.className = 'tag';
    stateTag.style.background = 'var(--brandS)';
    stateTag.style.color = 'var(--brand)';
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
    if (typeof window.__resetReplyModel === 'function') window.__resetReplyModel();
    send.onclick = () => sendCliContinue(taskKey);
    text.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendCliContinue(taskKey); } };
    text.oninput = () => updateReplyCount(text.value.length, countEl);
    setTimeout(() => text.focus(), 60);
    return;
  }

  if (canReply) {
    stateTag.className = 'tag tag-jade';
    stateTag.textContent = '可继续对话';
    hint.innerHTML = '同 session <b>--resume</b>，cache_read 命中省 token';
    replyBody.style.display = 'flex';   // composer 是 flex-direction:column
    text.disabled = false; send.disabled = false;
    text.value = '';
    updateReplyCount(0, countEl);
    if (typeof window.__resetReplyModel === 'function') window.__resetReplyModel();
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
    hint.innerHTML = '任务处于 <b>plan</b>（计划中）· 确认排队后才会执行；可先在概览里补充任务描述';
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

async function sendReply(taskKey) {
  const text = $('modalReplyText');
  const send = $('modalReplySend');
  const model = $('modalReplyModel').value;
  const msg = text.value.trim();
  if (!msg) { showReplyToast('消息不能为空', 'err'); return; }
  send.disabled = true; text.disabled = true; send.textContent = '发送中…';
  try {
    const body = model ? { message: msg, model } : { message: msg };
    const r = await api(`/api/task/reply?taskKey=${encodeURIComponent(taskKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { showReplyToast(r.error || '未知错误', 'err'); return; }
    text.value = '';
    updateReplyCount(0);
    // reply 走 --resume 重挂了一个绑定该任务的 Mode B 会话（后端已 seed 历史 + 这条回复）。
    // 立即刷 state 让 mbSessionId 现身、重载详情进 live（连 SSE 回放 seed → 历史 + 这条继续即时可见），
    // 不再死等 10s（旧 setTimeout 期间消息不显示 + 页面冻在旧只读历史，体验差）。
    await refreshState();
    if (modalOpen && modalPollTaskKey === taskKey) loadTaskDetail(taskKey);
  } catch (e) {
    showReplyToast(e.message, 'err');
  } finally {
    send.disabled = false; text.disabled = false; send.textContent = '发送 ⏎';
  }
}

// CLI 会话「发送消息」= 收养成 Mode B 实时会话并把这条消息作为首条发出（--resume + 全部历史），跳会话视图。
// 消息不塞进 adopt（createSession(prompt) 走 sendUserMessage 不进 transcript、视图看不到）——改为收养后由
// 会话视图 synced 时 mbSend 乐观回显发出，保证消息可见。pendingCliMessage 只在收养成功后置、消费一次即清。
let pendingCliMessage = null;
// 收养 CLI session 成 Mode B live 会话：taskKey 透传绑该任务，msg 不塞进 adopt 而是置 pendingCliMessage，
// 详情连上 live 会话 synced 后经 mbSend 乐观回显发出（保证可见），再跳详情进 live。
// 续接（sendCliContinue）与 rewind（先截断再收养）共用。返回 api 结果（{ok} 或 {ok:false,error}）。
async function adoptCliToLive({ taskKey, sessionId, msg, model }) {
  const body = model ? { sessionId, model, taskKey } : { sessionId, taskKey };
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
  const msg = text.value.trim();
  if (!msg) { showReplyToast('消息不能为空', 'err'); return; }
  const t = findTaskInState(taskKey);
  const sessionId = t?.meta?.sessionId;
  if (!sessionId) { showReplyToast('该会话无 sessionId，无法续接', 'err'); return; }
  if (t?.state === 'processing') { showReplyToast('会话仍在运行——先退出终端再续接，避免两个进程同写一个会话', 'err'); return; }
  send.disabled = true; text.disabled = true; send.textContent = '续接中…';
  try {
    const r = await adoptCliToLive({ taskKey, sessionId, msg, model });
    if (!r.ok) { showReplyToast(r.error || '未知错误', 'err'); return; }
  } catch (e) {
    showReplyToast(e.message, 'err');
  } finally {
    send.disabled = false; text.disabled = false; send.textContent = '发送 ⏎';
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

// ---- Claude Code 账号级用量（详情页卡片）：套餐 + Pro/Max 的 5h/7d 滚动窗，账号全局非按任务 ----
// 后端 /api/claude-usage 已 60s 缓存；前端再缓存一层，详情页 5s 轮询不必每 tick 拉。
let claudeUsage = null;          // 最近一次 /api/claude-usage 结果
let claudeUsageAt = 0;           // 拉取时刻（毫秒）
let claudeUsageInflight = false;
const CLAUDE_USAGE_TTL = 60000;
async function refreshClaudeUsage(taskKey) {
  if (claudeUsageInflight) return;
  if (claudeUsage && Date.now() - claudeUsageAt < CLAUDE_USAGE_TTL) return;   // 新鲜：不重复拉
  claudeUsageInflight = true;
  try {
    const u = await api('/api/claude-usage');
    claudeUsage = u; claudeUsageAt = Date.now();
    if (modalOpen && modalPollTaskKey === taskKey) renderTaskSide(taskKey);   // 到货重画卡片
  } catch { /* 网络抖动：忽略，下一 tick 再拉 */ }
  finally { claudeUsageInflight = false; }
}

// token 压缩显示（对齐 renderRuntime 的 compact：百万级用 K/M/B）
function compactTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// 距刷新剩余（resetsAt ISO → 「1d 22h 后刷新 / 3h 20m 后刷新 / 12m 后刷新 / 即将刷新」）
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

// 单个滚动窗横向进度条（5h / 7d）：百分比 + 距刷新剩余；≥80% 红、≥50% 琥珀、否则绿。
// 配色参考 claude-center 用量条：百分比文字用可读色档（coral/amber/jade），填充用底色半透明——
// 柔和不刺眼，避免压暗的 --amber 文字色直接做满值填充呈脏棕。
function ccUsageBarHtml(label, win) {
  if (!win || win.utilization == null) return '';
  const pct = Math.max(0, Math.min(100, Number(win.utilization)));
  const textColor = pct >= 80 ? 'var(--coral)' : pct >= 50 ? 'var(--amber)' : 'var(--jade)';
  const fillBase = pct >= 80 ? 'var(--destructive)' : pct >= 50 ? 'var(--warning)' : 'var(--success)';
  const fill = `color-mix(in oklab, ${fillBase} 62%, transparent)`;
  const reset = win.resetsAt ? fmtResetIn(win.resetsAt) : '';
  return `
    <div class="cc-bar">
      <div class="cc-bar-head">
        <span class="cc-bar-label">${escapeHtml(label)}</span>
        <span class="cc-bar-pct" style="color:${textColor}">${pct.toFixed(0)}%</span>
      </div>
      <div class="cc-bar-track"><div class="cc-bar-fill" style="width:${pct}%;background:${fill}"></div></div>
      ${reset ? `<div class="cc-bar-reset">${escapeHtml(reset)}</div>` : ''}
    </div>`;
}

// Claude Code 卡片：sessionId / 模型 / token 用量 + Pro/Max 的 5h/7d 滚动窗
function claudeCodeCardHtml(t, model) {
  const kv = (k, v) => `<div class="side-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const sessionId = t.meta?.sessionId || null;
  const u = t.meta?.usage || null;   // CC result.usage 末轮快照
  let tokenHtml;
  if (u) {
    const inTok = Number(u.input_tokens) || 0;
    const outTok = Number(u.output_tokens) || 0;
    const cacheTok = (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    const title = `输入 ${inTok.toLocaleString('en-US')} · 输出 ${outTok.toLocaleString('en-US')} · 缓存 ${cacheTok.toLocaleString('en-US')}`;
    tokenHtml = `<span title="${escapeAttr(title)}">↑${compactTokens(inTok)} ↓${compactTokens(outTok)} <span style="color:var(--dim)">缓存 ${compactTokens(cacheTok)}</span></span>`;
  } else if (t.source === 'cli') {
    tokenHtml = '<span style="color:var(--dim)">CLI 会话不计量</span>';   // CLI 会话 v1 不计 token
  } else {
    tokenHtml = '<span style="color:var(--dim)">—</span>';               // 分身任务：快照尚未落盘（多为处理中）
  }
  // 用量区：套餐 Pro/Max 才有 5h/7d 滚动窗；数据未到 / 非订阅 / 拉取失败各自提示
  const cu = claudeUsage;
  let usageHtml = '';
  if (!cu) {
    usageHtml = '<div class="cc-usage-note">用量加载中…</div>';
  } else if (cu.ok && cu.subscription) {
    if (cu.error) {
      const msg = cu.error === 'token-expired' ? 'OAuth 凭据已过期，重新登录 Claude Code 后恢复' : `用量读取失败（${escapeHtml(cu.error)}）`;
      usageHtml = `<div class="cc-usage-note">${msg}</div>`;
    } else {
      const bars = ccUsageBarHtml('5 小时', cu.fiveHour) + ccUsageBarHtml('7 天', cu.sevenDay);
      usageHtml = bars || '<div class="cc-usage-note">暂无滚动窗用量</div>';
    }
  }
  // 套餐徽章：max/pro 高亮，其余淡显
  const plan = cu?.plan;
  const planTag = plan
    ? `<span class="tag ${cu?.subscription ? 'tag-jade' : 'tag-mut'}" style="text-transform:uppercase">${escapeHtml(plan)}</span>`
    : '';
  return `
    <div class="side-block">
      <h3>Claude Code ${planTag ? `<span style="margin-left:auto">${planTag}</span>` : ''}</h3>
      ${kv('session', sessionId ? escapeHtml(sessionId) : '<span style="color:var(--dim)">—</span>')}
      ${kv('模型', escapeHtml(model))}
      ${kv('token', tokenHtml)}
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
  const isCli = t.source === 'cli';
  // 模型/cwd/git/工作时长/最近活动：CLI 与分身统一从详情 round 取（readWorkerLog 对两类同构产出）——不按来源分叉
  const model = lastOk?.ccSummary?.model || lastOk?.systemInit?.model || t.meta?.model || '—';
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
  // 仅执行差异按 isCli 分支——CLI processing 不干预运行中会话、CLI 归档区额外「从看板移除」。
  const btns = [];
  const _bk = escapeAttr(t.taskKey);
  if (t.isArchive) {
    btns.push(`<button class="btn" onclick="unarchiveTaskAction('${_bk}')">↺ 取消归档</button>`);
    if (isCli) btns.push(`<button class="btn btn-danger" onclick="removeCliSession('${escapeAttr(t.meta?.sessionId || '')}')">从看板移除</button>`);
  } else if (t.state === 'plan') {
    btns.push(`<button class="btn" style="color:var(--jade);border-color:color-mix(in oklab, var(--success) 40%, transparent)" onclick="approveTaskAction('${_bk}')">▶ 确认排队</button>`);
    btns.push(`<button class="btn" onclick="archiveTask('${_bk}')">归档</button>`);
  } else if (['queued', 'processing'].includes(t.state)) {
    // live 会话已收敛（idle/closed）但任务 state 还没轮询刷成 awaiting-human 的空窗期，不再显示「中断」——
    // 与「打断」同源于 mb.state，result 一到即随 mbSyncLiveHead→renderTaskSide 一起隐藏，不必等 5s 轮询。
    // 非 live 任务（无 mb / 不匹配）→ liveRunning 恒真，按 t.state 原逻辑显示，不受影响。
    const liveRunning = !mb || mb.id !== t.mbSessionId || mb.state === 'running' || mb.state === 'starting';
    if (!isCli && liveRunning) btns.push(`<button class="btn btn-danger" onclick="cancelTaskAction('${_bk}')">中断</button>`);
  } else if (t.state === 'awaiting-human') {
    btns.push(`<button class="btn" style="color:var(--jade);border-color:color-mix(in oklab, var(--success) 40%, transparent)" onclick="completeTaskAction('${_bk}')">✓ 完成</button>`);
    btns.push(`<button class="btn" onclick="archiveTask('${_bk}')">归档</button>`);
  } else if (t.state === 'done') {
    btns.push(`<button class="btn" onclick="uncompleteTaskAction('${_bk}')">↺ 取消完成</button>`);
    btns.push(`<button class="btn" onclick="archiveTask('${_bk}')">归档</button>`);
  }
  const descText = t.description || '';
  // 工作时长：claude 实际在算的时长（区别于创建→结束墙钟）；CLI 单 round、分身多 round，累加逻辑通用。
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
  }).join('');
  // 统一字段值：所有任务「任务信息」按同一字段集展示，共有字段（cwd/git/最近活动）一律取自详情 round
  // （readWorkerLog 对 CLI/分身同构产出）+ t.cli/t.cwd 兜底，不按来源分叉；
  // 权限模式/后台agent/jsonl大小是 CLI 会话独有真实数据，按 t.cli 存在性显（分身无 → 不显/—）。
  const rtCwds = [...new Set((r?.rounds || []).map((x) => x?.cwd || x?.systemInit?.cwd).filter(Boolean))];
  const rtCwd = rtCwds[rtCwds.length - 1] || null;
  const cwdVal = rtCwd || t.cli?.cwd || t.cwd || '—';
  const gitVal = lastOk?.gitBranch || t.cli?.gitBranch || '—';
  const permMode = (t.cli?.mode && t.cli.mode !== 'normal') ? t.cli.mode : null;   // CLI 非 normal 权限模式才显
  const bgAgent = Number(t.backgroundAgentCount) || 0;   // 统一后台维度：>0 = 主进程让出后仍有后台 agent 在跑
  const jsonlVal = t.cli?.jsonlBytes ? (t.cli.jsonlBytes / 1024 / 1024).toFixed(2) + ' MB' : '—';
  const lastActive = t.lease?.heartbeatAt || meta.lastRoundAt || t.resolvedAt || '—';
  const sideTitle = t.title || t.taskKey;
  const canRename = !t.isArchive;   // 非归档任务可重命名：统一走 /api/task/rename，后端按来源分派（分身写 task.json / CLI 写 watchlist）
  el.innerHTML = `
    <div class="side-block">
      <h3>任务信息</h3>
      <div class="side-title-row">
        <span class="side-title" title="${escapeAttr(sideTitle)}">${escapeHtml(sideTitle)}</span>
        ${canRename ? `<button class="btn side-edit" title="重命名任务" onclick="renameTaskPrompt('${escapeAttr(t.taskKey)}')">✎</button>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:10px 0">${tags}</div>
      ${kv('taskKey', escapeHtml(t.taskKey))}
      ${kv('cwd', escapeHtml(cwdVal))}
      ${kv('git', escapeHtml(gitVal))}
      ${permMode ? kv('权限模式', escapeHtml(permMode)) : ''}
      ${bgAgent > 0 ? kv('后台 agent', `<span style="color:var(--amber)">${bgAgent} 个运行中（主进程已让出，等后台完成）</span>`) : ''}
      ${/* turns / jsonl 大小 暂不在此展示（数据保留于 meta.numTurns / jsonlVal，待定放置位置）*/''}
      ${kv('创建', escapeHtml(t.createdAt || '—'))}
      ${kv('最近活动', escapeHtml(lastActive))}
      ${kv('总耗时', fmtDuration(t.durationMs))}
      ${kv('工作时长', workMs > 0 ? fmtDuration(workMs) : '—')}
      ${failureHtml}
      ${commentHtml}
    </div>
    ${claudeCodeCardHtml(t, model)}
    <div class="side-block">
      <h3>任务描述 <button class="btn" style="margin-left:auto;font-size:10px;padding:1px 9px" onclick="editTaskDesc('${escapeAttr(t.taskKey)}')">✎ 编辑</button></h3>
      ${descText
        ? `<div style="font-size:12.5px;color:var(--ink2);line-height:1.7;white-space:pre-wrap;word-break:break-word">${escapeHtml(descText)}</div>`
        : '<div style="font-size:11.5px;color:var(--dim)">暂无 · 自己看的备注，不会发给 claude</div>'}
    </div>
    ${btns.length ? `<div class="side-block"><h3>操作</h3><div class="side-actions">${btns.join('')}</div></div>` : ''}
    ${tlHtml ? `<div class="side-block"><h3>动态</h3><div class="timeline">${tlHtml}</div></div>` : ''}
  `;
  // 面包屑末级同步任务标题（详情页 header 已移除，标题改在此块内展示 · req4）
  const crumbLast = document.getElementById('crumbLast');
  if (crumbLast) crumbLast.textContent = sideTitle;
  // Claude Code 卡片的账号级用量：懒加载（到货后回调重画本卡）
  refreshClaudeUsage(taskKey);
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
  // 入参展开区：Edit 渲染成 old/new diff 色块；其余美化 JSON
  let inputBody;
  if (c.name === 'Edit' && c.input?.old_string != null) {
    inputBody = `<pre class="diff-old">${escapeHtml(String(c.input.old_string).slice(0, 2000))}</pre><pre class="diff-new">${escapeHtml(String(c.input.new_string ?? '').slice(0, 2000))}</pre>`;
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
      //   1. SYSTEM_TAG_RE 命中 → isMeta 灰细横线（<local-command-stdout/caveat/stderr> + <system-reminder>）
      //   2. CMD_HEAD_RE 命中 → 提取 <command-args> body 当用户真实 prompt；无 args → 整条跳过（/clear /model）
      //   3. 兜底 isMeta 字段 → 灰细横线
      //   4. 否则 → 正常 user 气泡
      const text = (u.m.content || []).map((c) => (c.type === 'text' ? String(c.text || '') : '')).join('\n');
      if (SYSTEM_TAG_RE.test(text)) {
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

// meta user 消息 → 灰细横线居中：<local-command-*> / <system-reminder> / <caveat> / jsonl.isMeta 全走这条
// 命令 XML 由 renderCcFlow 前置分派处理（args body 变正常 user；无 args 命令直接跳过）
function renderMetaTurn(m) {
  const text = (m.content || []).map((c) => (c.type === 'text' ? String(c.text || '') : '')).join('\n');
  // 剥 XML tag 只留内容：<local-command-stdout>Enabled plan mode</local-command-stdout> → Enabled plan mode
  const stripped = text.replace(/<\/?(?:local-command-[a-z-]+|system-reminder|caveat)>/gi, '').trim();
  const trimmed = (stripped || text).replace(/\s+/g, ' ').trim();
  const short = trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
  if (!short) return '';
  return `
    <div style="display:flex;align-items:center;gap:12px;margin:14px 0" title="${escapeAttr(fmtTime(m.at))}">
      <span style="flex:1;height:1px;background:var(--hair)"></span>
      <div style="max-width:640px;text-align:center">
        <div style="font-size:10.5px;color:var(--dim);font-weight:500;letter-spacing:.02em">system · ${fmtTime(m.at)}</div>
        <div style="margin-top:3px;font-size:11.5px;color:var(--mut);line-height:1.55;white-space:pre-wrap;word-break:break-word">${escapeHtml(short)}</div>
      </div>
      <span style="flex:1;height:1px;background:var(--hair)"></span>
    </div>`;
}

// 学 claude-code-session/server/lib/system-tags.ts：
// SYSTEM_TAG_RE 匹配"纯 system 注入"消息 → 走 isMeta 灰细横线：
//   - <local-command-*>（stdout / stderr / caveat）
//   - <system-reminder>
//   - <caveat>（legacy 命名）
// CMD_HEAD_RE 匹配斜杠命令消息 → 提取 <command-args> body 当"用户真实 prompt"，无 args 则整条跳过
//   - CC 认定：斜杠命令是用户驱动的，args body 就是用户的实际 prompt，不该额外加胶囊
//   - /clear、/model 之类无 args 命令 → 跳过不显示（视觉噪声）
const SYSTEM_TAG_RE = /^\s*<(local-command|system-reminder|caveat)/i;
const CMD_HEAD_RE = /^\s*<command-(?:name|message|args)>/;
function pickCommandArgs(text) {
  if (!CMD_HEAD_RE.test(text)) return null;
  const m = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  return (m?.[1] ?? '').trim();
}

// 原地 rewind：改写某条历史 user 消息并从那里重新执行（仅 CLI 会话；对齐 CC 交互 double-Esc rewind：
// 同一 session、同一张卡片；被截掉的原时间线直接丢弃、不备份）。两步：① 后端截断 jsonl 到该消息之前，
// ② 收养成 Mode B live 会话把改写后的消息从截断处叶子重跑（同「续接」路径，不再走已废弃的 ps1 runner）。
window.rewindCliMessage = async (uuid) => {
  const taskKey = modalPollTaskKey;
  if (!taskKey || !taskKey.startsWith('cli:')) return;
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
    // ① 截断 jsonl 到目标消息之前（后端返回 sid）
    const r = await api('/api/cli/rewind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskKey, uuid, message: v.trim() }),
    });
    if (!r.ok) { customAlert({ title: 'rewind 失败', message: escapeHtml(r.error || '未知错误') }); return; }
    // ② 截断后收养成 Mode B live 会话，把改写后的消息作新一轮从截断处重跑（同 sendCliContinue 的收养路径）
    const rr = await adoptCliToLive({ taskKey, sessionId: r.sid, msg: v.trim() });
    if (!rr.ok) { customAlert({ title: 'rewind 后续接失败（jsonl 已截断，可在卡片里直接续接重发）', message: escapeHtml(rr.error || '未知错误') }); return; }
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
  // fork-rewind 按钮：仅 CLI 会话 + 消息有 uuid 时给（hover 气泡出现在下方；分身任务不给）
  const canRewind = modalPollTaskKey?.startsWith('cli:') && m.uuid;
  const rewindBtn = canRewind
    ? `<div class="msg-rewind"><button class="btn" style="font-size:10px;padding:2px 9px;color:var(--dim)" onclick="rewindCliMessage('${escapeAttr(m.uuid)}')" title="改写这条消息，fork 新会话从这里重新执行（原会话不动）">⑂ 改写重跑</button></div>`
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
    syncProxyInput();
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

// 设置页出网代理：从 state 回填（不覆盖用户正在编辑的输入），保存走 /api/config/proxy
function syncProxyInput() {
  const inp = $('proxyUrlInput');
  if (!inp || inp === document.activeElement || inp.dataset.dirty === '1') return;   // 编辑中不回填
  inp.value = stateData?.runnerConfig?.proxyUrl || '';
}
{
  const inp = $('proxyUrlInput');
  const btn = $('proxySaveBtn');
  const hint = $('proxySaveHint');
  if (inp) inp.addEventListener('input', () => { inp.dataset.dirty = '1'; if (hint) hint.textContent = ''; });
  if (btn) btn.addEventListener('click', async () => {
    const proxyUrl = (inp.value || '').trim();
    btn.disabled = true; if (hint) { hint.style.color = 'var(--dim)'; hint.textContent = '保存中…'; }
    try {
      const r = await api('/api/config/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proxyUrl }) });
      if (r.ok) {
        delete inp.dataset.dirty;
        claudeUsage = null; claudeUsageAt = 0;   // 代理变了：清前端用量缓存，详情页下次即重拉
        if (hint) { hint.style.color = 'var(--jade)'; hint.textContent = proxyUrl ? '已保存 · 用量将经此代理拉取' : '已清除 · 回退系统环境变量代理'; }
      } else if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = r.error || '保存失败'; }
    } catch { if (hint) { hint.style.color = 'var(--coral)'; hint.textContent = '保存失败'; } }
    finally { btn.disabled = false; }
  });
}

// ---- 新建任务 Modal（同一弹窗兼作 plan 任务「编辑」：editingTaskKey 非空即编辑模式）----
const NEWTASK_HEAD = '新建 manual 任务';
const NEWTASK_HINT = 'source=manual · taskKey 自动生成（manual:mYYYYMMDDHHMMSS-NNN）· 默认存为 plan，在看板确认后才执行';
let editingTaskKey = null;   // null=新建；非空=正在编辑该 plan 任务，提交走 /api/task/edit
$('newTaskBtn').addEventListener('click', () => {
  editingTaskKey = null;
  $('newTaskModal').querySelector('.modal-head h2').textContent = NEWTASK_HEAD;
  $('newTaskModal').querySelector('.modal-hint').textContent = NEWTASK_HINT;
  $('newTaskPlanFirst').closest('label').style.display = '';   // 新建才显示「先计划」勾选
  $('newTaskSubmit').textContent = '提交';
  $('newTaskModal').style.display = 'flex';
  $('newTaskTitle').value = '';
  $('newTaskPrompt').value = '';
  $('newTaskDesc').value = '';
  $('newTaskCwd').value = '';              // req3：工作目录（可选）
  loadNewTaskCwds();                       // 填充「已有工作目录」下拉（现有任务 cwd + 近期 CLI session cwd）
  $('newTaskPlanFirst').checked = true;    // req4：页面新建任务默认进入 plan（可取消勾选改为立即执行）
  newTaskModelCtl?.setValue('claude-opus-4-8');
  $('newTaskErr').style.display = 'none';
  $('newTaskWarn').style.display = 'none';
  setTimeout(() => $('newTaskTitle').focus(), 100);
});

// plan 任务「编辑」：复用新建弹窗，先拉 /api/task/detail 回填，提交走 /api/task/edit（仅 plan 可编辑）
async function openEditTask(taskKey) {
  let r;
  try { r = await api(`/api/task/detail?taskKey=${encodeURIComponent(taskKey)}`); }
  catch (e) { return customAlert({ title: '打不开编辑', message: escapeHtml(e.message) }); }
  if (!r || !r.ok) return customAlert({ title: '打不开编辑', message: escapeHtml(r?.error || '读取任务失败') });
  acknowledgeTask(taskKey);             // 看过即清「状态变更」更新点
  editingTaskKey = taskKey;
  $('newTaskModal').querySelector('.modal-head h2').textContent = '编辑任务';
  $('newTaskModal').querySelector('.modal-hint').textContent = `source=${r.source} · ${taskKey} · plan 态可编辑；prompt 是确认排队后真正发给 claude 的指令`;
  $('newTaskPlanFirst').closest('label').style.display = 'none';   // 编辑不改变 plan 态，隐藏「先计划」勾选
  $('newTaskSubmit').textContent = '保存';
  $('newTaskModal').style.display = 'flex';
  $('newTaskTitle').value = r.title || '';
  $('newTaskPrompt').value = r.prompt || '';
  $('newTaskDesc').value = r.description || '';
  $('newTaskCwd').value = r.cwd || '';
  loadNewTaskCwds();
  newTaskModelCtl?.setValue(r.model || 'claude-opus-4-8');
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
  menu.addEventListener('mousedown', (e) => {   // mousedown 先于 input blur，避免选中前菜单被关
    const item = e.target.closest('.cwd-item');
    if (!item) return;
    e.preventDefault();
    input.value = item.dataset.cwd;
    closeCwdMenu();
  });
  document.addEventListener('click', (e) => { if (!combo.contains(e.target)) closeCwdMenu(); });
})();

// req3：浏览按钮 → 系统目录选择（桌面端 Electron dialog；web 模式回退提示手填）
$('newTaskCwdBrowse').addEventListener('click', async () => {
  const btn = $('newTaskCwdBrowse');
  const errBox = $('newTaskErr');
  btn.disabled = true;
  try {
    const r = await api('/api/pick-dir', { method: 'POST' });
    if (r.ok && r.dir) { $('newTaskCwd').value = r.dir; closeCwdMenu(); }
    else if (!r.ok && r.error) { errBox.textContent = r.error; errBox.style.display = 'block'; }
  } catch (e) {
    errBox.textContent = e.message; errBox.style.display = 'block';
  } finally { btn.disabled = false; }
});
window.closeNewTaskModal = () => {
  $('newTaskModal').style.display = 'none';
  editingTaskKey = null;   // 关闭即回落新建模式基线，下次「新建」打开干净
};
$('newTaskSubmit').addEventListener('click', async () => {
  const title = $('newTaskTitle').value.trim();
  const prompt = $('newTaskPrompt').value.trim();
  const description = $('newTaskDesc').value.trim();
  const cwd = $('newTaskCwd').value.trim();
  const planFirst = $('newTaskPlanFirst').checked;
  const model = $('newTaskModel').value;
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
        body: JSON.stringify({ title, prompt, model, description, cwd }),
      });
      if (!r.ok) { errBox.textContent = r.error || '未知错误'; errBox.style.display = 'block'; return; }
      closeNewTaskModal();
      await refreshState();
      return;
    }
    const r = await api('/api/task/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, prompt, model, description, plan: planFirst, cwd }),
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
  loadRecentCli();   // req1：打开即默认展示近 30min 活跃的 claude code 会话
  setTimeout(() => $('addCliSearch').focus(), 100);
});
window.closeAddCliModal = () => { $('addCliModal').style.display = 'none'; };

// 默认列表：近 30min 活跃 session（无需关键字）
async function loadRecentCli() {
  const results = $('addCliResults');
  results.innerHTML = '<div style="color:var(--dim);font-size:12.5px;padding:14px;text-align:center">加载近 30 分钟活跃会话…</div>';
  try {
    const r = await api('/api/cli/recent?within=30&limit=30');
    if (!r.ok) { results.innerHTML = `<div style="color:var(--coral);font-size:12px;padding:14px;text-align:center">${escapeHtml(r.error || '加载失败')}</div>`; return; }
    if (!r.candidates?.length) {
      results.innerHTML = '<div style="color:var(--dim);font-size:12.5px;padding:14px;text-align:center">近 30 分钟内没有活跃的 claude code 会话<br>可用上方搜索按关键字 / sid 前缀查更早的</div>';
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
      body: JSON.stringify({ q, limit: 30 }),
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
    : `<button class="btn btn-primary" style="font-size:11px;padding:5px 12px;margin-left:auto;flex:none" onclick="addCliFromSearch('${escapeAttr(c.sid)}')">+ 添加</button>`;
  return `
    <div style="padding:10px 12px;border-bottom:1px solid var(--hair);display:flex;flex-direction:column;gap:4px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-family:var(--mono);font-size:11.5px;color:var(--brand);font-weight:600">${short}</span>
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

window.addCliFromSearch = async (sid) => {
  const errBox = $('addCliErr');
  try {
    const r = await api('/api/cli/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid }),
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

// ---- 自定义 model 下拉：填选项 + 事件绑定（隐藏的 <select> 承担 value 存储）----
// 继续对话框用「继承任务 model」开头（value=''）；新建任务框不需要继承项，直接列出可选 model
const INHERIT_OPTION = { value: '', name: '继承任务 model', desc: '默认 · 不覆盖任务原本的 model', tier: 'mut', tierLabel: '默认' };
const BASE_MODELS = [
  { value: 'claude-opus-4-8',               name: 'Opus 4.8',       desc: '旗舰推理 · 全局默认（与 4.7 同价）',    tier: 'jade', tierLabel: '旗舰' },
  { value: 'claude-fable-5',                name: 'Fable 5',        desc: '最强推理 · 高于 Opus · issue 分析默认（配额消耗≈2×）', tier: 'coral',tierLabel: '最强' },
  { value: 'claude-opus-4-7',               name: 'Opus 4.7',       desc: '上一代旗舰',                            tier: 'jade', tierLabel: '旗舰' },
  { value: 'claude-sonnet-5',               name: 'Sonnet 5',       desc: '平衡 · 中等速度与推理',                 tier: 'cyan', tierLabel: '平衡' },
  { value: 'claude-haiku-4-5-20251001',     name: 'Haiku 4.5',      desc: '最快 · 最省 token',                     tier: 'amber',tierLabel: '高速' },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];   // claude --effort 档位（后端白名单一致）；默认 high

// 通用初始化：wrapId/btnId/menuId/selectId 四元素 + models 列表 + 是否首项后加分隔线
// inScroll=true：宿主在 overflow:auto 容器内（如新建任务表单）——absolute 定位会被容器裁剪，
// 改为 open 时用 getBoundingClientRect 算出 fixed 坐标（挂在 viewport，不受容器裁剪），并按上下可用空间自动选方向
function initModelDropdown({ wrapId, btnId, menuId, selectId, models, hairAfterFirst = false, inScroll = false }) {
  const wrap = $(wrapId);
  const btn = $(btnId);
  const menu = $(menuId);
  const btnLabel = btn?.querySelector('.reply-model-btn-label');
  const select = $(selectId);
  if (!wrap || !btn || !menu || !select) return null;

  menu.innerHTML = models.map((m, i) => `
    ${hairAfterFirst && i === 1 ? '<div class="reply-model-menu-hair"></div>' : ''}
    <button type="button" class="reply-model-item" data-value="${escapeAttr(m.value)}" role="option">
      <span class="item-main">
        <span class="item-name">${escapeHtml(m.name)}<span class="item-tier tier-${m.tier}">${escapeHtml(m.tierLabel)}</span></span>
        <span class="item-desc">${escapeHtml(m.desc)}</span>
      </span>
      <span class="item-check" aria-hidden="true">✓</span>
    </button>
  `).join('');

  const setValue = (val) => {
    select.value = val;
    const m = models.find((x) => x.value === val) || models[0];
    btnLabel.textContent = m.name;
    menu.querySelectorAll('.reply-model-item').forEach((it) => {
      it.classList.toggle('active', it.dataset.value === val);
    });
  };
  setValue(select.value || models[0].value);

  let scrollHost = null;
  const closeMenu = () => {
    menu.classList.remove('open');
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
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
      const openUp = spaceBelow < 260 && r.top > spaceBelow;
      menu.style.position = 'fixed';
      menu.style.left = r.left + 'px';
      menu.style.width = r.width + 'px';
      menu.style.bottom = openUp ? (window.innerHeight - r.top + 6) + 'px' : 'auto';
      menu.style.top = openUp ? 'auto' : (r.bottom + 6) + 'px';
      scrollHost = wrap.closest('[style*="overflow-y:auto"], [style*="overflow-y: auto"]');
      if (scrollHost) scrollHost.addEventListener('scroll', closeMenu, { passive: true });
      window.addEventListener('resize', closeMenu);
    }
    menu.classList.add('open');
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    const activeItem = menu.querySelector('.reply-model-item.active');
    if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.contains('open') ? closeMenu() : openMenu();
  });
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.reply-model-item');
    if (!item) return;
    setValue(item.dataset.value);
    closeMenu();
    btn.focus();
  });
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('open') && !wrap.contains(e.target) && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')) { closeMenu(); btn.focus(); }
  });
  return { setValue };
}

let replyModelCtl = null;
function initReplyModelSelector() {
  replyModelCtl = initModelDropdown({
    wrapId: 'modalReplyModelWrap', btnId: 'modalReplyModelBtn', menuId: 'modalReplyModelMenu', selectId: 'modalReplyModel',
    models: [INHERIT_OPTION, ...BASE_MODELS], hairAfterFirst: true,
  });
  // 暴露给状态机：切换 taskKey 时把 UI 同步回默认（继承）
  window.__resetReplyModel = () => replyModelCtl?.setValue('');
}

let newTaskModelCtl = null;
function initNewTaskModelSelector() {
  newTaskModelCtl = initModelDropdown({
    wrapId: 'newTaskModelWrap', btnId: 'newTaskModelBtn', menuId: 'newTaskModelMenu', selectId: 'newTaskModel',
    models: BASE_MODELS, hairAfterFirst: false, inScroll: true,
  });
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
function mbDetach() { mbStopStatusTimer(); if (mbFlushRaf) { cancelAnimationFrame(mbFlushRaf); mbFlushRaf = null; } if (mb?.sse) { try { mb.sse.close(); } catch { /* ignore */ } } mb = null; }

function loadSession(id) {
  if (mb && mb.id === id && mb.sse) return;   // 已在该会话，避免重复连
  mbDetach();
  mb = { id, sse: null, transcript: [], liveText: '', perms: [], info: {}, state: 'starting', syncing: true, liveUsage: null, turnStartedAt: null, gerundSeed: 0 };
  $('modalBody').innerHTML = '<div style="color:var(--dim);padding:12px 0">连接实时会话…</div>';
  mbSyncLiveHead();
  const es = new EventSource(`/api/session/stream?id=${encodeURIComponent(id)}`);
  mb.sse = es;
  es.addEventListener('info', (e) => { try { mb.info = JSON.parse(e.data); mb.state = mb.info.state || mb.state; mbSyncLiveHead(); } catch { /* ignore */ } });
  es.addEventListener('synced', () => {
    mb.syncing = false; mbRenderBody(); mbSyncLiveHead();
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
    case 'stream_event': {
      const e = ev.event;
      if (!e) return;
      if (e.type === 'content_block_delta' && e.delta) {
        const d = e.delta;
        if (d.type === 'text_delta') { mb.liveText += d.text || ''; mbScheduleLive(); }
        // thinking 态：thinking_delta 期间为真；正文/工具入参 delta 一来即结束（供底部实时状态行显示 " · thinking"）
        if (mb.liveUsage) { if (d.type === 'thinking_delta') mb.liveUsage.thinking = true; else if (d.type === 'text_delta' || d.type === 'input_json_delta') mb.liveUsage.thinking = false; }
        // 下行估算：累计所有 delta 文本长度（text/thinking/tool 入参），≈ output tokens（thinking 不可见但计费）
        const dl = (d.text || d.thinking || d.partial_json || '').length;
        if (dl && mb.liveUsage) { mb.liveUsage.outChars += dl; mbScheduleLive(); }
      } else if (e.type === 'message_start') {
        // 上行（input+cache）在开跑即知 → 即时真值；下行待末尾
        const u = e.message?.usage || {};
        mb.liveUsage = { up: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outChars: 0, outReal: null, active: true, thinking: false };
        if (!mb.turnStartedAt) { mb.turnStartedAt = Date.now(); mb.gerundSeed = Math.floor(Math.random() * MB_GERUNDS.length); }
        if (!mb.syncing) mbUpdateLiveTokens();
      } else if (e.type === 'message_delta' && e.usage) {
        // CC 只在末尾发一次 message_delta（实测：逐 token 增长不可得）→ 拿到本轮下行真值
        if (mb.liveUsage) { mb.liveUsage.outReal = e.usage.output_tokens ?? null; }
        // 贴到最近一条 assistant 事件的 message.usage，供每轮 token footer 显示真值
        for (let i = mb.transcript.length - 1; i >= 0; i--) { if (mb.transcript[i].type === 'assistant' && mb.transcript[i].message) { mb.transcript[i].message.usage = e.usage; break; } }
        if (!mb.syncing) { mbUpdateLiveTokens(); mbRenderBody(); }
      }
      return;
    }
    case 'assistant': mb.transcript.push(ev); mb.liveText = ''; if (!mb.syncing) mbRenderBody(); return;
    case 'user': mb.transcript.push(ev); if (!mb.syncing) mbRenderBody(); return;
    case 'result': mb.liveText = ''; mb.state = 'idle'; mb.turnStartedAt = null; if (mb.liveUsage) { mb.liveUsage.active = false; mb.liveUsage.thinking = false; } if (!mb.syncing) { mbRenderBody(); mbSyncLiveHead(); } return;
    case 'system':
      if (ev.subtype === 'init') { if (ev.session_id) mb.info.claudeSessionId = ev.session_id; mb.state = 'running'; if (!mb.syncing) mbSyncLiveHead(); }
      return;
    case 'control_request':
      if (ev.request && ev.request.subtype === 'can_use_tool') {
        mb.perms.push({ requestId: ev.request_id, toolName: ev.request.tool_name || 'Tool', input: ev.request.input || {} });
        if (!mb.syncing) mbRenderBody();
      }
      return;
    case 'closed': mb.state = 'closed'; if (!mb.syncing) { mbSyncLiveHead(); mbRenderBody(); } return;
    case 'error': mb.state = 'error'; mb.lastError = ev.error; if (!mb.syncing) mbSyncLiveHead(); return;
    default: return;
  }
}

// 把 Mode B settled 事件转成 renderDetailTab 认识的 rounds 形状（复用工具/思考/token/每步计时渲染）。
// stream-json 的 assistant 事件是增量（同 message.id 拆成 thinking/text/tool_use 各一条）——按 id 合并，
// 与 Mode A parseCcSession 同语义，否则消息被拆开、tool_use 与 usage 对不上。
function mbToRounds() {
  const messages = [];
  let curAsst = null;
  for (const ev of mb.transcript) {
    if (ev.type === 'assistant' && ev.message) {
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
    } else if (ev.type === 'user' && ev.message) {
      curAsst = null;
      let content = ev.message.content;
      if (typeof content === 'string') content = [{ type: 'text', text: content }];
      messages.push({ role: 'user', at: (content || [])[0]?._ts || null, content: content || [], isMeta: false });
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
    round: 1, sessionId: mb.info?.claudeSessionId || null, inflight, messages,
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
  let html = rounds[0].messages.length ? renderDetailTab({ rounds }, true) : '<div style="color:var(--dim);padding:12px 0">等待 claude 响应…</div>';
  if (mb.liveText) html += `<div class="cc-line cc-text"><span class="cc-dot">⏺</span><div class="mb-live" id="mbLive">${escapeHtml(mb.liveText)}</div></div>`;
  const running = mb.state === 'running' || mb.state === 'starting';
  if (running) html += `<div class="cc-dur cc-dur-total mb-status" id="mbStatus">${mbStatusHtml()}</div>`;
  for (const p of mb.perms) {
    html += (p.toolName === 'AskUserQuestion' && Array.isArray(p.input?.questions))
      ? mbAskCardHtml(p)
      : `<div class="perm-card">
      <div class="pc-tool">🔐 claude 请求使用工具 <span style="color:var(--amber)">${escapeHtml(p.toolName)}</span></div>
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
  const qs = p.input.questions || [];
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
    <div class="pc-tool">💬 claude 想问你</div>
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
  ta.value = ''; updateReplyCount(0);
  mb.transcript.push({ type: 'user', message: { role: 'user', content: msg } });   // 乐观回显
  mb.turnStartedAt = Date.now(); mb.gerundSeed = Math.floor(Math.random() * MB_GERUNDS.length); mb.liveUsage = null;   // 从发送即开始计时（CC 风格）
  mb.state = 'running'; mbRenderBody(); mbSyncLiveHead();
  // 绑定「文件任务」→ /api/task/reply（内部 sendUserMessage + 置任务 state=processing + lease）；
  // CLI 收养会话（taskKey=cli:*，无 runner-state）与未绑定会话 → 直接发到 live 会话 stdin（/api/session/send）。
  // 关键：cli:* 不能走 /api/task/reply——那会进 replyToTask 的 cli 分支→观察侧的 replyCliSession（已废弃 ps1），
  // 既撞不到活的 runner、guard 又会把「本会话自己的 claude」误判成终端占用而拒发。mb 本身就是这个 live 会话。
  const tk = mb.info?.taskKey;
  const useTaskReply = tk && !tk.startsWith('cli:');
  const r = useTaskReply
    ? await api(`/api/task/reply?taskKey=${encodeURIComponent(tk)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) }).catch((e) => ({ ok: false, error: e.message }))
    : await api(`/api/session/send?id=${encodeURIComponent(mb.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) customAlert({ title: '发送失败', message: escapeHtml(r.error || '') });
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
initReplyModelSelector();
initNewTaskModelSelector();
refreshState().then(() => {
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