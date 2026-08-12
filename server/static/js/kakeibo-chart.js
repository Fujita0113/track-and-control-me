// 家計簿ホームの折れ線（素の SVG）。design D6・spec: kakeibo-forecast
// 「予想はサーバで算出し、クライアントは描画に徹する」— この関数はサーバの
// forecastMonth() の返り値（series・capYen・crossDayKey・fixedYen）を写すだけで、
// 予想の式を一切再実装しない。

const SVGNS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

const L = 46;
const R = 688;
const T = 18;
const B = 246;

/** series（forecastMonth の日次配列）・capYen・crossDayKey・fixedYen から折れ線 SVG を作る。 */
export function renderChart(forecast) {
  const { series, capYen, crossDayKey, fixedYen, landingYen } = forecast;
  const n = series.length;
  const maxV = Math.max(capYen, landingYen, 1) * 1.08;
  const x = (i) => L + (i / Math.max(1, n - 1)) * (R - L);
  const y = (v) => B - (Math.max(0, Math.min(v, maxV)) / maxV) * (B - T);

  const todayIdx = series.findIndex((p) => p.kind === 'FORECAST') - 1;
  const lastActualIdx = todayIdx >= 0 ? todayIdx : series.map((p) => p.kind).lastIndexOf('ACTUAL');
  const crossIdx = crossDayKey ? series.findIndex((p) => p.dayKey === crossDayKey) : -1;

  const svg = svgEl('svg', {
    viewBox: `0 0 700 280`,
    role: 'img',
    'aria-label': `固定費 ${fixedYen}円を切片に、月末は${landingYen}円の見込み。`,
  });

  // 固定費の帯（切片）
  svg.appendChild(svgEl('rect', { x: L, y: y(fixedYen), width: R - L, height: B - y(fixedYen), fill: '#eef2f7' }));
  const fixedLabel = svgEl('text', { x: R, y: y(fixedYen) - 4, 'text-anchor': 'end', 'font-family': 'Consolas, monospace', 'font-size': 9.5, fill: '#91a0b0' });
  fixedLabel.textContent = `固定費 ¥${fixedYen.toLocaleString('ja-JP')}`;
  svg.appendChild(fixedLabel);

  // 上限の破線
  svg.appendChild(svgEl('line', { x1: L, y1: y(capYen), x2: R, y2: y(capYen), stroke: '#b06000', 'stroke-width': 1, 'stroke-dasharray': '4 4' }));
  const capLabel = svgEl('text', { x: L + 4, y: y(capYen) - 4, 'font-family': 'Consolas, monospace', 'font-size': 9.5, fill: '#b06000' });
  capLabel.textContent = `上限 ¥${capYen.toLocaleString('ja-JP')}`;
  svg.appendChild(capLabel);

  // 実績（実線・階段）
  if (lastActualIdx >= 0) {
    let d = `M ${x(0)},${y(series[0].cumulativeYen)}`;
    for (let i = 1; i <= lastActualIdx; i++) {
      d += ` V ${y(series[i].cumulativeYen)} L ${x(i)},${y(series[i].cumulativeYen)}`;
    }
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: '#1b2733', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    const tv = series[lastActualIdx].cumulativeYen;
    svg.appendChild(svgEl('circle', { cx: x(lastActualIdx), cy: y(tv), r: 4, fill: '#1b2733' }));
    const todayLabel = svgEl('text', { x: x(lastActualIdx) + 8, y: y(tv) - 8, 'font-family': 'Consolas, monospace', 'font-size': 10.5, fill: '#1b2733' });
    todayLabel.textContent = `今日 ¥${tv.toLocaleString('ja-JP')}`;
    svg.appendChild(todayLabel);
  }

  // 予想（破線・傾き＋予約の段）
  if (lastActualIdx >= 0 && lastActualIdx < n - 1) {
    let d = `M ${x(lastActualIdx)},${y(series[lastActualIdx].cumulativeYen)}`;
    for (let i = lastActualIdx + 1; i < n; i++) {
      if (series[i].plannedYen > 0) {
        const prevV = series[i - 1].cumulativeYen;
        d += ` L ${x(i)},${y(prevV)} V ${y(series[i].cumulativeYen)}`;
      } else {
        d += ` L ${x(i)},${y(series[i].cumulativeYen)}`;
      }
    }
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: '#91a0b0', 'stroke-width': 2, 'stroke-dasharray': '5 4', 'stroke-linejoin': 'round' }));
    const last = series[n - 1];
    svg.appendChild(svgEl('circle', { cx: x(n - 1), cy: y(last.cumulativeYen), r: 4, fill: '#91a0b0' }));
    const landLabel = svgEl('text', { x: x(n - 1) - 4, y: y(last.cumulativeYen) - 8, 'text-anchor': 'end', 'font-family': 'Consolas, monospace', 'font-size': 10.5, fill: '#66727f' });
    landLabel.textContent = `¥${last.cumulativeYen.toLocaleString('ja-JP')}`;
    svg.appendChild(landLabel);
  }

  // 上限超過日の点
  if (crossIdx >= 0) {
    svg.appendChild(svgEl('circle', { cx: x(crossIdx), cy: y(capYen), r: 4, fill: '#b06000' }));
  }

  return svg;
}
