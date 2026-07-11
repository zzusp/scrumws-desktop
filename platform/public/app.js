// 小小鹏 · 运行看板 · 前端交互（阶段 3 重写版）
// 三页：① 派发器（注册表驱动卡片 + 新建/调度/删除 + 运行日志）· ② 任务看板（状态分区 + 归档）· ③ 数据看板（平台守护 Runner Checker + 运营洞察）

const REFRESH_STATE_MS = 15000;
const REFRESH_LOGS_MS  = 60000;

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

// ---- 时钟 ----
function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('clock').textContent = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
tickClock(); setInterval(tickClock, 1000);

// ---- 状态 ----
let stateData = null;
let logsFilter = false;
let autoRefresh = true;
// modal 打开时暂停看板刷新 —— 用户焦点在 modal 上、看板轮询 5s 刷 detail；关闭时立即 refreshState + 重置 15s 计时
let modalOpen = false;
let modalPollTimer = null;
let modalPollTaskKey = null;
let stateTimer = null;
let logsTimer = null;
const MODAL_POLL_MS = 5000;

// ---- API ----
async function api(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

// ---- 面板 ① 派发器（Node 脚本 + 进程内调度，2026-07-10 Node 化）+ 数据看板页平台守护卡 ----
// job 实况卡的公共 HTML（派发器卡 / checker 卡共用）
function liveJobCardHtml(t, { title, mono, hint, actions = '' }) {
  const stateTag = !t.enabled
    ? '<span class="tag tag-coral">Disabled</span>'
    : t.running
      ? '<span class="tag tag-jade">Running</span>'
      : '<span class="tag tag-jade">Ready</span>';
  const lastTag = t.lastOutcome == null
    ? '<span class="tag tag-mut">last=—</span>'
    : t.lastOutcome === 'ok'
      ? '<span class="tag tag-mut">last=ok</span>'
      : `<span class="tag tag-amber" title="${escapeAttr(t.lastError || '')}">last=${escapeHtml(t.lastOutcome)}</span>`;
  const iv = t.intervalSec >= 60 && t.intervalSec % 60 === 0 ? `${t.intervalSec / 60}min` : `${t.intervalSec}s`;
  return `
    <div style="border:1px solid var(--hair);border-radius:11px;padding:14px 16px;background:var(--card2)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        ${title}
        ${stateTag}
        <label class="switch" style="margin-left:auto" title="启停 ${escapeAttr(t.id)}">
          <input type="checkbox" data-livejob="${escapeAttr(t.id)}" ${t.enabled ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
      <div style="font-family:var(--mono);font-size:10.5px;color:var(--dim);margin-bottom:8px">${mono}</div>
      <div style="font-size:11px;color:var(--mut);line-height:1.55;margin-bottom:8px">${hint}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:11px;color:var(--mut);font-family:var(--mono)">
        <span>心跳 <b style="color:var(--ink2)">${t.heartbeat}</b></span>
        <span>每 <b style="color:var(--ink2)">${iv}</b></span>
        ${lastTag}
        ${actions}
      </div>
    </div>
  `;
}

function renderDispatchers(dispatchers) {
  const grid = $('tasksGrid');
  grid.innerHTML = '';
  const schedMode = stateData?.scheduler?.mode;
  const modeTag = $('schedulerModeTag');
  if (modeTag) {
    const readonly = schedMode && schedMode !== 'running';
    modeTag.style.display = readonly ? '' : 'none';
    if (readonly) modeTag.title = `本实例调度器未运行（${schedMode}${stateData?.scheduler?.lockPid ? `，锁由 pid=${stateData.scheduler.lockPid} 持有` : ''}）`;
  }
  if (!dispatchers.length) {
    grid.innerHTML = '<div style="color:var(--dim);font-size:13px">还没有派发器 — 点右上「+ 新建派发器」按场景来源创建</div>';
    return;
  }
  for (const d of dispatchers) {
    const title = d.url
      ? `<a href="${d.url}" target="_blank" rel="noopener" title="打开当前检查的列表" style="font-weight:600;font-size:13px;color:var(--ink2);text-decoration:none;border-bottom:1px dashed var(--hair)">${escapeHtml(d.label)} <span style="font-size:10px;color:var(--mut)">↗</span></a>`
      : `<div style="font-weight:600;font-size:13px;color:var(--ink2)">${escapeHtml(d.label)}</div>`;
    const actions = [
      `<button class="btn" data-disp-edit="${escapeAttr(d.id)}" style="font-size:10.5px;padding:2px 8px" title="编辑名称 / 间隔 / 脚本内容">编辑</button>`,
      `<button class="btn" data-disp-delete="${escapeAttr(d.id)}" style="font-size:10.5px;padding:2px 8px;color:var(--coral)" title="停止调度并移出注册表（脚本文件保底改名）">删除</button>`,
    ].join('');
    grid.insertAdjacentHTML('beforeend', liveJobCardHtml(d, {
      title,
      mono: `${escapeHtml(d.scriptFile)} · ${escapeHtml(d.type)}`,
      hint: escapeHtml(d.hint || ''),
      actions: `<span style="margin-left:auto;display:inline-flex;gap:6px">${actions}</span>`,
    }));
  }
  bindLiveJobSwitches(grid, (id) => `/api/dispatcher/{action}?id=${encodeURIComponent(id)}`);
  grid.querySelectorAll('[data-disp-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openDispatcherModal('edit', btn.dataset.dispEdit));
  });
  grid.querySelectorAll('[data-disp-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.dispDelete;
      const d = (stateData?.dispatchers || []).find((x) => x.id === id);
      const okGo = await customConfirm({
        title: '删除派发器',
        message: `停止调度并从注册表移除「${escapeHtml(d?.label || id)}」？<br>脚本文件会保底改名（<code>.deleted-*</code>）；已 spawn 的 worker 不受影响；之后可从「+ 新建派发器」重建。`,
        confirmText: '删除', tone: 'danger',
      });
      if (!okGo) return;
      const r = await api(`/api/dispatcher/delete?id=${encodeURIComponent(id)}`, { method: 'POST' });
      if (!r.ok) await customAlert({ title: '删除失败', message: escapeHtml(r.error || '未知错误') });
      await refreshState();
    });
  });
}

// 数据看板页：平台守护卡（Runner Checker 不是派发器——平台内置 Node job）
function renderChecker(checker) {
  const grid = $('checkerGrid');
  if (!grid || !checker) return;
  grid.innerHTML = liveJobCardHtml(checker, {
    title: `<div style="font-weight:600;font-size:13px;color:var(--ink2)">${escapeHtml(checker.label)}</div>`,
    mono: 'dashboard/lib/jobs/runner-checker.js · 平台内置',
    hint: escapeHtml(checker.hint || ''),
  });
  bindLiveJobSwitches(grid, () => '/api/checker/{action}');
}

// 启停开关公共绑定：urlFor(id) 返回带 {action} 占位的端点
function bindLiveJobSwitches(rootEl, urlFor) {
  rootEl.querySelectorAll('input[type="checkbox"][data-livejob]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const action = cb.checked ? 'start' : 'stop';
      try {
        const r = await api(urlFor(cb.dataset.livejob).replace('{action}', action), { method: 'POST' });
        if (r && r.ok === false) await customAlert({ title: '操作失败', message: escapeHtml(r.error || '未知错误') });
        await refreshState();
      } catch (e) {
        await customAlert({ title: '操作失败', message: escapeHtml(e.message) });
        await refreshState();
      }
    });
  });
}

// ---- 新建 / 编辑派发器 modal（脚本内容直接在表单里写）----
let dispModalMode = 'create';   // 'create' | 'edit'
let dispModalId = null;
async function openDispatcherModal(mode, id = null) {
  dispModalMode = mode; dispModalId = id;
  const types = stateData?.dispatcherTypes || {};
  const sel = $('newDispType');
  const err = $('newDispErr');
  err.style.display = 'none';
  if (mode === 'create') {
    $('newDispTitle').textContent = '新建派发器';
    $('newDispSubmit').textContent = '创建';
    sel.disabled = false;
    sel.innerHTML = Object.entries(types).map(([type, t]) => {
      const gone = t.singleton && t.exists;
      return `<option value="${type}" ${gone ? 'disabled' : ''}>${escapeHtml(t.label)}（${type}）${gone ? ' · 已存在' : ''}</option>`;
    }).join('');
    const firstFree = Object.entries(types).find(([, t]) => !(t.singleton && t.exists));
    if (firstFree) sel.value = firstFree[0];
    await syncDispatcherForm();
  } else {
    const d = (stateData?.dispatchers || []).find((x) => x.id === id);
    if (!d) return;
    $('newDispTitle').textContent = `编辑派发器 · ${d.label}`;
    $('newDispSubmit').textContent = '保存';
    sel.disabled = true;
    sel.innerHTML = `<option value="${escapeAttr(d.type)}">${escapeHtml(types[d.type]?.label || d.type)}（${escapeHtml(d.type)}）</option>`;
    $('newDispLabel').value = d.label;
    $('newDispInterval').value = d.intervalSec;
    $('newDispTypeHint').textContent = types[d.type]?.hint || '—';
    $('newDispTaskName').textContent = `脚本：${d.scriptFile}`;
    $('newDispScript').value = '加载脚本中…';
    const r = await api(`/api/dispatcher/script?id=${encodeURIComponent(id)}`);
    $('newDispScript').value = r.ok ? r.content : `// 读取失败：${r.error || '未知错误'}`;
  }
  $('newDispatcherModal').style.display = 'flex';
}
window.closeNewDispatcherModal = () => { $('newDispatcherModal').style.display = 'none'; };
async function syncDispatcherForm() {
  const type = $('newDispType').value;
  const t = (stateData?.dispatcherTypes || {})[type];
  if (!t) { $('newDispTypeHint').textContent = '—'; $('newDispTaskName').textContent = '—'; return; }
  $('newDispTypeHint').textContent = t.hint;
  $('newDispLabel').value = t.label;
  $('newDispInterval').value = t.defaultIntervalSec;
  $('newDispTaskName').textContent = `脚本将存为：runtime/dispatchers/${type}.mjs`;
  $('newDispScript').value = '加载模板中…';
  const r = await api(`/api/dispatcher/template?type=${encodeURIComponent(type)}`);
  $('newDispScript').value = r.ok ? r.content : `// 模板读取失败：${r.error || '未知错误'}`;
}
$('newDispType').addEventListener('change', syncDispatcherForm);
$('newDispatcherBtn').addEventListener('click', () => openDispatcherModal('create'));
$('newDispSubmit').addEventListener('click', async () => {
  const err = $('newDispErr');
  err.style.display = 'none';
  const btn = $('newDispSubmit');
  const saving = dispModalMode === 'edit';
  btn.disabled = true; btn.textContent = saving ? '保存中…' : '创建中…';
  try {
    const payload = {
      label: $('newDispLabel').value,
      intervalSec: Number($('newDispInterval').value),
      script: $('newDispScript').value,
    };
    const url = saving
      ? `/api/dispatcher/update?id=${encodeURIComponent(dispModalId)}`
      : '/api/dispatcher/create';
    if (!saving) payload.type = $('newDispType').value;
    const r = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) { err.textContent = r.error || '失败'; err.style.display = 'block'; return; }
    closeNewDispatcherModal();
    await refreshState();
  } catch (e) {
    err.textContent = e.message; err.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = saving ? '保存' : '创建';
  }
});

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

function taskCardHtml(t, section) {
  const isCli = t.source === 'cli';
  const cost = t.meta?.totalCostUsd ? '$' + t.meta.totalCostUsd.toFixed(4) : '';
  const rounds = t.meta?.rounds ? `${t.meta.rounds} 轮` : '';
  const totalDur = fmtDuration(t.durationMs);

  let statusLine = '';
  if (isCli) {
    // CLI 卡片：只读展示 cwd + 心跳 + turns；无 pid / 无失败原因
    const cwd = t.cli?.cwd || '—';
    const cwdShort = cwd.length > 40 ? '…' + cwd.slice(-38) : cwd;
    const turns = t.meta?.numTurns ? `${t.meta.numTurns} turns` : '';
    const pending = t.cli?.pendingBackgroundAgentCount > 0 ? ` · <span style="color:var(--amber)">bg×${t.cli.pendingBackgroundAgentCount}</span>` : '';
    const heartbeat = t.lease?.heartbeatAgo ? ` · 心跳 ${t.lease.heartbeatAgo}` : '';
    statusLine = `<div style="font-size:11px;color:var(--mut);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(cwd)}">${escapeHtml(cwdShort)}</div><div style="font-size:11px;color:var(--dim);font-family:var(--mono);margin-top:2px">${turns} · 总耗时 ${totalDur}${heartbeat}${pending}</div>`;
  } else if (section === 'plan') {
    statusLine = `<div style="font-size:11px;color:var(--mut);font-family:var(--mono)">待确认 · 建于 ${escapeHtml(t.createdAt || t.enteredAt || '—')}</div>`;
  } else if (section === 'processing') {
    const durMin = t.lease?.durationMin ?? '?';
    const intent = t.lease?.intent ? `<div style="font-size:11.5px;color:var(--ink2);margin-top:4px;line-height:1.5">${escapeHtml(t.lease.intent)}</div>` : '';
    statusLine = `<div style="font-size:11px;color:var(--mut);font-family:var(--mono)">已跑 ${durMin}min · 总耗时 ${totalDur} · 心跳 ${t.lease?.heartbeatAgo || '—'} · pid=${t.lease?.pid || '?'}</div>${intent}`;
  } else if (section === 'queued') {
    const queuedAge = t.queuedAgeMin;
    const style = queuedAge != null && queuedAge > 2 ? 'color:var(--coral)' : 'color:var(--mut)';
    statusLine = `<div style="font-size:11px;font-family:var(--mono);${style}">queued ${queuedAge ?? '?'}min · 总耗时 ${totalDur}</div>`;
  } else if (section === 'done') {
    statusLine = `<div style="font-size:11px;color:var(--mut);font-family:var(--mono)">${t.resolvedAgo || '—'} · 耗时 ${totalDur} · ${rounds} · ${cost}</div>`;
  } else if (section === 'awaiting-human') {
    const reason = t.outcomeDetail?.failureReason || t.outcome || '未知';
    const short = reason.length > 60 ? reason.slice(0, 60) + '…' : reason;
    statusLine = `<div style="font-size:11px;color:var(--coral);font-family:var(--mono)">${escapeHtml(short)}</div><div style="font-size:11px;color:var(--dim);font-family:var(--mono);margin-top:2px">${t.resolvedAgo || '—'} · 耗时 ${totalDur}</div>`;
  } else {
    statusLine = `<div style="font-size:11px;color:var(--mut);font-family:var(--mono)">${t.resolvedAgo || '—'} · 耗时 ${totalDur}</div>`;
  }

  // 来源标签：chat 链走 dws（钉钉工具链），会话细分（self/group/dm）看底部 taskKey 短码；cli 独立
  const sourceTag = t.source === 'chat'
    ? '<span class="tag tag-cyan">dws</span>'
    : t.source === 'issue'
      ? '<span class="tag tag-amber">issue</span>'
      : t.source === 'cli'
        ? '<span class="tag" style="background:var(--brandS);color:var(--brand)">CLI</span>'
        : '<span class="tag tag-mut">' + (t.source || '?') + '</span>';

  // 按钮（底部 ghost 化，卡片 hover 提亮）：✎ 描述常驻；plan=确认排队+归档；processing/queued=中断；done/awaiting-human=归档
  const descBtn = `<button class="btn" onclick="event.stopPropagation();editTaskDesc('${escapeAttr(t.taskKey)}')" title="${t.description ? '编辑' : '添加'}任务描述（自己看的备注，不发给 claude）">✎ 描述</button>`;
  let actionBtn = '';
  if (isCli) {
    // CLI 卡片只读：processing/awaiting-human 可归档（收进已归档区）；archived 可取消归档；两态都有「移除」
    const rmBtn = `<button class="btn" style="color:var(--coralT)" onclick="event.stopPropagation();removeCliSession('${escapeAttr(t.meta?.sessionId || '')}')" title="从看板 watchlist 移除（不影响 CLI session 本体）">移除</button>`;
    if (section === 'archived' || t.cli?.archivedAt) {
      actionBtn = `<button class="btn" onclick="event.stopPropagation();unarchiveCliTask('${escapeAttr(t.taskKey)}')" title="取消归档，回落 mtime 自动判态（processing/awaiting-human）">↺ 取消归档</button>${rmBtn}`;
    } else {
      actionBtn = `<button class="btn" onclick="event.stopPropagation();archiveTask('${escapeAttr(t.taskKey)}')" title="收进已归档区（不影响 CLI session 本体，可随时取消归档）">归档</button>${rmBtn}`;
    }
  } else if (section === 'plan') {
    actionBtn = `<button class="btn" style="color:var(--jade)" onclick="event.stopPropagation();approveTaskAction('${escapeAttr(t.taskKey)}')">▶ 确认排队</button><button class="btn" onclick="event.stopPropagation();archiveTask('${escapeAttr(t.taskKey)}')" title="不做了，直接归档">归档</button>`;
  } else if (section === 'processing' || section === 'queued') {
    actionBtn = `<button class="btn" style="color:var(--coralT)" onclick="event.stopPropagation();cancelTaskAction('${escapeAttr(t.taskKey)}')">中断</button>`;
  } else if (section === 'done' || section === 'awaiting-human') {
    actionBtn = `<button class="btn" onclick="event.stopPropagation();archiveTask('${escapeAttr(t.taskKey)}')">归档</button>`;
  }
  // 任务描述（用户备注）：有则显示一行截断，点击直接编辑
  const descLine = t.description
    ? `<div style="font-size:11px;color:var(--ink2);margin-top:6px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" title="点击编辑描述：${escapeAttr(t.description)}" onclick="event.stopPropagation();editTaskDesc('${escapeAttr(t.taskKey)}')"><span style="color:var(--dim)">✎</span> ${escapeHtml(t.description)}</div>`
    : '';

  // 标题：优先 customTitle > 第一条真人 cc: > taskKey；customTitle 有加"★"标记（已重命名）
  const titleText = t.title || t.taskKey;
  const titleShort = titleText.length > 60 ? titleText.slice(0, 60) + '…' : titleText;
  const titleBadge = t.hasCustomTitle ? '<span title="已重命名" style="color:var(--amber);font-size:10px;margin-right:4px">★</span>' : '';

  return `
    <div class="taskcard" data-taskkey="${escapeAttr(t.taskKey)}" onclick="openTaskModal('${escapeAttr(t.taskKey)}')">
      <div style="font-weight:600;font-size:13px;color:var(--ink);line-height:1.45;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all" title="${escapeAttr(titleText)}">${titleBadge}${escapeHtml(titleShort)}</div>
      ${statusLine}
      ${descLine}
      <div class="card-foot">
        ${sourceTag}
        <span class="card-key" title="${escapeAttr(t.taskKey)}">${escapeHtml(shortTaskKey(t.taskKey))}</span>
        <span class="cardbtns">${descBtn}${actionBtn}</span>
      </div>
    </div>
  `;
}

// taskKey 短码（卡片底部展示；hover 全 key）：issue:HiQ-AI-feedback#69 → feedback#69、chat:self → self、manual:m…-183 → m…-183、cli:04689bb1 → 04689bb1
function shortTaskKey(k) {
  const m = /^issue:.*?([A-Za-z0-9_]+)#(\d+)$/.exec(k);
  if (m) return `${m[1]}#${m[2]}`;
  if (k.startsWith('chat:')) return k.slice(5);
  if (k.startsWith('manual:')) return k.slice(7);
  if (k.startsWith('cli:')) return k.slice(4);
  return k;
}

function renderLifecycle(lifecycle) {
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

// ---- 面板 ③ 运行日志 ----
function renderLogs(payload) {
  $('logsStats').textContent = `${payload.entries.length} 行 · 动作 ${payload.stats.action} · 异常 ${payload.stats.error} · 近 ${payload.stats.windowHours}h`;
  const list = $('logsList');
  const entries = logsFilter ? payload.entries.filter((e) => e.action) : payload.entries;
  if (entries.length === 0) {
    list.innerHTML = `<div style="color:var(--dim);padding:8px 0">无日志</div>`;
    return;
  }
  const html = entries.map((e) => {
    const color = e.kind === 'error' ? 'var(--coral)'
                : e.kind === 'checker' ? 'var(--amber)'
                : e.kind === 'spawn' ? 'var(--jade)'
                : e.kind === 'quota' ? 'var(--coral)'
                : e.kind === 'complete' ? 'var(--jade)'
                : 'var(--ink2)';
    const srcTag = e.source === 'chat' ? 'tag-cyan' : e.source === 'issue' ? 'tag-amber' : 'tag-mut';
    return `
      <div class="logrow">
        <span style="color:var(--dim);font-size:10.5px;min-width:60px">${e.time}</span>
        <span class="tag ${srcTag}" style="min-width:44px;text-align:center">${e.source}</span>
        <span style="color:${color};flex:1;line-height:1.5;word-break:break-all">${escapeHtml(e.msg)}</span>
      </div>
    `;
  }).join('');
  list.innerHTML = html;
}

$('logsRefreshBtn').addEventListener('click', () => refreshLogs());
$('logsActionOnly').addEventListener('change', (e) => {
  logsFilter = e.target.checked;
  if (stateData?.logsCache) renderLogs(stateData.logsCache);
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
    message: `强杀 worker 进程、state 改为 <code>awaiting-human</code>（outcome=cancelled）。<br>已产生的副作用（commit / 发出的消息）<b>不会回滚</b>。<br>之后可在 detail 里继续对话恢复（<code>--resume</code>）、或直接归档清走。<br><b>该会话的自动派发会暂停</b>，归档 / 重新发起后恢复。<br><br>目标：<code>${escapeHtml(taskKey)}</code>`,
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

// ---- 任务详情页（单一对话流 + 右侧信息栏）----
let currentModalData = null;
let lastModalFp = null;             // poll 内容指纹：没新内容不重画 DOM（保住滚动位置和 details 展开态）

// 卡片点击入口：跳 hash 路由（#/task/<key>），由 router 调 loadTaskDetail 渲染详情页
window.openTaskModal = (taskKey) => { location.hash = '#/task/' + encodeURIComponent(taskKey); };

async function loadTaskDetail(taskKey) {
  modalOpen = true;
  modalPollTaskKey = taskKey;
  // 从 stateData 里取该任务的 title/hasCustomTitle 用于详情页顶部展示
  const t = findTaskInState(taskKey);
  const displayTitle = t?.title || taskKey;
  renderModalTitle(taskKey, displayTitle, t?.hasCustomTitle);
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
    renderModalCwd(r);
    renderTaskSide(taskKey);
    // 回复框显示/禁用判据：需有 meta.sessionId + state ≠ processing
    updateReplyBoxAvailability(taskKey);
    // processing 任务：启动 modal 内 5s poll 拉最新 jsonl（含 in-flight round）
    ensureModalPoll(taskKey);
  } catch (e) {
    $('modalBody').innerHTML = `<div style="color:var(--coral)">${e.message}</div>`;
  }
}

// modal 内轮询：processing 任务每 5s 拉 worker-log；state 变了自动停 poll
function ensureModalPoll(taskKey) {
  if (modalPollTimer) { clearInterval(modalPollTimer); modalPollTimer = null; }
  const t = findTaskInState(taskKey);
  if (t?.state !== 'processing') return;
  modalPollTimer = setInterval(() => reloadModalIfProcessing(taskKey), MODAL_POLL_MS);
}

async function reloadModalIfProcessing(taskKey) {
  if (!modalOpen || modalPollTaskKey !== taskKey) {
    if (modalPollTimer) { clearInterval(modalPollTimer); modalPollTimer = null; }
    return;
  }
  try {
    // 先拉 state（modal 打开时看板 poll 被门控 skip 掉，findTaskInState 会陈旧；这里主动喂）
    const s = await api('/api/state');
    stateData = s;
    // 拉 worker-log
    const r = await api(`/api/worker-log?taskKey=${encodeURIComponent(taskKey)}`);
    if (!r.ok) return;
    currentModalData = r;
    const roundsCnt = r.rounds.length;
    const t = findTaskInState(taskKey);
    // title 随 cc: 解析出来会更新；正在 inline 重命名时不打断输入
    if (!document.getElementById('modalTitleInput')) {
      renderModalTitle(taskKey, t?.title || taskKey, t?.hasCustomTitle);
    }
    // 内容指纹没变就不重画（重画会丢滚动位置和 details 展开态——处理中"显示变动"的根因）
    const fp = JSON.stringify([roundsCnt, r.rounds.map((x) => (x.messages || []).length), r.hasInflight, t?.state, (t?.history || []).length]);
    if (fp !== lastModalFp) {
      lastModalFp = fp;
      renderModalBody(true);
      renderModalCwd(r);
      renderTaskSide(taskKey);
    }
    updateReplyBoxAvailability(taskKey);
    // state 已收敛 → 停 poll（下次 open 才再评估）
    if (t && t.state !== 'processing') {
      clearInterval(modalPollTimer); modalPollTimer = null;
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

// 标题下方：工作目录（取最新一轮 systemInit.cwd；跨轮不同则退化为"多个目录"提示，具体见 tooltip）
function renderModalCwd(r) {
  const el = $('modalCwd');
  if (!el) return;
  const cwds = [...new Set((r?.rounds || []).map((x) => x?.cwd || x?.systemInit?.cwd).filter(Boolean))];
  if (cwds.length === 0) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  const last = cwds[cwds.length - 1];
  const extra = cwds.length > 1 ? ` <span class="k" title="${escapeAttr(cwds.join('\n'))}">（其他轮 ${cwds.length - 1} 个）</span>` : '';
  el.innerHTML = `<span class="k">工作目录</span>${escapeHtml(last)}${extra}`;
}

// Modal 顶部 title 渲染（支持点击 inline edit）
function renderModalTitle(taskKey, title, hasCustom) {
  const star = hasCustom ? '<span title="已重命名" style="color:var(--amber);margin-right:4px">★</span>' : '';
  $('modalTitle').innerHTML = `
    <span style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
      ${star}
      <span id="modalTitleText" style="cursor:pointer;font-family:var(--display);font-size:16px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1" title="点击重命名">${escapeHtml(title)}</span>
    </span>
  `;
  $('modalTitleText').addEventListener('click', () => beginRename(taskKey));
}

function beginRename(taskKey) {
  const t = findTaskInState(taskKey);
  const currentTitle = t?.title || taskKey;
  const star = t?.hasCustomTitle ? '<span title="已重命名" style="color:var(--amber);margin-right:4px">★</span>' : '';
  $('modalTitle').innerHTML = `
    <span style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
      ${star}
      <input id="modalTitleInput" type="text" value="${escapeAttr(currentTitle)}" maxlength="200" style="flex:1;min-width:0;font-family:var(--display);font-size:16px;font-weight:600;padding:4px 10px;border:1px solid var(--hair2);border-radius:8px;background:var(--card);color:var(--ink);outline:none">
      <button class="btn btn-primary" id="modalRenameSave" style="font-size:11px;padding:3px 12px;flex:none">保存</button>
      <button class="btn" id="modalRenameCancel" style="font-size:11px;padding:3px 12px;flex:none">取消</button>
    </span>
  `;
  const input = $('modalTitleInput');
  input.focus();
  input.select();
  const submit = async () => {
    const newTitle = input.value.trim();
    try {
      const r = await api(`/api/task/rename?taskKey=${encodeURIComponent(taskKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      if (!r.ok) { customAlert({ title: '重命名失败', message: escapeHtml(r.error) }); return; }
      await refreshState();
      const t2 = findTaskInState(taskKey);
      renderModalTitle(taskKey, t2?.title || taskKey, t2?.hasCustomTitle);
    } catch (e) { customAlert({ title: '重命名失败', message: escapeHtml(e.message) }); }
  };
  const cancel = () => {
    const t3 = findTaskInState(taskKey);
    renderModalTitle(taskKey, t3?.title || taskKey, t3?.hasCustomTitle);
  };
  $('modalRenameSave').addEventListener('click', submit);
  $('modalRenameCancel').addEventListener('click', cancel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') cancel();
  });
}

// 状态徽章色调映射（与 taskCardHtml 对齐）
const STATE_TAG = {
  plan:           { cls: 'tag-cyan',  label: 'plan' },
  queued:         { cls: 'tag-mut',   label: 'queued' },
  processing: { cls: 'tag-amber', label: 'processing' },
  done:           { cls: 'tag-jade',  label: 'done' },
  'awaiting-human': { cls: 'tag-coral', label: 'awaiting-human' },
  cancelled:      { cls: 'tag-coral', label: 'cancelled' },   // 仅旧归档数据显示兼容；2026-07-10 起中断写 awaiting-human
};
function stateTagHtml(state) {
  const m = STATE_TAG[state] || { cls: 'tag-mut', label: state || '?' };
  return `<span class="tag ${m.cls}" style="font-size:10px">${escapeHtml(m.label)}</span>`;
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
  body.scrollTop = keepScroll ? (wasAtBottom ? body.scrollHeight : prevScroll) : body.scrollHeight;
}

// ---- hash 路由：#/dispatcher · #/board · #/dashboard · #/task/<taskKey>（旧 /<tab> 后缀兼容忽略）----
const ROUTE_VIEWS = ['dispatcher', 'board', 'dashboard', 'task'];
function router() {
  const h = location.hash || '#/board';
  let view = 'board';
  let taskKey = null;
  const mTask = /^#\/task\/([^/]+)(?:\/(?:overview|detail|timeline))?$/.exec(h);
  if (mTask) {
    view = 'task';
    taskKey = decodeURIComponent(mTask[1]);
  } else if (h.startsWith('#/dispatcher')) view = 'dispatcher';
  else if (h.startsWith('#/dashboard')) view = 'dashboard';

  for (const v of ROUTE_VIEWS) { const el = $(`view-${v}`); if (el) el.style.display = v === view ? (v === 'task' ? 'flex' : '') : 'none'; }
  // 详情页是 pageWrap 外的满宽满高布局，进入时隐藏常规页面容器（含 footer）
  $('pageWrap').style.display = view === 'task' ? 'none' : '';
  document.querySelectorAll('.topnav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === view || (view === 'task' && a.dataset.nav === 'board'));
  });

  // 离开详情页：停详情轮询 + 立即刷一次看板并重置计时
  if (view !== 'task' && modalOpen) {
    modalOpen = false;
    modalPollTaskKey = null;
    if (modalPollTimer) { clearInterval(modalPollTimer); modalPollTimer = null; }
    $('modalReplyBox').style.display = 'none';
    refreshState();
    scheduleStateRefresh();
  }
  if (view === 'task' && taskKey) loadTaskDetail(taskKey);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);

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
  const hasSid = !!(t?.meta?.sessionId);
  const processing = t?.state === 'processing';
  const isCli = t?.source === 'cli';
  // queued 场景 = quota 后回排队 / spawn 失败（manual 无派发器全靠人工拉起）；lease 存活 = worker 在起，不给重发
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
  // 清旧事件监听（防止上次 modal 的旧 handler 残留）
  send.onclick = null;
  restartBtn.onclick = null;
  text.onkeydown = null;
  text.oninput = null;

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
    // 空闲且无占用：开放 composer，走 /api/task/reply（后端路由到 cli-reply-runner → claude --resume）
    stateTag.textContent = 'CLI · 可回复';
    hint.innerHTML = '终端已关闭 · 从看板发消息将以 <b>headless --resume</b> 续跑该 session';
    replyBody.style.display = 'flex';
    text.disabled = false; send.disabled = false;
    text.value = '';
    updateReplyCount(0, countEl);
    if (typeof window.__resetReplyModel === 'function') window.__resetReplyModel();
    send.onclick = () => sendReply(taskKey);
    text.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(taskKey); } };
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
    showReplyToast('已提交、runner 在处理中… 10s 后自动刷新 detail', 'ok');
    setTimeout(async () => { await refreshState(); loadTaskDetail(taskKey); }, 10000);
  } catch (e) {
    showReplyToast(e.message, 'err');
  } finally {
    send.disabled = false; text.disabled = false; send.textContent = '发送 ⏎';
  }
}

// ---- Escape helpers ----
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
// 用户消息展示前剥掉钉钉链的指令前缀（cc: 是派发机制的触发词，任务视图里不出现这种用法）
function stripDirectivePrefix(s) { return String(s || '').replace(/^\s*cc[:：]\s*/i, ''); }

// ---- 右侧信息栏：任务信息 kv / 描述 / 快捷操作（参考 detail-side）----
function renderTaskSide(taskKey) {
  const el = $('taskSide');
  if (!el) return;
  const t = findTaskInState(taskKey);
  const r = currentModalData;
  if (!t) { el.innerHTML = ''; return; }
  const rounds = (r?.rounds || []).filter((x) => !x.error);
  const meta = t.meta || {};
  const usage = meta.usage || {};
  const lastOk = rounds[rounds.length - 1] || null;
  const isCli = t.source === 'cli';
  const model = isCli ? (t.meta?.model || '—') : (lastOk?.ccSummary?.model || lastOk?.systemInit?.model || '—');
  const srcTxt = t.source === 'chat' ? `dws / ${t.kind || '?'}` : (t.source === 'cli' ? `本机 CLI · ${t.cli?.version || '?'}` : (t.source || '—'));
  const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
  const kv = (k, v) => `<div class="side-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const tags = [
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
  // 快捷操作（与看板卡片同一套全局动作）；CLI 卡片：归档/取消归档 + 从看板移除
  const btns = [];
  if (isCli) {
    if (t.cli?.archivedAt) {
      btns.push(`<button class="btn" onclick="unarchiveCliTask('${escapeAttr(t.taskKey)}')">↺ 取消归档</button>`);
    } else {
      btns.push(`<button class="btn" onclick="archiveTask('${escapeAttr(t.taskKey)}')">归档</button>`);
    }
    btns.push(`<button class="btn btn-danger" onclick="removeCliSession('${escapeAttr(t.meta?.sessionId || '')}')">从看板移除</button>`);
  } else {
    if (t.state === 'plan' && !t.isArchive) btns.push(`<button class="btn" style="color:var(--jade);border-color:color-mix(in oklab, var(--success) 40%, transparent)" onclick="approveTaskAction('${escapeAttr(t.taskKey)}')">▶ 确认排队</button>`);
    if (['queued', 'processing'].includes(t.state) && !t.isArchive) btns.push(`<button class="btn btn-danger" onclick="cancelTaskAction('${escapeAttr(t.taskKey)}')">中断</button>`);
    if ((t.resolvedAt || t.state === 'plan') && !t.isArchive) btns.push(`<button class="btn" onclick="archiveTask('${escapeAttr(t.taskKey)}')">归档</button>`);
  }
  const descText = t.description || '';
  // 工作时长：claude 实际在算的时长（区别于创建→结束的墙钟总耗时）
  // - CLI：ccSummary.workMs（turn_duration 事件 durationMs 累加，不含用户输入间隔）
  // - 分身：各轮 rounds.jsonl 的 startedAt→endedAt 之和
  let workMs = 0;
  if (isCli) {
    workMs = rounds[0]?.ccSummary?.workMs || 0;
  } else {
    (r?.rounds || []).forEach((rd) => {
      if (rd.startedAt && rd.endedAt) {
        const d = new Date(rd.endedAt) - new Date(rd.startedAt);
        if (d > 0 && !isNaN(d)) workMs += d;
      }
    });
  }
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
  // CLI 独有字段块（cwd / gitBranch / version / mode / pendingBg / jsonl 大小）
  const cliBlock = isCli ? `
      ${kv('cwd', escapeHtml(t.cli?.cwd || '—'))}
      ${kv('git', escapeHtml(t.cli?.gitBranch || '—'))}
      ${kv('mode', escapeHtml(t.cli?.mode || '—'))}
      ${kv('后台 agent', t.cli?.pendingBackgroundAgentCount || 0)}
      ${kv('jsonl 大小', t.cli?.jsonlBytes ? (t.cli.jsonlBytes / 1024 / 1024).toFixed(2) + ' MB' : '—')}
  ` : '';
  el.innerHTML = `
    <div class="side-block">
      <h3>任务信息</h3>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px">${tags}</div>
      ${kv('taskKey', escapeHtml(t.taskKey))}
      ${kv('来源', escapeHtml(srcTxt))}
      ${cliBlock}
      ${kv('模型', escapeHtml(model))}
      ${isCli ? '' : kv('轮次', meta.rounds || rounds.length || 0)}
      ${kv('turns', fmtNum(meta.numTurns))}
      ${isCli ? '' : kv('成本', meta.totalCostUsd ? '$' + (+meta.totalCostUsd).toFixed(4) : '—')}
      ${isCli ? '' : kv('tokens', `${fmtNum(usage.inputTokens ?? 0)} / ${fmtNum(usage.outputTokens ?? 0)}`)}
      ${isCli ? '' : kv('缓存读', fmtNum(usage.cacheReadTokens ?? 0))}
      ${kv('创建', escapeHtml(t.createdAt || '—'))}
      ${kv(isCli ? '最近活动' : '结束', escapeHtml(isCli ? (t.lease?.heartbeatAt || '—') : (t.resolvedAt || '—')))}
      ${kv('总耗时', fmtDuration(t.durationMs))}
      ${kv('工作时长', workMs > 0 ? fmtDuration(workMs) : '—')}
      ${failureHtml}
      ${commentHtml}
    </div>
    <div class="side-block">
      <h3>任务描述 <button class="btn" style="margin-left:auto;font-size:10px;padding:1px 9px" onclick="editTaskDesc('${escapeAttr(t.taskKey)}')">✎ 编辑</button></h3>
      ${descText
        ? `<div style="font-size:12.5px;color:var(--ink2);line-height:1.7;white-space:pre-wrap;word-break:break-word">${escapeHtml(descText)}</div>`
        : '<div style="font-size:11.5px;color:var(--dim)">暂无 · 自己看的备注，不会发给 claude</div>'}
    </div>
    ${btns.length ? `<div class="side-block"><h3>操作</h3><div class="side-actions">${btns.join('')}</div></div>` : ''}
    ${tlHtml ? `<div class="side-block"><h3>动态</h3><div class="timeline">${tlHtml}</div></div>` : ''}
  `;
}

function renderDetailTab(r) {
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
    parts.push(renderCcFlow(units, resultById, false));
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
    if (roundDur > 0 && !isNaN(roundDur)) {
      parts.push(`<div class="cc-dur cc-dur-total"><span>✻</span><span>Worked for ${fmtDuration(roundDur)} in total${round.inflight ? '（进行中）' : ''}</span></div>`);
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

function renderCcTool(c, result) {
  const name = escapeHtml(c.name || 'Tool');
  const arg = escapeHtml(toolArgSummary(c));
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
          <summary><span class="cc-name">${name}</span><span class="cc-args">(${arg})</span></summary>
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
function renderCcFlow(units, resultById, forceOpen) {
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
    const inner = group.map((x) => (x.t === 'tool' ? renderCcTool(x.c, x.res) : renderCcThink(x.c))).join('');
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
// 同一 session、同一张卡片；被截掉的原时间线备份在 runtime/rewind-backup/）
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
    const r = await api('/api/cli/rewind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskKey, uuid, message: v.trim() }),
    });
    if (!r.ok) { customAlert({ title: 'rewind 失败', message: escapeHtml(r.error || '未知错误') }); return; }
    await refreshState();
    // 同一张卡片：留在当前详情页，重拉最新会话流
    loadTaskDetail(taskKey);
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
    renderDispatchers(stateData.dispatchers || []);
    renderChecker(stateData.checker);
    renderLifecycle(stateData.lifecycle);
    renderAuthBanner(stateData.authBlock);
    // 同步暂停开关状态（避免与真实 config 脱节）
    if (stateData.runnerConfig) {
      const paused = !!stateData.runnerConfig.pauseInvestigation;
      $('pauseSwitch').checked = paused;
      updatePauseUI(paused);
    }
  } catch (e) { console.error('state error:', e); }
}

// ---- dws 授权失效红条（authBlock 有值 → 显示；恢复正常 → 隐藏）----
function renderAuthBanner(ab) {
  const banner = $('authBanner');
  if (!ab) { banner.style.display = 'none'; return; }
  $('authBannerReason').textContent = ab.reason || 'dws 授权失效';
  const bits = [];
  if (ab.writtenAt) bits.push(`熔断于 ${ab.writtenAt}`);
  if (ab.source) bits.push(`来源 ${ab.source}`);
  if (ab.expiresAt) bits.push(`token 到期 ${ab.expiresAt}`);
  bits.push('登录后下一 tick 自动恢复（无需重启）');
  $('authBannerMeta').textContent = bits.join(' · ');
  banner.style.display = '';
}
$('authBannerCopy').addEventListener('click', async () => {
  const btn = $('authBannerCopy');
  try {
    await navigator.clipboard.writeText('dws auth login');
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch (e) {
    btn.textContent = '复制失败';
    setTimeout(() => { btn.textContent = '复制'; }, 1500);
  }
});
async function refreshLogs() {
  try {
    const payload = await api('/api/logs?hours=8');
    if (!stateData) stateData = {};
    stateData.logsCache = payload;
    renderLogs(payload);
  } catch (e) { console.error('logs error:', e); }
}

$('autoRefreshSwitch').addEventListener('change', (e) => { autoRefresh = e.target.checked; });

// ---- 新建任务 Modal ----
$('newTaskBtn').addEventListener('click', () => {
  $('newTaskModal').style.display = 'flex';
  $('newTaskTitle').value = '';
  $('newTaskPrompt').value = '';
  $('newTaskDesc').value = '';
  $('newTaskPlanFirst').checked = false;
  newTaskModelCtl?.setValue('claude-opus-4-8');
  $('newTaskErr').style.display = 'none';
  $('newTaskWarn').style.display = 'none';
  setTimeout(() => $('newTaskTitle').focus(), 100);
});
window.closeNewTaskModal = () => { $('newTaskModal').style.display = 'none'; };
$('newTaskSubmit').addEventListener('click', async () => {
  const title = $('newTaskTitle').value.trim();
  const prompt = $('newTaskPrompt').value.trim();
  const description = $('newTaskDesc').value.trim();
  const planFirst = $('newTaskPlanFirst').checked;
  const model = $('newTaskModel').value;
  const errBox = $('newTaskErr');
  const warnBox = $('newTaskWarn');
  errBox.style.display = 'none';
  warnBox.style.display = 'none';
  if (!title) { errBox.textContent = 'Title 必填'; errBox.style.display = 'block'; return; }
  if (!prompt) { errBox.textContent = 'Prompt 必填'; errBox.style.display = 'block'; return; }
  const btn = $('newTaskSubmit');
  btn.disabled = true; btn.textContent = '提交中…';
  try {
    const r = await api('/api/task/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, prompt, model, description, planFirst }),
    });
    if (!r.ok) {
      errBox.textContent = r.error || '未知错误';
      errBox.style.display = 'block';
      return;
    }
    if (!r.spawned && r.reason) {
      warnBox.textContent = `任务已建（${r.taskKey}）但未 spawn：${r.reason}`;
      warnBox.style.display = 'block';
      setTimeout(() => { closeNewTaskModal(); refreshState(); }, 3000);
    } else {
      closeNewTaskModal();
      await refreshState();
    }
  } catch (e) {
    errBox.textContent = e.message;
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = '提交';
  }
});

// ---- 添加本机 CLI 会话 Modal ----
$('addCliBtn').addEventListener('click', () => {
  $('addCliModal').style.display = 'flex';
  $('addCliSearch').value = '';
  $('addCliResults').innerHTML = '<div style="color:var(--dim);font-size:12.5px;padding:14px;text-align:center">输入关键字或 sid 前缀，回车搜索</div>';
  $('addCliErr').style.display = 'none';
  setTimeout(() => $('addCliSearch').focus(), 100);
});
window.closeAddCliModal = () => { $('addCliModal').style.display = 'none'; };

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

function renderCliCandidateRow(c) {
  const short = c.sid.slice(0, 8);
  const msg = c.firstUserMsg ? escapeHtml(c.firstUserMsg) : '<span style="color:var(--dim);font-style:italic">（无真人 user message · 可能是 subagent 会话）</span>';
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
    // 重跑一次搜索让列表刷新 alreadyAdded
    if ($('addCliSearch').value.trim()) doCliSearch();
  } catch (e) { errBox.textContent = e.message; errBox.style.display = 'block'; }
};

window.unarchiveCliTask = async (taskKey) => {
  try {
    const r = await api(`/api/cli/unarchive?taskKey=${encodeURIComponent(taskKey)}`, { method: 'POST' });
    if (!r.ok) { customAlert({ title: '取消归档失败', message: escapeHtml(r.error || '未知错误') }); return; }
    await refreshState();
    if (modalOpen && modalPollTaskKey === taskKey) renderTaskSide(taskKey);
  } catch (e) { customAlert({ title: '取消归档失败', message: escapeHtml(e.message) }); }
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

// 暂停派发 toggle
$('pauseSwitch').addEventListener('change', async (e) => {
  const paused = e.target.checked;
  try {
    await api(`/api/runner/${paused ? 'pause' : 'resume'}`, { method: 'POST' });
    updatePauseUI(paused);
    await refreshState();
  } catch (err) {
    customAlert({ title: '切换失败', message: escapeHtml(err.message) });
    e.target.checked = !paused;   // 回滚
  }
});
function updatePauseUI(paused) {
  const label = $('pauseLabel');
  if (paused) {
    label.textContent = '派发已暂停';
    label.style.color = 'var(--coral)';
  } else {
    label.textContent = '派发中';
    label.style.color = 'var(--mut)';
  }
}

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

// 计时器重排（modal 关闭时调用即可"重新计时 15s"；modal 打开期间轮询由 modalOpen 门控跳过）
function scheduleStateRefresh() {
  if (stateTimer) clearInterval(stateTimer);
  stateTimer = setInterval(() => { if (autoRefresh && !modalOpen) refreshState(); }, REFRESH_STATE_MS);
}
function scheduleLogsRefresh() {
  if (logsTimer) clearInterval(logsTimer);
  logsTimer = setInterval(() => { if (autoRefresh && !modalOpen) refreshLogs(); }, REFRESH_LOGS_MS);
}

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
refreshLogs();
scheduleStateRefresh();
scheduleLogsRefresh();