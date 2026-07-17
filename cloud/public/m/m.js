'use strict';
/* ==========================================================================
   手机端个人控制台（/m/）—— 原生 JS + hash 路由，零依赖、无构建
   契约：docs/spec/cloud-mobile-console.md §4.3（/api/my/*）、§4.4（rpc verb 表）、§5（页面）
   数据通路：手机 → 云端中继 → 本地 app（现取现回，不落云库）。与桌面云端大盘
   （cloud/public/app.js）同源同会话，但交互范式不同 → 独立 SPA，不复用其代码。
   ========================================================================== */

const app = document.getElementById('app');

// ---------- 基础工具 ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

function fmtAgoMs(ms) {
  const t = Number(ms);
  if (!isFinite(t) || t <= 0) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
function fmtAgo(iso) {
  const t = Date.parse(iso ?? '');
  return isFinite(t) ? fmtAgoMs(t) : '—';
}
function fmtDateTime(iso) {
  const t = Date.parse(iso ?? '');
  if (!isFinite(t)) return '—';
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 定时执行（#2）：datetime-local 'yyyy-MM-ddTHH:mm' ↔ 本地时间串 'yyyy-MM-dd HH:mm:ss'（timeutil.parse 按本机本地时间解释）。
const _p2 = (n) => String(n).padStart(2, '0');
function minDatetimeLocal() {                       // 选择器下限 = 此刻（禁选过去）
  const d = new Date();
  return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}T${_p2(d.getHours())}:${_p2(d.getMinutes())}`;
}
function datetimeLocalToLocalStr(v) {               // '2026-07-18T09:30' → '2026-07-18 09:30:00'；空 → ''
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/);
  return m ? `${m[1]} ${m[2]}:${m[3] || '00'}` : '';
}

// markdown：vendored marked（v9）。本地 app 同款姿势——raw html 一律转义后原样展示，
// 输出流内容来自自己机器的 CC 会话，但仍不给它注入 DOM 的路。
if (window.marked) {
  window.marked.use({
    breaks: true,
    renderer: { html: (t) => escapeHtml(typeof t === 'string' ? t : (t?.text ?? '')) },
  });
}
function renderMd(md) {
  const s = String(md ?? '');
  try { return window.marked ? window.marked.parse(s) : `<pre class="raw">${escapeHtml(s)}</pre>`; }
  catch { return `<pre class="raw">${escapeHtml(s)}</pre>`; }
}

// ---------- 主题：auto（跟随系统）→ light → dark 循环 ----------
const THEME_ORDER = ['auto', 'light', 'dark'];
const THEME_META = { auto: { icon: sysIcon, label: '跟随系统' }, light: { icon: sunIcon, label: '亮色' }, dark: { icon: moonIcon, label: '暗色' } };
const mqDark = matchMedia('(prefers-color-scheme: dark)');
function themePref() {
  try { return localStorage.getItem('m-theme') || 'auto'; } catch { return 'auto'; }
}
function applyTheme() {
  const pref = themePref();
  const dark = pref === 'dark' || (pref === 'auto' && mqDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // theme-color 跟主题走（PWA 状态栏配色）；值 ≈ --background 的 sRGB 近似
  const meta = document.getElementById('metaTheme');
  if (meta) meta.content = dark ? '#1b1b1e' : '#fafafa';
}
function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(themePref()) + 1) % THEME_ORDER.length];
  try { localStorage.setItem('m-theme', next); } catch { }
  applyTheme();
  const btn = document.getElementById('themeBtn');
  if (btn) { btn.innerHTML = THEME_META[next].icon(); btn.title = '主题：' + THEME_META[next].label; }
  toast('主题：' + THEME_META[next].label);
}
mqDark.addEventListener?.('change', applyTheme);   // auto 档下系统切换即时跟随
applyTheme();

// ---------- 图标（lucide 内联 path，与云端大盘同源）----------
function botIcon() { return '<svg class="ic" viewBox="0 0 24 24"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>'; }
function backIcon() { return '<svg class="ic" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>'; }
function refreshIcon() { return '<svg class="ic" viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/></svg>'; }
function plusIcon() { return '<svg class="ic" viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg>'; }
function sendIcon() { return '<svg class="ic" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>'; }
function sunIcon() { return '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>'; }
function moonIcon() { return '<svg class="ic" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>'; }
function sysIcon() { return '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/></svg>'; }
function logoutIcon() { return '<svg class="ic" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>'; }
function wifiOffIcon() { return '<svg class="ic" viewBox="0 0 24 24"><path d="M12 20h.01"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 5.2-2.7"/><path d="M19 12.9a9.9 9.9 0 0 0-2-1.5"/><path d="M2 8.8A15 15 0 0 1 8.6 5.4"/><path d="M22 8.8a15 15 0 0 0-7.3-3.7"/><path d="m2 2 20 20"/></svg>'; }
function clockIcon() { return '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'; }
function alertIcon() { return '<svg class="ic" viewBox="0 0 24 24"><path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>'; }

// ---------- Toast / 底部确认 Sheet ----------
function toast(msg, tone = 'ok', ms = 2600) {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + (tone === 'err' ? 'err' : 'ok');
  const icon = tone === 'err'
    ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>'
    : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/></svg>';
  t.innerHTML = icon + `<span>${escapeHtml(msg)}</span>`;
  host.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, ms);
}

/** 破坏性动作二次确认：移动端用底部 sheet（拇指可达）。danger 档点遮罩不关，必须明确表态。 */
function confirmSheet({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `
      <div class="sheet-mask"></div>
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="grip"></div>
        <div class="sheet-t">${escapeHtml(title)}</div>
        <div class="sheet-m">${escapeHtml(message)}</div>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${escapeHtml(confirmText)}</button>
        <button type="button" class="btn" data-no>取消</button>
      </div>`;
    document.body.appendChild(wrap);
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.querySelector('[data-yes]').addEventListener('click', () => done(true));
    wrap.querySelector('[data-no]').addEventListener('click', () => done(false));
    if (!danger) wrap.querySelector('.sheet-mask').addEventListener('click', () => done(false));
  });
}

// ==========================================================================
// API（会话走 HttpOnly cookie，同 cloud/public/app.js 的封装口径）
// ==========================================================================
let me = null;             // { user, workspace }
let pendingHash = null;    // 401 打断前想去的页面，登录后回去

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON（网关错误页等）→ null */ }
  return { status: r.status, json };
}

/** 401 → 回登录页（记住来路）。返回 true = 调用方应中止渲染。 */
function guard401(r) {
  if (r.status !== 401) return false;
  me = null;
  pendingHash = location.hash && location.hash !== '#/login' ? location.hash : null;
  location.hash = '#/login';
  return true;
}

/**
 * 中继 rpc（§4.3/§4.4）。错误语义收敛成 { ok:false, code, message }：
 *   503 MACHINE_OFFLINE → 机器离线或未开启远程控制（占位页）
 *   504 RELAY_TIMEOUT   → 机器响应超时（可重试）
 *   502 RELAY_FAILED    → 本地拒绝，message 透传本地原因（如白名单外）
 */
async function rpc(machineId, verb, args) {
  let r;
  try {
    r = await api(`/api/my/machines/${encodeURIComponent(machineId)}/rpc`, { method: 'POST', body: { verb, args: args || {} } });
  } catch (e) {
    return { ok: false, code: 'NETWORK', message: '无法连接云端：' + (e?.message || e) };
  }
  if (r.status === 200 && r.json?.ok) return { ok: true, data: r.json.data };
  if (guard401(r)) return { ok: false, code: 'AUTH', message: '登录已过期' };
  const code = r.json?.error?.code
    || (r.status === 503 ? 'MACHINE_OFFLINE' : r.status === 504 ? 'RELAY_TIMEOUT' : r.status === 502 ? 'RELAY_FAILED' : 'ERROR');
  const fallback = {
    MACHINE_OFFLINE: '机器离线或未开启远程控制',
    RELAY_TIMEOUT: '机器响应超时',
    RELAY_FAILED: '本地拒绝了该操作',
  }[code] || `请求失败（HTTP ${r.status}）`;
  return { ok: false, status: r.status, code, message: r.json?.error?.message || fallback };
}

// ==========================================================================
// 视图骨架 / 路由
// ==========================================================================
let cleanups = [];   // 当前视图的清理函数（轮询 timer / EventSource），切路由时统一执行
function onCleanup(fn) { cleanups.push(fn); }
function runCleanups() {
  for (const fn of cleanups.splice(0)) { try { fn(); } catch { } }
}

function topbarHtml({ back, title, sub, right = '' } = {}) {
  return `<header class="tb">
    ${back ? `<a class="tb-btn" href="${escapeAttr(back)}" aria-label="返回">${backIcon()}</a>`
      : `<span class="brand-logo" aria-hidden="true">${botIcon()}</span>`}
    <div class="tb-title">${escapeHtml(title)}${sub ? `<span class="tb-sub">${escapeHtml(sub)}</span>` : ''}</div>
    ${right}
  </header>`;
}
function themeBtnHtml() {
  const meta = THEME_META[themePref()];
  return `<button type="button" class="tb-btn" id="themeBtn" title="主题：${escapeAttr(meta.label)}" aria-label="切换主题">${meta.icon()}</button>`;
}
function bindThemeBtn() {
  document.getElementById('themeBtn')?.addEventListener('click', cycleTheme);
}
/** 占位页：离线 / 超时 / 加载失败，一律给「重试」和退路 */
function holderHtml({ icon, title, desc, retry = true, backTo = null }) {
  return `<div class="holder"><div>
    <div class="h-ic">${icon}</div>
    <div class="h-t">${escapeHtml(title)}</div>
    <div class="h-d">${escapeHtml(desc || '')}</div>
    ${retry ? `<button type="button" class="btn btn-primary" data-retry>重试</button>` : ''}
    ${backTo ? `<div style="margin-top:10px"><a class="btn" href="${escapeAttr(backTo)}">返回机器列表</a></div>` : ''}
  </div></div>`;
}
function rpcHolder(res, machineId) {
  const backTo = '#/machines';
  if (res.code === 'MACHINE_OFFLINE') {
    return holderHtml({ icon: wifiOffIcon(), title: '机器离线或未开启远程控制', desc: '到电脑端「设置 → 云端」开启远程控制后即可访问。', backTo });
  }
  if (res.code === 'RELAY_TIMEOUT') {
    return holderHtml({ icon: clockIcon(), title: '机器响应超时', desc: '机器可能正忙或网络不稳，稍后重试。', backTo });
  }
  return holderHtml({ icon: alertIcon(), title: '加载失败', desc: res.message, backTo });
}

const ROUTES = [
  { re: /^#\/login$/, fn: viewLogin, open: true },
  { re: /^#\/machines$/, fn: viewMachines },
  { re: /^#\/board\/([^/]+)$/, fn: (m) => viewBoard(decodeURIComponent(m[1])) },
  { re: /^#\/task\/([^/]+)\/([^/]+)$/, fn: (m) => viewTask(decodeURIComponent(m[1]), decodeURIComponent(m[2])) },
  { re: /^#\/new\/([^/]+)$/, fn: (m) => viewNew(decodeURIComponent(m[1])) },
];

function router() {
  runCleanups();
  window.scrollTo(0, 0);
  const h = location.hash || '#/machines';
  const hit = ROUTES.map((r) => ({ r, m: r.re.exec(h) })).find((x) => x.m);
  if (!hit) { location.replace('#/machines'); return; }
  if (!hit.r.open && !me) {
    pendingHash = h;
    if (h !== '#/login') { location.replace('#/login'); return; }
  }
  hit.r.fn(hit.m);
}
window.addEventListener('hashchange', router);

// ==========================================================================
// 登录 #/login（复用 /api/auth/login；已有会话由 boot 直接跳过）
// ==========================================================================
function viewLogin() {
  document.title = 'ScrumWS · 登录';
  app.innerHTML = `
  <div class="view login-wrap">
    <div class="login-card">
      <div class="login-brand">
        <span class="logo" aria-hidden="true">${botIcon()}</span>
        <span>
          <span class="name">ScrumWS</span>
          <span class="sub">手机端个人控制台 · 经云端中继访问你的机器</span>
        </span>
      </div>
      <div class="login-hint">粘贴以 <code>swuk_</code> 开头的登录密钥。没有密码 —— 密钥即身份，登录态 30 天。</div>
      <form id="loginForm" autocomplete="off">
        <input class="fi mono" id="loginKey" type="password" placeholder="swuk_…" autocomplete="off"
               spellcheck="false" aria-label="登录密钥" style="margin-bottom:12px">
        <button class="btn btn-primary btn-block" id="loginBtn" type="submit">登录</button>
      </form>
      <div class="login-err" id="loginErr"></div>
      <div class="login-foot">密钥只在本次请求中使用，不写入浏览器存储。会话由 HttpOnly cookie 承载。</div>
    </div>
  </div>`;
  const err = document.getElementById('loginErr');
  document.getElementById('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const key = document.getElementById('loginKey').value.trim();
    if (!key) { err.textContent = '请粘贴登录密钥'; err.style.display = 'block'; return; }
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { key } });
      if (r.status === 200 && r.json?.user) {
        document.getElementById('loginKey').value = '';   // 明文用完即弃
        me = r.json;
        const go = pendingHash && pendingHash !== '#/login' ? pendingHash : '#/machines';
        pendingHash = null;
        if (location.hash === go) router(); else location.hash = go;
        return;
      }
      err.textContent = r.json?.error?.message || r.json?.error?.code || `登录失败（HTTP ${r.status}）`;
      err.style.display = 'block';
    } catch (e) {
      err.textContent = '无法连接云端：' + (e?.message || e);
      err.style.display = 'block';
    } finally { btn.disabled = false; }
  });
  document.getElementById('loginKey').focus();
}

// ==========================================================================
// 机器 #/machines（GET /api/my/machines；单台直进看板，多台列表选择）
// ==========================================================================
function machineItemHtml(m) {
  const relay = !!m.relayOnline;
  const dot = m.status === 'online' ? 'online' : 'offline';
  const load = m.load || {};
  const proc = Number(load.processing) || 0, q = Number(load.queued) || 0, cap = Number(load.cap) || 0;
  const denom = cap > 0 ? Math.max(cap, proc + q) : Math.max(1, proc + q);
  const inner = `
    <div class="m-head">
      <span class="m-dot ${dot}"></span>
      <span class="m-name">${escapeHtml(m.displayName || m.id)}</span>
      ${relay ? '<svg class="ic" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>' : ''}
    </div>
    ${relay
      ? `<div class="m-sub">最后在线 ${escapeHtml(fmtAgo(m.lastSeenAt))}</div>
         <div class="m-load">
           <div class="bar"><div class="seg-p" style="width:${Math.min(100, proc / denom * 100)}%"></div><div class="seg-q" style="width:${Math.min(100, q / denom * 100)}%"></div></div>
           <span class="txt">${proc} / ${cap > 0 ? cap : '∞'}${q ? ` · +${q} 排队` : ''}</span>
         </div>`
      : `<div class="m-sub warn">离线或未开启远程控制</div>
         <div class="m-sub">最后在线 ${escapeHtml(fmtAgo(m.lastSeenAt))}</div>`}`;
  // 未开中继的机器不可点（置灰）——点进去也只有 503，一开始就别给这条路
  return relay
    ? `<a class="mitem" href="#/board/${encodeURIComponent(m.id)}">${inner}</a>`
    : `<div class="mitem off">${inner}</div>`;
}

async function viewMachines() {
  document.title = 'ScrumWS · 机器';
  app.innerHTML = `
  <div class="view">
    ${topbarHtml({
    title: 'ScrumWS', sub: me?.user?.name ? `${me.user.name} · ${me?.workspace?.name || ''}` : '',
    right: themeBtnHtml() + `<button type="button" class="tb-btn" id="logoutBtn" title="退出登录" aria-label="退出登录">${logoutIcon()}</button>`,
  })}
    <div class="page" id="machPage"><div class="empty">加载中…</div></div>
  </div>`;
  bindThemeBtn();
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (!await confirmSheet({ title: '退出登录', message: '退出后需要重新粘贴登录密钥。', confirmText: '退出' })) return;
    await api('/api/auth/logout', { method: 'POST' });
    me = null;
    location.hash = '#/login';
  });

  const box = document.getElementById('machPage');
  const r = await api('/api/my/machines');
  if (guard401(r)) return;
  if (r.status !== 200 || !r.json) {
    box.innerHTML = holderHtml({ icon: alertIcon(), title: '加载失败', desc: r.json?.error?.message || `HTTP ${r.status}` });
    box.querySelector('[data-retry]')?.addEventListener('click', viewMachines);
    return;
  }
  const machines = r.json.machines || [];
  if (!machines.length) {
    box.innerHTML = holderHtml({
      icon: botIcon(), title: '还没有你的机器',
      desc: '先在电脑端完成机器纳管（云端大盘 → 机器纳管），并在设置里开启远程控制。', retry: false,
    });
    return;
  }
  // 单台机器直接进看板（spec §5.2）；replace 不留历史，返回键不会弹回这层空壳
  if (machines.length === 1) { location.replace('#/board/' + encodeURIComponent(machines[0].id)); return; }
  box.innerHTML = machines.map(machineItemHtml).join('');
}

// ==========================================================================
// 看板 #/board/:machineId（10s 轮询 rpc state；分桶 chips + 单列卡片流）
// ==========================================================================
// 状态中文与本地看板同词（platform/public/index.html 列头 hint：待定/待认领/处理中/等人工/完成）。
// 顺序按手机使用频率：正在跑的、等我处理的排最前。
const BUCKETS = [
  { key: 'processing', label: '处理中', tag: 'tag-amber' },
  { key: 'awaiting-human', label: '等人工', tag: 'tag-coral' },
  { key: 'plan', label: '待定', tag: 'tag-cyan' },
  { key: 'queued', label: '待认领', tag: 'tag-mut' },
  { key: 'done', label: '完成', tag: 'tag-jade' },
];
const STATE_META = Object.fromEntries(BUCKETS.map((b) => [b.key, b]));
function stateTagHtml(state) {
  const m = STATE_META[state] || { tag: 'tag-mut', label: state || '?' };
  return `<span class="tag ${m.tag}">${escapeHtml(m.label)}</span>`;
}
// 来源展示名与云端大盘 sourceLabel 同口径 + mobile（本页新建的任务）
function sourceTagHtml(source) {
  if (source === 'chat') return '<span class="tag tag-cyan">dws</span>';
  if (source === 'cli') return '<span class="tag tag-brand">CLI</span>';
  if (source === 'issue') return '<span class="tag tag-amber">issue</span>';
  if (source === 'mobile') return '<span class="tag tag-brand">手机</span>';
  return `<span class="tag tag-mut">${escapeHtml(source === 'manual' ? 'Manual' : (source || '?'))}</span>`;
}
function outcomeTagHtml(outcome) {
  if (!outcome) return '';
  const cls = outcome === 'success' ? 'tag-jade' : outcome === 'failed' ? 'tag-coral' : 'tag-mut';
  return `<span class="tag ${cls}">${escapeHtml(outcome)}</span>`;
}

/** rpc state 返回的六桶（§4.4）。容忍两种形态：{lifecycle:{…}}（本地 getState 同构）或顶层就是桶。 */
function normalizeBuckets(data) {
  const src = data?.lifecycle || data || {};
  return {
    processing: src.processing || [],
    'awaiting-human': src.awaitingHuman || src['awaiting-human'] || [],
    plan: src.plan || [],
    queued: src.queued || [],
    done: src.done || [],
  };
}

function taskCardHtml(machineId, t) {
  const title = t.title || t.taskKey || '(无标题)';
  return `<a class="tcard" href="#/task/${encodeURIComponent(machineId)}/${encodeURIComponent(t.taskKey)}">
    <div class="tc-title">${escapeHtml(title)}</div>
    <div class="tc-foot">
      ${stateTagHtml(t.state)}
      ${outcomeTagHtml(t.outcome)}
      ${sourceTagHtml(t.source)}
      ${t.worktreeBranch ? `<span class="tc-branch" title="${escapeAttr(t.worktreeBranch)}">⎇ ${escapeHtml(t.worktreeBranch)}</span>` : ''}
      <span class="tc-ago">${escapeHtml(fmtAgoMs(t.lastActivityMs))}</span>
    </div>
  </a>`;
}

const boardSel = new Map();   // machineId → 选中的桶（跨刷新/跨路由记住）

async function viewBoard(machineId) {
  runCleanups();   // 允许「重试」直接重入本视图：先清掉上一轮的轮询 timer
  document.title = 'ScrumWS · 看板';
  app.innerHTML = `
  <div class="view">
    ${topbarHtml({
    back: '#/machines', title: '任务看板',
    right: themeBtnHtml() + `<button type="button" class="tb-btn" id="reloadBtn" title="刷新" aria-label="刷新">${refreshIcon()}</button>`,
  })}
    <div id="boardBody">
      <div class="chips" id="chips"></div>
      <div class="page has-fab">
        <div id="cards"><div class="empty">加载中…</div></div>
        <div class="sync-line" id="syncLine"></div>
      </div>
    </div>
    <button type="button" class="fab" id="fabNew" aria-label="新建任务">${plusIcon()}</button>
  </div>`;
  bindThemeBtn();
  document.getElementById('fabNew').addEventListener('click', () => { location.hash = '#/new/' + encodeURIComponent(machineId); });

  let buckets = null;
  const chipsEl = document.getElementById('chips');
  const cardsEl = document.getElementById('cards');

  function selected() {
    const cur = boardSel.get(machineId);
    if (cur && buckets) return cur;
    // 默认选第一个非空桶（优先处理中）；全空则停在处理中
    if (buckets) for (const b of BUCKETS) if ((buckets[b.key] || []).length) return b.key;
    return 'processing';
  }
  function paint() {
    if (!buckets) return;
    const sel = selected();
    chipsEl.innerHTML = BUCKETS.map((b) =>
      `<button type="button" class="chip ${b.key === sel ? 'on' : ''}" data-bucket="${b.key}">
        ${escapeHtml(b.label)}<span class="n">${(buckets[b.key] || []).length}</span>
      </button>`).join('');
    const list = (buckets[sel] || []).slice()
      .sort((a, b) => (Number(b.lastActivityMs) || 0) - (Number(a.lastActivityMs) || 0));
    cardsEl.innerHTML = list.length
      ? list.map((t) => taskCardHtml(machineId, t)).join('')
      : `<div class="empty">「${escapeHtml(STATE_META[sel].label)}」暂无任务</div>`;
  }
  chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bucket]');
    if (!b) return;
    boardSel.set(machineId, b.dataset.bucket);
    paint();
  });

  let loading = false;
  async function load(manual = false) {
    if (loading || (document.hidden && !manual)) return;   // 后台标签页不空转
    loading = true;
    const btn = document.getElementById('reloadBtn');
    btn?.classList.add('spin');
    try {
      const res = await rpc(machineId, 'state');
      if (!res.ok) {
        if (res.code === 'AUTH') return;
        if (buckets && (res.code === 'RELAY_TIMEOUT' || res.code === 'NETWORK')) {
          toast(res.message, 'err');   // 已有数据时瞬时故障不清屏，提示后保留旧数据
          return;
        }
        document.getElementById('boardBody').innerHTML = rpcHolder(res, machineId);
        document.querySelector('#boardBody [data-retry]')?.addEventListener('click', () => viewBoard(machineId));
        const fab = document.getElementById('fabNew');
        if (fab) fab.style.display = 'none';   // 机器都不可达了，新建入口一并收起
        return;
      }
      if (!document.getElementById('chips')) {   // 从占位页恢复
        viewBoard(machineId);
        return;
      }
      buckets = normalizeBuckets(res.data);
      paint();
      const sync = document.getElementById('syncLine');
      if (sync) sync.textContent = '拉取于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    } finally {
      loading = false;
      btn?.classList.remove('spin');
    }
  }
  document.getElementById('reloadBtn').addEventListener('click', () => load(true));
  await load(true);
  const timer = setInterval(load, 10000);   // spec §5.3：10s 轮询
  onCleanup(() => clearInterval(timer));
}

// ==========================================================================
// 详情 #/task/:machineId/:taskKey（taskDetail + workerLog + watch SSE + 消息 + 动作条）
// ==========================================================================
// 动作条按当前 state（spec / 任务书）：plan→确认执行 · processing→中断 · awaiting-human→完成 · done→撤回完成
const STATE_ACTIONS = {
  plan: [{ verb: 'approve', label: '确认执行', cls: 'btn-primary' }],
  processing: [{
    verb: 'cancel', label: '中断', cls: 'btn-danger',
    confirm: { title: '中断执行？', message: '停止当前执行，任务回到「等人工」。已产生的改动不会回滚。', confirmText: '中断', danger: true },
  }],
  'awaiting-human': [{ verb: 'complete', label: '完成', cls: 'btn-primary' }],
  done: [{ verb: 'uncomplete', label: '撤回完成', cls: '' }],
};
const ROLE_LABEL = { user: '我', assistant: 'CLAUDE', tool: '工具', system: '系统' };

/**
 * 块的稳定 key。真实 relay 块（relay-verbs.js workerLogBlocks）没有 idx 字段，但 workerLog 响应
 * 和 watch 帧都带 total（全量块数）且 blocks 恒为列表尾窗 → 绝对下标 = total - L + i 可就地算出。
 * 这让「watch 基线帧整窗重发」「增量帧与上一帧重叠 1 块（变化的尾部块）」「加载更早的重叠窗」
 * 都能按 key 去重/覆盖，不重复渲染。mock/未来后端若自带 idx 则直接用。
 */
function blockKey(b) {
  if (typeof b?.idx === 'number') return b.idx;
  if (typeof b?.__k === 'number') return b.__k;
  return null;
}
function keyBlocks(list, total) {
  const L = list.length;
  list.forEach((b, i) => {
    if (b && typeof b === 'object' && typeof b.idx !== 'number' && typeof b.__k !== 'number') {
      b.__k = (typeof total === 'number' ? total : L) - L + i;
    }
  });
  return list;
}
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '\n…（已截断）' : s);
/** tool_result 的 content：string 或 [{type:'text',text}] 数组，两种都出现在 CC jsonl 里 */
function toolResultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).filter(Boolean).join('\n');
  return '';
}
/**
 * CC content 数组（relay-verbs.js workerLogBlocks 摊平后的真实块形态：
 * {role, at, content:[{type:'text'|'thinking'|'tool_use'|'tool_result', …}]}）
 */
function ccContentHtml(list) {
  const parts = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') {
      parts.push(`<div class="md">${renderMd(c.text)}</div>`);
    } else if (c.type === 'thinking' && typeof c.thinking === 'string') {
      parts.push(`<div class="md thinking">${renderMd(truncate(c.thinking, 800))}</div>`);
    } else if (c.type === 'tool_use') {
      let arg = '';
      try { arg = c.input === undefined ? '' : JSON.stringify(c.input); } catch { }
      parts.push(`<div class="tool-line">⏺ ${escapeHtml(c.name || 'tool')}<code>${escapeHtml(truncate(arg, 160))}</code></div>`);
    } else if (c.type === 'tool_result') {
      const txt = toolResultText(c.content);
      if (txt.trim()) parts.push(`<pre class="tool-res">${escapeHtml(truncate(txt, 600))}</pre>`);
    }
  }
  return parts.join('');
}
function blockHtml(b) {
  if (b == null) return '';
  if (typeof b === 'string') return `<div class="blk"><div class="md">${renderMd(b)}</div></div>`;
  const role = String(b.role || b.kind || 'assistant');
  const md = b.md ?? b.text ?? b.body ?? (typeof b.content === 'string' ? b.content : null);
  const at = b.at || b.ts || null;
  const inner = md != null
    ? `<div class="md">${renderMd(md)}</div>`
    : Array.isArray(b.content)
      ? (ccContentHtml(b.content) || '<div class="md" style="color:var(--dim)">（空消息）</div>')
      : `<pre class="raw">${escapeHtml(JSON.stringify(b, null, 1))}</pre>`;
  return `<div class="blk role-${escapeAttr(role)}${b.isMeta ? ' role-system' : ''}"${blockKey(b) !== null ? ` data-idx="${blockKey(b)}"` : ''}>
    <div class="blk-head">
      <span class="blk-role">${escapeHtml(ROLE_LABEL[role] || role)}</span>
      ${at ? `<span class="blk-at" title="${escapeAttr(fmtDateTime(at))}">${escapeHtml(fmtAgo(at))}</span>` : ''}
    </div>
    ${inner}
  </div>`;
}

async function viewTask(machineId, taskKey) {
  runCleanups();   // 允许「重试」直接重入：先关上一轮的 EventSource
  document.title = 'ScrumWS · 任务详情';
  const backTo = '#/board/' + encodeURIComponent(machineId);
  app.innerHTML = `
  <div class="view">
    ${topbarHtml({ back: backTo, title: '任务详情' })}
    <div class="page has-bbar" id="dtPage"><div class="empty">加载中…</div></div>
  </div>`;
  const page = document.getElementById('dtPage');

  const [dRes, wlRes] = await Promise.all([
    rpc(machineId, 'taskDetail', { taskKey }),
    rpc(machineId, 'workerLog', { taskKey, tail: 30 }),
  ]);
  if (dRes.code === 'AUTH' || wlRes.code === 'AUTH') return;
  // detail 与输出都拿不到才算真错；detail 失败但输出能拉（异常兜底）→ 降级渲染，至少让输出可见。
  // （CLI 观察态任务的 detail 由后端从 lifecycle 卡兜底合成，正常不会走到这里的降级分支。）
  if (!dRes.ok && !wlRes.ok) {
    page.innerHTML = rpcHolder(dRes, machineId);
    page.querySelector('[data-retry]')?.addEventListener('click', () => viewTask(machineId, taskKey));
    return;
  }
  const d = dRes.ok ? (dRes.data || {}) : {
    taskKey, title: taskKey, prompt: null, history: [],
    source: String(wlRes.data?.taskKey || taskKey).startsWith('cli:') ? 'cli' : null,
    state: wlRes.data?.state || null,
  };
  let curState = d.state || 'awaiting-human';
  let curOutcome = d.outcome || null;
  const title = d.title || taskKey;
  document.title = 'ScrumWS · ' + title;

  // ---- 输出流状态（blocks 以绝对下标 key 去重/定位）----
  const wl = wlRes.ok ? (wlRes.data || {}) : {};
  let total = Number(wl.total ?? (wl.blocks || []).length);
  let blocks = keyBlocks(Array.isArray(wl.blocks) ? wl.blocks.slice() : [], total);
  const seen = new Set(blocks.map(blockKey).filter((k) => k !== null));

  page.innerHTML = `
    <section class="card dt-head">
      <div class="tc-title">${escapeHtml(title)}</div>
      <div class="dt-tags" id="dtTags"></div>
      <div class="dt-meta" title="${escapeAttr(d.cwd || '')}">${escapeHtml(d.cwd || '')}${d.model ? ' · ' + escapeHtml(d.model) : ''}${d.effort ? ' · ' + escapeHtml(d.effort) : ''}</div>
      ${d.prompt ? `<details class="dt-prompt"><summary>Prompt 全文</summary><div class="prompt-box">${escapeHtml(d.prompt)}</div></details>` : ''}
    </section>
    <div class="stream-head">
      <h2>输出</h2>
      <span class="live-dot" id="liveDot"><i></i><span id="liveTxt">连接中</span></span>
    </div>
    ${wlRes.ok ? '' : `<div class="empty" style="padding:14px">输出加载失败：${escapeHtml(wlRes.message)}</div>`}
    <button type="button" class="btn loadmore" id="loadMore" style="display:none">加载更早</button>
    <div id="stream"></div>
    <div class="stream-done" id="streamDone" style="display:none">— 输出已收敛 —</div>
    <div class="bbar"><div class="bbar-in">
      <div class="actrow" id="actRow"></div>
      <div class="msgrow">
        <textarea class="fi" id="msgInput" rows="1" placeholder="发消息给这个任务…" aria-label="消息"></textarea>
        <button type="button" class="send" id="msgSend" aria-label="发送">${sendIcon()}</button>
      </div>
    </div></div>`;

  const streamEl = document.getElementById('stream');
  const loadMoreBtn = document.getElementById('loadMore');

  function paintTags() {
    document.getElementById('dtTags').innerHTML = [
      stateTagHtml(curState), outcomeTagHtml(curOutcome), sourceTagHtml(d.source),
      d.worktree ? '<span class="tag tag-mut">worktree</span>' : '',
    ].filter(Boolean).join('');
  }
  function paintActions() {
    const row = document.getElementById('actRow');
    row.innerHTML = (STATE_ACTIONS[curState] || []).map((a) =>
      `<button type="button" class="btn ${a.cls}" data-verb="${a.verb}">${escapeHtml(a.label)}</button>`).join('');
  }
  function paintLoadMore() {
    const remain = total - blocks.length;
    loadMoreBtn.style.display = remain > 0 ? '' : 'none';
    loadMoreBtn.textContent = `加载更早（还有 ${Math.max(0, remain)} 块）`;
  }
  function nearBottom() {
    return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  }
  function appendBlocks(list) {
    let added = 0;
    for (const b of list || []) {
      const k = blockKey(b);
      if (k !== null && seen.has(k)) {
        // 变化的尾部块：同 idx 覆盖重画（watch 语义 §4.5）
        const old = streamEl.querySelector(`[data-idx="${k}"]`);
        if (old) { old.outerHTML = blockHtml(b); continue; }
      }
      if (k !== null) seen.add(k);
      blocks.push(b);
      streamEl.insertAdjacentHTML('beforeend', blockHtml(b));
      added++;
    }
    if (added) streamEl.querySelector(':scope > .empty')?.remove();   // 首块到达时清掉「暂无输出」占位
    return added;
  }

  paintTags();
  paintActions();
  streamEl.innerHTML = blocks.map(blockHtml).join('') || '<div class="empty" style="padding:16px">暂无输出</div>';
  paintLoadMore();

  // ---- 「加载更早」：workerLog 只有 tail 窗口 → 扩大 tail，把比当前最早块更早的补到最前。
  //      比已显示更新的块（拉取窗口里顺带带回的）忽略，交给 watch 帧按 key 送达。----
  loadMoreBtn.addEventListener('click', async () => {
    loadMoreBtn.disabled = true;
    try {
      const res = await rpc(machineId, 'workerLog', { taskKey, tail: blocks.length + 30 });
      if (!res.ok) { toast(res.message, 'err'); return; }
      const rbTotal = Number(res.data?.total ?? total);
      const rb = keyBlocks(res.data?.blocks || [], rbTotal);
      const minKey = seen.size ? Math.min(...seen) : Infinity;
      const older = rb.filter((b) => {
        const k = blockKey(b);
        return k !== null && k < minKey && !seen.has(k);
      });
      total = Math.max(total, rbTotal);
      if (older.length) {
        // 维持视觉位置：先记高度，插入后把滚动位置补回去
        const prevH = document.documentElement.scrollHeight;
        for (const b of older) seen.add(blockKey(b));
        blocks = older.concat(blocks);
        streamEl.insertAdjacentHTML('afterbegin', older.map(blockHtml).join(''));
        window.scrollBy(0, document.documentElement.scrollHeight - prevH);
      }
      paintLoadMore();
    } finally { loadMoreBtn.disabled = false; }
  });

  // ---- watch：EventSource 增量帧（§4.3/§4.5）。帧 = {kind:'worker-log', blocks, total, state}；done=true 收敛 ----
  const liveTxt = document.getElementById('liveTxt');
  const liveDot = document.getElementById('liveDot');
  function applyState(s, outcome) {
    if (s && s !== curState) { curState = s; paintTags(); paintActions(); }
    if (outcome !== undefined && outcome !== curOutcome) { curOutcome = outcome; paintTags(); }
  }
  function onFrame(f) {
    if (!f || typeof f !== 'object') return;
    if (typeof f.total === 'number') total = Math.max(total, f.total);
    const stick = nearBottom();
    const added = appendBlocks(keyBlocks(f.blocks || [], f.total));
    if (f.state) applyState(f.state);
    paintLoadMore();
    if (added && stick) window.scrollTo(0, document.documentElement.scrollHeight);
    if (f.done) {
      applyState(f.state);
      document.getElementById('streamDone').style.display = '';
      liveDot.classList.remove('on');
      liveTxt.textContent = '已收敛';
      es.close();
    }
  }
  const es = new EventSource(`/api/my/machines/${encodeURIComponent(machineId)}/watch?taskKey=${encodeURIComponent(taskKey)}`);
  const handle = (ev) => { try { onFrame(JSON.parse(ev.data)); } catch { } };
  es.onopen = () => { liveDot.classList.add('on'); liveTxt.textContent = '实时'; };
  es.onmessage = handle;
  es.addEventListener('frame', handle);   // 服务端若用命名事件也认
  es.addEventListener('done', handle);
  es.onerror = () => {   // EventSource 自带重连；这里只如实标注状态
    if (es.readyState !== EventSource.CLOSED) { liveDot.classList.remove('on'); liveTxt.textContent = '重连中…'; }
  };
  onCleanup(() => es.close());

  // ---- 消息（rpc message：活会话注入 / resume，本地分支；plan/queued/done 拒绝并透传原因）----
  const input = document.getElementById('msgInput');
  const sendBtn = document.getElementById('msgSend');
  input.addEventListener('input', () => {   // 1~4 行自适应
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
  });
  async function sendMsg() {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      const res = await rpc(machineId, 'message', { taskKey, text });
      if (!res.ok) { toast(res.message, 'err'); return; }
      input.value = '';
      input.style.height = 'auto';
      toast('已发送');
      if (res.data?.state) applyState(res.data.state);   // resume 分支会把任务带回 processing
    } finally { sendBtn.disabled = false; }
  }
  sendBtn.addEventListener('click', sendMsg);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMsg(); }
  });

  // ---- 动作条（事件委托；破坏性动作过 confirmSheet）----
  document.getElementById('actRow').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-verb]');
    if (!btn) return;
    const act = (STATE_ACTIONS[curState] || []).find((a) => a.verb === btn.dataset.verb);
    if (!act) return;
    if (act.confirm && !await confirmSheet(act.confirm)) return;
    btn.disabled = true;
    try {
      const res = await rpc(machineId, act.verb, { taskKey });
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast(`「${act.label}」已执行`);
      // 状态机在本地：以返回为准，没带就按预期迁移画（下一次 watch/刷新会校正）
      const next = res.data?.state
        || { approve: 'queued', cancel: 'awaiting-human', complete: 'done', uncomplete: 'awaiting-human' }[act.verb];
      applyState(next, res.data?.outcome ?? (act.verb === 'cancel' ? 'cancelled' : act.verb === 'complete' ? 'success' : null));
    } finally { btn.disabled = false; }
  });
}

// ==========================================================================
// 新建 #/new/:machineId（rpc cwds → 表单 → rpc createTask）
// ==========================================================================
// model / effort 选项与本地新建表单同源（platform/public/index.html #newTaskModel/#newTaskEffort）
const MODEL_OPTS = [
  ['claude-opus-4-8', 'Opus 4.8'], ['claude-fable-5', 'Fable 5'], ['claude-opus-4-7', 'Opus 4.7'],
  ['claude-sonnet-5', 'Sonnet 5'], ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
];
const EFFORT_OPTS = ['low', 'medium', 'high', 'xhigh', 'max'];

async function viewNew(machineId) {
  document.title = 'ScrumWS · 新建任务';
  const backTo = '#/board/' + encodeURIComponent(machineId);
  app.innerHTML = `
  <div class="view">
    ${topbarHtml({ back: backTo, title: '新建任务' })}
    <div class="page" id="newPage"><div class="empty">加载中…</div></div>
  </div>`;
  const page = document.getElementById('newPage');

  const res = await rpc(machineId, 'cwds');
  if (res.code === 'AUTH') return;
  if (!res.ok) {
    page.innerHTML = rpcHolder(res, machineId);
    page.querySelector('[data-retry]')?.addEventListener('click', () => viewNew(machineId));
    return;
  }
  const cwds = Array.isArray(res.data?.cwds) ? res.data.cwds : (Array.isArray(res.data) ? res.data : []);
  if (!cwds.length) {
    // 白名单空 = 本地闸门拒绝一切远程新建（fail-closed 是设计）。指路，不绕路。
    page.innerHTML = holderHtml({
      icon: alertIcon(), title: '目录白名单为空',
      desc: '远程新建任务只能落在白名单目录内。请到电脑端「设置 → 云端」添加允许的工作目录。',
      retry: false, backTo,
    });
    return;
  }

  page.classList.add('has-bbar');
  page.innerHTML = `
    <label class="fld">
      <span class="fld-l">标题（可选）</span>
      <input class="fi" id="nTitle" maxlength="120" placeholder="一句话说明这个任务">
    </label>
    <label class="fld">
      <span class="fld-l">Prompt（发给 claude 的指令）</span>
      <textarea class="fi" id="nPrompt" placeholder="要做什么、约束是什么、验收标准是什么…"></textarea>
    </label>
    <label class="fld">
      <span class="fld-l">工作目录（白名单）</span>
      <select class="fi mono" id="nCwd">
        ${cwds.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('')}
      </select>
    </label>
    <div style="display:flex;gap:10px">
      <label class="fld" style="flex:1">
        <span class="fld-l">Model</span>
        <select class="fi" id="nModel">
          ${MODEL_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </label>
      <label class="fld" style="flex:1">
        <span class="fld-l">Effort</span>
        <select class="fi" id="nEffort">
          ${EFFORT_OPTS.map((v) => `<option value="${v}"${v === 'xhigh' ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
    </div>
    <label class="sw fld">
      <input type="checkbox" id="nWorktree">
      <span><span class="sw-t">在 worktree 中执行</span><span class="sw-d">隔离分支跑，不碰主检出</span></span>
    </label>
    <label class="fld">
      <span class="fld-l">定时执行（可选）</span>
      <input class="fi" type="datetime-local" id="nSched" min="${escapeAttr(minDatetimeLocal())}">
      <span class="fld-hint">留空 = 立即处理；设了时间 = 到点由电脑端自动执行（存为计划，可在看板提前确认）</span>
    </label>
    <div class="bbar"><div class="bbar-in subrow" id="subrow"></div></div>`;

  // 定时与否决定底部按钮：设了时间 → 单个「定时执行」（createTask 有 scheduledAt 必落 plan、到点提升）；
  // 没设 → 「存为计划 / 立即执行」两个。
  const schedEl = document.getElementById('nSched');
  function paintSubrow() {
    const scheduled = !!schedEl.value;
    document.getElementById('subrow').innerHTML = scheduled
      ? '<button type="button" class="btn btn-primary btn-block" id="nSchedBtn">定时执行</button>'
      : '<button type="button" class="btn" id="nPlan">存为计划</button>'
      + '<button type="button" class="btn btn-primary" id="nRun">立即执行</button>';
    document.getElementById('nSchedBtn')?.addEventListener('click', () => submit(true));
    document.getElementById('nRun')?.addEventListener('click', () => submit(false));
    document.getElementById('nPlan')?.addEventListener('click', () => submit(true));
  }
  schedEl.addEventListener('input', paintSubrow);

  async function submit(plan) {
    const prompt = document.getElementById('nPrompt').value.trim();
    if (!prompt) { toast('Prompt 不能为空', 'err'); return; }
    const scheduledAt = datetimeLocalToLocalStr(schedEl.value);   // 'yyyy-MM-ddTHH:mm' → 'yyyy-MM-dd HH:mm:ss'
    const body = {
      title: document.getElementById('nTitle').value.trim() || null,
      prompt,
      model: document.getElementById('nModel').value,
      effort: document.getElementById('nEffort').value,
      cwd: document.getElementById('nCwd').value,
      worktree: document.getElementById('nWorktree').checked,
      scheduledAt: scheduledAt || undefined,   // 给了 → 后端 createTask 强制 plan
      plan,
    };
    document.querySelectorAll('#subrow .btn').forEach((b) => { b.disabled = true; });
    try {
      const r = await rpc(machineId, 'createTask', body);
      if (!r.ok) { toast(r.message, 'err'); return; }   // 502 = 本地拒绝（白名单外等），原因透传
      const taskKey = r.data?.taskKey || r.data?.key;
      toast(scheduledAt ? `已定时到 ${scheduledAt.slice(0, 16)}` : (plan ? '已存为计划' : '已排队执行'));
      location.hash = taskKey
        ? `#/task/${encodeURIComponent(machineId)}/${encodeURIComponent(taskKey)}`
        : backTo;
    } finally { document.querySelectorAll('#subrow .btn').forEach((b) => { b.disabled = false; }); }
  }
  paintSubrow();
}

// ==========================================================================
// 启动：已有会话（/api/auth/me 200）自动跳过登录
// ==========================================================================
async function boot() {
  let r;
  try { r = await api('/api/auth/me'); } catch { r = { status: 0, json: null }; }
  if (r.status === 200 && r.json?.user) me = r.json;
  const before = location.hash;
  if (!me && location.hash !== '#/login') {
    pendingHash = location.hash || null;
    location.replace('#/login');
  } else if (me && (!location.hash || location.hash === '#/login')) {
    location.replace('#/machines');
  }
  // replace 改了 hash 时 hashchange 会自己触发 router，别叫两次（会重复挂轮询/SSE）
  if (location.hash === before) router();
}
boot();
