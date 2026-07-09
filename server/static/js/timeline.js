// タイムライン(行動記録): Google カレンダー風の縦型日ビュー(spec: timeline-calendar).
// ref/timeline/TabTimeline.dc.html の設計を vanilla へ移植:
//  - 単一縦カラム / 時刻ガター / 時間ライン / ブロック境界目盛り / 現在時刻ライン
//  - 重なりは Google カレンダー式の列分割
//  - AUTO=グループ色/白文字, MANUAL(離席)=グレー破線+「自己申告」バッジ
//  - 空きギャップのマウスドラッグで離席記録(占有ブロック上は非発火, 30分グリッド+ブロック端に吸着)
//  - ドラッグ確定ポップオーバー(開始/終了 time 入力 + カテゴリチップ + 自由メモ)
//  - ブロッククリックで詳細(時間帯/種別/削除)
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, colorHex, fmtClock, fmtDur, toast, emptyState } from './util.js';

const PXM = 1.2; // px / 分 (= 72px/時)
const HOUR_MS = 3600000;
const CATEGORIES = ['昼食', '休憩', '移動', '仮眠', '運動', '雑務', 'その他'];

let laneRef = null; // 現在の lane 要素(yToMin 用)
let ctx = null; // 現在の描画コンテキスト { startMs, endMs, totalMin, blocks }
let dragState = null;

export function hide() {
  removeDragListeners();
  closePopover();
}

export async function show(root) {
  clear(root);
  const dateInput = h('input', { type: 'date', value: state.today });
  root.appendChild(h('div', { class: 'section-head' },
    h('h2', {}, 'タイムライン'),
    h('div', { class: 'row' }, h('label', { class: 'field' }, '対象日', dateInput)),
  ));
  const hint = h('div', { class: 'tl-hint' },
    h('span', { class: 'tl-hint-a', text: '空き時間を上下にドラッグして記録' }),
    h('span', { class: 'tl-hint-b', text: 'ブロックをクリックで詳細・削除' }),
  );
  root.appendChild(hint);
  const body = h('div', {});
  root.appendChild(body);

  const load = () => render(body, dateInput.value || state.today).catch((e) => toast(`失敗: ${e.message}`, 'err'));
  dateInput.addEventListener('change', load);
  await load();
}

async function render(body, date) {
  clear(body);
  closePopover();
  body.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));

  const tl = await api.getTimeline(date);
  clear(body);

  // AUTO と MANUAL を単一のブロック集合に統合(列分割は種別横断で行う)。
  const blocks = [
    ...tl.auto.map((b) => ({
      kind: 'AUTO',
      id: null,
      startAt: b.startAt,
      endAt: b.endAt,
      title: b.title,
      color: b.color,
      n: b.n,
    })),
    ...tl.manual.map((m) => ({
      kind: 'MANUAL',
      id: m.id,
      startAt: m.startAt,
      endAt: m.endAt,
      title: m.title,
      color: m.color,
      n: 1,
    })),
  ];

  // 表示レンジ: 境界〜(now / 最終ブロック) を時間単位に丸める。
  const winStart = tl.window.start;
  let latest = Math.max(tl.window.now, winStart + HOUR_MS);
  for (const b of blocks) latest = Math.max(latest, b.endAt);
  const startMs = Math.floor(winStart / HOUR_MS) * HOUR_MS;
  const endMs = Math.ceil(latest / HOUR_MS) * HOUR_MS;
  const totalMin = Math.max(60, (endMs - startMs) / 60000);

  ctx = { startMs, endMs, totalMin, blocks, date, body };

  if (blocks.length === 0) {
    body.appendChild(emptyState('この日の記録はまだありません。拡張機能が計測を送るとブロックが表示されます。空き領域を上下にドラッグして離席を記録できます。'));
  }

  const totalHeightPx = totalMin * PXM;
  const wrap = h('div', { class: 'tlc-wrap' });
  const scene = h('div', { class: 'tlc-scene' });

  // --- 時刻ガター ---
  const gutter = h('div', { class: 'tlc-gutter' });
  gutter.style.height = `${totalHeightPx}px`;
  const firstHour = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
  for (let t = firstHour; t <= endMs; t += HOUR_MS) {
    const lbl = h('div', { class: 'tlc-hour-lbl', text: fmtClock(t) });
    lbl.style.top = `${yOf(t)}px`;
    gutter.appendChild(lbl);
  }
  // ブロック境界目盛り(クラスタ先頭のみ, 非正時のみラベル)。
  for (const m of boundaryMinutes(blocks, startMs, totalMin)) {
    if (m % 60 === 0) continue;
    const tick = h('div', { class: 'tlc-tick-lbl', text: minToClock(m) });
    tick.style.top = `${m * PXM}px`;
    gutter.appendChild(tick);
  }

  // --- lane ---
  const lane = h('div', { class: 'tlc-lane' });
  lane.style.height = `${totalHeightPx}px`;
  laneRef = lane;

  // 時間ライン
  for (let t = firstHour; t <= endMs; t += HOUR_MS) {
    const ln = h('div', { class: 'tlc-hour-line' });
    ln.style.top = `${yOf(t)}px`;
    lane.appendChild(ln);
  }
  // 境界破線
  for (const m of boundaryMinutes(blocks, startMs, totalMin)) {
    const bl = h('div', { class: 'tlc-boundary-line' });
    bl.style.top = `${m * PXM}px`;
    lane.appendChild(bl);
  }
  // 現在時刻ライン(レンジ内のとき)
  const now = tl.window.now;
  if (now >= startMs && now <= endMs) {
    const nl = h('div', { class: 'tlc-now' });
    nl.style.top = `${yOf(now)}px`;
    nl.appendChild(h('div', { class: 'tlc-now-dot' }));
    lane.appendChild(nl);
  }

  // ブロック(列分割)
  const laid = layout(blocks, startMs);
  for (const { block, col, colCount } of laid) {
    lane.appendChild(blockEl(block, col, colCount));
  }

  // ドラッグゴースト置き場
  const ghost = h('div', { class: 'tlc-ghost', style: { display: 'none' } });
  ghost.appendChild(h('span', { class: 'tlc-ghost-lbl' }));
  lane.appendChild(ghost);
  ctx.ghost = ghost;

  lane.addEventListener('mousedown', onLaneMouseDown);
  scene.appendChild(gutter);
  scene.appendChild(lane);
  wrap.appendChild(scene);
  body.appendChild(wrap);

  // 凡例
  body.appendChild(h('div', { class: 'tl-legend' },
    h('span', {}, h('span', { class: 'swatch-l', style: { backgroundColor: '#1a73e8' } }), 'AUTO(グループ色)'),
    h('span', {}, h('span', { class: 'swatch-l tlc-leisure-sw' }), '自己申告(離席/手動)'),
    h('span', { class: 'muted', text: '空き領域をドラッグして記録' }),
  ));
}

// --- 座標変換 ------------------------------------------------------------
function yOf(ms) {
  return ((ms - ctx.startMs) / 60000) * PXM;
}
function minOf(ms) {
  return (ms - ctx.startMs) / 60000;
}
function msOfMin(m) {
  return ctx.startMs + m * 60000;
}
function minToClock(m) {
  return fmtClock(msOfMin(m));
}
/** clientY → 分(レンジ先頭からの相対), 5分丸め & クランプ。 */
function yToMin(clientY) {
  const r = laneRef.getBoundingClientRect();
  let m = (clientY - r.top) / PXM;
  m = Math.round(m / 5) * 5;
  return Math.max(0, Math.min(ctx.totalMin, m));
}

// --- 列分割レイアウト(Google カレンダー式) ------------------------------
function layout(blocks, startMs) {
  const evs = blocks
    .map((b) => ({ block: b, s: minOf2(b.startAt, startMs), e: minOf2(b.endAt, startMs) }))
    .sort((a, b) => a.s - b.s || a.e - b.e); // 開始→終了 安定ソート(順序入替を防ぐ)
  const clusters = [];
  let cur = [];
  let curEnd = -1;
  for (const ev of evs) {
    if (cur.length && ev.s >= curEnd) { clusters.push(cur); cur = []; curEnd = -1; }
    cur.push(ev); curEnd = Math.max(curEnd, ev.e);
  }
  if (cur.length) clusters.push(cur);

  const out = [];
  for (const cl of clusters) {
    const cols = [];
    for (const ev of cl) {
      let placed = false;
      for (let i = 0; i < cols.length; i++) {
        if (cols[i] <= ev.s) { cols[i] = ev.e; ev._col = i; placed = true; break; }
      }
      if (!placed) { ev._col = cols.length; cols.push(ev.e); }
    }
    const n = cols.length;
    for (const ev of cl) out.push({ block: ev.block, s: ev.s, e: ev.e, col: ev._col, colCount: n });
  }
  return out;
}
function minOf2(ms, startMs) {
  return (ms - startMs) / 60000;
}

/** クラスタ先頭ブロックの start/end 分をブロック境界目盛りとして返す。 */
function boundaryMinutes(blocks, startMs, totalMin) {
  const evs = blocks
    .map((b) => ({ s: minOf2(b.startAt, startMs), e: minOf2(b.endAt, startMs) }))
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const set = new Set();
  let cur = [];
  let curEnd = -1;
  const flush = (cl) => { if (cl.length) { set.add(Math.round(cl[0].s)); set.add(Math.round(cl[0].e)); } };
  for (const ev of evs) {
    if (cur.length && ev.s >= curEnd) { flush(cur); cur = []; curEnd = -1; }
    cur.push(ev); curEnd = Math.max(curEnd, ev.e);
  }
  flush(cur);
  return [...set].filter((m) => m > 0 && m < totalMin).sort((a, b) => a - b);
}

// --- ブロック DOM --------------------------------------------------------
function blockEl(block, col, colCount) {
  const top = yOf(block.startAt);
  const height = Math.max(18, yOf(block.endAt) - yOf(block.startAt));
  const short = height < 40;
  const leisure = block.kind === 'MANUAL';
  const el = h('div', { class: `tlc-block${leisure ? ' leisure' : ''}${short ? ' short' : ''}` });
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  el.style.left = `calc(${(col / colCount) * 100}% + 2px)`;
  el.style.width = `calc(${100 / colCount}% - 5px)`;
  if (!leisure) el.style.backgroundColor = colorHex(block.color);

  el.appendChild(h('div', { class: 'tlc-b-name', text: block.title + (block.n > 1 ? ` · 同時${block.n}` : '') }));
  el.appendChild(h('div', { class: 'tlc-b-time', text: `${fmtClock(block.startAt)} – ${fmtClock(block.endAt)}` }));
  if (leisure) el.appendChild(h('span', { class: 'tlc-badge', text: '自己申告' }));

  // ブロック上でのマウスダウンはドラッグ記録を開始しない。
  el.addEventListener('mousedown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => { e.stopPropagation(); openDetail(block, e.clientX, e.clientY); });
  return el;
}

// --- ドラッグによる離席記録 ----------------------------------------------
function gapContaining(m) {
  let lo = 0;
  let hi = ctx.totalMin;
  for (const b of ctx.blocks) {
    const s = minOf(b.startAt);
    const e = minOf(b.endAt);
    if (s < m && e > m) return null; // 占有ブロック内
    if (e <= m) lo = Math.max(lo, e);
    else if (s >= m) hi = Math.min(hi, s);
  }
  return [lo, hi];
}

function onLaneMouseDown(e) {
  if (e.button !== 0) return;
  closePopover();
  let start = yToMin(e.clientY);
  const gap = gapContaining(start);
  if (!gap) return; // 占有スロット上 → 無視
  const SNAP = 15;
  if (start - gap[0] <= SNAP) start = gap[0];
  else if (gap[1] - start <= SNAP) start = gap[1];
  dragState = { a: start, b: start, lo: gap[0], hi: gap[1] };
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragUp);
  e.preventDefault();
}

function onDragMove(e) {
  if (!dragState) return;
  let b = yToMin(e.clientY);
  b = Math.max(dragState.lo, Math.min(dragState.hi, b));
  dragState.b = b;
  updateGhost();
}

function updateGhost() {
  const g = ctx && ctx.ghost;
  if (!g) return;
  const d = dragState;
  if (!d || Math.abs(d.b - d.a) < 5) { g.style.display = 'none'; return; }
  const s = Math.min(d.a, d.b);
  const e = Math.max(d.a, d.b);
  g.style.display = 'flex';
  g.style.top = `${s * PXM}px`;
  g.style.height = `${(e - s) * PXM}px`;
  g.querySelector('.tlc-ghost-lbl').textContent = `${minToClock(s)} – ${minToClock(e)}`;
}

function onDragUp(e) {
  removeDragListeners();
  const d = dragState;
  dragState = null;
  if (ctx && ctx.ghost) ctx.ghost.style.display = 'none';
  if (!d) return;
  let start = Math.min(d.a, d.b);
  let end = Math.max(d.a, d.b);
  if (end - start < 10) return; // 微小ドラッグ(<10分) = クリック扱い
  // 30分グリッド + 近傍ブロック端に吸着(clamp は gap 範囲内)。
  start = snap(start, d.lo, d.hi);
  end = snap(end, d.lo, d.hi);
  if (end <= start) end = Math.min(d.hi, start + 30);
  openDraft(start, end, e.clientX, e.clientY);
}

/** 30分グリッド丸め。gap 端に近ければ端へ吸着。 */
function snap(m, lo, hi) {
  if (m - lo <= 15) return lo;
  if (hi - m <= 15) return hi;
  return Math.max(lo, Math.min(hi, Math.round(m / 30) * 30));
}

function removeDragListeners() {
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragUp);
}

// --- ポップオーバー(汎用, click 座標に固定配置) --------------------------
function openPopover(x, y, width, node) {
  closePopover();
  const backdrop = h('div', { class: 'tlc-pop-backdrop' });
  backdrop.addEventListener('mousedown', closePopover);
  const panel = h('div', { class: 'tlc-pop' }, node);
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x + 14;
  let top = y - 10;
  const h0 = 320;
  if (left + width > vw - 12) left = x - width - 14;
  if (left < 12) left = 12;
  if (top + h0 > vh - 12) top = Math.max(12, vh - h0 - 12);
  if (top < 12) top = 12;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.width = `${width}px`;
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);
}
function closePopover() {
  document.querySelectorAll('.tlc-pop, .tlc-pop-backdrop').forEach((n) => n.remove());
}

// --- 詳細ポップオーバー(時間帯/種別/削除) --------------------------------
function openDetail(block, x, y) {
  const isAuto = block.kind === 'AUTO';
  const node = h('div', {},
    h('div', { class: 'tlc-pop-head' },
      h('div', { class: `tlc-pop-dot${isAuto ? '' : ' leisure'}`, style: isAuto ? { backgroundColor: colorHex(block.color) } : {} }),
      h('div', { class: 'grow' },
        h('div', { class: 'tlc-pop-title', text: block.title }),
        h('div', { class: 'tlc-pop-sub', text: `${fmtClock(block.startAt)} – ${fmtClock(block.endAt)}` }),
        h('div', { class: 'tlc-pop-type', text: isAuto ? 'Edge タブグループ(自動記録)' : '自己申告した空き時間' }),
      ),
      h('button', { class: 'icon-btn', text: '✕', type: 'button', onclick: closePopover }),
    ),
  );
  if (!isAuto) {
    const del = h('div', { class: 'tlc-pop-delete' },
      h('span', { class: 'tlc-pop-delete-main', text: 'この記録を削除' }),
      h('span', { class: 'tlc-pop-delete-hint', text: '離席/手動エントリを取り消します' }),
    );
    del.addEventListener('click', async () => {
      try {
        await api.deleteEntry(block.id);
        toast('削除しました', 'ok');
        closePopover();
        render(ctx.body, ctx.date);
      } catch (err) { toast(`失敗: ${err.message}`, 'err'); }
    });
    node.appendChild(h('div', { class: 'tlc-pop-hr' }));
    node.appendChild(del);
  } else {
    node.appendChild(h('div', { class: 'tlc-pop-hr' }));
    node.appendChild(h('p', { class: 'muted', text: '自動記録ブロックは削除できません。' }));
  }
  openPopover(x, y, 272, node);
}

// --- ドラッグ確定(離席記録)ポップオーバー -------------------------------
function openDraft(startMin, endMin, x, y) {
  const st = { start: startMin, end: endMin, category: CATEGORIES[0], text: '' };

  const startInp = h('input', { type: 'time', value: minToClock(startMin) });
  const endInp = h('input', { type: 'time', value: minToClock(endMin) });
  startInp.addEventListener('change', () => { st.start = clockToMin(startInp.value); });
  endInp.addEventListener('change', () => { st.end = clockToMin(endInp.value); });

  const chipHost = h('div', { class: 'tlc-chips' });
  const memoInp = h('input', { type: 'text', placeholder: '例: 昼食を取りながら動画を視聴' });
  const chips = CATEGORIES.map((c) => {
    const chip = h('div', { class: 'tlc-chip', text: c });
    chip.addEventListener('click', () => {
      st.category = c; st.text = ''; memoInp.value = '';
      syncChips();
    });
    return { c, chip };
  });
  const syncChips = () => {
    for (const { c, chip } of chips) {
      const active = st.category === c && !st.text.trim();
      chip.classList.toggle('active', active);
    }
  };
  chips.forEach(({ chip }) => chipHost.appendChild(chip));
  syncChips();
  memoInp.addEventListener('input', () => { st.text = memoInp.value; syncChips(); });

  const addBtn = h('button', { class: 'btn primary', text: '追加', type: 'button' });
  addBtn.addEventListener('click', async () => {
    const startAt = msOfMin(st.start);
    const endAt = msOfMin(st.end);
    if (!(endAt > startAt)) { toast('終了は開始より後にしてください', 'err'); return; }
    const title = st.text.trim() || st.category;
    addBtn.disabled = true;
    try {
      await api.addManual(ctx.date, { startAt, endAt, title, color: 'grey' });
      toast('離席を記録しました', 'ok');
      closePopover();
      render(ctx.body, ctx.date);
    } catch (err) { toast(`失敗: ${err.message}`, 'err'); addBtn.disabled = false; }
  });

  const node = h('div', {},
    h('div', { class: 'tlc-pop-title', text: '空き時間を記録' }),
    h('div', { class: 'tlc-draft-times' }, startInp, h('span', { class: 'muted', text: '〜' }), endInp),
    h('div', { class: 'tlc-draft-lbl', text: 'よく使うカテゴリ' }),
    chipHost,
    h('div', { class: 'tlc-draft-lbl', text: 'またはメモを自由入力' }),
    memoInp,
    h('div', { class: 'tlc-draft-actions' },
      h('button', { class: 'btn', text: 'キャンセル', type: 'button', onclick: closePopover }),
      addBtn,
    ),
  );
  openPopover(x, y, 300, node);
}

/** "HH:MM" → 分(レンジ先頭からの相対)。レンジ先頭日を基準に解釈。 */
function clockToMin(str) {
  const [hh, mm] = str.split(':').map(Number);
  const d = new Date(ctx.startMs);
  d.setHours(hh, mm, 0, 0);
  let m = (d.getTime() - ctx.startMs) / 60000;
  m = Math.max(0, Math.min(ctx.totalMin, m));
  return m;
}
