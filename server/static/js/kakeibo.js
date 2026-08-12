// 家計簿タブ本体（design D15: {month, view} の2状態）。
// ホーム/履歴/分析/予算のサブタブ切替と、共有モーダル（実績確定・予想の計算基準）を持つ。
import { h, clear, closeModal, openModal, attachTooltip, ctrlEnterToSave, isTypingTarget, toast, emptyState, addDays } from './util.js';
import { api } from './api.js';
import { state as appState } from './state.js';
import { isDemo } from './demo.js';
import { shrinkImage, isImageFile } from './images.js';
import { renderChart } from './kakeibo-chart.js';
import { showHistoryView, showEditDaysView } from './kakeibo-history.js';
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
  { v: 'WASTE', label: 'いらない', key: 'E' },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.v, c.label]));
CATEGORY_LABEL.NONE = '複数';
const IMPORTANCE_LABEL = Object.fromEntries(IMPORTANCES.map((c) => [c.v, c.label]));
const BASIS_LABEL = { LAST: '前回の値', ALL_AVG: '全体の平均', RECENT_N: '直近N回の平均', MANUAL: '手動で指定' };

export function fmtYen(n) { return `¥${Math.round(n || 0).toLocaleString('ja-JP')}`; }
const CATEGORY_CSS_VAR = { FOOD: 'food', DAILY: 'daily', FUN: 'fun', SUDDEN: 'sudden', NONE: 'nodetail' };
export function catVar(cat) { return `var(--kb-${CATEGORY_CSS_VAR[cat] || 'nodetail'})`; }
export function catLabel(cat) { return CATEGORY_LABEL[cat] || cat; }
export function impLabel(imp) { return imp == null ? '重要度なし' : (IMPORTANCE_LABEL[imp] || imp); }
export function basisLabel(basis) { return BASIS_LABEL[basis] || basis; }
export function monthLabel(m) { const [y, mo] = (m || '').split('-'); return `${y}年${Number(mo)}月`; }
function parseYen(v) { return Number(String(v || '').replace(/[^\d.-]/g, '')) || 0; }

const kbState = { month: null, view: 'home' };
let sectionEl = null;

// デモの家計簿は目標タブの仮想日付とは無関係の固定シナリオ（server/src/services/demo-seed.ts の
// DEMO_KAKEIBO_MONTH/DEMO_KAKEIBO_TODAY と同じ値）。
const DEMO_KAKEIBO_MONTH = '2026-08';
function currentMonth() {
  if (isDemo()) return DEMO_KAKEIBO_MONTH;
  return (appState.today || '').slice(0, 7);
}

// --- デモ切替つき fetch ラッパー ------------------------------------------
function kbApi(prodFn, demoFn) {
  return (...args) => (isDemo() ? demoFn(appState.demo.virtualDay, ...args) : prodFn(...args));
}
const fetchHome = kbApi(api.kakeibo.home, (now, month) => api.demo.kakeiboHome(month, now));
const fetchHistory = kbApi(api.kakeibo.history, (now, month) => api.demo.kakeiboHistory(month, now));
const fetchDayEdit = kbApi(api.kakeibo.dayEdit, (now, month) => api.demo.kakeiboDayEdit(month, now));
const fetchAnalysis = kbApi(api.kakeibo.analysis, (now, month) => api.demo.kakeiboAnalysis(month, now));
const fetchBudget = kbApi(api.kakeibo.budget, (now, month) => api.demo.kakeiboBudget(month, now));

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
    todayDayKey: isDemo() ? '2026-08-11' : appState.today,
    refresh: () => renderView(),
    goto: (view) => { kbState.view = view; void renderView(); },
    fetchHome, fetchHistory, fetchDayEdit, fetchAnalysis, fetchBudget,
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
    else if (kbState.view === 'edit') await showEditDaysView(body, ctx());
    else if (kbState.view === 'ana') await showAnalysisView(body, ctx());
    else if (kbState.view === 'budget') await showBudgetView(body, ctx());
  } catch (err) {
    clear(body);
    body.appendChild(h('div', { class: 'fatal', text: `読み込みに失敗しました: ${err.message}` }));
  }
}

function subtabBtn(view, label) {
  const active = kbState.view === view || (kbState.view === 'edit' && view === 'hist');
  return h('button', {
    class: `kb-subtab${active ? ' active' : ''}`, type: 'button',
    onclick: () => { if (kbState.view !== view) { kbState.view = view; void renderView(); } },
  }, label);
}

// =========================================================================
// ホーム
// =========================================================================

async function renderHome(body) {
  const data = await ctx().fetchHome(kbState.month);
  clear(body);

  const f = data.forecast;
  const card = h('div', { class: 'kb-card', style: { marginBottom: '16px' } });
  card.appendChild(h('div', { class: 'kb-head' },
    h('span', { class: 't', text: '今月の支出推移と着地予想' }),
    h('span', { class: 'kb-meta', text: `上限 ${fmtYen(f.capYen)}` })));
  const big = h('div', { class: 'kb-big sm' },
    h('span', { class: 'cur', text: '¥' }),
    h('span', { class: 'n kb-amt', text: f.landingYen.toLocaleString('ja-JP') }));
  if (f.overYen > 0) big.appendChild(h('span', { class: 'kb-over', text: `▲ ${fmtYen(f.overYen)} 超過` }));
  big.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '今日まで ', h('b', { class: 'kb-amt', style: { color: 'var(--text)' }, text: f.actualYen.toLocaleString('ja-JP') })));
  card.appendChild(big);

  const plot = h('div', { class: 'kb-plot' });
  const chartWrap = h('div', { class: 'kb-chart' }, renderChart(f));
  const foot = h('div', { class: 'kb-chart-foot' },
    h('div', { class: 'kb-chart-legend' },
      h('span', {}, h('i', { class: 'ln' }), '実績'),
      h('span', {}, h('i', { class: 'ln pred' }), '予想'),
      h('span', {}, h('i', { class: 'ln cap' }), '上限')));
  if (f.crossDayKey) foot.appendChild(h('span', { class: 'kb-cross' }, 'このペースだと ', h('b', { text: fmtDayShort(f.crossDayKey) }), ' に上限超過'));
  chartWrap.appendChild(foot);
  plot.appendChild(chartWrap);
  plot.appendChild(renderSourcesPanel(data.sources, f));
  card.appendChild(plot);
  body.appendChild(card);

  const row2 = h('div', { class: 'kb-row2' });
  const w = data.week;
  row2.appendChild(h('div', { class: 'kb-card' },
    h('div', { class: 'kb-head' }, h('span', { class: 't', text: '今週使える残り' }), h('span', { class: 'kb-meta', text: `${fmtDayShort(w.weekFromDayKey)} – ${fmtDayShort(w.weekToDayKey)}` })),
    h('div', { class: 'kb-big' }, h('span', { class: 'cur', text: '¥' }), h('span', { class: 'n kb-amt', text: w.remainingYen.toLocaleString('ja-JP') })),
    h('div', { class: 'kb-sub' }, '残り', h('b', { text: `${w.remainingDays}日` }), ' · 1日 ', h('b', { text: fmtYen(w.perDayYen) }))));
  row2.appendChild(renderWasteCard(data.waste, f));
  body.appendChild(row2);

  if (isDemo()) {
    activeEntryForm = null;
    body.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px' }, text: 'デモ・閲覧専用（記録の追加や基準の変更はできません）' }));
  } else {
    body.appendChild(renderEntryCard(data.plannedChips));
  }
}

function fmtDayShort(dayKey) {
  if (!dayKey) return '';
  const [, m, d] = dayKey.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function renderSourcesPanel(sources, forecast) {
  const panel = h('div', { class: 'kb-srcs' });
  panel.appendChild(h('div', { class: 'kb-srcs-head' }, h('span', { class: 't', text: '予想の計算基準' }), h('span', { class: 'kb-meta', text: 'タップで変更' })));
  for (const s of sources) {
    const nm = h('span', { class: 'nm' }, h('i', { class: 'sw', style: { background: catVar(s.category) } }), s.name || catLabel(s.category));
    if (s.pendingCount) nm.appendChild(h('span', { class: 'badge warn', text: `未確定${s.pendingCount}` }));
    if (s.kind === 'RESERVATION') nm.appendChild(h('span', { class: 'badge accent', text: '予約' }));
    let rateText; let l2Text;
    if (s.kind === 'STOCK') { rateText = `${fmtYen(s.ratePerDay)}/日`; l2Text = cycleText(s.cycleDays, s.amountYen); }
    else if (s.kind === 'SPORADIC') { rateText = `${fmtYen(s.ratePerDay)}/日`; l2Text = 'その日限り'; }
    else if (s.kind === 'MONTHLY_ROOM') { rateText = `残り ${fmtYen(s.remainingYen)}`; l2Text = `月 ${fmtYen(s.roomYen)}`; }
    else { rateText = fmtYen(s.amountYen); l2Text = `次は ${fmtDayShort(s.dayKey)}`; }
    const basisText = s.kind === 'STOCK' ? basisLabel(s.basis) : s.kind === 'RESERVATION' ? '予約の値' : s.kind === 'MONTHLY_ROOM' ? '3か月の平均' : '全体の平均';
    const btn = h('button', { class: 'kb-src', type: 'button' },
      h('span', { class: 'l1' }, nm, h('span', { class: 'rate', text: rateText })),
      h('span', { class: 'l2' }, h('span', { text: l2Text }), h('span', { class: 'basis', text: basisText })));
    if (s.kind === 'STOCK' && !isDemo()) btn.addEventListener('click', () => openSourceModal(s.name, ctx()));
    panel.appendChild(btn);
  }
  panel.appendChild(h('div', { class: 'kb-srcs-total' }, h('span', { text: `残り${forecast.remainingDays}日の予想` }), h('b', { text: fmtYen(forecast.forecastYen) })));
  return panel;
}

function cycleText(cycleDays, amountYen) {
  if (cycleDays == null) return '';
  const d = Math.round(cycleDays * 10) / 10;
  const dText = Number.isInteger(d) ? `${d}日` : `${d.toFixed(1)}日`;
  return `${dText}ごと ${fmtYen(amountYen)}`;
}

function renderWasteCard(w, forecast) {
  const card = h('div', { class: 'kb-waste' });
  card.appendChild(h('div', { class: 'kb-head', style: { marginBottom: '2px' } }, h('span', { class: 't', text: '今月の「不要な支出」' })));
  card.appendChild(h('div', { class: 'kb-big sm' },
    h('span', { class: 'cur', text: '¥' }), h('span', { class: 'n kb-amt', text: w.totalYen.toLocaleString('ja-JP') }),
    h('span', { class: 'muted', style: { fontSize: '12.5px' }, text: `変動費の ${w.ratioPct}%` })));
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
  if (w.overYen > 0 && forecast) {
    const after = Math.max(0, forecast.overYen - w.overYen);
    card.appendChild(h('p', { style: { marginTop: '12px', fontSize: '12.5px', color: '#7a2f27' } },
      'ここを抑えると月末の超過が ', h('b', { text: fmtYen(forecast.overYen) }), ' → ', h('b', { text: fmtYen(after) }), '。'));
  }
  return card;
}

// --- 記録する ---------------------------------------------------------------

function renderEntryCard(plannedChips) {
  const form = { amountYen: 0, name: '', category: 'FOOD', importance: 'MUST', plannedDays: 1, receiptId: null, receiptPreview: null };
  const card = h('div', { class: 'kb-card' });
  card.appendChild(h('div', { class: 'kb-head', style: { marginBottom: '12px' } }, h('h2', { text: '記録する' })));

  if (plannedChips && plannedChips.length) {
    const row = h('div', { class: 'kb-resv-row', text: '今月の予定出費 ' });
    for (const p of plannedChips) {
      const chip = h('button', { class: 'kb-chip', type: 'button' }, `${p.name} `, h('span', { class: 'kb-meta', text: `${fmtDayShort(p.next_day_key)} · 目安 ${fmtYen(p.amount_yen)}` }));
      chip.addEventListener('click', () => {
        form.amountYen = p.amount_yen; form.name = p.name; form.category = p.category; form.plannedDays = 1;
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
  nameInput.addEventListener('input', async () => {
    form.name = nameInput.value;
    const prefix = nameInput.value.trim();
    if (!prefix) { suggestBox.style.display = 'none'; return; }
    const names = await api.kakeibo.suggestNames(prefix);
    clear(suggestBox);
    if (!names.length) { suggestBox.style.display = 'none'; return; }
    for (const n of names.slice(0, 8)) {
      const opt = h('button', { type: 'button', class: 'kb-suggest-opt', style: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none', background: 'none', font: 'inherit', cursor: 'pointer' }, text: n });
      opt.addEventListener('mousedown', (e) => { e.preventDefault(); form.name = n; nameInput.value = n; suggestBox.style.display = 'none'; });
      suggestBox.appendChild(opt);
    }
    suggestBox.style.display = 'block';
  });
  nameInput.addEventListener('blur', () => setTimeout(() => { suggestBox.style.display = 'none'; }, 120));

  card.appendChild(h('div', { class: 'kb-entry' }, h('div', { class: 'kb-amt-input' }, h('span', { class: 'yen', text: '¥' }), amtInput), nameList));

  const stack = h('div', { class: 'stack', style: { marginTop: '14px', gap: '12px' } });

  const catPicker = h('div', { class: 'kb-picker' });
  const impPicker = h('div', { class: 'kb-picker' });
  function renderPickers() {
    clear(catPicker);
    for (const c of CATEGORIES) {
      const btn = h('button', { class: `kb-pick${form.category === c.v ? ' on' : ''}`, type: 'button' },
        h('span', { class: 'num', text: c.key }), h('i', { class: 'sw', style: { background: catVar(c.v) } }), c.label);
      btn.addEventListener('click', () => { form.category = c.v; renderPickers(); });
      catPicker.appendChild(btn);
    }
    clear(impPicker);
    for (const i of IMPORTANCES) {
      const btn = h('button', { class: `kb-pick${form.importance === i.v ? ' on' : ''}`, type: 'button' },
        h('span', { class: 'num', text: i.key }), h('i', { class: `kb-imp ${i.v === 'MUST' ? 'must' : i.v === 'SEMI' ? 'semi' : 'none'}` }), i.label);
      btn.addEventListener('click', () => { form.importance = i.v; renderPickers(); });
      impPicker.appendChild(btn);
    }
    daysVal.textContent = `${form.plannedDays} 日`;
  }
  stack.appendChild(h('div', { class: 'kb-field-row' }, h('span', { class: 'lbl', text: 'カテゴリ' }), catPicker));
  stack.appendChild(h('div', { class: 'kb-field-row' }, h('span', { class: 'lbl', text: '重要度' }), impPicker));

  const daysVal = h('span', { class: 'v', text: '1 日' });
  const daysMinus = h('button', { type: 'button', 'aria-label': '1日減らす', text: '−' });
  const daysPlus = h('button', { type: 'button', 'aria-label': '1日増やす', text: '＋' });
  daysMinus.addEventListener('click', () => { form.plannedDays = Math.max(0, form.plannedDays - 1); daysVal.textContent = `${form.plannedDays} 日`; });
  daysPlus.addEventListener('click', () => { form.plannedDays = form.plannedDays + 1; daysVal.textContent = `${form.plannedDays} 日`; });
  stack.appendChild(h('div', { class: 'kb-field-row' }, h('span', { class: 'lbl', text: 'もつ日数' }), h('span', { class: 'kb-days' }, daysMinus, daysVal, daysPlus)));

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
    if (!form.name.trim() && form.plannedDays >= 1) { toast('名称を入力してください', 'err'); return; }
    saveBtn.disabled = true;
    try {
      await submitEntry(form);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ショートカット 1-4 / Q W E はページ全体で効く（グローバルハンドラ側で activeEntryForm を参照）。
  activeEntryForm = { form, renderPickers };

  return root;
}

// カテゴリ 1-4・重要度 Q W E のグローバルショートカット（design 9.7・プロジェクトルール: attachTooltip 併記）。
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
  if (cat) { e.preventDefault(); form.category = cat.v; renderPickers(); return; }
  const imp = IMPORTANCES.find((i) => i.key.toLowerCase() === e.key.toLowerCase());
  if (imp) { e.preventDefault(); form.importance = imp.v; renderPickers(); }
});

async function submitEntry(form) {
  const dayKey = isDemo() ? appState.demo.virtualDay : appState.today;
  const base = {
    dayKey, name: form.name.trim(), amountYen: form.amountYen, category: form.category,
    importance: form.importance, plannedDays: form.plannedDays, receiptId: form.receiptId,
  };
  if (form._plannedExpenseId) {
    await api.kakeibo.recordPlannedExpense(form._plannedExpenseId, { dayKey, amountYen: form.amountYen, importance: form.importance });
    toast('記録しました', 'ok');
    await renderView();
    return;
  }
  if (form.plannedDays >= 2 && form.name.trim()) {
    const pending = await api.kakeibo.pendingConfirmation(form.name.trim(), dayKey);
    if (pending) {
      openConfirmModal(pending, {
        onResolve: async (confirm) => {
          closeModal();
          await api.kakeibo.createEntry({ ...base, confirm });
          toast('記録しました', 'ok');
          await renderView();
        },
        onSkip: async () => {
          closeModal();
          await api.kakeibo.createEntry(base);
          toast('記録しました（あとで確定できます）', 'ok');
          await renderView();
        },
      });
      return;
    }
  }
  await api.kakeibo.createEntry(base);
  toast('記録しました', 'ok');
  await renderView();
}

// =========================================================================
// 実績日数を確定するモーダル（design D3）
// =========================================================================

/**
 * pending = pendingConfirmation() の返り値。
 * opts.onResolve(choiceObj) / opts.onSkip() のどちらかを呼ぶ。
 * opts.standalone=true のときは主ボタンで直接 confirmActualDays API を叩いて閉じる。
 */
export function openConfirmModal(pending, opts) {
  const body = h('div', {});
  body.appendChild(h('div', { class: 'cond', style: { background: 'var(--panel)' } },
    h('i', { class: 'kb-imp must' }),
    h('div', { class: 'cond-main' },
      h('div', { class: 'cond-title', text: `${pending.name} ${fmtYen(pending.amountYen)}` }),
      h('div', { class: 'cond-sub', text: `${fmtDayShort(pending.coversFrom)} に記録 · 今日で${pending.elapsedDays}日目` }))));

  let selected = pending.defaultChoice;
  let remainN = 1; let earlierN = 1;
  const choiceList = h('div', { class: 'kb-choice' });
  const effect = h('div', { class: 'kb-effect' });

  function choiceFor(kind) { return pending.choices.find((c) => c.choice === kind); }
  function currentActualDays() {
    if (selected === 'REMAINING') return pending.elapsedDays + remainN;
    if (selected === 'EARLIER') return pending.elapsedDays - earlierN;
    return pending.elapsedDays;
  }
  function currentRate() {
    const d = currentActualDays();
    return d > 0 ? Math.floor(pending.amountYen / d) : null;
  }

  function renderEffect() {
    clear(effect);
    const rate = currentRate();
    const days = currentActualDays();
    effect.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k', text: '実績日数' }), h('b', { text: days > 0 ? `${days}日` : '—' })));
    effect.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k', text: '日単価' }), h('b', { text: rate != null ? `${fmtYen(rate)}/日` : '—' })));
    const startText = selected === 'REMAINING'
      ? `${fmtDayShort(addDays(pending.coversFrom, days - 1))} から効く`
      : '今日から効く';
    effect.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k', text: '今回の買い物' }), h('span', { text: startText })));
  }

  function renderChoices() {
    clear(choiceList);
    const opts3 = [
      { kind: 'REMAINING', label: 'まだ残っている', stepper: true, get: () => remainN, set: (v) => { remainN = v; } },
      { kind: 'TODAY', label: '今日で使い切った（既定）', stepper: false },
      { kind: 'EARLIER', label: 'もっと前に使い切っていた', stepper: true, get: () => earlierN, set: (v) => { earlierN = v; } },
    ];
    for (const o of opts3) {
      const c = choiceFor(o.kind);
      const row = h('div', { class: `kb-opt${selected === o.kind ? ' on' : ''}` });
      row.appendChild(h('span', { class: 'radio' }));
      if (o.stepper) {
        const val = h('span', { class: 'v', text: `${o.get()} 日${o.kind === 'REMAINING' ? '分' : '前'}` });
        const minus = h('button', { type: 'button', text: '−' });
        const plus = h('button', { type: 'button', text: '＋' });
        minus.addEventListener('click', (e) => { e.stopPropagation(); o.set(Math.max(1, o.get() - 1)); val.textContent = `${o.get()} 日${o.kind === 'REMAINING' ? '分' : '前'}`; selected = o.kind; renderChoices(); renderEffect(); });
        plus.addEventListener('click', (e) => { e.stopPropagation(); o.set(o.get() + 1); val.textContent = `${o.get()} 日${o.kind === 'REMAINING' ? '分' : '前'}`; selected = o.kind; renderChoices(); renderEffect(); });
        row.appendChild(h('span', { class: 'row', style: { gap: '8px' } }, o.label, h('span', { class: 'kb-days' }, minus, val, plus)));
      } else {
        row.appendChild(h('span', { text: o.label }));
      }
      row.appendChild(h('span', { class: 'res', text: c ? `実績 ${c.actualDays}日 · ${c.ratePerDay != null ? fmtYen(c.ratePerDay) + '/日' : '—'}` : '' }));
      row.addEventListener('click', () => { selected = o.kind; renderChoices(); renderEffect(); });
      choiceList.appendChild(row);
    }
  }
  renderChoices();
  renderEffect();
  body.appendChild(choiceList);
  body.appendChild(effect);

  const actions = h('div', { class: 'actions' });
  const skipBtn = h('button', { class: 'btn', type: 'button', text: 'あとで' });
  const okBtn = h('button', { class: 'btn primary', type: 'button', text: opts.standalone ? '確定する' : 'これで記録する' });
  skipBtn.addEventListener('click', async () => { if (opts.onSkip) await opts.onSkip(); else closeModal(); });
  okBtn.addEventListener('click', async () => {
    const n = selected === 'REMAINING' ? remainN : selected === 'EARLIER' ? earlierN : undefined;
    if (opts.standalone) {
      await api.kakeibo.confirmActualDays(pending.entryId, { choice: selected, n });
      toast('確定しました', 'ok');
      closeModal();
      if (opts.onDone) await opts.onDone();
    } else if (opts.onResolve) {
      await opts.onResolve({ choice: selected, n });
    }
  });
  actions.appendChild(skipBtn);
  actions.appendChild(okBtn);
  body.appendChild(actions);

  openModal(body, '前回の購入分は何日もちましたか？');
}

// =========================================================================
// 予想の計算基準モーダル（design D5）
// =========================================================================

export async function openSourceModal(name, kctx) {
  const body = h('div', {}, h('div', { class: 'kb-empty', text: '読み込み中…' }));
  openModal(body, `予想の計算基準 — ${name}`);

  const [dayEdit, lastPreview, allAvgPreview, currentBasis] = await Promise.all([
    kctx.fetchDayEdit(kctx.month),
    api.kakeibo.previewBasis(name, { basis: 'LAST', month: kctx.month }),
    api.kakeibo.previewBasis(name, { basis: 'ALL_AVG', month: kctx.month }),
    api.kakeibo.getBasis(name),
  ]);
  let recentN = currentBasis.recent_n || 3;
  let recentPreview = await api.kakeibo.previewBasis(name, { basis: 'RECENT_N', recentN, month: kctx.month });

  clear(body);
  const choiceList = h('div', { class: 'kb-choice' });
  // モーダルを開いた時点で選択中なのは「現在保存されている基準」（design D5・spec: 「基準を選ぶと…」）。
  let selected = currentBasis.basis;
  let manualCycle = currentBasis.manual_cycle_days || (lastPreview.rate.cycleDays ? Math.round(lastPreview.rate.cycleDays) : 1);
  let manualAmount = currentBasis.manual_amount_yen || lastPreview.rate.amountYen || 0;
  const effect = h('div', { class: 'kb-effect' });

  function verdict(forecast) {
    return forecast.overYen > 0 ? { text: '▲ 上限超過', over: true } : { text: '上限内', over: false };
  }

  function renderEffect(rate, forecast) {
    clear(effect);
    effect.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k', text: 'この店の周期と金額' }), h('b', { text: rate.ratePerDay != null ? cycleText(rate.cycleDays, rate.amountYen) : '基準にできる記録がまだありません' })));
    const v = verdict(forecast);
    effect.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k', text: '今月の着地予想' }),
      h('span', {}, h('b', { text: fmtYen(forecast.landingYen) }), ' ', h('span', { class: v.over ? 'kb-over' : 'badge ok', style: { fontSize: '11px' }, text: v.text }))));
  }

  function optRow(kind, label, rate, forecast, extra) {
    const row = h('div', { class: `kb-opt${selected === kind ? ' on' : ''}` });
    row.appendChild(h('span', { class: 'radio' }));
    row.appendChild(h('span', {}, label, extra || null));
    row.appendChild(h('span', { class: 'res' }, rate.ratePerDay != null ? `${fmtYen(rate.ratePerDay)}/日` : '—', h('br'), `着地 ${fmtYen(forecast.landingYen)}`));
    row.addEventListener('click', () => { selected = kind; renderAll(); });
    return row;
  }

  async function renderAll() {
    clear(choiceList);
    choiceList.appendChild(optRow('LAST', '前回の値', lastPreview.rate, lastPreview.forecast));
    choiceList.appendChild(optRow('ALL_AVG', '全体の平均', allAvgPreview.rate, allAvgPreview.forecast));
    const nMinus = h('button', { type: 'button', text: '−' });
    const nPlus = h('button', { type: 'button', text: '＋' });
    const nVal = h('span', { class: 'v', text: `${recentN} 回` });
    nMinus.addEventListener('click', async (e) => { e.stopPropagation(); recentN = Math.max(1, recentN - 1); recentPreview = await api.kakeibo.previewBasis(name, { basis: 'RECENT_N', recentN, month: kctx.month }); selected = 'RECENT_N'; await renderAll(); });
    nPlus.addEventListener('click', async (e) => { e.stopPropagation(); recentN += 1; recentPreview = await api.kakeibo.previewBasis(name, { basis: 'RECENT_N', recentN, month: kctx.month }); selected = 'RECENT_N'; await renderAll(); });
    choiceList.appendChild(optRow('RECENT_N', '直近 ', recentPreview.rate, recentPreview.forecast, h('span', { class: 'row', style: { gap: '8px', display: 'inline-flex' } }, h('span', { class: 'kb-days' }, nMinus, nVal, nPlus), ' の平均')));
    const activeRate = selected === 'LAST' ? lastPreview.rate : selected === 'ALL_AVG' ? allAvgPreview.rate : selected === 'RECENT_N' ? recentPreview.rate : manualRate();
    const activeForecast = selected === 'LAST' ? lastPreview.forecast : selected === 'ALL_AVG' ? allAvgPreview.forecast : selected === 'RECENT_N' ? recentPreview.forecast : manualForecastCache;
    renderEffect(activeRate, activeForecast);
  }

  function manualRate() { return { ratePerDay: manualCycle > 0 ? Math.floor(manualAmount / manualCycle) : null }; }
  let manualForecastCache = lastPreview.forecast;
  async function refreshManual() {
    const r = await api.kakeibo.previewBasis(name, { basis: 'MANUAL', manualCycleDays: manualCycle, manualAmountYen: manualAmount, month: kctx.month });
    manualForecastCache = r.forecast;
    if (selected === 'MANUAL') renderEffect({ ratePerDay: r.rate.ratePerDay }, r.forecast);
  }

  await renderAll();
  body.appendChild(choiceList);

  const hist = h('div', { class: 'kb-hist-mini' });
  const rows = dayEdit.rows.filter((r) => r.name === name).slice(0, 6);
  for (const r of rows) {
    const rate = r.actual_days ? Math.floor(r.amount_yen / r.actual_days) : null;
    const cls = r.state === 'CONFIRMED' ? '' : r.state === 'PENDING' ? 'out' : '';
    const row = h('div', { class: cls },
      h('span', { text: fmtDayShort(r.day_key) }),
      h('span', { class: 'v', text: fmtYen(r.amount_yen) }),
      h('span', { text: r.actual_days ? `${r.actual_days}日` : `${r.state === 'PENDING' ? '未確定' : '進行中'}` }),
      h('span', { class: 'v', text: rate != null ? `${fmtYen(rate)}/日` : '—' }),
      h('span', { text: r.state === 'PENDING' ? '未確定なので除外' : '' }));
    hist.appendChild(row);
  }
  body.appendChild(hist);

  const cycleVal = h('span', { class: 'v', text: `${manualCycle} 日` });
  const cycleMinus = h('button', { type: 'button', text: '−' });
  const cyclePlus = h('button', { type: 'button', text: '＋' });
  const amountInput = h('input', { type: 'text', value: manualAmount.toLocaleString('ja-JP') });
  const rateLabel = h('b', { class: 'kb-amt', text: manualRate().ratePerDay != null ? `${fmtYen(manualRate().ratePerDay)}/日` : '—' });
  cycleMinus.addEventListener('click', async () => { manualCycle = Math.max(1, manualCycle - 1); cycleVal.textContent = `${manualCycle} 日`; selected = 'MANUAL'; rateLabel.textContent = manualRate().ratePerDay != null ? `${fmtYen(manualRate().ratePerDay)}/日` : '—'; await refreshManual(); await renderAll(); });
  cyclePlus.addEventListener('click', async () => { manualCycle += 1; cycleVal.textContent = `${manualCycle} 日`; selected = 'MANUAL'; rateLabel.textContent = manualRate().ratePerDay != null ? `${fmtYen(manualRate().ratePerDay)}/日` : '—'; await refreshManual(); await renderAll(); });
  amountInput.addEventListener('change', async () => { manualAmount = parseYen(amountInput.value); selected = 'MANUAL'; rateLabel.textContent = manualRate().ratePerDay != null ? `${fmtYen(manualRate().ratePerDay)}/日` : '—'; await refreshManual(); await renderAll(); });
  body.appendChild(h('div', { class: 'kb-manual' },
    h('span', { class: 'muted', text: '手動で指定' }),
    h('span', { class: 'kb-days' }, cycleMinus, cycleVal, cyclePlus),
    h('span', { class: 'muted', text: 'ごとに' }), amountInput, h('span', { class: 'muted', text: '円 →' }), rateLabel));

  body.appendChild(effect);

  const actions = h('div', { class: 'actions' });
  const cancel = h('button', { class: 'btn', type: 'button', text: 'キャンセル' });
  const confirm = h('button', { class: 'btn primary', type: 'button', text: 'これで予想する' });
  cancel.addEventListener('click', closeModal);
  confirm.addEventListener('click', async () => {
    await api.kakeibo.setBasis(name, { basis: selected, recentN: selected === 'RECENT_N' ? recentN : undefined, manualCycleDays: selected === 'MANUAL' ? manualCycle : undefined, manualAmountYen: selected === 'MANUAL' ? manualAmount : undefined });
    closeModal();
    await kctx.refresh();
  });
  actions.appendChild(cancel);
  actions.appendChild(confirm);
  body.appendChild(actions);
}

// =========================================================================
// レシートを開くモーダル（分析タブから利用）
// =========================================================================

export function openReceiptModal(entry) {
  const body = h('div', {});
  body.appendChild(h('div', { class: 'row', style: { gap: '8px' } },
    h('span', { class: 'kb-meta', text: fmtDayShort(entry.day_key) }),
    h('span', { class: 'kb-cat' }, h('i', { class: 'sw', style: { background: catVar(entry.category) } }), catLabel(entry.category)),
    entry.importance ? h('span', { class: 'row', style: { gap: '5px' } }, h('i', { class: `kb-imp ${entry.importance.toLowerCase()}` }), h('span', { style: { fontSize: '12.5px' }, text: impLabel(entry.importance) })) : null));
  body.appendChild(h('div', { class: 'kb-receipt-view' }, h('img', { src: `/api/kakeibo/receipts/${entry.receipt_id}`, alt: 'レシート' })));
  const actions = h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: '閉じる', onclick: closeModal }));
  body.appendChild(actions);
  openModal(body, `${entry.name || '内訳なし'} ${fmtYen(entry.amount_yen)}`);
}
