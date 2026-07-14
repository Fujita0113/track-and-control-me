// 共有ユーティリティ: DOM ヘルパー / 時間整形 / 色マップ / モーダル。
// すべて CSSOM (element.style.*) 経由でスタイルを適用し、CSP に適合する。

/** Edge グループ色名 → hex。null/未知は neutral grey。 */
export const GROUP_COLORS = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e',
};
export const FALLBACK_COLOR = '#5f6368';

/** 色名(または既に hex)→ hex。 */
export function colorHex(name) {
  if (!name) return FALLBACK_COLOR;
  if (typeof name === 'string' && name.startsWith('#')) return name;
  return GROUP_COLORS[name] || FALLBACK_COLOR;
}

/** createElement ラッパー。属性/子/イベントをまとめて設定。
 * on* は addEventListener（インライン属性ではない）で登録するため CSP 適合。
 * style はオブジェクトを CSSOM 経由で適用（インライン属性ではない）。 */
export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [p, val] of Object.entries(v)) e.style[p] = val;
      } else if (k === 'dataset' && typeof v === 'object') {
        for (const [p, val] of Object.entries(v)) e.dataset[p] = val;
      } else if (k.startsWith('on') && typeof v === 'function') {
        e.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) {
        e.setAttribute(k, '');
      } else {
        e.setAttribute(k, v);
      }
    }
  }
  appendKids(e, kids);
  return e;
}

function appendKids(e, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) {
      appendKids(e, kid);
    } else if (kid instanceof Node) {
      e.appendChild(kid);
    } else {
      e.appendChild(document.createTextNode(String(kid)));
    }
  }
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

/** 秒 → "Xh Ym" / "Ym"。0 以下は "0m"。 */
export function fmtDur(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** 秒 → "H:MM"。 */
export function fmtHM(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** epoch ms → "HH:MM"（ブラウザ ローカル tz）。 */
export function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** epoch ms → datetime-local input 値 "YYYY-MM-DDTHH:MM"（ローカル tz）。 */
export function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local input 値 → epoch ms。 */
export function fromLocalInput(v) {
  return new Date(v).getTime();
}

/** 'YYYY-MM-DD' に n 日加算（UTC 計算で tz ずれ回避）。 */
export function addDays(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** 今日(ブラウザローカル)の 'YYYY-MM-DD'。 */
export function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// --- トースト ------------------------------------------------------------
let toastTimer = null;
export function toast(msg, kind = 'info') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = h('div', { id: 'toast-host', class: 'toast-host' });
    document.body.appendChild(host);
  }
  clear(host);
  host.appendChild(h('div', { class: `toast toast-${kind}`, text: msg }));
  host.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('show'), 3200);
}

// --- モーダル ------------------------------------------------------------
export function openModal(contentNode, title) {
  const root = document.getElementById('modal-root');
  clear(root);
  const panel = h('div', { class: 'modal-panel' });
  const closeBtn = h('button', { class: 'icon-btn', text: '✕', onclick: closeModal });
  attachTooltip(closeBtn, { label: '閉じる', keys: ['Esc'] });
  const header = h(
    'div',
    { class: 'modal-header' },
    h('h3', { text: title || '' }),
    closeBtn,
  );
  panel.appendChild(header);
  panel.appendChild(contentNode);
  const backdrop = h('div', { class: 'modal-backdrop' });
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  root.appendChild(backdrop);
  root.classList.add('open');
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  clear(root);
  root.classList.remove('open');
}

/** クリップボードコピー（同一オリジン・ネットワーク不要）。 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました', 'ok');
  } catch {
    toast('コピーに失敗しました', 'err');
  }
}

/** 空状態プレースホルダ。 */
export function emptyState(msg) {
  return h('div', { class: 'empty', text: msg });
}

// --- ショートカット提示（カスタムツールチップ / kbd チップ） --------------
// shortcut-hover-hints: 主要操作（保存 Ctrl/Cmd+Enter・閉じる Esc・タブ切替 数字キー）の
// ショートカットをボタンのホバー／フォーカスでその場に提示する。ブラウザ標準 title は使わない。

/** mac 判定（取得失敗時は false=Ctrl 表記へフォールバック）。 */
function isMac() {
  try {
    const p = (navigator.platform || '') + ' ' + (navigator.userAgent || '');
    return /Mac|iPhone|iPad|iPod/i.test(p);
  } catch { return false; }
}

/** 修飾キー表記: mac→'Cmd' / 他→'Ctrl'。 */
export function modKey() { return isMac() ? 'Cmd' : 'Ctrl'; }

/** 論理キー名（'Ctrl' 等）→ 表示ラベル。'Ctrl' は plat 依存で出し分ける。 */
function keyLabel(k) {
  if (k === 'Ctrl' || k === 'Mod') return modKey();
  return k;
}

/** 論理キー名 → aria-keyshortcuts 用トークン（W3C 表記）。 */
function keyAria(k) {
  if (k === 'Ctrl' || k === 'Mod') return isMac() ? 'Meta' : 'Control';
  if (k === 'Esc') return 'Escape';
  if (k === 'Enter') return 'Enter';
  return k;
}

/** キー配列を <kbd> チップ列（間に '+'）へ描画する。 */
export function renderKeys(keys) {
  const wrap = h('span', { class: 'kbd-keys' });
  keys.forEach((k, i) => {
    if (i > 0) wrap.appendChild(h('span', { class: 'kbd-plus', text: '+' }));
    wrap.appendChild(h('kbd', { class: 'kbd', text: keyLabel(k) }));
  });
  return wrap;
}

// body 直下に 1 つだけ持つツールチップ DOM を使い回す。
let tipEl = null;
let tipTarget = null; // 現在ヒントを出している対象（leave/blur の取り違え防止）
function ensureTip() {
  if (tipEl) return tipEl;
  tipEl = h('div', { class: 'sc-tip', role: 'tooltip' });
  document.body.appendChild(tipEl);
  // Esc でヒントを消す（グローバル。モーダル閉じ等とは独立）。
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
  return tipEl;
}

function hideTip() {
  if (tipEl) tipEl.classList.remove('show');
  tipTarget = null;
}

/** 対象 el の矩形基準でツールチップを配置（下優先、画面端で上反転＋左右クランプ）。 */
function positionTip(el) {
  const tip = tipEl;
  const r = el.getBoundingClientRect();
  // まず可視化（計測のため）だが transform は付けずに測る。
  tip.classList.add('show');
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const gap = 8;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  // 縦: 下に入らなければ上へ。
  let top = r.bottom + gap;
  if (top + th > vh - 4) top = r.top - gap - th;
  if (top < 4) top = 4;
  // 横: 対象中央に合わせ、画面端でクランプ。
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(4, Math.min(left, vw - tw - 4));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

function showTipFor(el, label, keys) {
  const tip = ensureTip();
  clear(tip);
  if (label) tip.appendChild(h('span', { class: 'sc-tip-label', text: label }));
  tip.appendChild(renderKeys(keys));
  tipTarget = el;
  positionTip(el);
}

/**
 * ショートカット付きボタンに、ホバー／キーボードフォーカスでカスタムツールチップを出す。
 * @param {Element} el 対象要素
 * @param {{label?: string, keys: string[]}} opts label（例:「保存」）と論理キー配列（例: ['Ctrl','Enter']）
 * body 直下の使い回し DOM を表示。mouseenter/focus で表示、mouseleave/blur/Esc で非表示。
 * アクセシビリティのため aria-keyshortcuts を付与する。
 */
export function attachTooltip(el, { label = '', keys = [] } = {}) {
  if (!el) return;
  el.setAttribute('aria-keyshortcuts', keys.map(keyAria).join('+'));
  const show = () => showTipFor(el, label, keys);
  const hide = () => { if (tipTarget === el) hideTip(); };
  el.addEventListener('mouseenter', show);
  el.addEventListener('focus', show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('blur', hide);
}

// --- キーボード共通ヘルパー ----------------------------------------------

/** テキスト入力中か（input/textarea/contenteditable にフォーカス、または IME 変換中）。 */
export function isTypingTarget(e) {
  if (e && (e.isComposing || e.keyCode === 229)) return true;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * フォーム root 内で Ctrl/Cmd+Enter を押すと保存ボタンを click する。
 * 既存の素の Enter 送信（enter-submit-ime-guard）とは別系統。
 * IME 変換確定（isComposing / keyCode===229）はスキップし、saveBtn が disabled 中は二重送信しない。
 */
export function ctrlEnterToSave(root, saveBtn) {
  if (!root || !saveBtn) return;
  root.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (saveBtn.disabled) return;
    saveBtn.click();
  });
}
