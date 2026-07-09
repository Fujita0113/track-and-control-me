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
  const header = h(
    'div',
    { class: 'modal-header' },
    h('h3', { text: title || '' }),
    h('button', { class: 'icon-btn', text: '✕', title: '閉じる', onclick: closeModal }),
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
