// 予算サブタブ: 月の上限・固定費の予想・週の目標・毎月の予定出費（design D15・spec: kakeibo-budget）。
import { h, clear, toast } from './util.js';
import { api } from './api.js';
import { isDemo } from './demo.js';
import { fmtYen, monthLabel } from './kakeibo.js';

function parseYen(v) { return Number(String(v || '').replace(/[^\d.-]/g, '')) || 0; }

export async function showBudgetView(body, kctx) {
  const data = await kctx.fetchBudget(kctx.month);
  clear(body);

  body.appendChild(h('div', { class: 'section-head' }, h('h2', { text: `${monthLabel(kctx.month)}の予算` })));

  const grid = h('div', { class: 'kb-budget' });
  const leftStack = h('div', { class: 'stack', style: { gap: '16px' } });
  leftStack.appendChild(renderBudgetCard(data, kctx));
  leftStack.appendChild(renderPlannedExpensesCard(data.plannedExpenses, kctx));
  grid.appendChild(leftStack);
  grid.appendChild(renderFixedCostsCard(data.fixedCosts, kctx));
  body.appendChild(grid);
}

function renderBudgetCard(data, kctx) {
  const card = h('div', { class: 'kb-card' });
  card.appendChild(h('div', { class: 'kb-head', style: { marginBottom: '6px' } }, h('span', { class: 't', text: '今月の予算設定' })));

  const capInput = h('input', { type: 'text', disabled: isDemo(), value: data.budget.cap_yen ? data.budget.cap_yen.toLocaleString('ja-JP') : '' });
  capInput.addEventListener('change', async () => {
    await api.kakeibo.setBudget(kctx.month, { capYen: parseYen(capInput.value) });
    await kctx.refresh();
  });
  card.appendChild(h('div', { class: 'kb-brow' }, h('span', { class: 'lbl', text: '月の上限' }), h('span', {}, capInput)));
  card.appendChild(h('div', { class: 'kb-brow' }, h('span', { class: 'lbl' }, '固定費の予想', h('small', { text: '右の表の合計' })), h('span', { class: 'v muted', text: `− ${fmtYen(data.derived.fixedTotalYen)}` })));
  card.appendChild(h('div', { class: 'kb-out' }, h('span', { text: '変動費に使える' }), h('span', { class: 'v', text: fmtYen(data.derived.variableYen) })));
  card.appendChild(h('div', { class: 'kb-out', style: { background: 'var(--panel-2)', borderColor: 'var(--line)' } },
    h('span', {}, '週の目標', h('small', { class: 'kb-meta', style: { display: 'block' }, text: `${fmtYen(data.derived.variableYen)} ÷ ${data.derived.daysInMonth}日 × 7日` })),
    h('span', { class: 'v', style: { color: 'var(--text)' }, text: fmtYen(data.derived.weeklyTargetYen) })));

  const wasteInput = h('input', { type: 'text', disabled: isDemo(), value: data.budget.waste_cap_yen ? data.budget.waste_cap_yen.toLocaleString('ja-JP') : '' });
  wasteInput.addEventListener('change', async () => {
    await api.kakeibo.setBudget(kctx.month, { wasteCapYen: parseYen(wasteInput.value) });
    await kctx.refresh();
  });
  card.appendChild(h('div', { class: 'kb-brow', style: { marginTop: '8px' } }, h('span', { class: 'lbl' }, 'いらないの上限', h('small', { text: '超えるとホームで知らせる' })), h('span', {}, wasteInput)));
  return card;
}

function renderPlannedExpensesCard(items, kctx) {
  const card = h('div', { class: 'kb-card' });
  card.appendChild(h('div', { class: 'kb-head', style: { marginBottom: '6px' } }, h('span', { class: 't', text: '毎月の予定出費' }), h('span', { class: 'kb-meta', text: '予想にだけ入る' })));
  for (const p of items) {
    const input = h('input', { type: 'text', disabled: isDemo(), value: p.amount_yen.toLocaleString('ja-JP') });
    input.addEventListener('change', async () => {
      await api.kakeibo.updatePlannedExpense(p.id, { name: p.name, category: p.category, cycleDays: p.cycle_days, nextDayKey: p.next_day_key, amountYen: parseYen(input.value) });
      await kctx.refresh();
    });
    card.appendChild(h('div', { class: 'kb-brow' },
      h('span', { class: 'lbl' }, p.name, h('small', { text: `${p.cycle_days}日ごと · 次は ${fmtMD(p.next_day_key)}` })),
      h('span', {}, input)));
  }
  if (!isDemo()) {
    const addRow = h('div', {});
    const addBtn = h('button', { class: 'btn small', type: 'button', text: '＋ 予約を追加' });
    addBtn.addEventListener('click', () => { clear(addRow); addRow.appendChild(renderAddPlannedForm(kctx)); });
    card.appendChild(h('div', { class: 'row', style: { marginTop: '12px' } }, addBtn, h('span', { class: 'kb-meta', text: '記録すると実際の金額に置き換わる' })));
    card.appendChild(addRow);
  }
  return card;
}

function renderAddPlannedForm(kctx) {
  const nameInput = h('input', { type: 'text', placeholder: '名称' });
  const cycleInput = h('input', { type: 'text', placeholder: '周期(日)', style: { width: '70px' } });
  const nextInput = h('input', { type: 'date', value: kctx.todayDayKey });
  const amountInput = h('input', { type: 'text', placeholder: '目安金額' });
  const saveBtn = h('button', { class: 'btn small primary', type: 'button', text: '追加' });
  saveBtn.addEventListener('click', async () => {
    if (!nameInput.value.trim() || !cycleInput.value) { toast('名称と周期を入力してください', 'err'); return; }
    try {
      await api.kakeibo.createPlannedExpense({ name: nameInput.value.trim(), category: 'SUDDEN', cycleDays: Number(cycleInput.value), nextDayKey: nextInput.value, amountYen: parseYen(amountInput.value) });
      await kctx.refresh();
    } catch (e) { toast(e.data && e.data.error ? e.data.error : `追加に失敗しました: ${e.message}`, 'err'); }
  });
  return h('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, nameInput, cycleInput, nextInput, amountInput, saveBtn);
}

function renderFixedCostsCard(rows, kctx) {
  const card = h('div', { class: 'kb-card' });
  card.appendChild(h('div', { class: 'kb-head', style: { marginBottom: '6px' } }, h('span', { class: 't', text: '固定費の予想' }), h('span', { class: 'kb-meta', text: '前月の実績から' })));
  let total = 0;
  for (const r of rows) {
    total += r.amount_yen;
    const input = h('input', { type: 'text', disabled: isDemo(), value: r.amount_yen.toLocaleString('ja-JP') });
    input.addEventListener('change', async () => {
      await api.kakeibo.updateFixedCost(r.id, { amountYen: parseYen(input.value) });
      await kctx.refresh();
    });
    card.appendChild(h('div', { class: 'kb-brow' },
      h('span', { class: 'lbl' }, r.name, r.prev_amount_yen != null ? h('small', { text: `前月 ${r.prev_amount_yen.toLocaleString('ja-JP')}` }) : null),
      h('span', {}, input)));
  }
  card.appendChild(h('div', { class: 'kb-brow' }, h('span', { class: 'lbl', style: { fontWeight: '650' }, text: '合計' }), h('span', { class: 'v', text: fmtYen(total) })));

  if (!isDemo()) {
    const addRow = h('div', {});
    const addBtn = h('button', { class: 'btn small', type: 'button', text: '＋ 固定費を追加' });
    addBtn.addEventListener('click', () => { clear(addRow); addRow.appendChild(renderAddFixedCostForm(kctx)); });
    const importBtn = h('button', { class: 'btn small', type: 'button', text: '前月から取り込む' });
    importBtn.addEventListener('click', async () => {
      await api.kakeibo.importFixedCosts(kctx.month);
      toast('前月の固定費を取り込みました', 'ok');
      await kctx.refresh();
    });
    card.appendChild(h('div', { class: 'row', style: { marginTop: '12px' } }, addBtn, importBtn));
    card.appendChild(addRow);
  }
  return card;
}

function renderAddFixedCostForm(kctx) {
  const nameInput = h('input', { type: 'text', placeholder: '名称' });
  const amountInput = h('input', { type: 'text', placeholder: '金額' });
  const saveBtn = h('button', { class: 'btn small primary', type: 'button', text: '追加' });
  saveBtn.addEventListener('click', async () => {
    if (!nameInput.value.trim()) { toast('名称を入力してください', 'err'); return; }
    await api.kakeibo.upsertFixedCost(kctx.month, { name: nameInput.value.trim(), amountYen: parseYen(amountInput.value) });
    await kctx.refresh();
  });
  return h('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, nameInput, amountInput, saveBtn);
}

function fmtMD(dayKey) { const [, m, d] = dayKey.split('-'); return `${Number(m)}/${Number(d)}`; }
