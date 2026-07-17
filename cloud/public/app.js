'use strict';
/* ==========================================================================
   云端控制面前端（P0+P1）—— 原生 JS + fetch，零依赖
   契约：docs/spec/cloud-p0p1-contract.md（§6.1–6.3 会话 / §6.7 机器 / §6.11–6.12 任务）
   这是**只读大盘**：除登录 / 退出外不发起任何写请求（派活 / 回复是 P2/P3）。
   ========================================================================== */

const $ = (id) => document.getElementById(id);

// ---------- 基础工具 ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// 相对时间：云端所有时间字段都是 ISO-8601（契约 §4），本地化交给浏览器
function fmtAgo(iso) {
  const t = Date.parse(iso ?? '');
  if (!isFinite(t)) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
function fmtDateTime(iso) {
  const t = Date.parse(iso ?? '');
  if (!isFinite(t)) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtMoney(v) {
  const n = Number(v);
  return isFinite(n) ? '$' + n.toFixed(4) : '—';
}
// token 压缩显示：与本地看板 platform/public/app.js:1540 的 compactTokens 逐字同口径
// （两个看板的用量数字必须读起来一样，别各造一套阈值）
function compactTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// ---------- API ----------
/** 统一出站。会话走 HttpOnly cookie（契约 §3.2），不碰任何浏览器存储。 */
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON 响应体（如 502 网关页）→ json 保持 null */ }
  return { status: r.status, json };
}
/** 契约 §6 统一错误体 { error: { code, message } } */
function errMsg(r, fallback = '请求失败') {
  return r.json?.error?.message || r.json?.error?.code || `${fallback}（HTTP ${r.status}）`;
}
/** 会话失效 → 回登录页。返回 true 表示调用方应中止后续渲染。 */
function guard401(r) {
  if (r.status !== 401) return false;
  me = null;
  showLogin();
  return true;
}

// ---------- 全局状态 ----------
let me = null;                 // { user, workspace }
let machines = [];             // GET /api/machines 的结果（看板筛选 + 机器页共用）
let refreshTimer = null;
const REFRESH_MS = 15000;      // 与本地看板默认轮询同频（app.js:6 REFRESH_MS_DEFAULT）
const boardFilter = { machineId: '', mirror: '', q: '' };

// 看板 5 个桶。云端 GET /api/tasks 无 state 分桶接口 → 每桶各查一次（契约 §6.11 的 state 参数），
// 各自带回自己的 total，列头计数才是真数（单次拉 200 条再前端分桶会让 done 挤掉 processing）。
const BUCKETS = ['plan', 'queued', 'processing', 'awaiting-human', 'done'];
const BUCKET_LIMIT = 100;

// ==========================================================================
// 登录（契约 §6.1 / §6.3）
// ==========================================================================
function showLogin() {
  stopRefresh();
  $('shell').style.display = 'none';
  $('loginView').style.display = 'grid';
  $('loginKey').value = '';
  $('loginErr').style.display = 'none';
  $('loginKey').focus();
}
function showLoginErr(msg) {
  const el = $('loginErr');
  el.textContent = msg;
  el.style.display = 'block';
}
async function doLogin(ev) {
  ev.preventDefault();
  const key = $('loginKey').value.trim();
  if (!key) return showLoginErr('请粘贴登录密钥');
  $('loginBtn').disabled = true;
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: { key } });
    if (r.status === 200 && r.json?.user) {
      $('loginKey').value = '';      // 明文密钥用完即弃，不留在 DOM 里
      me = r.json;
      enterApp();
      return;
    }
    // 429 带 Retry-After（契约 §6 限流 10/5min/IP）
    showLoginErr(r.status === 429 ? errMsg(r, '登录过于频繁') : errMsg(r, '登录失败'));
  } catch (e) {
    showLoginErr('无法连接云端：' + (e?.message || e));
  } finally {
    $('loginBtn').disabled = false;
  }
}
async function doLogout() {
  await api('/api/auth/logout', { method: 'POST' });
  me = null;
  showLogin();
}

function enterApp() {
  $('loginView').style.display = 'none';
  $('shell').style.display = 'flex';
  const name = me?.user?.name || '—';
  const ws = me?.workspace?.name || '—';
  $('userName').textContent = name;
  $('userWs').textContent = ws;
  $('userAv').textContent = Array.from(name)[0] || '?';
  $('brandWs').textContent = ws;
  router();
  startRefresh();
}

// ==========================================================================
// mirror 显性化（铁律：stale 必须让人一眼看出「这不是实时的」）
// ==========================================================================
const MIRROR_TEXT = {
  live: { cls: 'live', title: '实时镜像', sub: (st) => `机器在线并持续对账 · 最后同步 ${fmtAgo(st.syncedAt)}` },
  stale: { cls: 'stale', title: '镜像已陈旧 —— 这不是实时状态', sub: (st) => `机器已离线，下面全部内容停留在最后一次同步：${fmtAgo(st.syncedAt)}（${fmtDateTime(st.syncedAt)}）。任务在那台机器上可能仍在运行 —— 云端不动它的执行状态。` },
  local_missing: { cls: 'missing', title: '本地已不存在这个任务', sub: (st) => `最近一次全量对账时该机器没有报告这个任务（本地删了草稿 / 归档漂移）。下面是云端最后收到的镜像：${fmtAgo(st.syncedAt)}。` },
};
/** 任务卡上的陈旧条：live 不出条（避免噪音），非 live 必出（铁律）。 */
function cardMirrorHtml(st) {
  const m = st?.mirror;
  if (m === 'stale') return `<div class="card-mirror stale" title="${escapeAttr('最后同步于 ' + fmtDateTime(st.syncedAt))}">⚠ 陈旧 · 最后同步 ${escapeHtml(fmtAgo(st.syncedAt))}</div>`;
  if (m === 'local_missing') return `<div class="card-mirror missing" title="${escapeAttr('最后同步于 ' + fmtDateTime(st.syncedAt))}">⚠ 本地已消失 · 最后同步 ${escapeHtml(fmtAgo(st.syncedAt))}</div>`;
  return '';
}
/** 详情页的 mirror 横幅：三态都出，让人明确知道自己在看什么新鲜度的数据。 */
function mirrorBannerHtml(st) {
  // mirror 认不出来时**故意**落到 stale 档而不是 live：宁可让人以为数据旧了去核实，
  // 也绝不在不确定的时候宣称「实时」（铁律的保守方向）。
  const meta = MIRROR_TEXT[st?.mirror] || MIRROR_TEXT.stale;
  const icon = st?.mirror === 'live'
    ? '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/></svg>'
    : '<svg class="ic" viewBox="0 0 24 24"><path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  return `<div class="mirror-banner ${meta.cls}">${icon}<div><b>${escapeHtml(meta.title)}</b>
    <span class="mb-sub">${escapeHtml(meta.sub(st || {}))}</span></div></div>`;
}

// ==========================================================================
// 看板（契约 §6.11）
// ==========================================================================
const STATE_TAG = {
  plan: { cls: 'tag-cyan', label: 'plan' },
  queued: { cls: 'tag-mut', label: 'queued' },
  processing: { cls: 'tag-amber', label: 'processing' },
  done: { cls: 'tag-jade', label: 'done' },
  'awaiting-human': { cls: 'tag-coral', label: 'awaiting' },
};
function stateTagHtml(state) {
  const m = STATE_TAG[state] || { cls: 'tag-mut', label: state || '?' };
  return `<span class="tag ${m.cls}" style="font-size:10px">${escapeHtml(m.label)}</span>`;
}
// 来源展示名（与本地看板 sourceLabel 同口径）。source 只是来源元数据，不参与任何分支判断。
function sourceLabel(source) {
  return source === 'chat' ? 'dws' : source === 'cli' ? 'CLI' : source === 'manual' ? 'Manual' : (source || '?');
}
function sourceTagHtml(source) {
  if (source === 'chat') return '<span class="tag tag-cyan">dws</span>';
  if (source === 'cli') return '<span class="tag tag-brand">CLI</span>';
  if (source === 'issue') return '<span class="tag tag-amber">issue</span>';
  return `<span class="tag tag-mut">${escapeHtml(sourceLabel(source))}</span>`;
}
// outcome 只在 done 桶有信息量（success / cancelled / failed）
function outcomeTagHtml(outcome) {
  if (!outcome) return '';
  const cls = outcome === 'success' ? 'tag-jade' : outcome === 'failed' ? 'tag-coral' : 'tag-mut';
  return `<span class="tag ${cls}" style="font-size:10px">${escapeHtml(outcome)}</span>`;
}

function taskCardHtml(t) {
  const st = t.status || {};
  const title = t.title || t.localTaskKey || '(无标题)';
  const short = title.length > 60 ? title.slice(0, 60) + '…' : title;
  const cwd = t.cwd || '';
  const cwdShort = cwd ? (cwd.length > 40 ? '…' + cwd.slice(-38) : cwd) : '—';
  const mach = t.machine || {};
  const dot = mach.status === 'online' ? 'online' : 'offline';
  return `
    <a class="taskcard" href="#/task/${encodeURIComponent(t.id)}" data-taskid="${escapeAttr(t.id)}">
      <div class="card-title" title="${escapeAttr(title)}">${escapeHtml(short)}</div>
      <div class="card-sub" title="${escapeAttr(cwd)}">${escapeHtml(cwdShort)}</div>
      <div class="card-status" title="${escapeAttr(fmtDateTime(st.lastActivityAt))}">最后活动 ${escapeHtml(fmtAgo(st.lastActivityAt))}</div>
      ${cardMirrorHtml(st)}
      <div class="card-foot">
        <span class="card-machine" title="${escapeAttr(mach.displayName || '')}">
          <span class="dot ${dot}"></span><span class="nm">${escapeHtml(mach.displayName || '—')}</span>
        </span>
        <span style="flex:1"></span>
        ${st.isArchive ? '<span class="tag tag-mut" style="font-size:10px">归档</span>' : ''}
        ${outcomeTagHtml(st.outcome)}
        ${sourceTagHtml(t.source)}
      </div>
    </a>`;
}

function boardQuery(state) {
  const p = new URLSearchParams({ state, limit: String(BUCKET_LIMIT) });
  if (boardFilter.machineId) p.set('machineId', boardFilter.machineId);
  if (boardFilter.mirror) p.set('mirror', boardFilter.mirror);
  if (boardFilter.q) p.set('q', boardFilter.q);
  return `/api/tasks?${p}`;
}

async function loadBoard() {
  const rs = await Promise.all(BUCKETS.map((s) => api(boardQuery(s))));
  if (rs.some(guard401)) return;
  BUCKETS.forEach((s, i) => {
    const r = rs[i];
    const list = $(`list-${s}`);
    const cnt = $(`count-${s}`);
    if (r.status !== 200 || !r.json) {
      cnt.textContent = '!';
      list.innerHTML = `<div class="empty">${escapeHtml(errMsg(r, '加载失败'))}</div>`;
      return;
    }
    const tasks = r.json.tasks || [];
    const total = Number(r.json.total ?? tasks.length);
    cnt.textContent = String(total);
    // 排序由云端固定 last_activity_at desc nulls last（契约 §6.11），前端不重排
    list.innerHTML = tasks.length
      ? tasks.map(taskCardHtml).join('') + (total > tasks.length ? `<div class="col-more">另有 ${total - tasks.length} 条未显示</div>` : '')
      : '<div class="empty">无</div>';
  });
  markSynced();
}

// 两个筛选器是自研 dropdown（ui.js）——原生 <select> 的展开态由操作系统绘制，暗色主题下必破功。
// 在 bindEvents 里建，这里只存句柄。
let ddMachine = null, ddMirror = null;

function syncBoardToolbar() {
  ddMachine?.setValue(boardFilter.machineId);
  ddMirror?.setValue(boardFilter.mirror);
  $('boardQ').value = boardFilter.q;
}
function fillMachineOptions() {
  // setOptions 会在当前值仍存在时保留选中 —— 机器列表 15s 刷一次，不能把用户的筛选刷没
  ddMachine?.setOptions([
    { value: '', label: '全部机器' },
    ...machines.map((m) => ({ value: m.id, label: m.displayName || m.hostname || m.id })),
  ]);
}

// ==========================================================================
// 机器列表（契约 §6.7）
// ==========================================================================
function loadBarHtml(load) {
  const proc = Number(load?.processing) || 0;
  const q = Number(load?.queued) || 0;
  const cap = Number(load?.cap) || 0;         // cap=0 → 不限（契约 §6.6）
  // 分母：cap 为 0（不限）时用「实际在跑 + 排队」当分母，条才有意义
  const denom = cap > 0 ? Math.max(cap, proc + q) : Math.max(1, proc + q);
  const pw = Math.min(100, (proc / denom) * 100);
  const qw = Math.min(100 - pw, (q / denom) * 100);
  return `
    <div class="load-row">
      <div class="load-bar" title="processing ${proc} · queued ${q} · cap ${cap || '不限'}">
        <div class="load-seg proc" style="width:${pw}%"></div>
        <div class="load-seg queued" style="width:${qw}%"></div>
      </div>
      <span class="load-txt">${proc} / ${cap > 0 ? cap : '∞'}${q ? ` · +${q} 排队` : ''}</span>
    </div>`;
}
function countsHtml(c) {
  if (!c) return '';
  const items = [
    ['plan', c.plan], ['queued', c.queued], ['processing', c.processing],
    ['awaiting', c.awaitingHuman], ['done', c.done], ['归档', c.archived],
  ];
  return `<div class="mach-counts">${items.map(([k, v]) =>
    `<span class="cnt">${escapeHtml(k)} <b>${Number(v) || 0}</b></span>`).join('')}</div>`;
}
function machineCardHtml(m) {
  const online = m.status === 'online';
  // acceptAutoMode：本地「是否接受自动执行」开关的镜像。契约 §7.3 明确 P0+P1 不实现该开关
  // → 机器不上报、此列恒 null。这里如实显示「未上报」，不假装有值。
  const aam = m.acceptAutoMode || null;
  return `
    <div class="mach-card">
      <div class="mach-head">
        <span class="mach-dot ${online ? 'online' : 'offline'}"></span>
        <span class="mach-name" title="${escapeAttr(m.displayName || '')}">${escapeHtml(m.displayName || m.hostname || '—')}</span>
        <span class="tag ${online ? 'tag-jade' : 'tag-mut'}" style="font-size:10px">${online ? 'online' : 'offline'}</span>
        ${m.revokedAt ? '<span class="tag tag-coral" style="font-size:10px">已撤销</span>' : ''}
        <span class="mach-owner">${escapeHtml(m.owner?.name || '')}</span>
      </div>
      ${loadBarHtml(m.load)}
      <dl class="kv">
        <dt>主机名</dt><dd title="${escapeAttr(m.hostname || '')}">${escapeHtml(m.hostname || '—')}</dd>
        <dt>平台</dt><dd>${escapeHtml([m.platform, m.arch].filter(Boolean).join(' / ') || '—')}</dd>
        <dt>claude</dt><dd>${escapeHtml(m.claudeVersion || '未装')}</dd>
        <dt>app</dt><dd>${escapeHtml(m.appVersion || '—')}</dd>
        <dt>最后心跳</dt><dd title="${escapeAttr(fmtDateTime(m.lastSeenAt))}">${escapeHtml(fmtAgo(m.lastSeenAt))}</dd>
        <dt title="本地「是否接受自动执行」开关的镜像">自动执行</dt><dd>${aam ? escapeHtml(aam) : '<span style="color:var(--dim)">未上报</span>'}</dd>
        <dt>注册于</dt><dd title="${escapeAttr(fmtDateTime(m.enrolledAt))}">${escapeHtml(fmtAgo(m.enrolledAt))}</dd>
        <dt>machineUid</dt><dd title="${escapeAttr(m.machineUid || '')}">${escapeHtml(m.machineUid || '—')}</dd>
      </dl>
      ${countsHtml(m.taskCounts)}
    </div>`;
}
async function loadMachines({ render = true } = {}) {
  const r = await api('/api/machines');
  if (guard401(r)) return;
  if (r.status !== 200 || !r.json) {
    if (render) $('machGrid').innerHTML = `<div class="empty">${escapeHtml(errMsg(r, '加载失败'))}</div>`;
    return;
  }
  machines = r.json.machines || [];
  fillMachineOptions();
  if (render) {
    $('machGrid').innerHTML = machines.length
      ? machines.map(machineCardHtml).join('')
      : '<div class="empty">还没有机器注册到本云端</div>';
    markSynced();
  }
}

// ==========================================================================
// 任务详情（契约 §6.12）
// ==========================================================================
function statHtml(k, v, title) {
  return `<div class="stat"${title ? ` title="${escapeAttr(title)}"` : ''}><div class="stat-k">${escapeHtml(k)}</div><div class="stat-v">${escapeHtml(v)}</div></div>`;
}
function timelineHtml(history) {
  if (!Array.isArray(history) || !history.length) return '<div class="empty">无历史</div>';
  return `<div class="tl">${history.map((h, i) => `
    <div class="tl-item">
      <div class="tl-rail"><span class="tl-dot ${i === history.length - 1 ? 'cur' : ''}"></span><span class="tl-line"></span></div>
      <div class="tl-main">
        <div class="tl-top">${stateTagHtml(h.state)}<span class="tl-at">${escapeHtml(fmtDateTime(h.at))}</span>
        ${h.by ? `<span class="tl-by">${escapeHtml(h.by)}</span>` : ''}</div>
      </div>
    </div>`).join('')}</div>`;
}
function usageHtml(u) {
  if (!u) return '<div class="empty">无用量数据</div>';
  // ⚠ usage 是**末轮快照**，rounds / totalCostUsd 是累计（契约 §6.12 / collect.js:263-265 的既定口径）。
  //   别把它当累计画趋势 —— 所以这里标题写死「末轮」。
  return `<div class="stat-grid">
    ${statHtml('输入', compactTokens(u.input_tokens), `${u.input_tokens ?? '—'} tokens`)}
    ${statHtml('输出', compactTokens(u.output_tokens), `${u.output_tokens ?? '—'} tokens`)}
    ${statHtml('缓存读', compactTokens(u.cache_read_input_tokens), `${u.cache_read_input_tokens ?? '—'} tokens`)}
    ${statHtml('缓存写', compactTokens(u.cache_creation_input_tokens), `${u.cache_creation_input_tokens ?? '—'} tokens`)}
  </div>`;
}

async function loadTaskDetail(id) {
  const box = $('taskDetail');
  const r = await api('/api/tasks/' + encodeURIComponent(id));
  if (guard401(r)) return;
  if (r.status === 404) {
    box.innerHTML = '<div class="card"><div class="empty">任务不存在，或不属于当前 workspace</div></div>';
    $('viewTitle').textContent = '任务详情';
    return;
  }
  if (r.status !== 200 || !r.json) {
    box.innerHTML = `<div class="card"><div class="empty">${escapeHtml(errMsg(r, '加载失败'))}</div></div>`;
    return;
  }
  const t = r.json;
  const st = t.status || {};
  const mach = t.machine || {};
  $('viewTitle').textContent = t.title || t.localTaskKey || '任务详情';

  box.innerHTML = `
    ${mirrorBannerHtml(st)}
    <div class="detail-grid">
      <div style="display:flex;flex-direction:column;gap:var(--gap);min-width:0">
        <section class="card">
          <div class="detail-title">${escapeHtml(t.title || '(无标题)')}</div>
          <div class="detail-tags">
            ${stateTagHtml(st.state)}
            ${outcomeTagHtml(st.outcome)}
            ${sourceTagHtml(t.source)}
            <span class="tag tag-mut" style="font-size:10px">${escapeHtml(t.origin || '—')}</span>
            ${st.isArchive ? '<span class="tag tag-mut" style="font-size:10px">归档</span>' : ''}
          </div>
        </section>

        <section class="card">
          <div class="sec-head"><h2>Prompt</h2><span class="sec-sub">任务正文原文</span></div>
          ${t.prompt
      ? `<div class="prompt-box">${escapeHtml(t.prompt)}</div>`
      : '<div class="empty">无 prompt（未物化的 CLI 观察态会话没有 task.json）</div>'}
        </section>

        ${t.description ? `<section class="card">
          <div class="sec-head"><h2>备注</h2></div>
          <div style="font-size:12.5px;color:var(--ink2);white-space:pre-wrap;word-break:break-word">${escapeHtml(t.description)}</div>
        </section>` : ''}

        <section class="card">
          <div class="sec-head"><h2>状态历史</h2><span class="sec-sub">本地 state.json.history 的镜像 · 按 seq 升序</span></div>
          ${timelineHtml(t.history)}
        </section>
      </div>

      <div style="display:flex;flex-direction:column;gap:var(--gap);min-width:0">
        <section class="card">
          <div class="sec-head"><h2>执行</h2></div>
          <div class="stat-grid" style="margin-bottom:12px">
            ${statHtml('轮次', String(st.rounds ?? '—'), '累计轮数')}
            ${statHtml('turns', String(st.numTurns ?? '—'), '累计 turn 数')}
            ${statHtml('成本', fmtMoney(st.totalCostUsd), '累计 USD')}
          </div>
          <dl class="kv">
            <dt>进入当前态</dt><dd title="${escapeAttr(fmtDateTime(st.enteredAt))}">${escapeHtml(fmtAgo(st.enteredAt))}</dd>
            <dt>最后活动</dt><dd title="${escapeAttr(fmtDateTime(st.lastActivityAt))}">${escapeHtml(fmtAgo(st.lastActivityAt))}</dd>
            <dt>结束于</dt><dd title="${escapeAttr(fmtDateTime(st.resolvedAt))}">${st.resolvedAt ? escapeHtml(fmtAgo(st.resolvedAt)) : '—'}</dd>
            <dt>后台子任务</dt><dd>${Number(st.backgroundTaskCount) || 0}</dd>
            <dt>sessionId</dt><dd title="${escapeAttr(st.sessionId || '')}">${escapeHtml(st.sessionId || '—')}</dd>
          </dl>
        </section>

        <section class="card">
          <div class="sec-head"><h2>用量</h2><span class="sec-sub">末轮快照</span></div>
          ${usageHtml(st.usage)}
          <div style="font-size:10.5px;color:var(--dim);margin-top:8px;line-height:1.5">
            usage 是最后一轮的快照，不是累计值 —— 上面的轮次 / 成本才是累计。
          </div>
        </section>

        <section class="card">
          <div class="sec-head"><h2>任务信息</h2></div>
          <dl class="kv">
            <dt>机器</dt><dd title="${escapeAttr(mach.displayName || '')}">${escapeHtml(mach.displayName || '—')} · ${escapeHtml(mach.status || '—')}</dd>
            <dt>工作目录</dt><dd title="${escapeAttr(t.cwd || '')}">${escapeHtml(t.cwd || '—')}</dd>
            <dt>模型</dt><dd>${escapeHtml(t.model || '—')}</dd>
            <dt>effort</dt><dd>${escapeHtml(t.effort || '—')}</dd>
            <dt>worktree</dt><dd>${t.worktree ? '是' : '否'}${t.baseBranch ? ' · ' + escapeHtml(t.baseBranch) : ''}</dd>
            <dt>分支</dt><dd title="${escapeAttr(st.worktreeBranch || st.gitBranch || '')}">${escapeHtml(st.worktreeBranch || st.gitBranch || '—')}</dd>
            <dt>本地 taskKey</dt><dd title="${escapeAttr(t.localTaskKey || '')}">${escapeHtml(t.localTaskKey || '—')}</dd>
            <dt>建于</dt><dd title="${escapeAttr(fmtDateTime(t.createdAt))}">${escapeHtml(fmtAgo(t.createdAt))}</dd>
            <dt>镜像同步</dt><dd title="${escapeAttr(fmtDateTime(st.syncedAt))}">${escapeHtml(fmtAgo(st.syncedAt))}</dd>
          </dl>
        </section>
      </div>
    </div>`;
  markSynced();
}

// ==========================================================================
// 机器纳管（契约 §6.14–6.16 注册密钥 / §6.4 配对码 / §6.17 join token）
// ==========================================================================
// ⚠⚠ 明文只此一次（§6.14 前端红线）：注册密钥与配对码的明文只在生成响应里存在**一次**，
//    云端此后只剩 sha256。下面三个变量是它们在本页的唯一去处 —— 纯 JS 内存，
//    **绝不**写 localStorage / sessionStorage / URL / 任何日志（调试时也别 console.log 它们）。
//    刷新即永久丢失，这是设计不是缺陷 —— 丢了就如实告诉用户重新生成（见 buildJt 的拒绝分支）。
let rkPlain = null;    // §6.14 的 201 响应：{ id, key, keyPrefix, label, createdAt }
let codePlain = null;  // §6.4  的 201 响应：{ code, expiresAt, ttlSec }
let joinToken = null;  // 就地拼出来的 swjt_ 串（同样只在内存里）
let codeTimer = null;  // 配对码倒计时（10min TTL 到点即止，不常驻）

/**
 * §6.17：joinToken = 'swjt_' + base64url(utf8(JSON.stringify({v:1,url,rk,code})))。
 * 服务端**拼不出它**（库里只剩 sha256）—— 这不是偷懒，是「明文只展示一次」的直接推论，所以只能在这里拼。
 * 桌面端的解包是 platform/public/app.js:2318 parseJoinToken：
 *   `decodeURIComponent(escape(atob(t.slice(5).replace(/-/g,'+').replace(/_/g,'/'))))`
 * 故这里必须是它的**逐字逆运算**：utf8 → base64 → base64url（+/ 换 -_、去掉 = 填充）。
 * `unescape(encodeURIComponent(s))` 是那边 `escape`/`decodeURIComponent` 的镜像配对：btoa 只吃 latin1，
 * URL / 备注里一旦出现中文，不这么转会直接抛 InvalidCharacterError。
 */
function encodeJoinToken({ url, rk, code }) {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, url, rk, code }))));
  return 'swjt_' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 一键复制。失败**必须说出来** —— 明文只此一次，让人以为复制成功却没进剪贴板 = 当场丢。 */
async function copyToClipboard(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    UI.toast(`${what}已复制到剪贴板`);
    return true;
  } catch {
    // 剪贴板 API 在非安全上下文（http 裸 IP）会拒绝。明文就在旁边框里且 user-select:all，让人手动选中。
    UI.toast(`${what}复制失败 —— 请手动选中框里的内容复制`, 'err');
    return false;
  }
}

const ONCE_WARN_RK = `<div class="once">
  <svg viewBox="0 0 24 24"><path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
  <span><b>现在就复制保存</b> —— 明文只在这一次出现。云端只存了它的 sha256，刷新或离开本页后<b>永久拿不回来</b>，只能重新生成一把。</span>
</div>`;

// ---------- 步骤 1：注册密钥 ----------
function renderWizRk() {
  const box = $('wizRk');
  $('wizNum1').classList.toggle('done', !!rkPlain);
  if (!rkPlain) {
    box.innerHTML = `
      <div class="wiz-act">
        <input class="field-input" id="rkLabel" maxlength="64" spellcheck="false" style="min-width:250px"
               placeholder="备注（可选 · 如「2026 上半年」）">
        <button class="btn btn-primary" id="rkGenBtn">生成一把</button>
        <span id="rkGenHint" style="font-size:11px;color:var(--dim)"></span>
      </div>
      <div class="wiz-d" style="margin:8px 0 0">已经有一把了？下面列表里的密钥仍然有效 —— 但<b>明文只在生成时出现过一次</b>，
        本页拿不到，只能用你自己保存的那份手动贴到桌面端。</div>`;
    $('rkGenBtn').addEventListener('click', genRk);
    $('rkLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') genRk(); });
    return;
  }
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="tag tag-jade">本页刚生成</span>
      <span style="font-family:var(--mono);font-size:11px;color:var(--mut)">${escapeHtml(rkPlain.keyPrefix || '')}…</span>
      ${rkPlain.label ? `<span class="tag tag-mut">${escapeHtml(rkPlain.label)}</span>` : ''}
      <button class="btn" id="rkRegenBtn" style="margin-left:auto">换一把</button>
    </div>
    <div class="secret">
      <code id="rkVal">${escapeHtml(rkPlain.key)}</code>
      <button class="btn btn-primary" id="rkCopyBtn">复制</button>
    </div>
    ${ONCE_WARN_RK}`;
  $('rkCopyBtn').addEventListener('click', () => copyToClipboard(rkPlain.key, '注册密钥'));
  // 「换一把」只丢掉本页内存里这份明文（旧密钥在云端仍有效，要作废得去下面列表撤销）
  $('rkRegenBtn').addEventListener('click', () => {
    rkPlain = null; joinToken = null;
    renderWizRk(); renderWizJt();
  });
}

async function genRk() {
  const btn = $('rkGenBtn'), hint = $('rkGenHint');
  const label = $('rkLabel').value.trim();
  btn.disabled = true;
  hint.style.color = 'var(--dim)';
  hint.textContent = '生成中…';
  const r = await api('/api/registration-keys', { method: 'POST', body: { label: label || null } });
  if (guard401(r)) return;
  if (r.status !== 201 || !r.json?.key) {
    btn.disabled = false;
    hint.style.color = 'var(--coralT)';
    hint.textContent = errMsg(r, '生成失败');
    return;
  }
  rkPlain = r.json;   // ⚠ 明文进内存，仅此一处
  joinToken = null;   // 换了 rk → 旧 token 里的 rk 已不是这把，作废重拼
  renderWizRk();
  renderWizJt();
  loadRegKeys();      // 新的一把要立刻出现在下面列表里
}

// ---------- 步骤 2：配对码 ----------
const codeLeftSec = () =>
  (codePlain ? Math.max(0, Math.round((Date.parse(codePlain.expiresAt) - Date.now()) / 1000)) : 0);

function stopCodeTimer() {
  if (codeTimer) clearInterval(codeTimer);
  codeTimer = null;
}
function tickCode() {
  const el = $('codeTtl');
  if (!el || !codePlain) return;
  const s = codeLeftSec();
  if (s > 0) {
    el.classList.remove('exp');
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} 后过期`;
    return;
  }
  el.classList.add('exp');
  el.textContent = '已过期 · 请重新生成';
  stopCodeTimer();
  $('wizNum2').classList.remove('done');
  // 配对码过期 → token 里的 code 也废了。主动作废，别让人拿着一串必然 401 的东西去贴桌面端。
  if (joinToken) { joinToken = null; renderWizJt(); }
}

function renderWizCode() {
  const box = $('wizCode');
  $('wizNum2').classList.toggle('done', codeLeftSec() > 0);
  if (!codePlain) {
    box.innerHTML = `
      <div class="wiz-act">
        <button class="btn btn-primary" id="codeGenBtn">生成配对码</button>
        <span id="codeGenHint" style="font-size:11px;color:var(--dim)"></span>
      </div>`;
    $('codeGenBtn').addEventListener('click', genCode);
    return;
  }
  box.innerHTML = `
    <div class="wiz-act" style="gap:14px">
      <span class="code-big">${escapeHtml(codePlain.code)}</span>
      <span class="code-ttl" id="codeTtl"></span>
      <span style="flex:1"></span>
      <button class="btn" id="codeCopyBtn">复制</button>
      <button class="btn" id="codeGenBtn">重新生成</button>
      <span id="codeGenHint" style="font-size:11px;color:var(--dim)"></span>
    </div>
    <div class="once">
      <svg viewBox="0 0 24 24"><path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      <span>明文同样<b>只此一次</b> · 10 分钟内有效 · 用掉即废。刷新本页就得重新生成一个。</span>
    </div>`;
  $('codeCopyBtn').addEventListener('click', () => copyToClipboard(codePlain.code, '配对码'));
  $('codeGenBtn').addEventListener('click', genCode);
  tickCode();
  stopCodeTimer();
  codeTimer = setInterval(tickCode, 1000);
}

async function genCode() {
  const btn = $('codeGenBtn'), hint = $('codeGenHint');
  btn.disabled = true;
  hint.style.color = 'var(--dim)';
  hint.textContent = '生成中…';
  // 本端点没有任何字段（workspace 取会话所属），但统一走 JSON 出站
  const r = await api('/api/machines/enrollment-codes', { method: 'POST', body: {} });
  if (guard401(r)) return;
  if (r.status !== 201 || !r.json?.code) {
    btn.disabled = false;
    hint.style.color = 'var(--coralT)';
    hint.textContent = errMsg(r, '生成失败');
    return;
  }
  codePlain = r.json;  // ⚠ 明文进内存，仅此一处
  joinToken = null;    // 换了 code → 旧 token 作废重拼
  renderWizCode();
  renderWizJt();
}

// ---------- 步骤 3：join token（就地拼装） ----------
function renderWizJt() {
  const box = $('wizJt');
  $('wizNum3').classList.toggle('done', !!joinToken);
  if (!joinToken) {
    box.innerHTML = `
      <div class="wiz-act">
        <button class="btn btn-primary" id="jtBuildBtn">拼 join token</button>
        <span style="font-size:11px;color:var(--dim)">= 本页 URL + 上面两步的明文，在浏览器里拼</span>
      </div>`;
    $('jtBuildBtn').addEventListener('click', buildJt);
    return;
  }
  box.innerHTML = `
    <div class="secret">
      <code id="jtVal">${escapeHtml(joinToken)}</code>
      <button class="btn btn-primary" id="jtCopyBtn">复制</button>
    </div>
    <div class="once">
      <svg viewBox="0 0 24 24"><path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      <span>这串里就是<b>注册密钥 + 配对码的明文</b>（没有额外权限，安全等级 = 里面那两样）——
        10 分钟内一次性有效，<b>别往 IM 群里长期留</b>。</span>
    </div>
    <div class="wiz-d" style="margin:9px 0 0">桌面端：<b>设置 → 云端 → 粘贴 join token</b> → 三项自动填好 → 确认 URL 后点「连接」。</div>`;
  $('jtCopyBtn').addEventListener('click', () => copyToClipboard(joinToken, 'join token'));
}

/** 拼不出来就**明确说为什么 + 怎么办**，绝不静默失败、绝不拼出个半成品（缺字段的 token 贴过去只会 401）。 */
function buildJt() {
  const url = location.origin;   // §6.17：云端 base URL，无尾斜杠 —— origin 天然没有
  const expired = codePlain && codeLeftSec() <= 0;

  if (!rkPlain || !codePlain || expired) {
    joinToken = null;
    renderWizJt();
    // 手动路径永远可用（§6.17）：手上没 rk 明文时只出配对码，让机器主人自己贴 rk
    const manual = `<div class="man">
        <div><i>云端 URL</i>${escapeHtml(url)}</div>
        <div><i>注册密钥</i>${rkPlain ? escapeHtml(rkPlain.key) : '你自己保存的那把 swrk_…（本页已拿不到）'}</div>
        <div><i>配对码</i>${codePlain && !expired ? escapeHtml(codePlain.code) : '（上面「生成配对码」现取一个）'}</div>
      </div>`;
    let why;
    if (!rkPlain) {
      why = `<b>拼不出 join token：本页内存里没有注册密钥的明文。</b><br>
        明文只在「生成」那一次的响应里出现过 —— <b>刷新 / 重进本页即永久丢失</b>（云端库里只剩 sha256，谁也拿不回来）。<br>
        请在上面<b>重新生成一把注册密钥</b>再拼；或者手动把三个字段分别贴到桌面端「设置 → 云端」：`;
    } else if (!codePlain) {
      why = `<b>拼不出 join token：还没有配对码。</b><br>请先在上面「生成配对码」（10 分钟内有效、只能用一次）。也可以手动贴三个字段：`;
    } else {
      why = `<b>拼不出 join token：配对码已过期。</b><br>配对码只活 10 分钟。请在上面「重新生成」一个再拼。手动贴的话三个字段是：`;
    }
    const err = document.createElement('div');
    err.className = 'jt-err';
    err.id = 'jtErr';
    err.innerHTML = why + manual;
    $('wizJt').appendChild(err);
    return;
  }

  joinToken = encodeJoinToken({ url, rk: rkPlain.key, code: codePlain.code });
  renderWizJt();
}

// ---------- 注册密钥列表（§6.15 / §6.16） ----------
function rkStatusTag(k) {
  if (k.revokedAt) return '<span class="tag tag-coral" style="font-size:10px">已撤销</span>';
  if (!k.lastUsedAt) return '<span class="tag tag-mut" style="font-size:10px">未用过</span>';
  return '<span class="tag tag-jade" style="font-size:10px">在用</span>';
}
function rkRowHtml(k) {
  return `<tr class="${k.revokedAt ? 'revoked' : ''}">
    <td class="pfx">${escapeHtml(k.keyPrefix || '—')}…</td>
    <td>${k.label ? escapeHtml(k.label) : '<span style="color:var(--dim)">—</span>'}</td>
    <td>${escapeHtml(k.createdBy?.name || '—')}</td>
    <td class="dim" title="${escapeAttr(fmtDateTime(k.createdAt))}">${escapeHtml(fmtAgo(k.createdAt))}</td>
    <td class="dim" title="${escapeAttr(k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : '从没有机器用它 enroll 过')}">${k.lastUsedAt ? escapeHtml(fmtAgo(k.lastUsedAt)) : '—'}</td>
    <td>${rkStatusTag(k)}</td>
    <td class="act">${k.revokedAt
    ? `<span style="font-size:10.5px;color:var(--dim);font-family:var(--mono)" title="${escapeAttr(fmtDateTime(k.revokedAt))}">${escapeHtml(fmtAgo(k.revokedAt))}撤销</span>`
    : `<button class="btn" data-revoke="${escapeAttr(k.id)}" data-pfx="${escapeAttr(k.keyPrefix || '')}">撤销</button>`}</td>
  </tr>`;
}

async function loadRegKeys() {
  const activeOnly = $('rkActiveOnly').checked;
  const r = await api('/api/registration-keys' + (activeOnly ? '?activeOnly=1' : ''));
  if (guard401(r)) return;
  const list = $('rkList'), empty = $('rkEmpty');
  if (r.status !== 200 || !r.json) {
    list.innerHTML = '';
    empty.style.display = '';
    empty.textContent = errMsg(r, '加载失败');
    return;
  }
  const keys = r.json.keys || [];
  list.innerHTML = keys.map(rkRowHtml).join('');
  empty.style.display = keys.length ? 'none' : '';
  // 撤到一把不剩是**合法状态**（= 暂时关闭新机器加入），不是错误（§6.16）
  empty.textContent = activeOnly
    ? '没有未撤销的注册密钥 —— 新机器暂时进不来（这是个合法状态）'
    : '还没有注册密钥 —— 上面「生成一把」后机器才能 enroll';
  markSynced();
}

async function revokeRk(id, pfx) {
  // 撤销不可逆（幂等，但撤了就是撤了）→ 二次确认走自研 modal（danger 档：确认键红 + 点遮罩不关）。
  // 文案讲清「不踢已在线机器」，免得人误以为这是踢机器的开关（那是 §6.8 撤销机器）。
  const yes = await UI.confirmDanger({
    title: '撤销注册密钥',
    messageHtml: `即将撤销 <code>${escapeHtml(pfx)}…</code>
      <ul>
        <li>之后用这把密钥的机器<b>再也进不来</b>（enroll → 401）</li>
        <li><b>已在线的机器不受任何影响</b>：照常心跳、照常上报（密钥只管入场，不管在场）</li>
        <li>不可撤回</li>
      </ul>`,
    confirmText: '撤销',
  });
  if (!yes) return;
  const r = await api(`/api/registration-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} });
  if (guard401(r)) return;
  if (r.status !== 200) { UI.toast(errMsg(r, '撤销失败'), 'err'); return; }
  UI.toast(`已撤销 ${pfx}…`);
  // 撤掉的正好是本页内存里那把 → 它已经废了，别再让人拿它去拼一串必然 401 的 token
  if (rkPlain?.id === id) {
    rkPlain = null; joinToken = null;
    renderWizRk(); renderWizJt();
  }
  loadRegKeys();
}

/** 进入本页时按内存状态重画三步（rkPlain 等跨路由切换仍在，回来还能接着复制）。 */
function renderEnrollView() {
  renderWizRk();
  renderWizCode();
  renderWizJt();
}

// ==========================================================================
// 路由 / 刷新
// ==========================================================================
const ROUTE_VIEWS = ['board', 'machines', 'enroll', 'task'];
let currentView = 'board';
let currentTaskId = null;

function router() {
  if (!me) return;
  const h = location.hash || '#/board';
  const mTask = /^#\/task\/([^/]+)$/.exec(h);
  let view = 'board';
  currentTaskId = null;
  if (mTask) { view = 'task'; currentTaskId = decodeURIComponent(mTask[1]); }
  else if (h.startsWith('#/machines')) view = 'machines';
  else if (h.startsWith('#/enroll')) view = 'enroll';
  currentView = view;

  for (const v of ROUTE_VIEWS) {
    const el = $(`view-${v}`);
    if (el) el.style.display = v === view ? '' : 'none';
  }
  document.querySelectorAll('.topnav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === view || (view === 'task' && a.dataset.nav === 'board'));
  });
  const crumbs = $('crumbs');
  const mid = crumbs.querySelector('.crumb-mid-wrap');
  if (mid) mid.remove();
  if (view === 'task') {
    // 面包屑加一层「任务看板 ›」，详情页有回路
    const span = document.createElement('span');
    span.className = 'crumb-mid-wrap';
    span.innerHTML = '<a class="crumb-mid" href="#/board">任务看板</a><span class="crumb-sep">›</span>';
    crumbs.insertBefore(span, $('viewTitle'));
    $('viewTitle').textContent = '任务详情';
  } else {
    $('viewTitle').textContent = view === 'machines' ? '机器' : view === 'enroll' ? '机器纳管' : '任务看板';
  }
  // 向导只在**进入本页**时按内存状态重画一次 —— 绝不挂进 refreshCurrentView：
  // 15s 一次的轮询把 DOM 重建掉，会打断正在复制明文的人（明文只此一次，打断的代价是重新生成）。
  if (view === 'enroll') renderEnrollView();
  refreshCurrentView();
}

function refreshCurrentView() {
  if (!me) return;
  if (currentView === 'board') { loadMachines({ render: false }); loadBoard(); }
  else if (currentView === 'machines') loadMachines();
  else if (currentView === 'enroll') loadRegKeys();   // 只刷列表，不动向导
  else if (currentView === 'task' && currentTaskId) loadTaskDetail(currentTaskId);
}
function markSynced() {
  $('topSync').textContent = '拉取于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(refreshCurrentView, REFRESH_MS);
}
function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

// ==========================================================================
// 启动
// ==========================================================================
// 明暗主题（multica token 是双主题的，别只活在亮色档）
const SUN = '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
const MOON = '<svg class="ic" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('cloud-theme', theme);   // 只存主题偏好；明文凭据绝不进任何存储
  const btn = $('themeBtn');
  btn.innerHTML = theme === 'light' ? MOON : SUN;
  btn.title = theme === 'light' ? '切到暗色' : '切到亮色';
}

function bindEvents() {
  $('loginForm').addEventListener('submit', doLogin);
  $('logoutBtn').addEventListener('click', doLogout);
  window.addEventListener('hashchange', router);
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  $('themeBtn').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));

  ddMachine = UI.dropdown({
    mount: $('boardMachine'), ariaLabel: '按机器筛选', minWidth: '150px',
    options: [{ value: '', label: '全部机器' }],
    value: boardFilter.machineId,
    onChange: (v) => { boardFilter.machineId = v; loadBoard(); },
  });
  ddMirror = UI.dropdown({
    mount: $('boardMirror'), ariaLabel: '按镜像新鲜度筛选', minWidth: '170px',
    options: [
      { value: '', label: '全部' },
      { value: 'live', label: 'live · 实时' },
      { value: 'stale', label: 'stale · 陈旧' },
      { value: 'local_missing', label: 'local_missing · 本地已消失' },
    ],
    value: boardFilter.mirror,
    onChange: (v) => { boardFilter.mirror = v; loadBoard(); },
  });
  let qTimer = null;
  $('boardQ').addEventListener('input', (e) => {
    boardFilter.q = e.target.value.trim();
    clearTimeout(qTimer);
    qTimer = setTimeout(loadBoard, 300);      // 输入防抖，别每个字符打一次云端
  });
  $('boardClear').addEventListener('click', () => {
    boardFilter.machineId = ''; boardFilter.mirror = ''; boardFilter.q = '';
    syncBoardToolbar();
    loadBoard();
  });

  // 机器纳管：撤销按钮随列表重绘，用事件委托绑一次（别每次重绘都重新挂）
  $('rkList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-revoke]');
    if (b) revokeRk(b.dataset.revoke, b.dataset.pfx);
  });
  $('rkActiveOnly').addEventListener('change', loadRegKeys);
  $('rkReload').addEventListener('click', loadRegKeys);
  // 页面隐藏时停轮询（大盘常年开着，没必要在后台标签页里空转）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRefresh();
    else if (me) { refreshCurrentView(); startRefresh(); }
  });
}

async function boot() {
  bindEvents();
  const r = await api('/api/auth/me');
  if (r.status === 200 && r.json?.user) { me = r.json; enterApp(); }
  else showLogin();
}
boot();
