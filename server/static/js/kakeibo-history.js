// 履歴サブタブ・未記録期間の一括入力（design D15・D16）。
import { h, clear, openModal, closeModal, attachTooltip, toast, emptyState } from './util.js';
import { api } from './api.js';
import { isDemo } from './demo.js';
import { fmtYen, catVar, catLabel, impLabel, monthLabel, openDetailModal } from './kakeibo.js';

function prevMonthKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function isFutureMonth(monthKey, todayDayKey) { return monthKey > todayDayKey.slice(0, 7); }
function weekday(dayKey) { const [y, m, d] = dayKey.split('-').map(Number); return ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }
function fmtMD(dayKey) { const [, m, d] = dayKey.split('-'); return `${Number(m)}/${Number(d)}`; }

function monthNav(kctx) {
  // デモは固定シナリオ月のみ（月をまたぐと固定データと表示月がずれるため月送りを封じる）。
  const demo = isDemo();
  const prevBtn = h('button', { class: 'btn small', type: 'button', disabled: demo, text: `‹ ${monthLabel(prevMonthKey(kctx.month)).replace('年', '/').replace('月', '')}` });
  if (!demo) prevBtn.addEventListener('click', () => kctx.setMonth(prevMonthKey(kctx.month)));
  const nextKey = (() => { const [y, m] = kctx.month.split('-').map(Number); const d = new Date(Date.UTC(y, m, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; })();
  const nextDisabled = demo || isFutureMonth(nextKey, kctx.todayDayKey);
  const nextBtn = h('button', { class: 'btn small', type: 'button', text: `${monthLabel(nextKey).replace('年', '/').replace('月', '')} ›`, disabled: nextDisabled });
  if (!nextDisabled) nextBtn.addEventListener('click', () => kctx.setMonth(nextKey));
  return [prevBtn, nextBtn];
}

// =========================================================================
// 履歴（一覧だけ。グラフ・帯は置かない・spec: kakeibo-ledger）
// =========================================================================

export async function showHistoryView(body, kctx) {
  const data = await kctx.fetchHistory(kctx.month);
  clear(body);

  const headActions = [...monthNav(kctx)];
  if (!isDemo()) {
    const bulkBtn = h('button', { class: 'btn', type: 'button', text: '未記録期間を一括入力' });
    attachTooltip(bulkBtn, { label: 'つけ忘れた期間を1件で埋める', keys: ['Ctrl', 'M'] });
    bulkBtn.addEventListener('click', () => openBulkEntryModal(kctx));
    headActions.push(bulkBtn);

    const handler = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'm') return;
      e.preventDefault();
      openBulkEntryModal(kctx);
    };
    document.addEventListener('keydown', handler);
    body._kbCleanup = () => document.removeEventListener('keydown', handler);
  }

  body.appendChild(h('div', { class: 'section-head' }, h('h2', { text: monthLabel(kctx.month) }), h('div', { class: 'row' }, ...headActions)));

  if (data.entries.length === 0) {
    body.appendChild(emptyState('この月の記録はまだありません'));
  } else {
    for (const e of data.entries) body.appendChild(renderHistRow(e, kctx));
  }
}

function renderHistRow(e, kctx) {
  const isBulk = !!e.bulk_from;
  const openable = e.has_detail === true || (e.detail && e.detail.trim()) || e.receipt_id != null;
  const nameNode = isBulk
    ? h('span', { class: 'nm' }, `${fmtMD(e.bulk_from)}–${fmtMD(e.bulk_to)} まとめ `, h('span', { class: 'badge', text: '内訳未入力' }))
    : h('span', { class: 'nm', text: e.name });

  const marks = h('span', { class: 'marks' });
  const hasDetail = !!(e.detail && e.detail.trim());
  if (hasDetail) marks.appendChild(h('span', {}, '内訳 '));
  if (e.receipt_id != null) marks.appendChild(h('span', {}, 'レシート'));

  const main = h('button', {
    class: 'kb-hist-main', type: 'button', disabled: !openable,
  },
    h('span', { class: 'd', text: `${fmtMD(e.day_key)} ${weekday(e.day_key)}` }),
    nameNode,
    h('span', { class: 'amt', text: fmtYen(e.amount_yen) }),
    h('span', { class: 'kb-cat' }, h('i', { class: 'sw', style: { background: catVar(isBulk ? 'NONE' : e.category) } }), isBulk ? '複数' : catLabel(e.category)),
    h('i', { class: `kb-imp ${e.importance ? e.importance.toLowerCase() : 'nodetail'}`, title: impLabel(e.importance) }),
    marks);
  if (openable) {
    main.addEventListener('click', () => openDetailModal({ ...e, has_detail: hasDetail, has_receipt: e.receipt_id != null }, kctx));
  }

  const toggle = renderSpecialToggle(e, kctx);
  return h('div', { class: 'kb-hist-row' }, main, toggle);
}

/** 特別費の二択（design D16）。急な出費は自動＝操作不可・それ以外は押すと即座に保存される。 */
function renderSpecialToggle(e, kctx) {
  const auto = e.category === 'SUDDEN';
  const special = auto || e.is_special === 1;
  const toggle = h('span', { class: `kb-toggle${auto ? ' auto' : ''}` });
  const normalSeg = h('button', { class: `seg${!special ? ' on' : ''}`, type: 'button', disabled: auto || isDemo(), text: '通常の出費' });
  const specialSeg = h('button', { class: `seg${special ? ' on' : ''}`, type: 'button', disabled: auto || isDemo(), text: auto ? '特別費（自動）' : '特別費（除外）' });
  if (!auto && !isDemo()) {
    const set = async (isSpecial) => {
      await api.kakeibo.updateEntry(e.id, { isSpecial });
      await kctx.refresh();
    };
    normalSeg.addEventListener('click', () => set(false));
    specialSeg.addEventListener('click', () => set(true));
  }
  toggle.appendChild(normalSeg);
  toggle.appendChild(specialSeg);
  return toggle;
}

// =========================================================================
// 未記録期間の一括入力（Ctrl+M）
// =========================================================================

function openBulkEntryModal(kctx) {
  const body = h('div', {});
  const fromInput = h('input', { type: 'date', value: kctx.todayDayKey });
  const toInput = h('input', { type: 'date', value: kctx.todayDayKey });
  const amtInput = h('input', { type: 'text', placeholder: '0' });
  body.appendChild(h('div', { class: 'kb-field-row' }, h('span', { class: 'lbl', text: '期間' }), fromInput, h('span', { text: '〜' }), toInput));
  body.appendChild(h('div', { class: 'kb-field-row', style: { marginTop: '10px' } }, h('span', { class: 'lbl', text: '総額' }), h('span', { class: 'kb-amt-input', style: { position: 'relative', display: 'inline-block' } }, h('span', { class: 'yen', style: { position: 'absolute', left: '8px', top: '9px' }, text: '¥' }), amtInput)));
  const actions = h('div', { class: 'actions' });
  const cancel = h('button', { class: 'btn', type: 'button', text: 'キャンセル', onclick: closeModal });
  const save = h('button', { class: 'btn primary', type: 'button', text: '保存する' });
  save.addEventListener('click', async () => {
    const amountYen = Number(String(amtInput.value).replace(/[^\d.-]/g, ''));
    if (!fromInput.value || !toInput.value || !amountYen) { toast('期間と総額を入力してください', 'err'); return; }
    try {
      await api.kakeibo.createBulkEntry({ fromDayKey: fromInput.value, toDayKey: toInput.value, amountYen });
      closeModal();
      toast('保存しました', 'ok');
      await kctx.refresh();
    } catch (e) {
      toast(e.data && e.data.error ? e.data.error : `保存に失敗しました: ${e.message}`, 'err');
    }
  });
  actions.appendChild(cancel);
  actions.appendChild(save);
  body.appendChild(actions);
  openModal(body, '未記録期間を一括入力');
}
