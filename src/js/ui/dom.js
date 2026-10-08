/** ui/dom.js — the handful of helpers the UI actually needs. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** `<svg class="i"><use href="#i-x"/></svg>` */
export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) s.setAttribute('class', cls);
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + name);
  s.appendChild(u);
  return s;
}

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'data' && typeof v === 'object') for (const [dk, dv] of Object.entries(v)) n.dataset[dk] = dv;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

export function fmtDb(v) {
  if (!isFinite(v)) return '−∞ dB';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)} dB`;
}

/* ---------------------------------------------------------------- toasts */

let toastHost = null;
export function toast(title, body, kind = '') {
  toastHost = toastHost || $('#toasts');
  if (!toastHost) return;
  const t = el('div', { class: 'toast ' + kind },
    icon(kind === 'err' ? 'alert' : kind === 'ok' ? 'check' : 'info', 'ic'),
    el('div', { class: 'tx' },
      el('div', { class: 'tt', text: title }),
      body ? el('div', { class: 'ts', text: body }) : null
    )
  );
  toastHost.appendChild(t);
  const life = kind === 'err' ? 9000 : 4200;
  setTimeout(() => {
    t.style.transition = 'opacity .25s, transform .25s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(12px)';
    setTimeout(() => t.remove(), 260);
  }, life);
  return t;
}

/* ---------------------------------------------------------------- modals */

let openModal = null;

/** Show a modal. `render(close)` returns the modal element. */
export function modal(render, opts = {}) {
  closeModal();
  const scrim = el('div', { class: 'scrim' });
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  scrim.appendChild(box);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim && !opts.sticky) closeModal(); });
  document.getElementById('modalRoot').appendChild(scrim);
  const close = () => { scrim.remove(); openModal = null; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && !opts.sticky) close(); };
  document.addEventListener('keydown', onKey);
  render(box, close);
  openModal = close;
  // focus the first sensible control
  const f = box.querySelector('input,select,button.primary,button');
  if (f) setTimeout(() => f.focus(), 30);
  return close;
}

export function closeModal() {
  if (openModal) openModal();
}

/* ---------------------------------------------------------------- inputs */

export function bindRange(input, fn) {
  const paint = () => {
    const min = +input.min || 0, max = +input.max || 100;
    const pct = ((+input.value - min) / (max - min)) * 100;
    input.style.setProperty('--pct', pct + '%');
  };
  input.addEventListener('input', () => { paint(); fn(+input.value); });
  paint();
  return paint;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}