// カンバン(spec: kanban-board)。ref/kanban/Cadence Board.dc.html の忠実移植。
//  - 4 列: 保留(HOLD) / 未着手(TODO) / 進行中(DOING) / 完了(DONE)
//  - 列内インラインの「＋ 新規タスク」コンポーザ(Enter 連続追加 / Ctrl+Enter 詳細 / Esc 取消)
//  - 完了列ドロップ → カード上フロスト演出 + 粒子 → 約1秒でアーカイブ(ボードから消えログへ)
//  - 右サイド: 本日の進捗(SVG ドーナツ) + アクティビティログ。カードクリックで詳細パネルに切替
//  - 詳細: 優先度ピル / カレンダー式期限ピッカー(今日・明日・期限なし) / 行ブロック式ライブ Markdown エディタ
//  - CSP(style-src 'self')適合: スタイルは全てクラス + CSSOM。サウンドは設定ポップオーバー(既定 OFF)
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, addDays, localDateKey, toast } from './util.js';

const COLS = [
  { key: 'HOLD', label: '保留', kind: 'plain' },
  { key: 'TODO', label: '未着手', kind: 'plain' },
  { key: 'DOING', label: '進行中', kind: 'doing' },
  { key: 'DONE', label: '完了', kind: 'done' },
];
const PRI = {
  high: { label: '高' },
  mid: { label: '中' },
  low: { label: '低' },
};
const WD_JP = ['日', '月', '火', '水', '木', '金', '土'];
const SOUND_KEY = 'tcm_kanban_sound';
const TOMORROW_KEY = 'tcm_kanban_tomorrow'; // {date, on} その日限りの「明日の計画モード」
const HOLD_AHEAD_DAYS = 7; // 保留カードの既定 due（作業日 +7）
const NS = 'http://www.w3.org/2000/svg';

// --- 明日トグル（明日の計画モード） ------------------------------------------
// クライアント状態。localStorage に日付キーで保持し、翌日は OFF にリセット。
// 振り返り画面（reflection.js）の「明日の計画へ」からも setTomorrowMode(true) で ON にする。
export function tomorrowMode() {
  try {
    const raw = JSON.parse(localStorage.getItem(TOMORROW_KEY) || 'null');
    if (raw && raw.date === state.today) return !!raw.on;
  } catch { /* noop */ }
  return false;
}
export function setTomorrowMode(on) {
  localStorage.setItem(TOMORROW_KEY, JSON.stringify({ date: state.today, on: !!on }));
}

/**
 * 自動 due 決定エンジン（design D3）。ロックされていないタスクにのみ適用する純関数。
 * @param {string|null} fromCol 遷移前の列（作成時は null）
 * @param {string} toCol 遷移後の列（HOLD/TODO/DOING/DONE）
 * @param {boolean} tomorrowOn 明日トグル
 * @param {string} workday 作業日 'YYYY-MM-DD'（= state.today）
 * @returns {{change: boolean, due?: string}} change=false は「期日を変更しない」
 */
export function computeDue(fromCol, toCol, tomorrowOn, workday) {
  if (toCol === 'DONE') return { change: false }; // 完了＝アーカイブ。触らない。
  if (toCol === 'HOLD') return { change: true, due: addDays(workday, HOLD_AHEAD_DAYS) };
  // toCol は非HOLD（TODO/DOING）。
  // 作成（fromCol=null）または HOLD からの復帰なら today/明日を付与。
  if (fromCol === null || fromCol === 'HOLD') {
    return { change: true, due: tomorrowOn ? addDays(workday, 1) : workday };
  }
  // 非HOLD → 非HOLD の移動は据え置き。
  return { change: false };
}

// --- 画面状態 -------------------------------------------------------------
let rootEl = null;
let S = null;
let blurTimer = null;
const saveTimers = new Map(); // `${id}:${field}` → { timer, run }

export async function show(root) {
  rootEl = root;
  document.body.classList.add('kb-page');
  S = {
    tasks: [],
    detailId: null,
    editLine: -1,
    pendingCaret: null,
    composingCol: null,
    composerText: '',
    dueCalOpen: false,
    dueCalYM: null,
    settingsOpen: false,
    completingId: null,
    draggingId: null,
  };
  clear(root);
  root.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
  S.tasks = await api.getTasks();
  renderAll();
}

export function hide() {
  flushSaves();
  if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
  document.body.classList.remove('kb-page');
}

async function reload() {
  try { S.tasks = await api.getTasks(); } catch { /* 直前の状態を維持 */ }
  renderAll();
}

// --- 派生データ -----------------------------------------------------------
function normStatus(s) {
  return s === 'HOLD' || s === 'DOING' || s === 'DONE' ? s : 'TODO';
}
function activeTasks() {
  return S.tasks.filter((t) => normStatus(t.status) !== 'DONE');
}
function tasksFor(colKey) {
  if (colKey === 'DONE') {
    return S.tasks.filter((t) => normStatus(t.status) === 'DONE' && t.id === S.completingId);
  }
  return S.tasks.filter((t) => normStatus(t.status) === colKey);
}
function completedTodayCount() {
  return S.tasks.filter(
    (t) => normStatus(t.status) === 'DONE' && t.done_at && localDateKey(new Date(t.done_at)) === state.today,
  ).length;
}
function archivedCount() {
  return S.tasks.filter((t) => normStatus(t.status) === 'DONE').length;
}
function overdueCount() {
  return activeTasks().filter((t) => t.due && t.due < state.today).length;
}
function findTask(id) {
  return S.tasks.find((t) => t.id === id) || null;
}

// --- 明日の計画進捗（gate の tomorrow_tasks_registered と同じ数え方: due=翌日 かつ 未完了） ---
function planningThreshold() {
  const n = state.config && state.config.planning_min_tomorrow_tasks;
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function tomorrowTaskCount() {
  const tk = addDays(state.today, 1);
  return activeTasks().filter((t) => t.due === tk).length;
}

/** 参照の fmtDue: 期限なし/今日/明日/昨日/M/D 超過/M/D。 */
function fmtDue(iso) {
  if (!iso) return '期限なし';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date(`${state.today}T00:00:00`);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === -1) return '昨日';
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return diff < -1 ? `${md} 超過` : md;
}

// --- 保存(デバウンス) -----------------------------------------------------
function scheduleSave(t, field) {
  const key = `${t.id}:${field}`;
  const prev = saveTimers.get(key);
  if (prev) clearTimeout(prev.timer);
  const run = async () => {
    saveTimers.delete(key);
    try { await api.updateTask(t.id, { [field]: t[field] }); }
    catch (err) { toast(`保存に失敗: ${err.message}`, 'err'); }
  };
  saveTimers.set(key, { timer: setTimeout(run, 600), run });
}
function flushSaves() {
  for (const [, entry] of saveTimers) { clearTimeout(entry.timer); entry.run(); }
  saveTimers.clear();
}

// --- 全体レンダリング -------------------------------------------------------
function renderAll() {
  clear(rootEl);
  const page = h('div', { class: 'kb' });
  page.appendChild(headerEl());
  const main = h('div', { class: 'kb-main' });
  main.appendChild(boardEl());
  main.appendChild(asideEl());
  page.appendChild(main);
  rootEl.appendChild(page);
  afterRender();
}

function afterRender() {
  if (S.composingCol) {
    const ta = rootEl.querySelector('.kb-composer');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
  focusEditorLine();
}

// --- SVG ヘルパ -------------------------------------------------------------
function svgEl(tag, attrs, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  for (const kid of kids) e.appendChild(kid);
  return e;
}
function iconBars(size, stroke, sw) {
  return svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
    svgEl('rect', { x: '3.5', y: '4', width: '4.2', height: '16', rx: '1.4', stroke, 'stroke-width': sw }),
    svgEl('rect', { x: '9.9', y: '4', width: '4.2', height: '11', rx: '1.4', stroke, 'stroke-width': sw }),
    svgEl('rect', { x: '16.3', y: '4', width: '4.2', height: '7', rx: '1.4', stroke, 'stroke-width': sw }));
}
function iconGear() {
  return svgEl('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none' },
    svgEl('path', { d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', stroke: '#6B6A65', 'stroke-width': '1.7' }),
    svgEl('path', {
      d: 'M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
      stroke: '#6B6A65', 'stroke-width': '1.4',
    }));
}
function iconPlus() {
  return svgEl('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none' },
    svgEl('path', { d: 'M12 5v14M5 12h14', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round' }));
}
function iconClose() {
  return svgEl('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none' },
    svgEl('path', { d: 'M6 6l12 12M18 6L6 18', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }));
}
function iconCheckSmall(size, stroke, sw) {
  return svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
    svgEl('path', { d: 'M5 12.5l4 4L19 7', stroke, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}
function iconCheckAnimated(size, sw) {
  return svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
    svgEl('path', {
      d: 'M5 12.5l4.2 4.3L19 7', stroke: '#fff', 'stroke-width': sw,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'kb-check-path',
    }));
}
function iconCalendar(stroke) {
  return svgEl('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none' },
    svgEl('rect', { x: '3.5', y: '5', width: '17', height: '15', rx: '2.6', stroke, 'stroke-width': '1.7' }),
    svgEl('path', { d: 'M3.5 9.5h17', stroke, 'stroke-width': '1.7' }),
    svgEl('path', { d: 'M8 3v3M16 3v3', stroke, 'stroke-width': '1.7', 'stroke-linecap': 'round' }));
}

// --- ヘッダ -----------------------------------------------------------------
function headerEl() {
  const [, m, d] = state.today.split('-').map(Number);
  const logo = h('div', { class: 'kb-logo' }, iconBars('16', '#8A8983', '1.7'));
  const left = h('div', { class: 'kb-head-left' }, logo, h('span', { class: 'kb-title', text: 'タスクボード' }));

  const dateChip = h('div', { class: 'kb-chip' },
    h('span', { class: 'kb-chip-lbl', text: '本日' }),
    h('span', { class: 'kb-chip-val', text: `${m}月${d}日` }));
  const doneChip = h('div', { class: 'kb-chip kb-chip-done' },
    h('span', { class: 'kb-chip-dot' }),
    '完了 ', h('span', { id: 'kb-done-num', text: String(completedTodayCount()) }));

  const setWrap = h('div', { class: 'kb-set-wrap' });
  const setBtn = h('button', {
    class: 'kb-set-btn', type: 'button',
    onclick: () => { S.settingsOpen = !S.settingsOpen; renderAll(); },
  }, iconGear(), '設定');
  setWrap.appendChild(setBtn);
  if (S.settingsOpen) {
    setWrap.appendChild(h('div', {
      class: 'kb-pop-backdrop',
      onclick: () => { S.settingsOpen = false; renderAll(); },
    }));
    const pop = h('div', { class: 'kb-set-pop' }, h('div', { class: 'kb-set-title', text: '設定' }));
    pop.appendChild(h('div', { class: 'kb-set-row' },
      h('div', {},
        h('div', { class: 'kb-set-name', text: 'サウンド' }),
        h('div', { class: 'kb-set-sub', text: '完了時の効果音' })),
      switchEl(soundOn(), () => {
        localStorage.setItem(SOUND_KEY, soundOn() ? '0' : '1');
        ensureAudio();
        renderAll();
      })));
    setWrap.appendChild(pop);
  }

  // 明日の計画モード トグル（＋ ON 中は「明日のタスク n/N」進捗）。
  const tmOn = tomorrowMode();
  const planChip = h('div', { class: `kb-chip${tmOn ? ' kb-chip-plan' : ''}` },
    h('span', { class: 'kb-chip-lbl', text: '明日の計画' }),
    switchEl(tmOn, () => { setTomorrowMode(!tmOn); renderAll(); }));
  const right = h('div', { class: 'kb-head-right' }, dateChip, doneChip);
  if (tmOn) {
    const n = tomorrowTaskCount();
    const need = planningThreshold();
    right.appendChild(h('div', { class: `kb-chip kb-chip-plan${n >= need ? ' done' : ''}` },
      h('span', { class: 'kb-chip-lbl', text: '明日のタスク' }),
      h('span', { class: 'kb-chip-val', text: `${n} / ${need}` })));
  }
  right.appendChild(planChip);
  right.appendChild(setWrap);
  return h('div', { class: 'kb-head' }, left, right);
}

function switchEl(on, onToggle) {
  return h('button', { class: `kb-switch${on ? ' on' : ''}`, type: 'button', onclick: onToggle },
    h('span', { class: 'kb-switch-knob' }));
}

// --- ドラッグ端の自動横スクロール(issue #16) --------------------------------
// ドラッグ中にポインタがボード表示領域(.kb-board-scroll)の左右端近傍へ入ると、
// requestAnimationFrame ループで横スクロールし、画面外の列(特に完了)へ運べるようにする。
// HTML5 D&D を壊さないため renderAll は一切呼ばず scrollLeft を直接操作する。
const EDGE_ZONE = 90; // 端からこの距離(px)以内でスクロール開始
const MAX_SPEED = 18; // 1フレームあたりの最大スクロール量(px)
let autoScrollEl = null;
let autoScrollDir = 0; // -1=左 / +1=右 / 0=停止
let autoScrollSpeed = 0;
let autoScrollRAF = null;

function autoScrollStep() {
  if (!autoScrollEl || autoScrollDir === 0) { autoScrollRAF = null; return; }
  autoScrollEl.scrollLeft += autoScrollDir * autoScrollSpeed; // 端に達しても値はクランプされ継続
  autoScrollRAF = requestAnimationFrame(autoScrollStep);
}

/** 端への食い込み量 intensity(0〜1) に比例した速度でループ開始/更新。冪等。 */
function startAutoScroll(el, dir, intensity) {
  if (!S || !S.draggingId) return; // ドラッグ中でなければ無視(暴走防止)
  autoScrollEl = el;
  autoScrollDir = dir;
  autoScrollSpeed = MAX_SPEED * Math.max(0, Math.min(1, intensity));
  if (autoScrollRAF == null) autoScrollRAF = requestAnimationFrame(autoScrollStep);
}

function stopAutoScroll() {
  if (autoScrollRAF != null) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
  autoScrollEl = null;
  autoScrollDir = 0;
  autoScrollSpeed = 0;
}

// --- ボード -----------------------------------------------------------------
function boardEl() {
  const scroll = h('div', {
    class: 'kb-board-scroll',
    onclick: () => { if (S.detailId != null || S.dueCalOpen) closeDetail(); },
  });
  // ドラッグ中の端寄せで自動横スクロール。dragover はバブリングするため、列側の
  // 挿入インジケータ経路(kanban-task-reorder)と衝突せず祖先で clientX を拾える。
  scroll.addEventListener('dragover', (e) => {
    if (!S.draggingId) return;
    const rect = scroll.getBoundingClientRect();
    const distLeft = e.clientX - rect.left;
    const distRight = rect.right - e.clientX;
    if (distLeft >= 0 && distLeft < EDGE_ZONE) {
      startAutoScroll(scroll, -1, (EDGE_ZONE - distLeft) / EDGE_ZONE);
    } else if (distRight >= 0 && distRight < EDGE_ZONE) {
      startAutoScroll(scroll, 1, (EDGE_ZONE - distRight) / EDGE_ZONE);
    } else {
      stopAutoScroll();
    }
  });
  scroll.addEventListener('dragleave', (e) => {
    if (!scroll.contains(e.relatedTarget)) stopAutoScroll();
  });
  const board = h('div', { class: 'kb-board' });
  for (const col of COLS) board.appendChild(colEl(col));
  scroll.appendChild(board);
  return scroll;
}

function colEl(col) {
  const items = tasksFor(col.key);
  const el = h('div', { class: 'kb-col', dataset: { col: col.key } });

  el.appendChild(h('div', { class: 'kb-col-head' },
    h('div', { class: 'kb-col-name' },
      h('span', { class: `kb-col-dot ${col.kind}` }),
      h('span', { class: `kb-col-label ${col.kind}`, text: col.label })),
    h('span', { class: `kb-count ${col.kind}`, text: String(items.length) })));

  const list = h('div', { class: 'kb-col-list' });
  for (const t of items) list.appendChild(cardEl(t));
  if (col.key === 'DONE' && items.length === 0) {
    list.appendChild(h('div', { class: 'kb-done-hint' },
      'ここにドロップで', h('br'),
      h('span', { class: 'kb-done-hint-em', text: 'タスク完了' }), h('br'),
      h('span', { class: 'kb-done-hint-sub', text: '完了後は自動でアーカイブ' })));
  }
  if (col.key !== 'DONE') {
    if (S.composingCol === col.key) list.appendChild(composerEl());
    else {
      list.appendChild(h('button', {
        class: 'kb-add', type: 'button',
        onclick: () => { S.composingCol = col.key; S.composerText = ''; renderAll(); },
      }, iconPlus(), '新規タスク'));
    }
  }
  el.appendChild(list);

  // D&D 受け入れ。ドラッグ中の再レンダーは HTML5 D&D を壊すためオーバーレイは直接 DOM 操作。
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch { /* noop */ }
    if (!el.querySelector('.kb-col-over')) el.appendChild(h('div', { class: 'kb-col-over' }));
    // 並べ替え可能列のみ挿入位置インジケータを追従表示（DONE は完了ドロップ専用）。
    if (col.key !== 'DONE') positionDropIndicator(el.querySelector('.kb-col-list'), e.clientY);
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) {
      el.querySelector('.kb-col-over')?.remove();
      if (col.key !== 'DONE') removeDropIndicator();
    }
  });
  el.addEventListener('drop', (e) => onDrop(e, col.key, el));
  return el;
}

function cardEl(t) {
  const pri = PRI[t.priority] ? t.priority : 'low';
  const card = h('div', { class: 'kb-card', draggable: 'true', dataset: { id: String(t.id) } });
  card.addEventListener('click', (e) => { e.stopPropagation(); openDetail(t); });
  card.addEventListener('dragstart', (e) => {
    S.draggingId = t.id;
    try {
      e.dataTransfer.setData('text/plain', String(t.id));
      e.dataTransfer.effectAllowed = 'move';
    } catch { /* noop */ }
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    S.draggingId = null;
    card.classList.remove('dragging');
    document.querySelectorAll('.kb-col-over').forEach((o) => o.remove());
    removeDropIndicator();
    stopAutoScroll();
  });

  card.appendChild(h('div', { class: 'kb-card-top' },
    h('span', { class: `kb-pri ${pri}`, text: PRI[pri].label }),
    h('span', {
      class: 'kb-due',
      title: t.due_locked ? '手動指定した期日（自動更新なし）' : '自動決定の期日',
    }, fmtDue(t.due), t.due_locked ? ' 🔒' : null)));
  card.appendChild(h('div', { class: 'kb-card-title', text: t.title }));
  if (S.detailId === t.id) card.appendChild(h('div', { class: 'kb-card-sel' }));
  if (S.completingId === t.id) card.appendChild(completingOverlayEl());
  return card;
}

function completingOverlayEl() {
  return h('div', { class: 'kb-complete-overlay' },
    h('div', { class: 'kb-complete-sweep' }),
    h('div', { class: 'kb-complete-ring' }),
    h('div', { class: 'kb-complete-badge' }, iconCheckAnimated('22', '2.6')));
}

// --- D&D / 完了 -------------------------------------------------------------
// 挿入位置インジケータ（design D3）。ドラッグ中の再描画は HTML5 D&D を壊すため、
// プレースホルダは renderAll を介さず直接 DOM 操作で移動する。列内で 1 本のみ使う。
let dropIndicator = null;

/**
 * 列リスト内で clientY が入る挿入インデックスを、各カードの垂直中点比較で算出する。
 * ドラッグ中のカード（.dragging）は測定対象から除外する。
 */
function dropIndexIn(listEl, clientY) {
  const cards = [...listEl.querySelectorAll('.kb-card:not(.dragging)')];
  let idx = cards.length;
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { idx = i; break; }
  }
  return idx;
}

/** インジケータを算出位置へ挿入/移動。測定は自身を外した状態で行い揺れを防ぐ。 */
function positionDropIndicator(listEl, clientY) {
  if (!listEl) return;
  if (dropIndicator && dropIndicator.parentElement) dropIndicator.remove();
  const cards = [...listEl.querySelectorAll('.kb-card:not(.dragging)')];
  let ref = null;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { ref = c; break; }
  }
  if (!dropIndicator) dropIndicator = h('div', { class: 'kb-drop-indicator' });
  if (ref) {
    listEl.insertBefore(dropIndicator, ref);
  } else {
    // 末尾は「＋新規タスク」ボタン/コンポーザの直前に置く。
    const tail = listEl.querySelector('.kb-composer, .kb-add');
    if (tail) listEl.insertBefore(dropIndicator, tail);
    else listEl.appendChild(dropIndicator);
  }
}

function removeDropIndicator() {
  if (dropIndicator && dropIndicator.parentElement) dropIndicator.remove();
}

/** 列の並びを sort_order=0,1,2… に振り直し、status を当該キーへ正規化する。 */
function reindexColumn(colKey, orderedTasks) {
  orderedTasks.forEach((x, i) => { x.sort_order = i; x.status = colKey; });
}

/**
 * 影響列の新しい表示順を S.tasks に反映する。描画は列でフィルタするため列間の絶対順序は
 * 無関係で、within-column の順序のみ担保すればよい。未変更列は現在の相対順を保つ
 * （legacy status 混在列を不用意に並べ替えない）。
 */
function commitColumnOrder(affected) {
  const groups = { HOLD: [], TODO: [], DOING: [], DONE: [] };
  for (const x of S.tasks) groups[normStatus(x.status)].push(x);
  for (const k of Object.keys(affected)) groups[k] = affected[k];
  S.tasks = [...groups.HOLD, ...groups.TODO, ...groups.DOING, ...groups.DONE];
}

/** バッチ再インデックスを保存。失敗時は再取得でサーバ状態へ収束（design Risks）。 */
async function saveReorder(groups) {
  const filtered = groups.filter((g) => g.ids.length > 0);
  if (!filtered.length) return;
  try { await api.reorder(filtered); }
  catch (err) { toast(`並べ替えの保存に失敗: ${err.message}`, 'err'); await reload(); }
}

async function onDrop(e, colKey, colElm) {
  e.preventDefault();
  stopAutoScroll();
  colElm.querySelector('.kb-col-over')?.remove();
  removeDropIndicator();
  let id = Number(e.dataTransfer.getData('text/plain'));
  if (!id) id = S.draggingId;
  S.draggingId = null;
  const t = findTask(id);
  if (!t) return;
  const fromCol = normStatus(t.status);

  // 完了列：従来どおり完了演出＋アーカイブ（並べ替え対象外, design D4）。
  if (colKey === 'DONE') {
    if (fromCol === 'DONE') return;
    const rect = colElm.getBoundingClientRect();
    completeTask(t, rect.left + rect.width / 2, rect.top + 64);
    return;
  }

  const listEl = colElm.querySelector('.kb-col-list');
  const idx = dropIndexIn(listEl, e.clientY);

  if (fromCol === colKey) {
    // 同一列内の並べ替え：算出インデックスへ挿入 → 列を連番へ正規化。
    const without = S.tasks.filter((x) => normStatus(x.status) === colKey && x.id !== t.id);
    without.splice(idx, 0, t);
    reindexColumn(colKey, without);
    commitColumnOrder({ [colKey]: without });
    renderAll();
    await saveReorder([{ status: colKey, ids: without.map((x) => x.id) }]);
    return;
  }

  // 列間移動：status 更新＋due 再計算（design D3）＋算出インデックスへ挿入。source/dest の
  // 両列を連番へ正規化し、1 リクエストで一貫保存する。
  const dest = S.tasks.filter((x) => normStatus(x.status) === colKey && x.id !== t.id);
  const src = S.tasks.filter((x) => normStatus(x.status) === fromCol && x.id !== t.id);
  t.status = colKey;
  if (t.done_at) t.done_at = null;
  // ロック無しで due が実際に変わった場合のみ永続化対象にする（design D2）。
  let dueChanged = false;
  if (!t.due_locked) {
    const dec = computeDue(fromCol, colKey, tomorrowMode(), state.today);
    if (dec.change) { t.due = dec.due; dueChanged = true; }
  }
  dest.splice(idx, 0, t);
  reindexColumn(colKey, dest);
  reindexColumn(fromCol, src);
  commitColumnOrder({ [colKey]: dest, [fromCol]: src });
  renderAll();
  await saveReorder([
    { status: fromCol, ids: src.map((x) => x.id) },
    { status: colKey, ids: dest.map((x) => x.id) },
  ]);
  // 並べ替え（status/sort_order）とは別に due の変更を永続化する（design D1/D3）。
  if (dueChanged) {
    try { await api.updateTask(t.id, { due: t.due }); }
    catch (err) { toast(`保存に失敗: ${err.message}`, 'err'); }
  }
}

function completeTask(t, x, y) {
  ensureAudio();
  playChime('gentle');
  fireCelebration('gentle', x, y);
  t.status = 'DONE';
  t.done_at = Date.now();
  S.completingId = t.id;
  if (S.detailId === t.id) { S.detailId = null; S.editLine = -1; S.dueCalOpen = false; }
  renderAll();
  api.updateTask(t.id, { status: 'DONE' }).catch((err) => toast(`保存に失敗: ${err.message}`, 'err'));
  setTimeout(() => {
    S.completingId = null;
    renderAll();
    bumpDoneCount();
    fireDonutGlow();
    if (activeTasks().length === 0) {
      playChime('milestone');
      fireCelebration('all', window.innerWidth / 2, window.innerHeight * 0.44);
    }
  }, 980);
}

function bumpDoneCount() {
  const el = document.getElementById('kb-done-num');
  if (!el) return;
  el.classList.add('kb-bump');
  setTimeout(() => el.classList.remove('kb-bump'), 520);
}
function fireDonutGlow() {
  const wrap = rootEl.querySelector('.kb-donut-wrap');
  if (!wrap) return;
  const glow = h('div', { class: 'kb-donut-glow' });
  wrap.appendChild(glow);
  setTimeout(() => glow.remove(), 1000);
}

// --- インラインコンポーザ ----------------------------------------------------
function composerEl() {
  const ta = h('textarea', { class: 'kb-composer', rows: '2', placeholder: 'タスク名を入力' });
  ta.value = S.composerText || '';
  let handled = false;
  ta.addEventListener('input', () => { S.composerText = ta.value; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); handled = true; commitComposer(false, true);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); handled = true; commitComposer(true, false);
    } else if (e.key === 'Escape') {
      e.preventDefault(); handled = true;
      S.composingCol = null; S.composerText = '';
      renderAll();
    }
  });
  ta.addEventListener('blur', () => { if (!handled) commitComposer(false, false); });
  return ta;
}

async function commitComposer(keepOpen, openDet) {
  const text = (S.composerText || '').trim();
  const col = S.composingCol;
  if (!col) return;
  if (!text) { S.composingCol = null; S.composerText = ''; renderAll(); return; }
  S.composerText = '';
  try {
    // 作成時に列＋明日トグルから due を自動決定（design D3）。ロックは 0。
    const dec = computeDue(null, normStatus(col), tomorrowMode(), state.today);
    const due = dec.change ? dec.due : null;
    const t = await api.createTask({ title: text, status: col, priority: 'low', due, due_locked: 0 });
    S.tasks.push(t);
    if (openDet) {
      S.composingCol = null;
      S.detailId = t.id;
      S.editLine = 0;
      S.pendingCaret = 0;
    } else if (!keepOpen && S.composingCol === col) {
      // blur コミット中に別列のコンポーザが開かれた場合はそちらを維持する。
      S.composingCol = null;
    }
  } catch (err) {
    toast(`追加に失敗: ${err.message}`, 'err');
    if (S.composingCol === col) S.composingCol = null;
  }
  renderAll();
}

// --- サイドバー ---------------------------------------------------------------
function asideEl() {
  const aside = h('div', { class: 'kb-aside' });
  const t = S.detailId != null ? findTask(S.detailId) : null;
  if (t) {
    aside.appendChild(detailEl(t));
  } else {
    aside.appendChild(progressEl());
    aside.appendChild(logEl());
  }
  return aside;
}

function progressEl() {
  const completed = completedTodayCount();
  const active = activeTasks().length;
  const total = completed + active;
  const progress = total > 0 ? completed / total : 0;
  const CIRC = 339.29;
  const offset = CIRC * (1 - progress);
  const percent = total > 0 ? Math.round(progress * 100) : 0;

  const donut = h('div', { class: 'kb-donut-wrap' });
  donut.appendChild(svgEl('svg', { width: '140', height: '140', viewBox: '0 0 140 140' },
    svgEl('circle', { cx: '70', cy: '70', r: '54', fill: 'none', stroke: '#EDECE8', 'stroke-width': '13' }),
    svgEl('circle', {
      cx: '70', cy: '70', r: '54', fill: 'none', stroke: '#2E9E63', 'stroke-width': '13',
      'stroke-linecap': 'round', 'stroke-dasharray': String(CIRC), 'stroke-dashoffset': String(offset),
      transform: 'rotate(-90 70 70)', class: 'kb-donut-arc',
    })));
  donut.appendChild(h('div', { class: 'kb-donut-center' },
    h('span', { class: 'kb-donut-num', text: String(completed) }),
    h('span', { class: 'kb-donut-sub', text: `/ ${total}件 完了` })));

  const right = h('div', { class: 'kb-prog-right' },
    h('div', {},
      h('span', { class: 'kb-pct', text: `${percent}%` }),
      h('span', { class: 'kb-pct-lbl', text: '達成率' })),
    h('div', { class: 'kb-stat-row' },
      h('span', { class: 'kb-stat-name' }, h('span', { class: 'kb-stat-dot red' }), '期限超過'),
      h('span', { class: 'kb-stat-val', text: String(overdueCount()) })),
    h('div', { class: 'kb-stat-row' },
      h('span', { class: 'kb-stat-name' }, h('span', { class: 'kb-stat-dot green' }), 'アーカイブ'),
      h('span', { class: 'kb-stat-val', text: String(archivedCount()) })));

  return h('div', { class: 'kb-panel' },
    h('div', { class: 'kb-panel-head' },
      h('span', { class: 'kb-panel-title', text: '本日の進捗' }),
      h('span', { class: 'kb-panel-tag', text: 'TODAY' })),
    h('div', { class: 'kb-prog' }, donut, right));
}

function logEl() {
  const rows = S.tasks
    .filter((t) => normStatus(t.status) === 'DONE' && t.done_at
      && localDateKey(new Date(t.done_at)) === state.today && t.id !== S.completingId)
    .sort((a, b) => b.done_at - a.done_at);

  const panel = h('div', { class: 'kb-panel' },
    h('div', { class: 'kb-panel-head' },
      h('span', { class: 'kb-panel-title', text: 'アクティビティログ' }),
      h('span', { class: 'kb-panel-tag', text: 'LOG' })));
  if (!rows.length) {
    panel.appendChild(h('div', { class: 'kb-log-empty', text: 'まだ記録はありません' }));
    return panel;
  }
  const list = h('div', {});
  for (const t of rows) {
    const d = new Date(t.done_at);
    const p = (n) => String(n).padStart(2, '0');
    list.appendChild(h('div', { class: 'kb-log-row' },
      h('span', { class: 'kb-log-check' }, iconCheckSmall('11', '#2E9E63', '2.8')),
      h('div', { class: 'kb-log-main' },
        h('div', { class: 'kb-log-text', text: `「${t.title}」を完了しました` }),
        h('div', { class: 'kb-log-time', text: `${p(d.getHours())}:${p(d.getMinutes())}` }))));
  }
  panel.appendChild(list);
  return panel;
}

// --- 詳細パネル ---------------------------------------------------------------
function openDetail(t) {
  flushSaves();
  S.detailId = t.id;
  const empty = !(t.notes && t.notes.trim());
  S.editLine = empty ? 0 : -1;
  S.pendingCaret = empty ? 0 : null;
  S.dueCalOpen = false;
  renderAll();
}

function closeDetail() {
  flushSaves();
  S.detailId = null;
  S.editLine = -1;
  S.dueCalOpen = false;
  renderAll();
}

function detailEl(t) {
  const panel = h('div', { class: 'kb-detail' });

  panel.appendChild(h('div', { class: 'kb-detail-close-row' },
    h('button', { class: 'kb-detail-close', type: 'button', title: '閉じる', onclick: closeDetail }, iconClose())));

  const titleInp = h('input', { class: 'kb-detail-title', type: 'text', placeholder: 'タイトル' });
  titleInp.value = t.title;
  titleInp.addEventListener('input', () => {
    t.title = titleInp.value;
    scheduleSave(t, 'title');
    const cardTitle = rootEl.querySelector(`.kb-card[data-id="${t.id}"] .kb-card-title`);
    if (cardTitle) cardTitle.textContent = t.title;
  });
  panel.appendChild(h('div', { class: 'kb-detail-title-wrap' }, titleInp));

  const priPills = h('div', { class: 'kb-pills' },
    ...['high', 'mid', 'low'].map((p) => h('button', {
      class: `kb-pill ${p}${(PRI[t.priority] ? t.priority : 'low') === p ? ' on' : ''}`,
      type: 'button', text: PRI[p].label,
      onclick: async () => {
        t.priority = p;
        try { await api.updateTask(t.id, { priority: p }); }
        catch (err) { toast(`保存に失敗: ${err.message}`, 'err'); }
        renderAll();
      },
    })));
  panel.appendChild(h('div', { class: 'kb-detail-rows' },
    h('div', { class: 'kb-detail-row' }, h('span', { class: 'kb-detail-lbl', text: '優先度' }), priPills),
    h('div', { class: 'kb-detail-row' }, h('span', { class: 'kb-detail-lbl', text: '期限' }), duePickerEl(t))));

  panel.appendChild(h('div', { class: 'kb-hr' }));

  const body = h('div', { class: 'kb-detail-body' });
  const ed = h('div', { class: 'kb-ed', id: 'kb-ed-root' });
  buildEditorInto(ed, t);
  body.appendChild(ed);
  panel.appendChild(body);

  panel.appendChild(h('div', { class: 'kb-detail-foot' },
    h('button', {
      class: 'kb-del-btn', type: 'button', text: 'タスクを削除',
      onclick: async () => {
        if (!confirm('このタスクを削除しますか?')) return;
        try {
          await api.deleteTask(t.id);
          S.tasks = S.tasks.filter((x) => x.id !== t.id);
          S.detailId = null; S.editLine = -1; S.dueCalOpen = false;
          toast('削除しました', 'ok');
        } catch (err) { toast(`削除に失敗: ${err.message}`, 'err'); }
        renderAll();
      },
    }),
    h('p', { class: 'kb-detail-hint', text: 'ノートは自動保存されます。カードはボードでドラッグして列の移動・並べ替えができます。' })));
  return panel;
}

// --- 期限ピッカー(カレンダーポップオーバー) ------------------------------------
function duePickerEl(t) {
  const wrap = h('div', { class: 'kb-detail-row-grow' });
  wrap.style.position = 'relative';
  wrap.style.flex = '1';

  let label = '期限を設定';
  let overdue = false;
  if (t.due) {
    const d = new Date(`${t.due}T00:00:00`);
    overdue = t.due < state.today;
    const p = (n) => String(n).padStart(2, '0');
    label = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} (${WD_JP[d.getDay()]})`;
  }
  const cls = ['kb-due-btn'];
  if (!t.due) cls.push('empty');
  if (overdue) cls.push('overdue');
  if (S.dueCalOpen) cls.push('open');
  const btn = h('button', {
    class: cls.join(' '), type: 'button',
    onclick: (e) => {
      e.stopPropagation();
      if (S.dueCalOpen) { S.dueCalOpen = false; renderAll(); return; }
      const ref = t.due ? new Date(`${t.due}T00:00:00`) : new Date(`${state.today}T00:00:00`);
      S.dueCalYM = { y: ref.getFullYear(), m: ref.getMonth() };
      S.dueCalOpen = true;
      renderAll();
    },
  }, iconCalendar(overdue ? '#C25E4D' : '#8A8983'),
    h('span', { text: t.due_locked ? `${label} 🔒` : label }));
  wrap.appendChild(btn);
  if (S.dueCalOpen) wrap.appendChild(calendarEl(t));
  return wrap;
}

async function pickDue(t, iso) {
  // 手動指定はロック（以後、自動 due エンジンの上書き対象から外す）。
  t.due = iso;
  t.due_locked = 1;
  S.dueCalOpen = false;
  try { await api.updateTask(t.id, { due: iso, due_locked: 1 }); }
  catch (err) { toast(`保存に失敗: ${err.message}`, 'err'); }
  renderAll();
}

/** ロックを解除し、現在の列＋明日トグルから due を再計算する（design D4）。 */
async function resetDueAuto(t) {
  const col = normStatus(t.status);
  const dec = computeDue(null, col, tomorrowMode(), state.today); // 現列に「置き直す」扱い
  const due = dec.change ? dec.due : null;
  t.due = due;
  t.due_locked = 0;
  S.dueCalOpen = false;
  try { await api.updateTask(t.id, { due, due_locked: 0 }); }
  catch (err) { toast(`保存に失敗: ${err.message}`, 'err'); }
  renderAll();
}

function calendarEl(t) {
  const ym = S.dueCalYM || (() => {
    const d = new Date(`${state.today}T00:00:00`);
    return { y: d.getFullYear(), m: d.getMonth() };
  })();
  const { y, m } = ym;
  const startWd = new Date(y, m, 1).getDay();
  const daysIn = new Date(y, m + 1, 0).getDate();
  const p = (n) => String(n).padStart(2, '0');

  const cal = h('div', { class: 'kb-cal', onclick: (e) => e.stopPropagation() });
  const shift = (delta) => {
    let mm = m + delta; let yy = y;
    while (mm < 0) { mm += 12; yy -= 1; }
    while (mm > 11) { mm -= 12; yy += 1; }
    S.dueCalYM = { y: yy, m: mm };
    renderAll();
  };
  cal.appendChild(h('div', { class: 'kb-cal-head' },
    h('button', { class: 'kb-cal-nav', type: 'button', text: '‹', onclick: () => shift(-1) }),
    h('div', { class: 'kb-cal-ym', text: `${y}年 ${m + 1}月` }),
    h('button', { class: 'kb-cal-nav', type: 'button', text: '›', onclick: () => shift(1) })));

  const grid = h('div', { class: 'kb-cal-grid' });
  WD_JP.forEach((w, i) => {
    grid.appendChild(h('div', { class: `kb-cal-wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`, text: w }));
  });
  for (let i = 0; i < startWd; i++) grid.appendChild(h('div', {}));
  for (let d = 1; d <= daysIn; d++) {
    const iso = `${y}-${p(m + 1)}-${p(d)}`;
    const wd = new Date(y, m, d).getDay();
    const cls = ['kb-cal-day'];
    if (wd === 0) cls.push('sun');
    if (wd === 6) cls.push('sat');
    if (iso === state.today) cls.push('today');
    if (t.due === iso) cls.push('sel');
    grid.appendChild(h('button', {
      class: cls.join(' '), type: 'button', text: String(d), onclick: () => pickDue(t, iso),
    }));
  }
  cal.appendChild(grid);

  cal.appendChild(h('div', { class: 'kb-cal-foot' },
    h('button', { class: 'kb-cal-quick green', type: 'button', text: '今日', onclick: () => pickDue(t, state.today) }),
    h('button', { class: 'kb-cal-quick green', type: 'button', text: '明日', onclick: () => pickDue(t, addDays(state.today, 1)) }),
    h('button', { class: 'kb-cal-quick plain', type: 'button', text: '期限なし', onclick: () => pickDue(t, null) }),
    h('button', { class: 'kb-cal-quick plain', type: 'button', text: '自動に戻す', title: '列と明日トグルから期日を自動決定', onclick: () => resetDueAuto(t) })));
  return cal;
}

// --- ライブ Markdown エディタ(行ブロック) ---------------------------------------
// 参照の parseBlock/blockToLine/detectShortcut/renderEditorBlock を vanilla へ移植。
function getLines(t) {
  const notes = t.notes || '';
  return notes.length ? notes.split('\n') : [''];
}
function writeNotes(t, v) {
  t.notes = v;
  scheduleSave(t, 'notes');
}

function parseBlock(line) {
  let m;
  if ((m = line.match(/^(#{1,3})\s+(.*)$/))) return { type: `h${m[1].length}`, content: m[2] };
  if ((m = line.match(/^[-*]\s+\[([ xX])\]\s?(.*)$/))) return { type: 'todo', checked: m[1].toLowerCase() === 'x', content: m[2] };
  if ((m = line.match(/^[-*]\s+(.*)$/))) return { type: 'bullet', content: m[1] };
  if ((m = line.match(/^(\d+)\.\s+(.*)$/))) return { type: 'ordered', number: parseInt(m[1], 10), content: m[2] };
  if ((m = line.match(/^>\s+(.*)$/))) return { type: 'quote', content: m[1] };
  return { type: 'p', content: line };
}
function blockToLine(b) {
  switch (b.type) {
    case 'h1': return `# ${b.content}`;
    case 'h2': return `## ${b.content}`;
    case 'h3': return `### ${b.content}`;
    case 'todo': return `- [${b.checked ? 'x' : ' '}] ${b.content}`;
    case 'bullet': return `- ${b.content}`;
    case 'ordered': return `${b.number || 1}. ${b.content}`;
    case 'quote': return `> ${b.content}`;
    default: return b.content;
  }
}
function detectShortcut(v) {
  let m;
  if ((m = v.match(/^[-*] \[[ ]?\] (.*)$/))) return { type: 'todo', checked: false, content: m[1] };
  if ((m = v.match(/^[-*] \[[xX]\] (.*)$/))) return { type: 'todo', checked: true, content: m[1] };
  if ((m = v.match(/^\[[ ]?\] (.*)$/))) return { type: 'todo', checked: false, content: m[1] };
  if ((m = v.match(/^\[[xX]\] (.*)$/))) return { type: 'todo', checked: true, content: m[1] };
  if ((m = v.match(/^(#{1,3}) (.*)$/))) return { type: `h${m[1].length}`, content: m[2] };
  if ((m = v.match(/^[-*] (.*)$/))) return { type: 'bullet', content: m[1] };
  if ((m = v.match(/^(\d+)\. (.*)$/))) return { type: 'ordered', content: m[2] };
  if ((m = v.match(/^> (.*)$/))) return { type: 'quote', content: m[1] };
  return null;
}
function orderedNumber(lines, i) {
  let n = 1;
  for (let j = i - 1; j >= 0; j--) {
    if (parseBlock(lines[j]).type === 'ordered') n++;
    else break;
  }
  return n;
}
function contentClass(b) {
  switch (b.type) {
    case 'h1': return 'kb-ed-h1';
    case 'h2': return 'kb-ed-h2';
    case 'h3': return 'kb-ed-h3';
    case 'todo': return `kb-ed-todo${b.checked ? ' checked' : ''}`;
    case 'quote': return 'kb-ed-qt';
    case 'bullet': case 'ordered': return 'kb-ed-li-txt';
    default: return 'kb-ed-p';
  }
}
function editorPlaceholder(b, only) {
  if (b.content !== '') return '';
  if (only && b.type === 'p') return 'クリックして入力…   # 見出し ／ [ ] チェック ／ - リスト';
  const map = { todo: 'To-do', bullet: 'リスト項目', ordered: 'リスト項目', h1: '見出し1', h2: '見出し2', h3: '見出し3', quote: '引用', p: 'テキスト' };
  return map[b.type] || '';
}

// インライン Markdown(コード・太字・斜体・リンク) → DOM ノード列。
// CSP のため innerHTML は使わず要素を組み立てる。
function mdInlineNodes(s) {
  const out = [];
  const re = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(document.createTextNode(s.slice(last, m.index)));
    if (m[1]) out.push(h('code', { class: 'kb-md-code', text: m[2] }));
    else if (m[3]) out.push(h('strong', { text: m[4] }));
    else if (m[5]) out.push(h('em', { text: m[6] }));
    else if (m[7]) out.push(h('a', { class: 'kb-md-link', href: m[9], target: '_blank', rel: 'noreferrer', text: m[8] }));
    last = re.lastIndex;
  }
  if (last < s.length) out.push(document.createTextNode(s.slice(last)));
  return out;
}

function buildEditorInto(wrap, t) {
  clear(wrap);
  const lines = getLines(t);
  if (lines.length === 1 && lines[0] === '' && S.editLine !== 0) {
    wrap.appendChild(h('div', {
      class: 'kb-ed-empty',
      text: 'クリックして入力…   # 見出し ／ [ ] チェック ／ - リスト',
      onmousedown: (e) => { e.preventDefault(); enterEdit(t, 0, 0); },
    }));
    return;
  }
  lines.forEach((line, i) => wrap.appendChild(editorBlockEl(t, i, line, i === S.editLine, lines)));
}

function renderEditor(t) {
  const wrap = document.getElementById('kb-ed-root');
  if (!wrap) return;
  buildEditorInto(wrap, t);
  focusEditorLine();
}

function focusEditorLine() {
  const ta = rootEl ? rootEl.querySelector('.kb-ed-input') : null;
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
  if (S.pendingCaret != null) {
    const pos = Math.max(0, Math.min(S.pendingCaret, ta.value.length));
    S.pendingCaret = null;
    try { ta.focus(); ta.setSelectionRange(pos, pos); } catch { /* noop */ }
  }
}

function editorBlockEl(t, i, line, active, lines) {
  const b = parseBlock(line);
  const cls = contentClass(b);
  let inner;
  if (active) {
    const ta = h('textarea', {
      class: `kb-ed-input ${cls}`, rows: '1',
      placeholder: editorPlaceholder(b, lines.length === 1),
    });
    ta.value = b.content;
    ta.addEventListener('input', () => onContentChange(t, i, ta));
    ta.addEventListener('keydown', (e) => onBlockKey(t, i, e));
    ta.addEventListener('blur', () => onLineBlur(t));
    inner = ta;
  } else if (b.content === '') {
    inner = h('span', { class: `kb-ed-blank ${cls}`, text: ' ' });
  } else {
    inner = h('span', { class: `kb-ed-span ${cls}` }, ...mdInlineNodes(b.content));
  }
  const holder = h('div', { class: 'kb-ed-holder', dataset: { content: '1' } }, inner);
  const md = active ? null : (e) => startEdit(e, t, i);

  if (b.type.charAt(0) === 'h') {
    return h('div', { class: 'kb-ed-blk h', onmousedown: md }, holder);
  }
  if (b.type === 'todo') {
    const box = h('span', {
      class: `kb-ed-box${b.checked ? ' checked' : ''}`,
      onmousedown: (e) => { e.preventDefault(); e.stopPropagation(); toggleCheckbox(t, i); },
    }, b.checked ? iconCheckSmall('10', '#fff', '3') : null);
    return h('div', { class: 'kb-ed-blk flex', onmousedown: md }, box, holder);
  }
  if (b.type === 'bullet') {
    return h('div', { class: 'kb-ed-blk flex li', onmousedown: md },
      h('span', { class: 'kb-ed-marker', text: '•' }), holder);
  }
  if (b.type === 'ordered') {
    return h('div', { class: 'kb-ed-blk flex li', onmousedown: md },
      h('span', { class: 'kb-ed-marker num', text: `${orderedNumber(lines, i)}.` }), holder);
  }
  if (b.type === 'quote') {
    return h('div', { class: 'kb-ed-blk quote', onmousedown: md }, holder);
  }
  return h('div', { class: 'kb-ed-blk', onmousedown: md }, holder);
}

function enterEdit(t, i, caret) {
  if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
  const len = parseBlock(getLines(t)[i]).content.length;
  S.pendingCaret = caret == null ? len : Math.max(0, Math.min(caret, len));
  S.editLine = i;
  renderEditor(t);
}

function startEdit(e, t, i) {
  if (e && e.preventDefault) e.preventDefault();
  const len = parseBlock(getLines(t)[i]).content.length;
  enterEdit(t, i, getClickOffset(e, len));
}

function getClickOffset(e, contentLen) {
  try {
    const wrap = (e.currentTarget && e.currentTarget.querySelector('[data-content]')) || e.currentTarget;
    let node = null;
    let no = 0;
    if (document.caretPositionFromPoint) {
      const cp = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (cp) { node = cp.offsetNode; no = cp.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) { node = r.startContainer; no = r.startOffset; }
    }
    if (node && wrap && wrap.contains(node)) return Math.min(textOffsetWithin(wrap, node, no), contentLen);
  } catch { /* noop */ }
  return contentLen;
}

function textOffsetWithin(container, node, nodeOffset) {
  let total = 0;
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (n.nodeType === 3) {
      if (n === node) { total += nodeOffset; found = true; return; }
      total += n.textContent.length;
    } else {
      if (n === node) {
        for (let k = 0; k < nodeOffset && k < n.childNodes.length; k++) total += n.childNodes[k].textContent.length;
        found = true;
        return;
      }
      for (let c = 0; c < n.childNodes.length; c++) { walk(n.childNodes[c]); if (found) return; }
    }
  };
  walk(container);
  return total;
}

function onLineBlur(t) {
  blurTimer = setTimeout(() => {
    blurTimer = null;
    // 構造編集(Enter 改行など)の再描画で編集テキストエリアが差し替わると、外れた旧
    // テキストエリアの blur がこの遅延タイマーを仕掛ける。発火時点では focusEditorLine が
    // 既に新テキストエリアへフォーカス済みのため、実フォーカスが別の .kb-ed-input なら
    // 「単なる差し替え」とみなし編集を継続する。エディタ外へ真に出た時のみ終了(issue #16)。
    const a = document.activeElement;
    if (a && a.classList && a.classList.contains('kb-ed-input')) return;
    S.editLine = -1;
    renderEditor(t);
  }, 130);
}

function onContentChange(t, i, ta) {
  const val = ta.value;
  const lines = getLines(t);
  const block = parseBlock(lines[i]);
  if (block.type === 'p') {
    const conv = detectShortcut(val);
    if (conv) {
      lines[i] = blockToLine({ type: conv.type, content: conv.content, checked: conv.checked, number: 1 });
      S.pendingCaret = 0;
      writeNotes(t, lines.join('\n'));
      renderEditor(t);
      return;
    }
  }
  lines[i] = blockToLine({ ...block, content: val });
  writeNotes(t, lines.join('\n'));
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function onBlockKey(t, i, e) {
  const lines = getLines(t);
  const block = parseBlock(lines[i]);
  const content = block.content;
  const caret = e.target.selectionStart;
  const end = e.target.selectionEnd;
  const cancelBlur = () => { if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; } };
  const listy = ['todo', 'bullet', 'ordered', 'quote'].includes(block.type);

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    cancelBlur();
    if (listy && content === '') {
      lines[i] = '';
      S.pendingCaret = 0;
      writeNotes(t, lines.join('\n'));
      S.editLine = i;
      renderEditor(t);
      return;
    }
    const before = content.slice(0, caret);
    const after = content.slice(caret);
    lines[i] = blockToLine({ ...block, content: before });
    const newType = block.type.charAt(0) === 'h' ? 'p' : block.type;
    lines.splice(i + 1, 0, blockToLine({ type: newType, content: after, checked: false, number: 1 }));
    S.pendingCaret = 0;
    writeNotes(t, lines.join('\n'));
    S.editLine = i + 1;
    renderEditor(t);
  } else if (e.key === 'Backspace' && caret === 0 && end === 0) {
    if (block.type !== 'p') {
      e.preventDefault();
      cancelBlur();
      lines[i] = content;
      S.pendingCaret = 0;
      writeNotes(t, lines.join('\n'));
      S.editLine = i;
      renderEditor(t);
      return;
    }
    if (i > 0) {
      e.preventDefault();
      cancelBlur();
      const prev = parseBlock(lines[i - 1]);
      const pos = prev.content.length;
      lines.splice(i - 1, 2, blockToLine({ ...prev, content: prev.content + content }));
      S.pendingCaret = pos;
      writeNotes(t, lines.join('\n'));
      S.editLine = i - 1;
      renderEditor(t);
    }
  } else if (e.key === 'ArrowUp' && caret === 0 && i > 0) {
    e.preventDefault();
    cancelBlur();
    S.pendingCaret = parseBlock(lines[i - 1]).content.length;
    S.editLine = i - 1;
    renderEditor(t);
  } else if (e.key === 'ArrowDown' && caret === content.length && i < lines.length - 1) {
    e.preventDefault();
    cancelBlur();
    S.pendingCaret = parseBlock(lines[i + 1]).content.length;
    S.editLine = i + 1;
    renderEditor(t);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    S.editLine = -1;
    renderEditor(t);
  }
}

function toggleCheckbox(t, i) {
  const lines = getLines(t);
  const b = parseBlock(lines[i]);
  if (b.type !== 'todo') return;
  b.checked = !b.checked;
  lines[i] = blockToLine(b);
  writeNotes(t, lines.join('\n'));
  renderEditor(t);
}

// --- 祝福演出 -----------------------------------------------------------------
function fireCelebration(type, x, y) {
  const layer = h('div', { class: 'kb-celebrate' });
  if (type === 'gentle') {
    const ring = h('div', { class: 'kb-cel-ring' });
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    layer.appendChild(ring);
    const colors = ['#2E9E63', '#82C99D', '#CDE7D7', '#D8B65A'];
    for (let i = 0; i < 10; i++) {
      const s = 4 + Math.random() * 4;
      const p = h('div', { class: 'kb-cel-p' });
      p.style.left = `${x}px`;
      p.style.top = `${y}px`;
      p.style.width = `${s}px`;
      p.style.height = `${s}px`;
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--tx', `${(Math.random() - 0.5) * 78}px`);
      p.style.setProperty('--ty', `${-(26 + Math.random() * 60)}px`);
      p.style.setProperty('--r', `${(Math.random() - 0.5) * 200}deg`);
      p.style.animationDelay = `${i * 0.015}s`;
      p.style.animationDuration = `${0.85 + Math.random() * 0.5}s`;
      layer.appendChild(p);
    }
  } else {
    [340, 232, 148].forEach((sz, i) => {
      const ring = h('div', { class: 'kb-cel-big' });
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      ring.style.width = `${sz}px`;
      ring.style.height = `${sz}px`;
      ring.style.borderColor = `rgba(46,158,99,${0.42 - i * 0.09})`;
      ring.style.animationDelay = `${i * 0.12}s`;
      layer.appendChild(ring);
    });
    const colors = ['#2E9E63', '#52B07E', '#82C99D', '#CDE7D7', '#D8B65A', '#E7D49B', '#C9C7BF', '#FFFFFF'];
    for (let i = 0; i < 42; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 90 + Math.random() * 250;
      const s = 6 + Math.random() * 8;
      const rect = Math.random() > 0.45;
      const c = h('div', { class: 'kb-cel-conf' });
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
      c.style.width = `${rect ? s * 0.6 : s}px`;
      c.style.height = `${s}px`;
      c.style.borderRadius = rect ? '2px' : '50%';
      c.style.background = colors[i % colors.length];
      if (colors[i % colors.length] === '#FFFFFF') c.style.boxShadow = '0 1px 3px rgba(0,0,0,.12)';
      c.style.setProperty('--tx', `${Math.cos(ang) * sp * (0.5 + Math.random() * 0.6)}px`);
      c.style.setProperty('--ty', `${Math.sin(ang) * sp * 0.55 + (130 + Math.random() * 230)}px`);
      c.style.setProperty('--r', `${(Math.random() - 0.5) * 640}deg`);
      c.style.animationDelay = `${Math.random() * 0.12}s`;
      c.style.animationDuration = `${1.5 + Math.random() * 1.05}s`;
      layer.appendChild(c);
    }
    const medal = h('div', { class: 'kb-cel-medal' }, iconCheckAnimated('46', '2.4'));
    medal.style.left = `${x}px`;
    medal.style.top = `${y}px`;
    layer.appendChild(medal);
    const toastEl = h('div', { class: 'kb-cel-toast', text: 'すべてのタスクを完了しました' });
    toastEl.style.left = `${x}px`;
    toastEl.style.top = `${y + 76}px`;
    layer.appendChild(toastEl);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), type === 'gentle' ? 1500 : 2900);
}

// --- サウンド -------------------------------------------------------------------
let audioCtx = null;
function soundOn() {
  return localStorage.getItem(SOUND_KEY) === '1';
}
function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { audioCtx = null; }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    try { audioCtx.resume(); } catch { /* noop */ }
  }
}
function playChime(kind) {
  if (!soundOn()) return;
  ensureAudio();
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  let notes; let gap; let peak; let len;
  if (kind === 'milestone') { notes = [523.25, 659.25, 783.99, 1046.5]; gap = 0.10; peak = 0.15; len = 0.95; }
  else { notes = [659.25, 783.99]; gap = 0.075; peak = 0.10; len = 0.5; }
  notes.forEach((f, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const start = now + i * gap;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + len);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(start);
    o.stop(start + len + 0.05);
  });
  if (kind === 'milestone') {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 261.63;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.06, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(now);
    o.stop(now + 1.5);
  }
}
