'use strict';
/* ==========================================================================
   cloud/public 通用组件层 —— 原生 JS + DOM，零依赖，全站共用一份
   （dropdown / modal / toast；index.html 在 app.js **之前**引它）

   为什么自研而不用浏览器原生组件：
     · `<select>` 的收起态能用 CSS 改，但**展开的选项框是操作系统画的、改不了** ——
       暗色主题下会露出 Windows 原生白底列表，主题当场破功。收起态好看 ≠ 展开态能看。
     · `alert()` / `confirm()` / `prompt()` 同理是系统对话框：排版/配色全无，还会阻塞 JS 主线程。
   ⚠ 视觉语言仍照 multica 抄（docs/spec/multica-style-guide.md）：oklch token / 圆角阶梯 /
     ring 代 border / lucide 内联图标。被推翻的只是该文档 §4「移植为原生组件样式」这条**实现策略**，
     不是它的设计语言 —— 别把这里的自研组件当成「不跟 multica 了」。

   自研就得补齐原生 select 白送的能力，否则是退步：键盘可达（↑↓/Enter/Esc/Tab）、
   点外部关闭、浮层盖得出容器、ARIA、选中/hover/禁用态。下面逐条兑现。
   ========================================================================== */

const UI = (() => {
  // 组件层自带，不借 app.js 的同名函数：ui.js 先于 app.js 执行，依赖它等于埋一颗加载顺序雷
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ========================================================================
  // Dropdown —— 触发器 + 自绘浮层
  // ========================================================================
  /**
   * @param {object} o
   * @param {HTMLElement} o.mount     挂载点（触发器插进去；浮层挂 body）
   * @param {{value:string,label:string,disabled?:boolean}[]} o.options
   * @param {string} o.value          当前值
   * @param {(v:string)=>void} o.onChange  仅在值**真的变了**时触发（与原生 change 同语义）
   * @param {string} o.ariaLabel
   * @param {string} o.minWidth       如 '140px'
   * @returns {{setOptions:Function,setValue:Function,getValue:Function,el:HTMLElement}}
   */
  function dropdown({ mount, options = [], value = '', onChange, ariaLabel, minWidth }) {
    let opts = options.slice();
    let val = value;
    let pop = null;
    let active = -1;             // 键盘高亮项下标

    const trig = document.createElement('button');
    trig.type = 'button';        // 默认 submit，落在 <form> 里会误提交
    trig.className = 'dd-trig';
    trig.setAttribute('role', 'combobox');
    trig.setAttribute('aria-haspopup', 'listbox');
    trig.setAttribute('aria-expanded', 'false');
    if (ariaLabel) trig.setAttribute('aria-label', ariaLabel);
    if (minWidth) trig.style.minWidth = minWidth;
    trig.innerHTML = '<span class="dd-val"></span>'
      + '<svg class="dd-caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
    mount.appendChild(trig);

    const cur = () => opts.find((o) => o.value === val);
    const paintTrig = () => { trig.querySelector('.dd-val').textContent = cur()?.label ?? opts[0]?.label ?? ''; };

    function paintActive() {
      if (!pop) return;
      [...pop.querySelectorAll('.dd-opt')].forEach((el, i) => {
        el.classList.toggle('on', i === active);
        if (i === active) el.scrollIntoView({ block: 'nearest' });
      });
    }

    // 浮层用 position:fixed 并挂在 body 上：#pageWrap / .board-toolbar 链上有 overflow:auto，
    // 挂在容器里会被裁掉（这正是「浮层要能盖出容器」那条要求的成因）。
    function place() {
      if (!pop) return;
      const r = trig.getBoundingClientRect();
      const h = pop.offsetHeight;
      const flipUp = window.innerHeight - r.bottom - 8 < h && r.top > h;   // 下方放不下且上方放得下 → 向上翻
      pop.style.minWidth = r.width + 'px';
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = (flipUp ? r.top - h - 6 : r.bottom + 6) + 'px';
    }

    function onDocDown(e) {
      if (pop && !pop.contains(e.target) && !trig.contains(e.target)) close();   // 点外部关闭
    }

    function close() {
      if (!pop) return;
      pop.remove();
      pop = null;
      active = -1;
      trig.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onDocDown, true);
      window.removeEventListener('resize', place, true);
      window.removeEventListener('scroll', place, true);
    }

    function open() {
      if (pop) return close();
      pop = document.createElement('div');
      pop.className = 'dd-pop';
      pop.setAttribute('role', 'listbox');
      if (ariaLabel) pop.setAttribute('aria-label', ariaLabel);
      pop.innerHTML = opts.map((o, i) => `
        <div class="dd-opt${o.value === val ? ' sel' : ''}${o.disabled ? ' dis' : ''}" role="option"
             data-i="${i}" aria-selected="${o.value === val}"${o.disabled ? ' aria-disabled="true"' : ''}>
          <span class="dd-opt-t">${esc(o.label)}</span>
          <svg class="dd-tick" viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>
        </div>`).join('');
      document.body.appendChild(pop);
      trig.setAttribute('aria-expanded', 'true');
      active = Math.max(0, opts.findIndex((o) => o.value === val));
      paintActive();
      place();
      document.addEventListener('mousedown', onDocDown, true);
      window.addEventListener('resize', place, true);
      window.addEventListener('scroll', place, true);   // capture：#pageWrap 内部滚动也要跟，否则浮层会脱锚
      pop.addEventListener('click', (e) => {
        const el = e.target.closest('.dd-opt');
        if (el) pick(Number(el.dataset.i));
      });
      pop.addEventListener('mousemove', (e) => {
        const el = e.target.closest('.dd-opt');
        if (el && !el.classList.contains('dis')) { active = Number(el.dataset.i); paintActive(); }
      });
    }

    function pick(i) {
      const o = opts[i];
      if (!o || o.disabled) return;
      const changed = o.value !== val;
      val = o.value;
      paintTrig();
      close();
      trig.focus();                        // 关闭后焦点回触发器（键盘用户不能丢焦点）
      if (changed) onChange?.(val);
    }

    function move(d) {
      if (!opts.length) return;
      let i = active;
      for (let n = 0; n < opts.length; n++) {      // 跳过禁用项，循环绕回
        i = (i + d + opts.length) % opts.length;
        if (!opts[i].disabled) { active = i; paintActive(); return; }
      }
    }

    trig.addEventListener('click', open);
    trig.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown': case 'ArrowUp':
          e.preventDefault();
          if (!pop) open(); else move(e.key === 'ArrowDown' ? 1 : -1);
          break;
        case 'Enter': case ' ':
          e.preventDefault();
          if (pop) pick(active); else open();
          break;
        case 'Escape':
          if (pop) { e.preventDefault(); close(); }
          break;
        case 'Tab':
          close();                          // Tab 移焦 → 顺手收浮层（别让它飘在那）
          break;
        case 'Home': case 'End':
          if (pop) { e.preventDefault(); active = e.key === 'Home' ? -1 : opts.length; move(e.key === 'Home' ? 1 : -1); }
          break;
      }
    });

    paintTrig();
    return {
      el: trig,
      getValue: () => val,
      setValue(v) { val = v; paintTrig(); if (pop) { close(); open(); } },
      /** 选项换了但当前值仍在新集合里 → 保留选中（机器列表 15s 刷一次，不能把用户的筛选刷没） */
      setOptions(next) {
        opts = next.slice();
        if (!opts.some((o) => o.value === val)) val = opts[0]?.value ?? '';
        paintTrig();
        if (pop) { close(); open(); }
      },
    };
  }

  // ========================================================================
  // Modal —— 自研二次确认（破坏性操作用它，别用 confirm()）
  // ========================================================================
  /**
   * @returns {Promise<boolean>} 确认 true / 取消・Esc・点遮罩 false
   * @param {string} o.messageHtml 允许 HTML（**调用方负责转义**动态片段）
   * @param {'default'|'danger'} o.tone danger 档：确认键红、且**点遮罩不关**（破坏性操作要求明确表态）
   */
  function modal({ title, messageHtml = '', confirmText = '确定', cancelText = '取消', tone = 'default' }) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const wrap = document.createElement('div');
      wrap.className = 'mo-wrap';
      wrap.innerHTML = `
        <div class="mo-mask"></div>
        <div class="mo-card" role="dialog" aria-modal="true" aria-labelledby="moTitle">
          <div class="mo-t" id="moTitle">${esc(title)}</div>
          <div class="mo-m">${messageHtml}</div>
          <div class="mo-f">
            <button type="button" class="btn" data-no>${esc(cancelText)}</button>
            <button type="button" class="btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);

      const card = wrap.querySelector('.mo-card');
      const btns = [...card.querySelectorAll('button')];

      const done = (v) => {
        wrap.remove();
        document.removeEventListener('keydown', onKey, true);
        prevFocus?.focus?.();               // 焦点还给打开它的那个按钮
        resolve(v);
      };
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(false); return; }
        if (e.key !== 'Tab') return;
        // 焦点陷阱：Tab 只在 modal 内部循环，不许跑到背后的页面上
        const i = btns.indexOf(document.activeElement);
        e.preventDefault();
        btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
      }
      document.addEventListener('keydown', onKey, true);
      card.querySelector('[data-yes]').addEventListener('click', () => done(true));
      card.querySelector('[data-no]').addEventListener('click', () => done(false));
      // 破坏性确认**不给**点遮罩关的路（要么点确定要么点取消，别让人手滑划过去）
      if (tone !== 'danger') wrap.querySelector('.mo-mask').addEventListener('click', () => done(false));
      // 背景滚动：.mo-mask 是 position:fixed 铺满视口的，滚轮事件落在它身上，
      // 而 body 本身 overflow:hidden（index.html 的 body 规则）、真正的滚动容器 #pageWrap 不在它的祖先链上
      // → 背景天然滚不动，不需要再加一层锁（实测见 round-2.md「modal 背景不滚动」）。
      (tone === 'danger' ? card.querySelector('[data-no]') : card.querySelector('[data-yes]')).focus();
    });
  }

  /** 破坏性确认的语义糖 */
  const confirmDanger = (o) => modal({ ...o, tone: 'danger' });

  // ========================================================================
  // Toast —— 轻反馈（「已复制」这类），别用 alert()
  // ========================================================================
  const ICON = {
    ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/></svg>',
    err: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
  };
  function toast(msg, tone = 'ok', ms = 2800) {
    let host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.setAttribute('role', 'status');       // 读屏能播报
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = 'toast ' + (tone === 'err' ? 'err' : 'ok');
    t.innerHTML = (ICON[tone] || ICON.ok) + `<span>${esc(msg)}</span>`;
    host.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      t.addEventListener('animationend', () => t.remove(), { once: true });
    }, ms);
  }

  return { dropdown, modal, confirmDanger, toast };
})();
