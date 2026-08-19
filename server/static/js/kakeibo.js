// 家計簿タブ本体（design D15: {month, view} の2状態）。
// ホーム/履歴/分析/予算のサブタブ切替と、共有モーダル（明細・予想の計算内訳調整）を持つ。
import { h, clear, closeModal, openModal, attachTooltip, ctrlEnterToSave, isTypingTarget, toast, emptyState, addDays } from './util.js';
import { api } from './api.js';
import { state as appState } from './state.js';
import { isDemo } from './demo.js';
import { shrinkImage, isImageFile } from './images.js';
import { createChart } from './kakeibo-chart.js';
import { showHistoryView } from './kakeibo-history.js';
import { showAnalysisView } from './kakeibo-analysis.js';
import { showBudgetView } from './kakeibo-budget.js';

export const CATEGORIES = [
  { v: 'FOOD', label: '食品', key: '1' },
  { v: 'DAILY', label: '日用品', key: '2' },
  { v: 'FUN', label: '娯楽', key: '3' },
  { v: 'SUDDEN', label: '急な出費', key: '4' },
];
export const IMPORTANCES = [
  { v: 'MUST', label: '必須', key: 'Q' },
  { v: 'SEMI', label: '準必須', key: 'W' },
  { v: 'WASTE', label: '無駄遣い', key: 'E' },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.v, c.label]));
CATEGORY_LABEL.NONE = '複数';
const IMPORTANCE_LABEL = Object.fromEntries(IMPORTANCES.map((c) => [c.v, c.label]));

export function fmtYen(n) { return `¥${Math.round(n || 0).toLocaleString('ja-JP')}`; }
const CATEGORY_CSS_VAR = { FOOD: 'food', DAILY: 'daily', FUN: 'fun', SUDDEN: 'sudden', NONE: 'nodetail' };
export function catVar(cat) { return `var(--kb-${CATEGORY_CSS_VAR[cat] || 'nodetail'})`; }
export function catLabel(cat) { return CATEGORY_LABEL[cat] || cat; }
export function impLabel(imp) { return imp == null ? '内訳未入力' : (IMPORTANCE_LABEL[imp] || imp); }
export function monthLabel(m) { const [y, mo] = (m || '').split('-'); return `${y}年${Number(mo)}月`; }
function parseYen(v) { return Number(String(v || '').replace(/[^\d.-]/g, '')) || 0; }

const kbState = { month: null, view: 'home', basis: 'all' };
let sectionEl = null;

// デモの家計簿は目標タブの仮想日付とは無関係の固定シナリオ（server/src/services/demo-seed.ts の
// DEMO_KAKEIBO_MONTH/DEMO_KAKEIBO_TODAY と同じ値）。
const DEMO_KAKEIBO_MONTH = '2026-08';
const DEMO_KAKEIBO_TODAY = '2026-08-11';
function currentMonth() {
  if (isDemo()) return DEMO_KAKEIBO_MONTH;
  return (appState.today || '').slice(0, 7);
}

// --- デモ切替つき fetch ラッパー ------------------------------------------
function kbApi(prodFn, demoFn) {
  return (...args) => (isDemo() ? demoFn(...args) : prodFn(...args));
}
const fetchHome = kbApi(api.kakeibo.home, () => api.demo.kakeiboHome());
const fetchHistory = kbApi(api.kakeibo.history, () => api.demo.kakeiboHistory());
const fetchAnalysis = kbApi(api.kakeibo.analysis, () => api.demo.kakeiboAnalysis());
const fetchBudget = kbApi(api.kakeibo.budget, () => api.demo.kakeiboBudget());
const fetchAdjust = kbApi(api.kakeibo.forecastAdjust, () => api.demo.kakeiboForecastAdjust());

export async function show(section) {
  sectionEl = section;
  if (!kbState.month) kbState.month = currentMonth();
  await renderView();
}

export function hide() { sectionEl = null; activeEntryForm = null; }

function ctx() {
  return {
    get month() { return kbState.month; },
    setMonth: (m) => { kbState.month = m; void renderView(); },
    todayDayKey: isDemo() ? DEMO_KAKEIBO_TODAY : appState.today,
    refresh: () => renderView(),
    goto: (view) => { kbState.view = view; void renderView(); },
    fetchHome, fetchHistory, fetchAnalysis, fetchBudget, fetchAdjust,
  };
}

async function renderView() {
  if (!sectionEl) return;
  clear(sectionEl);
  const tabs = h('div', { class: 'kb-subtabs' },
    subtabBtn('home', 'ホーム'), subtabBtn('hist', '履歴'), subtabBtn('ana', '分析'), subtabBtn('budget', '予算'));
  const body = h('div', { id: 'kb-body' }, h('div', { class: 'kb-empty', text: '読み込み中…' }));
  sectionEl.appendChild(tabs);
  sectionEl.appendChild(body);
  if (kbState.view !== 'home') activeEntryForm = null;
  try {
    if (kbState.view === 'home') await renderHome(body);
    else if (kbState.view === 'hist') await showHistoryView(body, ctx());
    else if (kbState.view === 'ana') await showAnalysisView(body, ctx());
    else if (kbState.view === 'budget') await showBudgetView(body, ctx());
  } catch (err) {
    clear(body);
    body.appendChild(h('div', { class: 'fatal', text: `読み込みに失敗しました: ${err.message}` }));
  }
}

function subtabBtn(view, label) {
  const active = kbState.view === view;
  return h('button', {
    class: `kb-subtab${active ? ' active' : ''}`, type: 'button',
    onclick: () => { if (kbState.view !== view) { kbState.view = view; void renderView(); } },
  }, label);
}

// =========================================================================
// ホーム
// =========================================================================

function fmtDayShort(dayKey) {
  if (!dayKey) return '';
  const [, m, d] = dayKey.split('-');
  return `${Number(m)}/${Number(d)}`;
}

// 基準で変わる値だけを1つの形に揃える（design decision 1）。特別費・予定出費・固定費・今日までの実績・
// 上限は2基準で同じ値（サーバが recent 側にも同じものを写して返す）なので、ここには含めない。
function basisView(data, basis) {
  const { landing } = data;
  const src = basis === 'recent' ? landing.recent : landing;
  return { landingYen: src.landingYen, overYen: src.overYen, crossDayKey: src.crossDayKey, actualYen: landing.actualYen };
}

/**
 * 基準の切り替え。押す前から両方の1日平均が見えるようにセルの中へ数字を入れてある
 * （切り替えないと相手の数字が分からない状態を避けるため）。
 * 読み上げ名はグラフのフッター文と揃えて「これまでの平均ペース」「直近7日ベース」を aria-label で与える。
 */
function renderBasisToggle(basis, onChange) {
  const seg = h('div', { class: 'kb-basis-seg', role: 'group', 'aria-label': '予想に使う1日平均の基準' });
  const cells = [
    { key: 'all', name: '今月のペース', full: 'これまでの平均ペース' },
    { key: 'recent', name: '直近7日のペース', full: '直近7日ベース' },
  ];
  for (const c of cells) {
    const on = basis === c.key;
    const btn = h('button', {
      class: `kb-basis-btn${on ? ' on' : ''}`, type: 'button',
      'aria-label': c.full, 'aria-pressed': on ? 'true' : 'false',
    }, c.name);
    btn.addEventListener('click', () => { if (!on) onChange(c.key); });
    seg.appendChild(btn);
  }
  return h('div', { class: 'kb-basis' }, seg);
}

async function renderHome(body) {
  const data = await ctx().fetchHome(kbState.month);
  clear(body);

  const { landing, summary } = data;
  const card = h('div', { class: 'kb-card', style: { marginBottom: '16px' } });
  card.appendChild(h('div', { class: 'kb-head' },
    h('span', { class: 't', text: '今月の支出推移と月末予想' }),
    h('span', { class: 'kb-meta', text: `上限 ${fmtYen(landing.capYen)}` })));

  const bigWrap = h('div', {});
  const plot = h('div', { class: 'kb-plot' });
  const summaryRow = h('div', { class: 'kb-summary' });
  card.appendChild(bigWrap);
  card.appendChild(plot);
  card.appendChild(summaryRow);

  // グラフは作り直さず update() で描き替える（基準の切り替えを補間で見せるため）。
  const chart = createChart();
  const crossEl = h('span', { class: 'kb-cross' });
  const chartWrap = h('div', { class: 'kb-chart' }, chart.el,
    h('div', { class: 'kb-chart-foot' },
      h('div', { class: 'kb-chart-legend' },
        h('span', {}, h('i', { class: 'ln' }), '実績'),
        h('span', {}, h('i', { class: 'ln pred' }), '予想')),
      crossEl));
  plot.appendChild(chartWrap);

  const items = h('div', { class: 'kb-summary-items' });
  const adjustBtn = h('button', {
    class: 'btn small',
    type: 'button',
    text: '内訳・調整 ›',
    'aria-label': '予想の計算内訳・調整 ›',
  });
  adjustBtn.addEventListener('click', () => openAdjustModal(ctx()));
  summaryRow.appendChild(items);
  summaryRow.appendChild(adjustBtn);

  function draw(basis, animate) {
    kbState.basis = basis;
    clear(bigWrap);
    const v = basisView(data, basis);
    const currentDailyAvg = basis === 'recent' ? landing.recent.dailyAverageYen : summary.dailyAverageYen;

    const big = h('div', { class: 'kb-big sm' },
      h('span', { class: 'cur', text: '¥' }),
      h('span', { class: 'n kb-amt', text: v.landingYen.toLocaleString('ja-JP') }));
    if (v.overYen > 0) big.appendChild(h('span', { class: 'kb-over', text: `▲ ${fmtYen(v.overYen)} 超過` }));
    bigWrap.appendChild(big);
    bigWrap.appendChild(renderBasisToggle(basis, (next) => draw(next, true)));

    clear(items);
    items.append(
      h('span', {}, '1日ペース: ', h('b', { text: fmtYen(currentDailyAvg) })),
      h('span', {}, '特別費: ', h('b', { text: fmtYen(summary.specialYen) })),
      h('span', {}, '予定出費: ', h('b', { text: fmtYen(summary.plannedYen) })),
      h('span', {}, '固定費: ', h('b', { text: fmtYen(summary.fixedYen) })),
    );

    chart.update({
      seriesAll: data.series, seriesRecent: landing.recent.series,
      avgAll: summary.dailyAverageYen, avgRecent: landing.recent.dailyAverageYen,
      crossAll: landing.crossDayKey, crossRecent: landing.recent.crossDayKey,
      capYen: landing.capYen, fixedYen: landing.fixedYen, basis,
    }, { animate });

    clear(crossEl);
    if (v.crossDayKey) crossEl.append(h('b', { text: fmtDayShort(v.crossDayKey) }), ' に上限超過ペース');
  }

  draw(kbState.basis, false);
  body.appendChild(card);

  const row2 = h('div', { class: 'kb-row2' });
  const w = data.week;
  row2.appendChild(h('div', { class: 'kb-card' },
    h('div', { class: 'kb-head' }, h('span', { class: 't', text: '今週の残り予算' }), h('span', { class: 'kb-meta', text: `${fmtDayShort(w.weekFromDayKey)} – ${fmtDayShort(w.weekToDayKey)}` })),
    h('div', { class: 'kb-big' }, h('span', { class: 'cur', text: '¥' }), h('span', { class: 'n kb-amt', text: w.remainingYen.toLocaleString('ja-JP') })),
    h('div', { class: 'kb-sub' }, '残り', h('b', { text: `${w.remainingDays}日` }), ' · 1日 ', h('b', { text: fmtYen(w.perDayYen) }))));
  row2.appendChild(renderWasteCard(data.waste));
  body.appendChild(row2);

  if (isDemo()) {
    activeEntryForm = null;
    body.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px' }, text: 'デモ・閲覧専用（記録の追加や調整はできません）' }));
  } else {
    body.appendChild(renderEntryCard(data.plannedChips));
  }
}

function renderWasteCard(w) {
  const card = h('div', { class: 'kb-waste' });
  card.appendChild(h('div', { class: 'kb-head', style: { marginBottom: '2px' } }, h('span', { class: 't', text: '今月の「無駄遣い」' })));
  card.appendChild(h('div', { class: 'kb-big sm' },
    h('span', { class: 'cur', text: '¥' }), h('span', { class: 'n kb-amt', text: w.totalYen.toLocaleString('ja-JP') })));
  const pctOfCap = w.capYen > 0 ? Math.min(100, (w.totalYen / w.capYen) * 100) : 0;
  const gauge = h('div', { class: 'kb-gauge' });
  if (w.totalYen > w.capYen) gauge.appendChild(h('i', { class: 'over', style: { width: '100%' } }));
  gauge.appendChild(h('i', { style: { width: `${Math.min(100, pctOfCap)}%` } }));
  gauge.appendChild(h('span', { class: 'cap', style: { left: `${Math.min(100, pctOfCap)}%` } }));
  card.appendChild(gauge);
  card.appendChild(h('div', { class: 'kb-cap-lbl' }, h('span', { style: { left: `${Math.min(100, pctOfCap)}%` }, text: `上限 ${fmtYen(w.capYen)}` })));
  const rowsWrap = h('div', { style: { marginTop: '8px' } });
  for (const r of w.rows.slice(0, 4)) {
    rowsWrap.appendChild(h('div', { class: 'kb-waste-row' },
      h('i', { class: 'kb-imp none' }),
      h('span', { class: 'grow' }, r.name, r.count > 1 ? h('span', { class: 'kb-meta', text: ` ${r.count}回` }) : null),
      h('span', { class: 'v', text: fmtYen(r.amountYen) })));
  }
  card.appendChild(rowsWrap);
  return card;
}

// --- 記録する ---------------------------------------------------------------

function renderEntryCard(plannedChips) {
  const todayDayKey = isDemo() ? DEMO_KAKEIBO_TODAY : appState.today;
  const form = { dayKey: todayDayKey, amountYen: 0, name: '', category: 'FOOD', importance: 'MUST', isSpecial: false, detail: '', receiptId: null, receiptPreview: null };
  const card = h('div', { class: 'kb-card' });
  card.appendChild(h('div', { class: 'kb-head', style: { marginBottom: '12px' } }, h('h2', { text: '記録する' })));

  if (plannedChips && plannedChips.length) {
    const row = h('div', { class: 'kb-resv-row', text: '今月の予定出費 ' });
    for (const p of plannedChips) {
      const chip = h('button', { class: 'kb-chip', type: 'button' }, `${p.name} `, h('span', { class: 'kb-meta', text: `${fmtDayShort(p.next_day_key)} · 目安 ${fmtYen(p.amount_yen)}` }));
      chip.addEventListener('click', () => {
        form.amountYen = p.amount_yen; form.name = p.name; form.category = p.category;
        form._plannedExpenseId = p.id;
        amtInput.value = form.amountYen.toLocaleString('ja-JP');
        nameInput.value = form.name;
        renderPickers();
      });
      row.appendChild(chip);
    }
    card.appendChild(row);
  }

  const amtInput = h('input', { type: 'text', 'aria-label': '金額' });
  amtInput.addEventListener('input', () => { form.amountYen = parseYen(amtInput.value); });
  amtInput.addEventListener('blur', () => { amtInput.value = form.amountYen ? form.amountYen.toLocaleString('ja-JP') : ''; });
  const nameInput = h('input', { class: 'kb-name-input', type: 'text', 'aria-label': '名称', autocomplete: 'off' });
  const nameList = h('div', { class: 'kb-name-suggest', style: { position: 'relative' } });
  const suggestBox = h('div', { class: 'kb-suggest-box', style: { display: 'none', position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '8px', boxShadow: 'var(--shadow)' } });
  nameList.appendChild(nameInput);
  nameList.appendChild(suggestBox);
  async function showSuggestions(prefix) {
    const names = await api.kakeibo.suggestNames(prefix);
    clear(suggestBox);
    if (!names.length) { suggestBox.style.display = 'none'; return; }
    for (const n of names.slice(0, 8)) {
      const opt = h('button', { type: 'button', class: 'kb-suggest-opt', style: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none', background: 'none', font: 'inherit', cursor: 'pointer' }, text: n });
      opt.addEventListener('mousedown', (e) => { e.preventDefault(); form.name = n; nameInput.value = n; suggestBox.style.display = 'none'; });
      suggestBox.appendChild(opt);
    }
    suggestBox.style.display = 'block';
  }
  // 空欄でフォーカスしたときは prefix='' で呼ぶ＝直近入力順の簡易履歴がそのまま出る（suggestNames の順序契約）。
  nameInput.addEventListener('focus', () => { showSuggestions(nameInput.value.trim()); });
  nameInput.addEventListener('input', () => {
    form.name = nameInput.value;
    showSuggestions(nameInput.value.trim());
  });
  nameInput.addEventListener('blur', () => setTimeout(() => { suggestBox.style.display = 'none'; }, 120));

  card.appendChild(h('div', { class: 'kb-entry' }, h('div', { class: 'kb-amt-input' }, h('span', { class: 'yen', text: '¥' }), amtInput), nameList));

  const stack = h('div', { class: 'stack', style: { marginTop: '14px', gap: '12px' } });

  const catPicker = h('div', { class: 'kb-picker' });
  const impPicker = h('div', { class: 'kb-picker' });
  const specialToggle = h('span', { class: 'kb-toggle' });
  function renderPickers() {
    clear(catPicker);
    for (const c of CATEGORIES) {
      const btn = h('button', { class: `kb-pick${form.category === c.v ? ' on' : ''}`, type: 'button' },
        h('span', { class: 'num', text: c.key }), h('i', { class: 'sw', style: { background: catVar(c.v) } }), c.label);
      btn.addEventListener('click', () => {
        form.category = c.v;
        if (c.v === 'SUDDEN') form.isSpecial = true;
        renderPickers();
      });
      catPicker.appendChild(btn);
    }
    clear(impPicker);
    for (const i of IMPORTANCES) {
      const btn = h('button', { class: `kb-pick${form.importance === i.v ? ' on' : ''}`, type: 'button' },
        h('span', { class: 'num', text: i.key }), h('i', { class: `kb-imp ${i.v === 'MUST' ? 'must' : i.v === 'SEMI' ? 'semi' : 'none'}` }), i.label);
      btn.addEventListener('click', () => { form.importance = i.v; renderPickers(); });
      impPicker.appendChild(btn);
    }
    clear(specialToggle);
    const auto = form.category === 'SUDDEN';
    if (auto) specialToggle.classList.add('auto'); else specialToggle.classList.remove('auto');
    const normalSeg = h('button', { class: `seg${!form.isSpecial ? ' on' : ''}`, type: 'button', disabled: auto, text: '通常の出費' });
    const specialSeg = h('button', { class: `seg${form.isSpecial ? ' on' : ''}`, type: 'button', disabled: auto, text: auto ? '特別費（自動）' : '特別費にする' });
    if (!auto) {
      normalSeg.addEventListener('click', () => { form.isSpecial = false; renderPickers(); });
      specialSeg.addEventListener('click', () => { form.isSpecial = true; renderPickers(); });
    }
    specialToggle.appendChild(normalSeg);
    specialToggle.appendChild(specialSeg);
    attachTooltip(specialSeg, { label: '特別費にする（日々の計算から外す）', keys: ['X'] });
  }
  const dayInput = h('input', { type: 'date', value: form.dayKey, max: todayDayKey, 'aria-label': '買った日' });
  dayInput.addEventListener('change', () => { form.dayKey = dayInput.value || todayDayKey; });
  stack.appendChild(h('div', { class: 'kb-field-row' }, h('span', { class: 'lbl', text: '買った日' }), dayInput));
  stack.appendChild(h('div', { class: 'kb-field-row' }, h('span', { class: 'lbl', text: 'カテゴリ' }), catPicker));
  stack.appendChild(h('div', { class: 'kb-field-row' }, h('span', { class: 'lbl', text: '重要度' }), impPicker));
  stack.appendChild(h('div', { class: 'kb-field-row' }, h('span', { class: 'lbl', text: '計算対象' }), specialToggle));

  const detailInput = h('textarea', { rows: 2, placeholder: '豚こま 598 / 鶏むね 898 …', style: { width: '100%', font: 'inherit', fontSize: '13px' } });
  detailInput.addEventListener('input', () => { form.detail = detailInput.value; });
  stack.appendChild(h('div', { class: 'kb-field-row' }, h('span', { class: 'lbl', text: '内訳（任意）' }), h('span', { style: { flex: '1', minWidth: '200px' } }, detailInput)));

  const receiptRow = h('span', { class: 'kb-receipt' });
  function renderReceipt() {
    clear(receiptRow);
    if (form.receiptPreview) {
      receiptRow.appendChild(h('span', { class: 'kb-thumb' }, h('img', { src: form.receiptPreview, alt: 'レシート' })));
      receiptRow.appendChild(h('span', { class: 'kb-clip', text: '添付済み' }));
      const del = h('button', { class: 'btn small', type: 'button', text: '削除' });
      del.addEventListener('click', () => { form.receiptId = null; form.receiptPreview = null; renderReceipt(); });
      receiptRow.appendChild(del);
    }
    const fileInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file || !isImageFile(file)) return;
      try {
        const dataUrl = await shrinkImage(file);
        const r = await api.kakeibo.uploadReceipt(dataUrl);
        form.receiptId = r.id; form.receiptPreview = dataUrl;
        renderReceipt();
      } catch (e) { toast(`画像を読み込めません: ${e.message}`, 'err'); }
    });
    const pick = h('button', { class: 'btn small', type: 'button', text: form.receiptPreview ? '変更' : '添付' });
    pick.addEventListener('click', () => fileInput.click());
    receiptRow.appendChild(pick);
    receiptRow.appendChild(fileInput);
  }
  renderReceipt();
  renderPickers();

  const saveBtn = h('button', { class: 'btn primary', type: 'button', text: '記録する' });
  const lastRow = h('div', { class: 'kb-field-row' },
    h('span', { class: 'lbl', style: { minWidth: '86px' }, text: 'レシート（任意）' }), receiptRow, h('span', { class: 'spacer' }), saveBtn);
  stack.appendChild(lastRow);
  card.appendChild(stack);

  attachTooltip(saveBtn, { label: '記録する', keys: ['Ctrl', 'Enter'] });
  const root = h('div', {}, card);
  ctrlEnterToSave(root, saveBtn);

  saveBtn.addEventListener('click', async () => {
    if (!form.amountYen || form.amountYen <= 0) { toast('金額を入力してください', 'err'); return; }
    if (!form.name.trim()) { toast('名称を入力してください', 'err'); return; }
    saveBtn.disabled = true;
    try {
      await submitEntry(form);
    } catch (e) {
      toast(e.data && e.data.error ? e.data.error : `記録に失敗しました: ${e.message}`, 'err');
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ショートカット 1-4 / Q W E / X はページ全体で効く（グローバルハンドラ側で activeEntryForm を参照）。
  activeEntryForm = { form, renderPickers };

  return root;
}

// カテゴリ 1-4・重要度 Q W E・特別費 X のグローバルショートカット（プロジェクトルール: attachTooltip 併記）。
// モジュール読み込み時に一度だけ登録し、記録カードが再描画されるたびに activeEntryForm を差し替える。
let activeEntryForm = null;
document.addEventListener('keydown', (e) => {
  if (!activeEntryForm || !sectionEl) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (isTypingTarget(e)) return;
  const modal = document.getElementById('modal-root');
  if (modal && modal.classList.contains('open')) return;
  const { form, renderPickers } = activeEntryForm;
  const cat = CATEGORIES.find((c) => c.key === e.key);
  if (cat) { e.preventDefault(); form.category = cat.v; if (cat.v === 'SUDDEN') form.isSpecial = true; renderPickers(); return; }
  const imp = IMPORTANCES.find((i) => i.key.toLowerCase() === e.key.toLowerCase());
  if (imp) { e.preventDefault(); form.importance = imp.v; renderPickers(); return; }
  if (e.key.toLowerCase() === 'x' && form.category !== 'SUDDEN') {
    e.preventDefault(); form.isSpecial = !form.isSpecial; renderPickers();
  }
});

async function submitEntry(form) {
  const dayKey = form.dayKey || (isDemo() ? DEMO_KAKEIBO_TODAY : appState.today);
  const base = {
    dayKey, name: form.name.trim(), amountYen: form.amountYen, category: form.category,
    importance: form.importance, isSpecial: form.isSpecial, detail: form.detail ? form.detail.trim() || null : null,
    receiptId: form.receiptId,
  };
  if (form._plannedExpenseId) {
    await api.kakeibo.recordPlannedExpense(form._plannedExpenseId, { dayKey, amountYen: form.amountYen, importance: form.importance });
    toast('記録しました', 'ok');
    await renderView();
    return;
  }
  await api.kakeibo.createEntry(base);
  toast('記録しました', 'ok');
  await renderView();
}

// =========================================================================
// 予想の計算内訳・調整モーダル（design D3・D14）
// =========================================================================

export async function openAdjustModal(kctx) {
  const body = h('div', {}, h('div', { class: 'kb-empty', text: '読み込み中…' }));
  openModal(body, '予想の計算内訳・調整');

  const initial = await kctx.fetchAdjust(kctx.month);
  clear(body);

  const overrides = {};
  let effect = initial.effect;
  const list = h('div', { class: 'kb-choice' });
  const effectPanel = h('div', { class: 'kb-effect', style: { marginTop: '12px' } });

  function currentSpecial(row) {
    if (row.auto) return true;
    return Object.prototype.hasOwnProperty.call(overrides, row.name) ? overrides[row.name] : row.isSpecial;
  }

  function renderEffect() {
    clear(effectPanel);
    effectPanel.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k', text: '日々の出費（計算対象）' }), h('b', { text: fmtYen(effect.dailyPoolYen) })));
    effectPanel.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k', text: '1日平均' }), h('b', { text: fmtYen(effect.dailyAverageYen) })));
    effectPanel.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k', text: '今月末の予想額' }), h('b', { text: fmtYen(effect.landingYen) })));
    effectPanel.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k', text: '上限を超える日' }), h('b', { text: effect.crossDayKey ? fmtDayShort(effect.crossDayKey) : '超過なし' })));
  }

  async function refreshEffect() {
    effect = await api.kakeibo.previewForecastAdjust(kctx.month, overrides);
    renderEffect();
  }

  function renderList() {
    clear(list);
    for (const row of initial.rows) {
      if (row.name === '') continue; // まとめ登録（内訳未入力）は名称の単位で切り替えられないので出さない
      const special = currentSpecial(row);
      const toggle = h('span', { class: `kb-toggle${row.auto ? ' auto' : ''}` });
      const normalSeg = h('button', { class: `seg${!special ? ' on' : ''}`, type: 'button', disabled: row.auto, text: '通常の出費' });
      const specialSeg = h('button', { class: `seg${special ? ' on' : ''}`, type: 'button', disabled: row.auto, text: row.auto ? '特別費（自動）' : '特別費（除外）' });
      if (!row.auto) {
        normalSeg.addEventListener('click', async () => { overrides[row.name] = false; renderList(); await refreshEffect(); });
        specialSeg.addEventListener('click', async () => { overrides[row.name] = true; renderList(); await refreshEffect(); });
      }
      toggle.appendChild(normalSeg);
      toggle.appendChild(specialSeg);
      list.appendChild(h('div', { class: 'kb-adjust-row' },
        h('span', { class: 'nm' }, row.name, h('span', { class: 'kb-meta', text: ` ${fmtYen(row.amountYen)}${row.count > 1 ? ` ×${row.count}` : ''}` })),
        toggle));
    }
  }

  renderList();
  renderEffect();
  body.appendChild(list);
  body.appendChild(effectPanel);

  const actions = h('div', { class: 'actions' });
  const cancel = h('button', { class: 'btn', type: 'button', text: 'キャンセル' });
  const confirm = h('button', { class: 'btn primary', type: 'button', text: 'これで予想する' });
  cancel.addEventListener('click', closeModal);
  confirm.addEventListener('click', async () => {
    try {
      const names = Object.keys(overrides);
      if (names.length > 0) {
        const hist = await api.kakeibo.history(kctx.month);
        for (const name of names) {
          const isSpecial = overrides[name];
          for (const e of hist.entries) {
            if (e.name === name && e.category !== 'SUDDEN') {
              await api.kakeibo.updateEntry(e.id, { isSpecial });
            }
          }
        }
      }
      closeModal();
      await kctx.refresh();
    } catch (e) {
      toast(`反映できませんでした: ${e.message}`, 'err');
    }
  });
  actions.appendChild(cancel);
  actions.appendChild(confirm);
  body.appendChild(actions);
}

// =========================================================================
// 明細（内訳＋レシート）モーダル（design D10・spec: kakeibo-ledger / kakeibo-analysis）
// =========================================================================

/** entry は { id, name, day_key, amount_yen, category, importance, detail, has_detail, has_receipt, receipt_id } を持つレコード。 */
export function openDetailModal(entry, kctx) {
  const body = h('div', {});
  body.appendChild(h('div', { class: 'row', style: { gap: '8px', marginBottom: '10px' } },
    h('span', { class: 'kb-meta', text: fmtDayShort(entry.day_key) }),
    h('span', { class: 'kb-cat' }, h('i', { class: 'sw', style: { background: catVar(entry.category) } }), catLabel(entry.category)),
    entry.importance !== undefined ? h('span', { class: 'row', style: { gap: '5px' } }, h('i', { class: `kb-imp ${entry.importance ? entry.importance.toLowerCase() : 'nodetail'}` }), h('span', { style: { fontSize: '12.5px' }, text: impLabel(entry.importance) })) : null));

  const panes = h('div', { class: 'kb-detail-panes' });

  const detailPane = h('div', { class: 'kb-detail-pane' }, h('div', { class: 't', text: '内訳' }));
  const hasDetail = !!(entry.detail && entry.detail.trim());
  if (hasDetail) {
    detailPane.appendChild(h('div', { class: 'txt', text: entry.detail }));
  } else {
    detailPane.appendChild(h('div', { class: 'none', text: '内訳は書かれていません' }));
  }
  if (kctx && !isDemo()) {
    const editBtn = h('button', { class: 'btn small', type: 'button', text: hasDetail ? '内訳を直す' : '内訳を書く' });
    const ta = h('textarea', { rows: 3, style: { display: 'none', marginTop: '8px' } });
    ta.value = entry.detail || '';
    const saveBtn = h('button', { class: 'btn small primary', type: 'button', text: '保存', style: { display: 'none', marginTop: '6px' } });
    editBtn.addEventListener('click', () => { ta.style.display = 'block'; saveBtn.style.display = 'inline-flex'; editBtn.style.display = 'none'; });
    saveBtn.addEventListener('click', async () => {
      await api.kakeibo.updateEntry(entry.id, { detail: ta.value.trim() || null });
      closeModal();
      toast('保存しました', 'ok');
      await kctx.refresh();
    });
    detailPane.appendChild(editBtn);
    detailPane.appendChild(ta);
    detailPane.appendChild(saveBtn);
  }
  panes.appendChild(detailPane);

  const receiptPane = h('div', { class: 'kb-detail-pane' }, h('div', { class: 't', text: 'レシート' }));
  if (entry.has_receipt || entry.receipt_id) {
    receiptPane.appendChild(h('div', { class: 'kb-receipt-view' }, h('img', { src: `/api/kakeibo/receipts/${entry.receipt_id}`, alt: 'レシート' })));
  } else {
    receiptPane.appendChild(h('div', { class: 'none', text: 'レシートは付いていません' }));
  }
  if (kctx && !isDemo()) {
    const fileInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file || !isImageFile(file)) return;
      try {
        const dataUrl = await shrinkImage(file);
        const r = await api.kakeibo.uploadReceipt(dataUrl);
        await api.kakeibo.updateEntry(entry.id, { receiptId: r.id });
        closeModal();
        toast('レシートを保存しました', 'ok');
        await kctx.refresh();
      } catch (e) { toast(`画像を読み込めません: ${e.message}`, 'err'); }
    });
    const pick = h('button', { class: 'btn small', type: 'button', text: entry.has_receipt || entry.receipt_id ? 'レシートを差し替える' : 'レシートを付ける' });
    pick.addEventListener('click', () => fileInput.click());
    receiptPane.appendChild(pick);
    receiptPane.appendChild(fileInput);
  }
  panes.appendChild(receiptPane);

  body.appendChild(panes);
  const actions = h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: '閉じる', onclick: closeModal }));
  body.appendChild(actions);
  openModal(body, `${entry.name || '内訳未入力'} ${fmtYen(entry.amount_yen)}`);
}
