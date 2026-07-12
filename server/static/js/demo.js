// お試し（デモ）モードの中央コントローラ（spec: demo-mode / design.md D5）。
//  - state.demo（active / virtualDay / goal）を所有。
//  - 全画面共通の上部バー（🧪 デモモード帯＋日付コントロール）を active 時のみ描画。
//  - 日付ジャンプ（＋1/＋7/＋30/完走へ/リセット）で仮想「今日」を動かし、
//    'demo:refresh' を発火して現在画面を再取得・再描画させる（main.js が受ける）。
//  通常モード（active=false）ではバーを隠すだけで、既存経路は一切変えない。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, addDays } from './util.js';

/** b − a の日数差（整数）。UTC 計算で tz ずれ回避。 */
function dayDiff(a, b) {
  const toUtc = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

export function isDemo() {
  return state.demo.active === true;
}

/** 現在の仮想日付から導出した状態ラベル（開始前 / 進行中 Day N/30 / 完走）。 */
function statusLabel() {
  const { virtualDay, goal } = state.demo;
  if (!goal || !virtualDay) return '';
  if (virtualDay < goal.startDay) {
    const left = dayDiff(virtualDay, goal.startDay);
    return `開始前（開始まであと ${left} 日）`;
  }
  if (virtualDay > goal.endDay) return '完走';
  return `進行中 Day ${dayDiff(goal.startDay, virtualDay) + 1}/${goal.dayCount || 30}`;
}

/** 仮想日付を dayKey へ設定して現在画面を再描画（バーも更新）。 */
function setVirtualDay(dayKey) {
  state.demo.virtualDay = dayKey;
  renderDemoBar();
  document.dispatchEvent(new CustomEvent('demo:refresh'));
}

// --- 日付ジャンプ（3.3）---------------------------------------------------
function jumpDays(n) {
  if (!state.demo.goal) return;
  setVirtualDay(addDays(state.demo.virtualDay, n));
}
function jumpToComplete() {
  const g = state.demo.goal;
  if (!g) return;
  setVirtualDay(addDays(g.endDay, 1)); // end + 1 = 完走
}
function jumpToStartBefore() {
  const g = state.demo.goal;
  if (!g) return;
  setVirtualDay(addDays(g.startDay, -1)); // start − 1 = 開始前
}

// --- 入り口（3.4。settings.js から呼ぶ）-----------------------------------
/** デモを開始: /api/demo/reset で初期化し、開始前（start − 1）から始める。 */
export async function startDemo() {
  const meta = await api.demo.reset();
  state.demo.active = true;
  state.demo.goal = {
    id: meta.goal?.id ?? 1,
    name: meta.goal?.name ?? '',
    startDay: meta.startDay,
    endDay: meta.endDay,
    dayCount: meta.goal?.dayCount ?? 30,
  };
  state.demo.virtualDay = meta.virtualDay; // 開始前
  renderDemoBar();
  document.dispatchEvent(new CustomEvent('demo:refresh'));
}

/** デモを終了: 帯を撤去し通常モードへ完全復帰。 */
export function stopDemo() {
  state.demo.active = false;
  state.demo.virtualDay = null;
  state.demo.goal = null;
  renderDemoBar();
  document.dispatchEvent(new CustomEvent('demo:refresh'));
}

/** サンプルをリセット: デモ DB を再 seed し、開始前へ戻す。 */
export async function resetSample() {
  if (!state.demo.active) return;
  const meta = await api.demo.reset();
  state.demo.goal = {
    id: meta.goal?.id ?? 1,
    name: meta.goal?.name ?? '',
    startDay: meta.startDay,
    endDay: meta.endDay,
    dayCount: meta.goal?.dayCount ?? 30,
  };
  state.demo.virtualDay = meta.virtualDay;
  renderDemoBar();
  document.dispatchEvent(new CustomEvent('demo:refresh'));
  toast('サンプルを初期状態に戻しました', 'ok');
}

// --- 上部バー（3.2）-------------------------------------------------------
export function renderDemoBar() {
  const bar = document.getElementById('demobar');
  if (!bar) return;
  clear(bar);
  if (!state.demo.active) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const label = h('div', { class: 'demobar-label' },
    h('span', { class: 'demobar-badge', text: '🧪 デモモード' }),
    h('span', { class: 'demobar-status', text: `${state.demo.virtualDay}　${statusLabel()}` }),
  );

  const mkBtn = (text, handler, cls) => {
    const b = h('button', { class: `demobar-btn${cls ? ' ' + cls : ''}`, type: 'button', text });
    b.addEventListener('click', handler);
    return b;
  };

  const controls = h('div', { class: 'demobar-controls' },
    mkBtn('＋1日', () => jumpDays(1)),
    mkBtn('＋7日', () => jumpDays(7)),
    mkBtn('＋30日', () => jumpDays(30)),
    mkBtn('完走へ', jumpToComplete, 'accent'),
    mkBtn('リセット', jumpToStartBefore),
    mkBtn('デモを終了', stopDemo, 'ghost'),
  );

  bar.appendChild(label);
  bar.appendChild(controls);
}
