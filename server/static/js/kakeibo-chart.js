// 家計簿ホームの折れ線（Canvas）。design: kakeibo-forecast D6 / kakeibo-recent-forecast decision 4・5。
// 「予想はサーバで算出し、クライアントは描画に徹する」— このモジュールは forecastMonth() の
// 返り値（2基準ぶんの series・1日平均・上限超過日）を写すだけで、予想の式を一切再実装しない。
//
// 見せ方の芯（issue #105 のフロント調整）:
//   予想の直線を「今日」で折り返して手前へ伸ばす「定規」表現は、UIがごちゃつくため不採用（意図的に削除済み）。
//   直近7日ゾーンは薄青の帯としてグラフに残す（spec: 直近7日ゾーンが帯で示される）。
//
// 2本の予想曲線（これまで／直近7日）は常に同じ位置に描かれ、基準の切り替えで動くのは
//   「どちらを濃く描くか」「直近7日帯の濃さ」「上限超過の印」だけ。
//   そのため補間するのは選択度 s（0=これまで / 1=直近7日）というスカラー1つで足りる。

const L = 16;
const R = 684;
const T = 20;
const B = 246;
const W = 700;
const H = 288;

const INK = '#1b2733';
const INK_RGB = [27, 39, 51];
const SLATE_RGB = [123, 136, 150]; // 選択中の予想
const GHOST_RGB = [185, 194, 203]; // 選んでいない基準
const AMBER = '#b06000';
const FLOOR = '#eef2f7';
const FLOOR_TEXT = '#a3b0bd';
const AXIS_TEXT = '#91a0b0';
const BAND_RGB = [59, 130, 246]; // 直近7日ゾーンの帯
const FONT = '-apple-system, "Segoe UI", "Yu Gothic UI", system-ui, sans-serif';

const BASIS_SHORT = { all: '今月ペース', recent: '直近7日ペース' };
const BASIS_LABEL = { all: 'これまでの平均ペース', recent: '直近7日ベース' };

const ANIM_MS = 320;

function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) { return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))]; }
function rgba([r, g, b], a) { return `rgba(${r}, ${g}, ${b}, ${a})`; }
function easeOutCubic(t) { return 1 - (1 - t) ** 3; }

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Fritsch–Carlson の単調3次補間の各点の傾き。
 * Catmull-Rom は単調性を保証せず、実測で「3日間まったく動いていない区間が下り坂に描かれる」
 * （＝返金があったように読める）不具合が出た。累計支出は必ず単調非減少なので、行き過ぎない
 * この方式で滑らかさだけを得る。
 */
function monotoneTangents(pts) {
  const n = pts.length;
  if (n < 2) return [0];
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x));
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return m;
}

/** pts[from..to] を単調3次補間のベジェで現在のパスへ足す（moveTo 済みは呼び出し側の責任）。 */
function tracePath(ctx, pts, m, from, to) {
  for (let i = from; i < to; i++) {
    const h = pts[i + 1].x - pts[i].x;
    ctx.bezierCurveTo(
      pts[i].x + h / 3, pts[i].y + (m[i] * h) / 3,
      pts[i + 1].x - h / 3, pts[i + 1].y - (m[i + 1] * h) / 3,
      pts[i + 1].x, pts[i + 1].y,
    );
  }
}

function strokeCurve(ctx, pts, m, from, to, { color, width, dash, alpha = 1 }) {
  if (to <= from) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash || []);
  ctx.lineJoin = 'round';
  ctx.lineCap = dash && dash.length ? 'butt' : 'round';
  ctx.beginPath();
  ctx.moveTo(pts[from].x, pts[from].y);
  tracePath(ctx, pts, m, from, to);
  ctx.stroke();
  ctx.restore();
}

function dot(ctx, cx, cy, r, fill, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** halo: 線の上に重なっても読めるよう、白フチを敷いてから字を置く。 */
function text(ctx, x, y, s, { align = 'left', baseline = 'alphabetic', color = INK, size = 10, weight = '', alpha = 1, halo = false } = {}) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} ${size}px ${FONT}`.trim();
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (halo) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3.5;
    ctx.lineJoin = 'round';
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  ctx.restore();
}

/** 「今日」の目盛りと重なる既定目盛りを間引くための最小間隔（px）。 */
const AXIS_LABEL_MIN_GAP_PX = 28;

/** 日付軸（始点・終点＋間の2点＋今日）。始点だけ月を出し、以降は日のみ。 */
function drawXAxis(ctx, series, xOf, todayIdx) {
  const n = series.length;
  if (n === 0) return;
  const defaults = [...new Set([0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1])];
  const hasToday = todayIdx >= 0 && todayIdx < n;
  let idxs = hasToday
    ? defaults.filter((i) => i === todayIdx || Math.abs(xOf(i) - xOf(todayIdx)) >= AXIS_LABEL_MIN_GAP_PX)
    : defaults;
  if (hasToday && !idxs.includes(todayIdx)) idxs = [...idxs, todayIdx].sort((a, b) => a - b);

  for (const i of idxs) {
    const [, mo, d] = series[i].dayKey.split('-');
    const isToday = i === todayIdx;
    text(ctx, xOf(i), B + 15, i === 0 ? `${Number(mo)}/${Number(d)}` : String(Number(d)), {
      align: i === 0 ? 'left' : i === n - 1 ? 'right' : 'center',
      color: isToday ? INK : AXIS_TEXT,
      size: 9.5,
      weight: isToday ? '600' : '',
    });
  }
}

// 定規の後ろ足とキャリパーは削除（今日と8/1とグレーの実績面で十分に自明なため）。

/** 実表示サイズ（CSS px）× devicePixelRatio に描画解像度を合わせる。論理座標系（W/H）は変えない。 */
function fitResolution(canvas, hostWidth) {
  const displayWidth = hostWidth || canvas.clientWidth || W;
  const scale = displayWidth / W;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(1, Math.round(displayWidth * dpr));
  const ch = Math.max(1, Math.round(H * scale * dpr));
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== ch) canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  return ctx;
}

/**
 * ホームの折れ線をひとつ作る。DOM は作り直さず update() で描き替える（基準の切り替えを補間するため）。
 *
 * update(model) の model は「サーバが返した2基準ぶんの値」そのまま:
 *   seriesAll / seriesRecent … 日次の累計（同じ長さ・同じ dayKey 並び）
 *   avgAll / avgRecent       … 1日平均（傾き）
 *   crossAll / crossRecent   … 上限超過日の dayKey（無ければ null）
 *   capYen / fixedYen / basis
 */
export function createChart() {
  const host = document.createElement('div');
  host.className = 'kb-chart-canvas';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  host.appendChild(canvas);

  let model = null;
  let s = 0; // 選択度: 0 = これまでの平均ペース / 1 = 直近7日ベース
  let raf = 0;

  function paint() {
    if (!model) return;
    const ctx = fitResolution(canvas, host.clientWidth);
    ctx.clearRect(0, 0, W, H);

    const { seriesAll, seriesRecent, capYen, fixedYen } = model;
    const n = seriesAll.length;
    if (n === 0) return;

    const landingAll = seriesAll[n - 1].cumulativeYen;
    const landingRecent = seriesRecent[n - 1].cumulativeYen;
    // 上限・両基準の着地のうち最大に合わせる。両基準で同じ値なので切り替えても縦の縮尺は動かない。
    const maxV = Math.max(capYen, landingAll, landingRecent, 1) * 1.08;
    // 月初の切片（固定費）を index -1 として持たせ、折れ線を固定費の帯から立ち上げる。
    const xOf = (i) => L + ((i + 1) / n) * (R - L);
    const yOf = (v) => B - (Math.max(0, Math.min(v, maxV)) / maxV) * (B - T);
    const toPts = (series) => [
      { x: xOf(-1), y: yOf(fixedYen) },
      ...series.map((p, i) => ({ x: xOf(i), y: yOf(p.cumulativeYen) })),
    ];

    const elapsedDays = Math.max(1, seriesAll.filter((p) => p.kind === 'ACTUAL').length);
    const todayIdx = elapsedDays - 1;
    const k = todayIdx + 1; // pts 側の添字（原点ぶん1つずれる）
    const todayYen = seriesAll[todayIdx].cumulativeYen;

    // ── 固定費の床（切片）
    ctx.save();
    ctx.fillStyle = FLOOR;
    ctx.fillRect(L, yOf(fixedYen), R - L, B - yOf(fixedYen));
    ctx.restore();
    if (B - yOf(fixedYen) >= 18) text(ctx, L + 6, yOf(fixedYen) + 13, `固定費 ¥${fixedYen.toLocaleString('ja-JP')}`, { color: FLOOR_TEXT, size: 9.5 });

    // ── 上限（金額と名前を添える）
    ctx.save();
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(L, yOf(capYen));
    ctx.lineTo(R, yOf(capYen));
    ctx.stroke();
    ctx.restore();
    text(ctx, L + 6, yOf(capYen) - 5, `上限 ¥${capYen.toLocaleString('ja-JP')}`, { color: AMBER, size: 9.5, weight: '600' });

    // ── 直近7日ゾーン（帯）。「直近7日ベース」を選んでいるときに強調する（spec: 直近7日ゾーンが帯で示される）。
    const recentFromIdx = todayIdx - 6;
    const bandX1 = xOf(Math.max(recentFromIdx, -1));
    const bandX2 = xOf(todayIdx);
    if (s > 0.01 && bandX2 > bandX1) {
      ctx.save();
      ctx.globalAlpha = 0.16 * s;
      ctx.fillStyle = rgba(BAND_RGB, 1);
      ctx.fillRect(bandX1, T, bandX2 - bandX1, B - T);
      ctx.restore();
    }

    drawXAxis(ctx, seriesAll, xOf, todayIdx);

    const ptsAll = toPts(seriesAll);
    const ptsRecent = toPts(seriesRecent);
    const mAll = monotoneTangents(ptsAll);
    const mRecent = monotoneTangents(ptsRecent);

    // ── 予想（2基準とも常に同じ位置に描き、濃さだけが入れ替わる）
    const styleOf = (w) => ({
      color: rgba(mix(GHOST_RGB, SLATE_RGB, w), 1),
      alpha: 0.7 + 0.3 * w,
      width: 1.2 + 0.8 * w,
      dash: [2 + 4 * w, 5],
    });
    if (k < ptsAll.length - 1) {
      strokeCurve(ctx, ptsAll, mAll, k, ptsAll.length - 1, styleOf(1 - s));
      strokeCurve(ctx, ptsRecent, mRecent, k, ptsRecent.length - 1, styleOf(s));
    }

    // ── 実績（過去は面、未来は線。基準を切り替えても不変）。
    //    面は固定費の床から折れ線までを塗る＝そこに積み上がった変動費そのもの。床まで塗ると
    //    床のグレーと二重になって長方形のかたまりに見えたので、床から上だけにしている。
    ctx.save();
    const grad = ctx.createLinearGradient(0, T, 0, yOf(fixedYen));
    grad.addColorStop(0, rgba(INK_RGB, 0.14));
    grad.addColorStop(1, rgba(INK_RGB, 0.02));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(ptsAll[0].x, ptsAll[0].y);
    tracePath(ctx, ptsAll, mAll, 0, k);
    ctx.lineTo(ptsAll[k].x, yOf(fixedYen));
    ctx.lineTo(ptsAll[0].x, yOf(fixedYen));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    strokeCurve(ctx, ptsAll, mAll, 0, k, { color: INK, width: 2.5, dash: [] });

    // ── 上限超過の印（選択中の基準ぶんだけ。日付はフッター文に1箇所あるので出さない）
    for (const [dayKey, alpha] of [[model.crossAll, 1 - s], [model.crossRecent, s]]) {
      if (!dayKey || alpha <= 0.01) continue;
      const i = seriesAll.findIndex((p) => p.dayKey === dayKey);
      if (i < 0) continue;
      ctx.save();
      ctx.globalAlpha = alpha * 0.45;
      ctx.strokeStyle = AMBER;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(xOf(i), yOf(capYen));
      ctx.lineTo(xOf(i), B);
      ctx.stroke();
      ctx.restore();
      dot(ctx, xOf(i), yOf(capYen), 3.5, AMBER, alpha);
    }

    // ── 今日（実績プロット点と金額）
    dot(ctx, ptsAll[k].x, ptsAll[k].y, 6, '#fff');
    dot(ctx, ptsAll[k].x, ptsAll[k].y, 4, INK);
    text(ctx, ptsAll[k].x - 8, ptsAll[k].y - 10, `今日 ¥${todayYen.toLocaleString('ja-JP')}`, { align: 'right', color: INK, size: 10, weight: '600', halo: true });

    // ── 着地点（基準名＋着地金額）
    if (k < ptsAll.length - 1) {
      const endAll = ptsAll[ptsAll.length - 1];
      const endRecent = ptsRecent[ptsRecent.length - 1];
      // 2本の着地が近いと名前が重なるので、上の線は上へ・下の線は下へ最小間隔まで押し広げる。
      let yA = endAll.y - 10;
      let yR = endRecent.y - 10;
      const gap = yA - yR;
      if (Math.abs(gap) < 14) {
        const push = (14 - Math.abs(gap)) / 2;
        if (gap >= 0) { yA += push; yR -= push; } else { yA -= push; yR += push; }
      }
      for (const [end, ly, w, key, yen] of [[endAll, yA, 1 - s, 'all', landingAll], [endRecent, yR, s, 'recent', landingRecent]]) {
        dot(ctx, end.x, end.y, 2.5 + 1.5 * w, rgba(mix(GHOST_RGB, SLATE_RGB, w), 1), 0.7 + 0.3 * w);
        text(ctx, end.x - 6, ly, `${BASIS_SHORT[key]} ¥${yen.toLocaleString('ja-JP')}`, {
          align: 'right', color: rgba(mix(GHOST_RGB, [102, 114, 127], w), 1), size: 10, weight: w > 0.5 ? '600' : '', halo: true,
        });
      }
    }
  }

  function animateTo(next) {
    cancelAnimationFrame(raf);
    if (prefersReducedMotion()) { s = next; paint(); return; }
    const from = s;
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ANIM_MS);
      s = lerp(from, next, easeOutCubic(t));
      paint();
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  if (typeof ResizeObserver !== 'undefined') {
    // canvas 自身ではなくホストを見る（paint() が canvas の実サイズを書き換えるため）。
    new ResizeObserver(() => paint()).observe(host);
  }

  return {
    el: host,
    update(next, { animate = false } = {}) {
      const first = model === null;
      model = next;
      const target = next.basis === 'recent' ? 1 : 0;
      const n = next.seriesAll.length;
      const landing = (next.basis === 'recent' ? next.seriesRecent : next.seriesAll)[n - 1];
      const today = next.seriesAll[Math.max(0, next.seriesAll.filter((p) => p.kind === 'ACTUAL').length - 1)];
      const cross = next.basis === 'recent' ? next.crossRecent : next.crossAll;
      canvas.setAttribute(
        'aria-label',
        `固定費 ${next.fixedYen}円を切片に、今日までの実績 ${today.cumulativeYen}円。` +
          `基準は${BASIS_LABEL[next.basis]}、月末は${landing.cumulativeYen}円の見込み（上限 ${next.capYen}円）。` +
          (cross ? `このペースだと ${cross} に上限超過。` : '上限内に収まる見込み。'),
      );
      if (first || !animate) { s = target; paint(); } else animateTo(target);
    },
  };
}
