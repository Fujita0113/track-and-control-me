// タイムライン(行動記録): Google カレンダー風の縦型日ビュー(spec: timeline-run-view / timeline-gap-recording).
// ref/timeline/TabTimeline.dc.html の設計を vanilla へ移植し、timeline-revamp で刷新:
//  - ラン描画: 同一グループの AUTO 断片を「間隔<閾値 かつ 間に他ブロック非重畳」の条件で
//    表示レイヤーのみ1つのランへ結合し、タイトル/時間帯を1回表示。吸収した離席はハッチで描く。
//  - ガターは正時ラベルのみ(境界目盛り・境界破線は廃止)。
//  - 未記録ギャップ(tl.gaps, サーバー閾値 away_min_seconds 以上)を「＋ 未記録」ゴーストスロットで描画し、
//    クリックで区間プリフィル済みの記録ポップオーバーを開く。ドラッグ記録は任意区間用として存置。
//  - カラム割当は前回カラム優先の first-fit で安定化(同一グループの左右フリップを抑制)。
//  - ディープリンク(#timeline?from=&to=)で該当区間の記録ポップオーバーを自動オープン。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, colorHex, fmtClock, fmtDur, toast, emptyState, localDateKey } from './util.js';

const PXM = 1.2; // px / 分 (= 72px/時)
const HOUR_MS = 3600000;
const CATEGORIES = ['昼食', '休憩', '移動', '仮眠', '運動', '雑務', 'その他'];
const DEFAULT_AWAY_MIN_SECONDS = 600; // welcome/config 未取得時のフォールバック。
const HATCH_MIN_PX = 4; // ハッチスライスの最低描画高さ。
const HATCH_LABEL_PX = 16; // これ以上の高さならスライス内にラベルを出す。

let laneRef = null; // 現在の lane 要素(yToMin 用)
let ctx = null; // 現在の描画コンテキスト { startMs, endMs, totalMin, blocks, ... }
let dragState = null;

export function hide() {
  removeDragListeners();
  closePopover();
}

export async function show(root) {
  clear(root);
  // ディープリンク: #timeline?from=&to= を読み取り、該当区間の記録ドラフトを自動オープンする。
  const link = consumeHashParams();
  const initialDate = link && link.from ? deriveDayKey(link.from) : state.today;

  const dateInput = h('input', { type: 'date', value: initialDate });
  root.appendChild(h('div', { class: 'section-head', style: { justifyContent: 'flex-end' } },
    h('div', { class: 'row' }, h('label', { class: 'field' }, '対象日', dateInput)),
  ));
  const hint = h('div', { class: 'tl-hint' },
    h('span', { class: 'tl-hint-a', text: '「＋ 未記録」をクリックして離席を記録' }),
    h('span', { class: 'tl-hint-b', text: '空き領域のドラッグでも任意区間を記録できます' }),
  );
  root.appendChild(hint);
  const body = h('div', {});
  root.appendChild(body);

  const load = () => render(body, dateInput.value || state.today).catch((e) => toast(`失敗: ${e.message}`, 'err'));
  dateInput.addEventListener('change', load);
  await load();

  // 描画完了後にディープリンク区間の記録ポップオーバーを開き、URL からパラメータを除去する。
  if (link && link.from && link.to) {
    openDraftForRange(link.from, link.to);
  }
}

async function render(body, date) {
  clear(body);
  closePopover();
  body.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));

  const tl = await api.getTimeline(date);
  clear(body);

  const thresholdMs = awayMinSeconds() * 1000;

  // stableGroupId → グループ名（同時オープングループの表示名解決に使う）。
  const groupNames = new Map();
  for (const b of tl.auto) groupNames.set(b.stableGroupId, b.title);

  // ラン結合(表示レイヤーのみ)。同一グループの AUTO 断片を条件付きで1ランへ。
  const runs = buildRuns(tl.auto, tl.manual, thresholdMs).map((r) => finalizeRun(r, groupNames));

  const manual = tl.manual.map((m) => ({
    kind: 'MANUAL',
    id: m.id,
    startAt: m.startAt,
    endAt: m.endAt,
    title: m.title,
    color: m.color,
  }));

  // 列分割は種別横断(ラン + MANUAL)。ゴーストスロットは占有ブロックと時間的に重ならないため別描画。
  const blocks = [...runs, ...manual];
  const gaps = tl.gaps || [];

  // 表示レンジ: 境界〜(now / 最終ブロック / 最終ギャップ) を時間単位に丸める。
  const winStart = tl.window.start;
  let latest = Math.max(tl.window.now, winStart + HOUR_MS);
  for (const b of blocks) latest = Math.max(latest, b.endAt);
  for (const g of gaps) latest = Math.max(latest, g.endAt);
  const startMs = Math.floor(winStart / HOUR_MS) * HOUR_MS;
  const endMs = Math.ceil(latest / HOUR_MS) * HOUR_MS;
  const totalMin = Math.max(60, (endMs - startMs) / 60000);

  ctx = { startMs, endMs, totalMin, blocks, date, body };

  if (blocks.length === 0 && gaps.length === 0) {
    body.appendChild(emptyState('この日の記録はまだありません。拡張機能が計測を送るとブロックが表示されます。未記録の離席は「＋ 未記録」として表示され、クリックで記録できます。'));
  }

  const totalHeightPx = totalMin * PXM;
  const wrap = h('div', { class: 'tlc-wrap' });
  const scene = h('div', { class: 'tlc-scene' });

  // --- 時刻ガター(正時ラベルのみ) ---
  const gutter = h('div', { class: 'tlc-gutter' });
  gutter.style.height = `${totalHeightPx}px`;
  const firstHour = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
  for (let t = firstHour; t <= endMs; t += HOUR_MS) {
    const lbl = h('div', { class: 'tlc-hour-lbl', text: fmtClock(t) });
    lbl.style.top = `${yOf(t)}px`;
    gutter.appendChild(lbl);
  }

  // --- lane ---
  const lane = h('div', { class: 'tlc-lane' });
  lane.style.height = `${totalHeightPx}px`;
  laneRef = lane;

  // 時間ライン(正時)
  for (let t = firstHour; t <= endMs; t += HOUR_MS) {
    const ln = h('div', { class: 'tlc-hour-line' });
    ln.style.top = `${yOf(t)}px`;
    lane.appendChild(ln);
  }
  // 現在時刻ライン(レンジ内のとき)
  const now = tl.window.now;
  if (now >= startMs && now <= endMs) {
    const nl = h('div', { class: 'tlc-now' });
    nl.style.top = `${yOf(now)}px`;
    nl.appendChild(h('div', { class: 'tlc-now-dot' }));
    lane.appendChild(nl);
  }

  // 未記録ゴーストスロット(占有ブロックと重ならないので全幅)。ブロックより下・ドラッグゴーストより下。
  for (const g of gaps) lane.appendChild(slotEl(g));

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
  ctx.wrap = wrap;

  lane.addEventListener('mousedown', onLaneMouseDown);
  scene.appendChild(gutter);
  scene.appendChild(lane);
  wrap.appendChild(scene);
  body.appendChild(wrap);

  // 凡例
  body.appendChild(h('div', { class: 'tl-legend' },
    h('span', {}, h('span', { class: 'swatch-l', style: { backgroundColor: '#1a73e8' } }), 'AUTO(グループ色)'),
    h('span', {}, h('span', { class: 'swatch-l tlc-hatch-sw' }), 'ラン内の離席(ハッチ)'),
    h('span', {}, h('span', { class: 'swatch-l tlc-leisure-sw' }), '自己申告(離席/手動)'),
    h('span', {}, h('span', { class: 'swatch-l tlc-slot-sw' }), '未記録(クリックで記録)'),
  ));
}

// --- ラン結合(design D1) --------------------------------------------------
/**
 * 同一 stableGroupId の隣接 AUTO 断片を、次の両条件で1ランへ結合する:
 *  1. b.startAt - a.endAt < thresholdMs
 *  2. 区間 (a.endAt, b.startAt) に他の描画ブロック(他グループ AUTO / MANUAL)が重ならない
 * 結合は描画専用。segments / innerGaps / creditedMs 合計 / coactiveKeys 和集合 を持つ。
 */
function buildRuns(autoBlocks, manualEntries, thresholdMs) {
  const byGroup = new Map();
  for (const b of autoBlocks) {
    const arr = byGroup.get(b.stableGroupId) || [];
    arr.push(b);
    byGroup.set(b.stableGroupId, arr);
  }
  const runs = [];
  for (const [gid, frags] of byGroup) {
    frags.sort((a, b) => a.startAt - b.startAt);
    // 条件2の判定対象: このグループ以外の AUTO 断片 + 全 MANUAL エントリ。
    const others = [
      ...autoBlocks.filter((b) => b.stableGroupId !== gid),
      ...manualEntries,
    ];
    let run = null;
    for (const f of frags) {
      if (run && canMerge(run, f, others, thresholdMs)) {
        if (f.startAt > run.endAt) run.innerGaps.push({ startAt: run.endAt, endAt: f.startAt });
        run.endAt = Math.max(run.endAt, f.endAt);
        run.creditedMs += f.creditedMs || 0;
        run.segments.push({ startAt: f.startAt, endAt: f.endAt });
        for (const k of f.coactiveGroupKeys || []) run.coactiveKeys.add(k);
      } else {
        if (run) runs.push(run);
        run = {
          kind: 'RUN',
          stableGroupId: gid,
          title: f.title,
          color: f.color,
          startAt: f.startAt,
          endAt: f.endAt,
          segments: [{ startAt: f.startAt, endAt: f.endAt }],
          innerGaps: [],
          creditedMs: f.creditedMs || 0,
          coactiveKeys: new Set(f.coactiveGroupKeys || []),
        };
      }
    }
    if (run) runs.push(run);
  }
  runs.sort((a, b) => a.startAt - b.startAt);
  return runs;
}

function canMerge(run, frag, others, thresholdMs) {
  const gap = frag.startAt - run.endAt;
  if (gap >= thresholdMs) return false; // 閾値以上 → 結合しない。
  if (gap <= 0) return true; // 連続/重複 → 結合(内部ギャップなし)。
  return !overlapsAny(run.endAt, frag.startAt, others); // 間に他ブロックがあれば結合しない。
}

function overlapsAny(s, e, intervals) {
  for (const o of intervals) if (o.startAt < e && o.endAt > s) return true;
  return false;
}

/** Set を配列化し、同時オープングループ名(自グループ除外)を解決する。 */
function finalizeRun(run, groupNames) {
  const coactiveNames = [...run.coactiveKeys]
    .filter((k) => k && k !== run.stableGroupId)
    .map((k) => (k === 'ungrouped' ? 'その他（未グループ）' : groupNames.get(k) || k));
  return { ...run, coactiveKeys: [...run.coactiveKeys], coactiveNames };
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

// --- 列分割レイアウト(前回カラム優先の first-fit, design D6) ---------------
function layout(blocks, startMs) {
  const evs = blocks
    .map((b) => ({ block: b, s: minOf2(b.startAt, startMs), e: minOf2(b.endAt, startMs) }))
    .sort((a, b) => a.s - b.s || a.e - b.e); // 開始→終了 安定ソート。
  const clusters = [];
  let cur = [];
  let curEnd = -1;
  for (const ev of evs) {
    if (cur.length && ev.s >= curEnd) { clusters.push(cur); cur = []; curEnd = -1; }
    cur.push(ev); curEnd = Math.max(curEnd, ev.e);
  }
  if (cur.length) clusters.push(cur);

  const prevCol = new Map(); // stableGroupId/manual → 直前クラスタで使ったカラム index。
  const out = [];
  for (const cl of clusters) {
    const colCount = clusterColCount(cl); // 真の最大同時数(最小カラム数)。
    const cols = new Array(colCount).fill(-Infinity); // 各カラムの占有終了分。
    // Pass 1: 直前カラムが空いていればそこへ再割当(< colCount に限定し hole を防ぐ)。
    const deferred = [];
    for (const ev of cl) {
      const pref = prevCol.get(keyOf(ev.block));
      if (pref != null && pref < colCount && cols[pref] <= ev.s) {
        cols[pref] = ev.e; ev._col = pref;
      } else {
        ev._col = -1; deferred.push(ev);
      }
    }
    // Pass 2: 残りは first-fit。
    for (const ev of deferred) {
      for (let i = 0; i < cols.length; i++) {
        if (cols[i] <= ev.s) { cols[i] = ev.e; ev._col = i; break; }
      }
      if (ev._col === -1) { ev._col = cols.length; cols.push(ev.e); } // 保険(通常発生しない)。
    }
    const n = cols.length;
    for (const ev of cl) {
      prevCol.set(keyOf(ev.block), ev._col);
      out.push({ block: ev.block, col: ev._col, colCount: n });
    }
  }
  return out;
}

/** クラスタの最小カラム数(標準 first-fit の結果 = 最大同時数)。 */
function clusterColCount(cl) {
  const cols = [];
  for (const ev of cl) {
    let placed = false;
    for (let i = 0; i < cols.length; i++) { if (cols[i] <= ev.s) { cols[i] = ev.e; placed = true; break; } }
    if (!placed) cols.push(ev.e);
  }
  return cols.length;
}

function keyOf(block) {
  return block.kind === 'RUN' ? `g:${block.stableGroupId}` : `m:${block.id}`;
}
function minOf2(ms, startMs) {
  return (ms - startMs) / 60000;
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

  // ラン内部の離席をハッチスライスとして実時間位置に描画(ラベル/時間帯の前に置いて背面に)。
  if (block.kind === 'RUN' && block.innerGaps.length) {
    for (const g of block.innerGaps) el.appendChild(hatchEl(block, g));
  }

  el.appendChild(h('div', { class: 'tlc-b-name', text: block.title }));
  el.appendChild(h('div', { class: 'tlc-b-time', text: `${fmtClock(block.startAt)} – ${fmtClock(block.endAt)}` }));
  if (leisure) el.appendChild(h('span', { class: 'tlc-badge', text: '自己申告' }));

  // ブロック上でのマウスダウンはドラッグ記録を開始しない(ラン全スパン=ハッチ含む)。
  el.addEventListener('mousedown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => { e.stopPropagation(); openDetail(block, e.clientX, e.clientY); });
  return el;
}

/** ラン内離席のハッチスライス(実時間比例, 最低 HATCH_MIN_PX)。 */
function hatchEl(block, gap) {
  const relTop = yOf(gap.startAt) - yOf(block.startAt);
  const rawH = yOf(gap.endAt) - yOf(gap.startAt);
  const height = Math.max(HATCH_MIN_PX, rawH);
  const mins = Math.round((gap.endAt - gap.startAt) / 60000);
  const el = h('div', { class: 'tlc-hatch' });
  el.style.top = `${relTop}px`;
  el.style.height = `${height}px`;
  el.setAttribute('title', `離席 ${fmtClock(gap.startAt)}–${fmtClock(gap.endAt)}（${mins}分）`);
  if (height >= HATCH_LABEL_PX) {
    el.appendChild(h('span', { class: 'tlc-hatch-lbl', text: `離席 ${mins}分` }));
  }
  return el;
}

// --- 未記録ゴーストスロット(design D9) ------------------------------------
function slotEl(gap) {
  const top = yOf(gap.startAt);
  const height = Math.max(20, yOf(gap.endAt) - yOf(gap.startAt));
  const mins = Math.round(gap.seconds / 60);
  const el = h('div', { class: 'tlc-slot' });
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  el.appendChild(h('span', { class: 'tlc-slot-lbl', text: `＋ 未記録 ${fmtClock(gap.startAt)}–${fmtClock(gap.endAt)}（${mins}分）` }));
  // ドラッグ記録と干渉させない。クリックで区間プリフィル済みドラフトを開く。
  el.addEventListener('mousedown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openDraft(minOf(gap.startAt), minOf(gap.endAt), e.clientX, e.clientY);
  });
  return el;
}

// --- ドラッグによる離席記録 ----------------------------------------------
function gapContaining(m) {
  let lo = 0;
  let hi = ctx.totalMin;
  for (const b of ctx.blocks) {
    const s = minOf(b.startAt);
    const e = minOf(b.endAt);
    if (s < m && e > m) return null; // 占有ブロック内(ラン全スパン=ハッチ含む)。
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

// --- 詳細ポップオーバー --------------------------------------------------
function openDetail(block, x, y) {
  const isAuto = block.kind === 'RUN';
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

  if (isAuto) {
    node.appendChild(h('div', { class: 'tlc-pop-hr' }));
    node.appendChild(runBreakdown(block));
  } else {
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
  }
  openPopover(x, y, 300, node);
}

/** AUTO ランの内訳: 実働クレジット・同時オープングループ・離席内訳(design D3/D4)。 */
function runBreakdown(run) {
  const wrap = h('div', { class: 'tlc-pop-detail' });

  // 実働クレジット(結合断片の creditedMs 合計)。
  wrap.appendChild(h('div', { class: 'tlc-pop-metric' },
    h('span', { class: 'tlc-pop-metric-k', text: '実働(クレジット)' }),
    h('span', { class: 'tlc-pop-metric-v', text: fmtDur(run.creditedMs / 1000) }),
  ));

  // 同時に開いていたグループ(divide-by-N の均等割注記)。
  if (run.coactiveNames && run.coactiveNames.length) {
    wrap.appendChild(h('div', { class: 'tlc-pop-sec-lbl', text: '同時に開いていたグループ' }));
    wrap.appendChild(h('div', { class: 'tlc-pop-coactive', text: run.coactiveNames.join('、') }));
    wrap.appendChild(h('div', { class: 'tlc-pop-note', text: 'この時間帯は同時オープンのため実働は均等割(divide-by-N)で計上されています。' }));
  }

  // 離席内訳(回数・合計・各区間)。
  if (run.innerGaps && run.innerGaps.length) {
    const totalMs = run.innerGaps.reduce((a, g) => a + (g.endAt - g.startAt), 0);
    const totalMin = Math.round(totalMs / 60000);
    wrap.appendChild(h('div', { class: 'tlc-pop-sec-lbl', text: `離席 ${run.innerGaps.length}回・合計 ${totalMin}分` }));
    const list = h('div', { class: 'tlc-pop-gaps' });
    for (const g of run.innerGaps) {
      const mins = Math.round((g.endAt - g.startAt) / 60000);
      list.appendChild(h('div', { class: 'tlc-pop-gap-row', text: `${fmtClock(g.startAt)} – ${fmtClock(g.endAt)}（${mins}分）` }));
    }
    wrap.appendChild(list);
  }

  wrap.appendChild(h('p', { class: 'muted', style: { marginTop: '10px' }, text: '自動記録ブロックは削除できません。' }));
  return wrap;
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

/** ディープリンク: from/to(epoch ms) 区間の記録ドラフトを中央に自動オープンする。 */
function openDraftForRange(fromMs, toMs) {
  if (!ctx) return;
  const startMin = Math.max(0, Math.min(ctx.totalMin, minOf(fromMs)));
  const endMin = Math.max(0, Math.min(ctx.totalMin, minOf(toMs)));
  // 該当区間へスクロール(可視化)。
  if (ctx.wrap) ctx.wrap.scrollTop = Math.max(0, startMin * PXM - 120);
  const x = Math.round(window.innerWidth / 2);
  const y = Math.round(window.innerHeight / 3);
  openDraft(startMin, endMin, x, y);
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

// --- 閾値・ディープリンク ヘルパ -----------------------------------------
/** ラン結合の閾値(秒)。サーバー設定 away_min_seconds を権威とし、未取得時は既定へ。 */
function awayMinSeconds() {
  const v = state.config && state.config.away_min_seconds;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_AWAY_MIN_SECONDS;
}

/** epoch ms → day_key(境界 04:00 を考慮)。導出不能時は state.today。 */
function deriveDayKey(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return state.today;
  const boundaryMin = (state.config && state.config.day_boundary_minutes) || 240;
  return localDateKey(new Date(n - boundaryMin * 60000));
}

/**
 * location.hash から #timeline?from=&to= を読み取り、パラメータを URL から除去して返す。
 * リロードで再発火させないため replaceState で消費する。返り値 { from, to } or null。
 */
function consumeHashParams() {
  const hash = location.hash || '';
  const qi = hash.indexOf('?');
  if (!hash.startsWith('#timeline') || qi < 0) return null;
  const params = new URLSearchParams(hash.slice(qi + 1));
  const from = params.get('from');
  const to = params.get('to');
  if (!from && !to) return null;
  // パラメータを消費(#timeline は残す)。
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}#timeline`);
  } catch { /* noop */ }
  return { from: from ? Number(from) : null, to: to ? Number(to) : null };
}
