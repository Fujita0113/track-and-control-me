// 進捗グラフ（バーンアップ）ビュー（spec: goal-burnup / design.md D8-D13）。
//  - 目標の唯一のビュー。GET /api/goals/:id/burnup の算定済みの値をそのまま描く（割り算はしない）。
//  - 参考実装: ref/goal-burnup/burnup-mock.html（配色・情報設計・インタラクション）。
//  - インライン SVG で描く（Chart.js は使わない・design D8）。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, openModal, closeModal, emptyState, addDays, attachTooltip } from './util.js';
import { isDemo } from './demo.js';
import { renderMarkdown } from './markdown.js';
import { buildAllocCard, buildReflectionEntry, loadReflectionEntry, saveReflectionEntry } from './reflection.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, ...kids) {
  const e = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      e.setAttribute(k, v);
    }
  }
  for (const k of kids) if (k) e.appendChild(k);
  return e;
}

function fetchGoal(goalId) {
  return isDemo() ? api.demo.goal(goalId, state.demo.virtualDay) : api.getGoal(goalId);
}
function fetchBurnup(goalId) {
  return isDemo() ? api.demo.burnup(goalId, state.demo.virtualDay) : api.getGoalBurnup(goalId);
}

// --- day_key 算術（util.js の addDays と同じ UTC 規則） ---------------------
function dayDiff(a, b) {
  const toUtc = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}
function maxKey(a, b) { return a > b ? a : b; }
function minKey(a, b) { return a < b ? a : b; }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtShort(dayKey) {
  const [, m, d] = dayKey.split('-');
  return `${Number(m)}/${Number(d)}`;
}
function fmtLong(dayKey) {
  const [, m, d] = dayKey.split('-');
  return `${Number(m)}月${Number(d)}日`;
}
function monthsIn(s, e) {
  let [y, m] = s.split('-').map(Number);
  const [ey, em] = e.split('-').map(Number);
  const out = [];
  while (y < ey || (y === ey && m <= em)) {
    const first = `${y}-${pad2(m)}-01`;
    const last = `${y}-${pad2(m)}-${pad2(daysInMonth(y, m))}`;
    out.push({ first, last, clipStart: maxKey(first, s), clipEnd: minKey(last, e), label: `${m}月` });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}
function daysIn(s, e) {
  const out = [];
  let cur = s;
  while (cur <= e) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}
/**
 * 日単位まで拡大した日付をクリックしたときの振り返りモーダル（spec: goal-burnup・issue #106）。
 * タブ遷移はせず、振り返りタブと同じ部品（buildAllocCard / buildReflectionEntry）を流用して
 * 作業時間バーと本文の閲覧・編集・保存をこの場で完結させる。保存は既存の PUT /api/reflection/:date
 * だけを使い、新しい API は起こさない。デモは閲覧専用のため保存動線を出さない（spec: demo-mode）。
 */
async function openReflectionDayModal(goal, dayKey) {
  const body = h('div', { class: 'modal-body stack bu-day-modal' });
  const allocHost = h('div', { class: 'bu-day-alloc' });
  const entryHost = h('div', { class: 'bu-day-entry' });
  body.appendChild(allocHost);
  body.appendChild(entryHost);
  openModal(body, `${fmtLong(dayKey)} の振り返り`);

  const allocReq = isDemo() ? api.demo.allocation(dayKey) : api.getAllocation(dayKey);
  allocReq
    .then((alloc) => allocHost.appendChild(buildAllocCard(alloc)))
    .catch(() => allocHost.appendChild(buildAllocCard(null)));

  if (isDemo()) {
    let content = '';
    try { const r = await api.demo.journal(goal.id, dayKey); content = r.content || ''; } catch { /* noop */ }
    entryHost.appendChild(content.trim()
      ? renderMarkdown(content)
      : h('p', { class: 'muted', text: 'この日の記録はありません。' }));
    entryHost.appendChild(h('p', { class: 'muted bu-day-note', text: 'デモでは閲覧のみです。' }));
    return;
  }

  const entry = buildReflectionEntry({ onSubmit: () => save() });
  entryHost.appendChild(entry.moodRow);
  entryHost.appendChild(entry.card);
  entry.saveBtn.addEventListener('click', () => save());

  async function save() {
    entry.saveBtn.disabled = true;
    try {
      await saveReflectionEntry(entry, dayKey);
      entry.savedEl.classList.add('show');
    } catch (err) {
      toast(`失敗: ${err.message}`, 'err');
    } finally {
      entry.saveBtn.disabled = false;
    }
  }

  await loadReflectionEntry(entry, dayKey);
}

// --- モーダル（葉一覧・詳細）。タイトルは openModal() 側のヘッダで出るため body には重複させない。
function openLeavesModal(title, leaves) {
  const body = h('div', { class: 'modal-body stack bu-modal' });
  for (const l of leaves) {
    const state2 = l.done ? `完了${l.dayKey ? `・${fmtLong(l.dayKey)}` : ''}` : '未着手';
    body.appendChild(h('div', { class: 'bu-modal-row' }, h('span', { text: l.done ? '✓ ' : '・ ' }), h('span', { text: l.title }), h('span', { class: 'muted', text: ` — ${state2}` })));
  }
  openModal(body, title);
}
function openDayLeavesModal(dayKey, leaves) {
  const body = h('div', { class: 'modal-body stack bu-modal' });
  for (const l of leaves) body.appendChild(h('div', { class: 'bu-modal-row' }, h('span', { text: '✓ ' }), h('span', { text: l.title })));
  openModal(body, `${fmtLong(dayKey)} に完了`);
}

function backEl(opts) {
  const back = h('button', { class: 'bu-back', type: 'button', text: '← 目標一覧へ' });
  back.addEventListener('click', () => opts.onBack && opts.onBack());
  return back;
}

function emptyStateBlock() {
  const box = h('div', { class: 'bu-empty-box' },
    h('span', { text: 'まだ何で測るか決まっていません' }));
  const cta = h('button', { class: 'btn small bu-empty-cta', type: 'button', text: '対象を決める' });
  attachTooltip(cta, { label: '振り返りタブ→目標コーナーで、目標時間かグループ/カテゴリのルールを設定できます' });
  cta.addEventListener('click', () => {
    toast('振り返りタブの目標コーナーから、目標時間かグループ/カテゴリのルールを設定してください', 'info');
  });
  box.appendChild(cta);
  return box;
}

/**
 * 進捗グラフを描く（目標の唯一のビュー・spec: goal-burnup）。
 * @param {Element} root
 * @param {number} goalId
 * @param {{onBack: () => void, onOpenBlueprint?: () => void}} opts
 */
export async function renderBurnup(root, goalId, opts = {}) {
  clear(root);
  root.appendChild(h('div', { class: 'empty', text: '進捗グラフを読み込み中…' }));

  let goal;
  let burnup;
  try {
    [goal, burnup] = await Promise.all([fetchGoal(goalId), fetchBurnup(goalId)]);
  } catch (err) {
    clear(root);
    root.appendChild(backEl(opts));
    root.appendChild(emptyState(
      err.status === 409 ? '進捗グラフは開始日以降に開けます。' : `進捗グラフを開けません: ${err.data?.error || err.message}`,
    ));
    return;
  }

  clear(root);
  const page = h('div', { class: 'bu-page' });
  root.appendChild(page);
  page.appendChild(backEl(opts));

  if (opts.onOpenBlueprint) {
    const topRow = h('div', { class: 'row', style: { marginBottom: '14px' } });
    const bpBtn = h('button', { class: 'btn small', type: 'button', text: 'タスク一覧' });
    bpBtn.addEventListener('click', opts.onOpenBlueprint);
    topRow.appendChild(bpBtn);
    page.appendChild(topRow);
  }

  const card = h('section', { class: 'card bu-card' });
  page.appendChild(card);
  card.appendChild(h('div', { class: 'bu-eyebrow', text: '進捗グラフ' }));
  card.appendChild(h('h1', { class: 'bu-title', text: goal.name }));
  card.appendChild(h('p', { class: 'bu-target', text: burnup.target ? `計測対象: ${burnup.target.labels.join(' / ')}` : '計測対象: 未設定' }));

  if (!burnup.target) {
    card.appendChild(emptyStateBlock());
    return;
  }

  buildChartBlock(card, goal, burnup);
}

function buildChartBlock(card, goal, burnup) {
  const pointsMap = new Map(burnup.points.map((p) => [p.dayKey, p.accumulatedSeconds]));
  const today = burnup.points.length ? burnup.points[burnup.points.length - 1].dayKey : burnup.startDay;
  const canProject = goal.status === 'active';
  const todaySeconds = pointsMap.get(today) ?? 0;
  const scopeHours = burnup.remainingSeconds != null ? (todaySeconds + burnup.remainingSeconds) / 3600 : null;

  // --- 表示範囲の全期間（design D12）。予想日が期限を越えても隠さず全期間に含める。
  let fullEnd = maxKey(burnup.endDay, today);
  if (canProject) {
    if (burnup.overall.projectedDay) fullEnd = maxKey(fullEnd, burnup.overall.projectedDay);
    if (burnup.recent3.projectedDay) fullEnd = maxKey(fullEnd, burnup.recent3.projectedDay);
  }
  const FULL_START = burnup.startDay;
  const FULL_END = fullEnd;

  // --- ヒーロー（完了予想の大きな日付＋ペーストグル・design D7）。
  // 完走後・終了後は完了予想（トグル・予測直線・完了予想日）を一切出さない（design task 7.7）。
  let selectedPace = 'avg';
  let heroBig = null;
  let toggleEl = null;
  if (canProject) {
    const hero = h('div', { class: 'bu-hero2' });
    heroBig = h('div', { class: 'fc-big' }, h('span', { class: 'fc-date-big' }), h('span', { class: 'fc-suffix', text: '完了見込み' }));
    hero.appendChild(heroBig);
    toggleEl = h('div', { class: 'pace-toggle', role: 'group', 'aria-label': '予測ペースの切り替え' });
    for (const { v, label } of [{ v: 'avg', label: '全体平均ペース' }, { v: 'recent', label: '直近3日ペース' }]) {
      const b = h('button', { type: 'button', text: label });
      attachTooltip(b, { label: `${label}で完了予想を計算する` });
      b.addEventListener('click', () => {
        if (selectedPace === v) return;
        selectedPace = v;
        syncHero();
        renderChart();
      });
      toggleEl.appendChild(b);
    }
    hero.appendChild(toggleEl);
    card.appendChild(hero);
  }

  function syncHero() {
    if (!heroBig) return;
    const fc = selectedPace === 'avg' ? burnup.overall : burnup.recent3;
    heroBig.firstChild.textContent = fc.projectedDay ? fmtLong(fc.projectedDay) : '—';
    [...toggleEl.children].forEach((b, i) => b.classList.toggle('active', (i === 0) === (selectedPace === 'avg')));
  }

  // --- 表示バー（現在の表示範囲＋全期間に戻す・design D12） ------------------
  const viewBar = h('div', { class: 'bu-viewbar' });
  const viewLabel = h('span', {});
  const resetBtn = h('button', { type: 'button', class: 'btn small', text: '← 全期間に戻す', hidden: true });
  attachTooltip(resetBtn, { label: '月→日のズームを解除して全期間表示に戻す' });
  viewBar.appendChild(viewLabel);
  viewBar.appendChild(resetBtn);
  card.appendChild(viewBar);

  const svg = svgEl('svg', { id: 'bu-chart', viewBox: '0 0 960 460', role: 'img', 'aria-label': '累積作業時間の推移とタスク達成の記録', class: 'bu-svg' });
  card.appendChild(svg);

  const legend = h('div', { class: 'bu-legend' },
    h('span', {}, h('i', { class: 'bu-swatch' }), '累積作業時間（実測）'),
    h('span', {}, h('i', { class: 'bu-dot-swatch done' }), '完了タスク（クリックで詳細）'),
    h('span', {}, h('i', { class: 'bu-dot-swatch todo' }), '進行中の枝（クリックで内訳）'),
    canProject ? h('span', {}, h('i', { class: 'bu-swatch dash' }), '選んだペースの完了予想') : null,
  );
  card.appendChild(legend);
  card.appendChild(h('p', { class: 'bu-footnote', text: '凍結中の日も実測0hとして暦どおり数える。月の帯をクリックすると期間を絞り込め、日付が見える範囲まで拡大すると、その日をクリックしてその日の振り返りをその場で開ける。' }));

  const view = { start: FULL_START, end: FULL_END };
  const isZoomed = () => !(view.start === FULL_START && view.end === FULL_END);

  const W = 960, H = 460, ML = 52, MR = 20, MT = 22, MB = 38;
  const PW = W - ML - MR, PH = H - MT - MB;
  let yMax = 4;

  const X = (dayKey) => {
    const total = Math.max(1, dayDiff(view.start, view.end));
    return ML + (dayDiff(view.start, dayKey) / total) * PW;
  };
  const Y = (hours) => MT + PH - (hours / yMax) * PH;
  const isMonthMode = () => dayDiff(view.start, view.end) > 40;

  function setView(s, e) {
    view.start = s;
    view.end = e;
    renderChart();
  }

  function niceStep(rough) {
    const r = Math.max(rough, 0.25);
    const mag = Math.pow(10, Math.floor(Math.log10(r)));
    const norm = r / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  // --- ラベルの衝突回避（design D14・issue #106） ---------------------------
  // その回の描画で置くラベルを1パスで積み、確定済みの矩形と重なるものは上下へずらす。
  // 右端に近ければアンカーを反転し、累積線に重なる場合は背後へ半透明のハロを敷く。
  // 文字幅は実測（getBBox）ではなく字種からの見積もりで足りる（再レイアウトを起こさないため）。
  function textWidth(str, fs) {
    let w = 0;
    for (const ch of str) w += /[ -~｡-ﾟ]/.test(ch) ? 0.56 : 1;
    return w * fs;
  }
  function overlaps(a, b) { return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2; }

  function createLabelLayer(cumPts) {
    const boxes = [];
    const paths = [cumPts]; // 文字が乗ると読めなくなる線（累積線・予測直線）。x について単調増加。
    /** 登録した線がこの矩形を横切るか（ハロの要否・design D14-4）。線形補間で数点だけ見る。 */
    function lineHits(box) {
      for (const pts of paths) {
        if (pts.length < 2) continue;
        for (let i = 0; i <= 6; i++) {
          const x = box.x1 + ((box.x2 - box.x1) * i) / 6;
          if (x < pts[0].x || x > pts[pts.length - 1].x) continue;
          let j = 1;
          while (j < pts.length && pts[j].x < x) j++;
          const a = pts[j - 1], b = pts[Math.min(j, pts.length - 1)];
          const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
          const y = a.y + (b.y - a.y) * t;
          if (y >= box.y1 && y <= box.y2) return true;
        }
      }
      return false;
    }
    function boxOf(text, fs, anchor, x, y) {
      const w = textWidth(text, fs);
      const x1 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
      return { x1, x2: x1 + w, y1: y - fs * 0.82, y2: y + fs * 0.24 };
    }
    return {
      /** ハロ判定の対象へ線を1本足す（予測直線のように、レイヤ生成後に決まるもの）。 */
      addPath(pts) { paths.push(pts); },
      /**
       * ラベルを1つ置く。置けなければ何も描かず null を返す（重ねて潰さない）。
       * @param {{text:string,x:number,y:number,cls:string,fs?:number,anchor?:string,dx?:number,
       *          shift?:boolean,halo?:boolean,top?:number,bottom?:number}} spec
       */
      place(spec) {
        const fs = spec.fs ?? 11;
        const dx = spec.dx ?? 0;
        let anchor = spec.anchor ?? 'start';
        let x = spec.x + (anchor === 'end' ? -dx : dx);
        const w = textWidth(spec.text, fs);
        // 右端でのアンカー反転（プロット域からはみ出さない・design D14-3）。
        if (anchor === 'start' && x + w > W - MR) { anchor = 'end'; x = spec.x - dx; }
        else if (anchor === 'end' && x - w < 2) { anchor = 'start'; x = spec.x + dx; }
        const top = spec.top ?? MT + fs;
        const bottom = spec.bottom ?? MT + PH;
        const offsets = spec.shift === false ? [0] : [0, -1, 1, -2, 2, -3, 3, -4, 4];
        const stepY = fs + 3;
        let chosen = null;
        for (const k of offsets) {
          const y = spec.y + k * stepY;
          if (y < top || y > bottom) continue;
          const box = boxOf(spec.text, fs, anchor, x, y);
          if (boxes.some((o) => overlaps(box, o))) continue;
          chosen = { y, box };
          break;
        }
        if (!chosen) return null;
        boxes.push(chosen.box);
        if (spec.halo && lineHits(chosen.box)) {
          svg.appendChild(svgEl('rect', {
            class: 'bu-label-halo', x: chosen.box.x1 - 2, y: chosen.box.y1 - 1,
            width: (chosen.box.x2 - chosen.box.x1) + 4, height: (chosen.box.y2 - chosen.box.y1) + 2,
          }));
        }
        const t = svgEl('text', { class: spec.cls, x, y: chosen.y, 'text-anchor': anchor });
        t.textContent = spec.text;
        svg.appendChild(t);
        return t;
      },
    };
  }

  function renderChart() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const lastHours = todaySeconds / 3600;
    const topHours = Math.max(lastHours, scopeHours ?? 0) * 1.15;
    yMax = niceStep(Math.max(topHours, 1) / 4) * 4;
    if (yMax <= 0) yMax = 4;
    const step = niceStep(yMax / 4);

    // --- 図形（線・帯・丸）を先に全て描き、ラベルは後段の1パス配置へ回す（design D14）。
    const axisLabels = []; // 目盛りと日付。ずらさず、先客と重なったら描かない。
    for (let hh = 0; hh <= yMax + 0.001; hh += step) {
      svg.appendChild(svgEl('line', { class: 'bu-grid-line', x1: ML, x2: W - MR, y1: Y(hh), y2: Y(hh) }));
      axisLabels.push({ text: `${Math.round(hh)}h`, x: ML - 8, y: Y(hh) + 3, cls: 'bu-ax-label', anchor: 'end', fs: 10.5, top: 0, bottom: H });
    }

    if (isMonthMode()) {
      for (const m of monthsIn(view.start, view.end)) {
        const x1 = X(m.clipStart), x2 = X(addDays(m.clipEnd, 1));
        const band = svgEl('rect', { class: 'bu-zoom-band', x: x1, y: MT, width: Math.max(2, x2 - x1), height: PH });
        attachTooltip(band, { label: `${m.label}をクリックして期間を絞り込む` });
        band.addEventListener('click', () => setView(maxKey(FULL_START, addDays(m.first, -3)), minKey(FULL_END, addDays(m.last, 3))));
        svg.appendChild(band);
        if (m.first >= view.start) svg.appendChild(svgEl('line', { class: 'bu-month-line', x1: X(m.first), x2: X(m.first), y1: MT, y2: H - MB }));
        const lx = (X(m.clipStart) + X(addDays(m.clipEnd, 1))) / 2;
        axisLabels.push({ text: m.label, x: lx, y: H - MB + 16, cls: 'bu-ax-label', anchor: 'middle', fs: 10.5, top: H - MB, bottom: H });
      }
    } else {
      const days = daysIn(view.start, view.end);
      const labelEvery = Math.max(1, Math.round(days.length / 8));
      days.forEach((d, idx) => {
        const x = X(d), w = X(addDays(d, 1)) - x;
        const band = svgEl('rect', { class: 'bu-day-band', x, y: MT, width: Math.max(1, w), height: PH });
        attachTooltip(band, { label: `${fmtLong(d)}の振り返り（作業時間バーと本文）をその場で開く` });
        band.addEventListener('click', () => openReflectionDayModal(goal, d));
        svg.appendChild(band);
        if (idx % labelEvery === 0 || d === today) {
          svg.appendChild(svgEl('line', { class: 'bu-month-line', x1: x, x2: x, y1: MT, y2: H - MB }));
          axisLabels.push({ text: fmtShort(d), x: x + w / 2, y: H - MB + 16, cls: 'bu-ax-label', anchor: 'middle', fs: 10.5, top: H - MB, bottom: H });
        }
      });
    }

    // 累積線（実測。今日より先は描かない）。ハロの要否判定にも使うので点列を残す。
    const cumPts = [];
    const lineEnd = minKey(view.end, today);
    if (view.start <= lineEnd) {
      const dks = daysIn(maxKey(view.start, FULL_START), lineEnd).filter((dk) => pointsMap.has(dk));
      for (const dk of dks) cumPts.push({ x: X(dk), y: Y((pointsMap.get(dk) ?? 0) / 3600) });
      if (cumPts.length) {
        svg.appendChild(svgEl('path', { class: 'bu-cum-line', d: `M${cumPts.map((pt) => `${pt.x},${pt.y}`).join(' L')}` }));
      }
    }

    const layer = createLabelLayer(cumPts);
    const labels = []; // 優先度の高い順に積む（先に置いたものが場所を取る）。

    // 今日の位置（横軸=今日の日付、縦軸=実測時間・design D6 タスク7.6）。
    if (view.start <= today && today <= view.end) {
      svg.appendChild(svgEl('line', { class: 'bu-today-line', x1: X(today), x2: X(today), y1: MT, y2: H - MB }));
      svg.appendChild(svgEl('line', { class: 'bu-today-hline', x1: ML, x2: X(today), y1: Y(lastHours), y2: Y(lastHours) }));
      // 実測時間は丸めた目盛りより優先する（同じ左端の桁に両方は入らない）。
      labels.push({ text: `${lastHours.toFixed(1)}h`, x: ML - 8, y: Y(lastHours) + 3, cls: 'bu-today-hlabel', anchor: 'end', fs: 10.5, shift: false, top: 0, bottom: H });
      labels.push({ text: fmtShort(today), x: X(today), y: H - MB + 29, cls: 'bu-today-sub', anchor: 'middle', fs: 11.5, shift: false, top: H - MB, bottom: H });
    }

    // 完了予想（全期間表示のときだけ・design D7・参照実装に合わせる）。
    if (canProject && scopeHours != null && !isZoomed()) labels.push(...drawForecastShapes(layer));

    // タスク達成マーカー（design D11）。
    for (const b of burnup.markers.branches) {
      if (b.dayKey < view.start || b.dayKey > view.end || !pointsMap.has(b.dayKey)) continue;
      const x = X(b.dayKey), y = Y((pointsMap.get(b.dayKey) ?? 0) / 3600);
      const dot = svgEl('circle', { class: `bu-ach-dot branch ${b.completed ? 'done' : 'todo'}`, cx: x, cy: y, r: 6 });
      if (!b.completed) {
        dot.appendChild(svgEl('title', {})).textContent = `${b.title}（進行中・クリックで内訳）`;
        dot.addEventListener('click', () => openLeavesModal(`${b.title}（進行中）`, b.leaves));
      }
      svg.appendChild(dot);
      labels.push({ text: b.title + (b.completed ? '' : '（進行中）'), x, y: y - 9, cls: 'bu-ach-label', dx: 9, fs: 11, halo: true });
    }
    for (const g of burnup.markers.leafCompletions) {
      if (g.dayKey < view.start || g.dayKey > view.end || !pointsMap.has(g.dayKey)) continue;
      const multi = g.leaves.length > 1;
      const x = X(g.dayKey), y = Y((pointsMap.get(g.dayKey) ?? 0) / 3600);
      const dot = svgEl('circle', { class: 'bu-ach-dot leaf done', cx: x, cy: y, r: multi ? 5.5 : 4 });
      dot.appendChild(svgEl('title', {})).textContent = multi ? `${fmtLong(g.dayKey)}に${g.leaves.length}件完了` : `${g.leaves[0].title}（完了・${fmtLong(g.dayKey)}）`;
      dot.addEventListener('click', () => (multi ? openDayLeavesModal(g.dayKey, g.leaves) : openLeavesModal(g.leaves[0].title, [{ ...g.leaves[0], done: true, dayKey: g.dayKey }])));
      svg.appendChild(dot);
    }

    // --- ラベルの1パス配置。優先度順に置き、目盛り・日付は最後（場所が無ければ諦める）。
    for (const spec of labels) layer.place(spec);
    for (const spec of axisLabels) layer.place({ ...spec, shift: false });

    const zoomed = isZoomed();
    viewLabel.textContent = zoomed ? `表示: ${fmtShort(view.start)} 〜 ${fmtShort(view.end)}` : `全期間（${fmtShort(FULL_START)} 〜 ${fmtShort(FULL_END)}）`;
    resetBtn.hidden = !zoomed;
  }

  /** 完了予想の図形（案内線・予測直線・到達の丸）を描き、ラベルは配置レイヤ用の仕様として返す。 */
  function drawForecastShapes(layer) {
    const FC = { avg: burnup.overall, recent: burnup.recent3 };
    const sel = selectedPace, other = sel === 'avg' ? 'recent' : 'avg';
    if (!FC[sel].projectedDay) return [];
    const out = [];

    svg.appendChild(svgEl('line', { class: 'bu-fc-target-guide', x1: ML, x2: X(FC[sel].projectedDay), y1: Y(scopeHours), y2: Y(scopeHours) }));

    if (FC[other].projectedDay) {
      const od = FC[other].projectedDay;
      svg.appendChild(svgEl('line', { class: 'bu-fc-line dim', x1: X(today), y1: Y(lastHoursOf()), x2: X(od), y2: Y(scopeHours) }));
      layer.addPath([{ x: X(today), y: Y(lastHoursOf()) }, { x: X(od), y: Y(scopeHours) }]);
      const mx = X(today) + (X(od) - X(today)) * 0.55, my = Y(lastHoursOf()) + (Y(scopeHours) - Y(lastHoursOf())) * 0.55;
      out.push({ text: (other === 'avg' ? '全体平均なら ' : '直近3日なら ') + fmtShort(od), x: mx, y: my - 8, cls: 'bu-fc-dim-label', anchor: 'middle', fs: 10.5, halo: true });
    }

    svg.appendChild(svgEl('line', { class: 'bu-fc-line strong', x1: X(today), y1: Y(lastHoursOf()), x2: X(FC[sel].projectedDay), y2: Y(scopeHours) }));
    layer.addPath([{ x: X(today), y: Y(lastHoursOf()) }, { x: X(FC[sel].projectedDay), y: Y(scopeHours) }]);
    svg.appendChild(svgEl('circle', { class: 'bu-fc-target-dot', cx: X(FC[sel].projectedDay), cy: Y(scopeHours), r: 7 }));
    // 到達日（主役）を先に置き、ペース（従）はその後。ずれても上下が入れ替わらない。
    out.unshift(
      { text: `${fmtLong(FC[sel].projectedDay)} 到達`, x: X(FC[sel].projectedDay), y: Y(scopeHours) - 8, cls: 'bu-fc-target-label', dx: 10, fs: 13, halo: true },
      { text: `${(FC[sel].averageSecondsPerDay / 3600).toFixed(1)}h/日`, x: X(FC[sel].projectedDay), y: Y(scopeHours) + 11, cls: 'bu-fc-target-sub', dx: 10, fs: 10.5, halo: true },
    );
    return out;
  }
  function lastHoursOf() { return (pointsMap.get(today) ?? 0) / 3600; }

  resetBtn.addEventListener('click', () => setView(FULL_START, FULL_END));
  syncHero();
  renderChart();
}
