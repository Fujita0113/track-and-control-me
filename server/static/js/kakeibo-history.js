// 履歴サブタブ・支出のカバー期間の帯・日数の一括編集・未記録期間の一括入力（design D15）。
import { h, clear, openModal, closeModal, attachTooltip, toast, emptyState, addDays } from './util.js';
import { api } from './api.js';
import { isDemo } from './demo.js';
import { fmtYen, catVar, catLabel, impLabel, basisLabel, monthLabel, openConfirmModal } from './kakeibo.js';

function dayNum(dayKey) { return Number(dayKey.slice(8, 10)); }
function daysInMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function prevMonthKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function isFutureMonth(monthKey, todayDayKey) { return monthKey > todayDayKey.slice(0, 7); }
function weekday(dayKey) { const [y, m, d] = dayKey.split('-').map(Number); return ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }

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
// 履歴
// =========================================================================

export async function showHistoryView(body, kctx) {
  const data = await kctx.fetchHistory(kctx.month);
  clear(body);

  const headActions = [...monthNav(kctx)];
  if (!isDemo()) {
    const editBtn = h('button', { class: 'btn', type: 'button', text: '日数を一括編集' });
    editBtn.addEventListener('click', () => kctx.goto('edit'));
    const bulkBtn = h('button', { class: 'btn', type: 'button', text: '未記録期間を一括入力' });
    const bulkHint = h('span', { class: 'kb-hint' }, bulkBtn, h('span', { class: 'tip' }, 'つけ忘れた期間を1件で埋める ', h('span', { class: 'kb-k', text: 'Ctrl' }), h('span', { class: 'kb-k', text: 'M' })));
    attachTooltip(bulkBtn, { label: 'つけ忘れた期間を1件で埋める', keys: ['Ctrl', 'M'] });
    bulkBtn.addEventListener('click', () => openBulkEntryModal(kctx));
    headActions.push(editBtn, bulkHint);

    // Ctrl+M（入力中は無効・isTypingTarget 相当は util 側の isTypingTarget を使う）。
    const handler = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'm') return;
      e.preventDefault();
      openBulkEntryModal(kctx);
    };
    document.addEventListener('keydown', handler);
    body._kbCleanup = () => document.removeEventListener('keydown', handler);
  }

  body.appendChild(h('div', { class: 'section-head' }, h('h2', { text: monthLabel(kctx.month) }), h('div', { class: 'row' }, ...headActions)));

  body.appendChild(renderCoverageBand(kctx.month, data.coverage, kctx.todayDayKey));

  if (data.entries.length === 0) {
    body.appendChild(emptyState('この月の記録はまだありません'));
  } else {
    for (const e of data.entries) body.appendChild(renderHistRow(e, kctx));
  }
}

function renderHistRow(e, kctx) {
  const wait = e.state === 'PENDING';
  const row = h('div', { class: `kb-hist-row${wait ? ' wait' : ''}` });
  const isBulk = !!e.bulk_from;
  const nameNode = isBulk
    ? h('span', { class: 'nm' }, `${fmtMD(e.bulk_from)}–${fmtMD(e.bulk_to)} まとめ `, h('span', { class: 'badge', text: '内訳なし' }))
    : h('span', { class: 'nm', text: e.name });
  row.appendChild(h('span', { class: 'd', text: `${fmtMD(e.day_key)} ${weekday(e.day_key)}` }));
  row.appendChild(nameNode);
  row.appendChild(h('span', { class: 'amt', text: fmtYen(e.amount_yen) }));
  row.appendChild(h('span', { class: 'kb-cat' }, h('i', { class: 'sw', style: { background: catVar(isBulk ? 'NONE' : e.category) } }), isBulk ? '複数' : catLabel(e.category)));
  row.appendChild(h('i', { class: `kb-imp ${e.importance ? e.importance.toLowerCase() : 'nodetail'}`, title: impLabel(e.importance) }));
  if (wait) {
    const badge = h('span', { class: 'badge warn', text: `${daysSince(e, kctx.todayDayKey)}日目` });
    if (isDemo()) {
      row.appendChild(h('span', { class: 'row', style: { justifyContent: 'flex-end' } }, badge));
    } else {
      const confirmBtn = h('button', { class: 'btn small', type: 'button', text: '実績日数を確定' });
      confirmBtn.addEventListener('click', async () => {
        const pending = await api.kakeibo.pendingConfirmation(e.name, kctx.todayDayKey);
        if (!pending) { toast('確定できる記録がありません', 'err'); return; }
        openConfirmModal(pending, { standalone: true, onDone: () => kctx.refresh() });
      });
      row.appendChild(h('span', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } }, badge, confirmBtn));
    }
  } else {
    row.appendChild(h('span', { class: 'kb-dayscell', text: daysCellText(e) }));
  }
  return row;
}

function fmtMD(dayKey) { const [, m, d] = dayKey.split('-'); return `${Number(m)}/${Number(d)}`; }
function daysSince(e, todayDayKey) {
  const [y1, m1, d1] = e.covers_from.split('-').map(Number);
  const [y2, m2, d2] = todayDayKey.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;
}
function daysCellText(e) {
  if (e.bulk_from) return `${e.planned_days}日分`;
  if (e.planned_days <= 1) return e.planned_days === 1 ? '1日' : '—';
  if (e.actual_days) return `${e.planned_days}日 · 実績${e.actual_days}日`;
  return `${e.planned_days}日`;
}

// --- 支出のカバー期間の帯 ---------------------------------------------------

function renderCoverageBand(monthKey, coverage, todayDayKey) {
  const cols = daysInMonth(monthKey);
  const card = h('div', { class: 'kb-card', style: { marginBottom: '16px' } });
  const why = h('span', { class: 'kb-why' },
    h('button', { type: 'button', 'aria-label': '帯の読み方', text: '?' }),
    h('span', { class: 'pop' },
      '塗り潰し：実際にもった日数', h('br'),
      '点線枠：予定より早く使い切った期間', h('br'),
      '注意色の枠：予定期間を超えて継続中（実績未確定）', h('br'),
      'グレー斜線：内訳なしのまとめ登録', h('br'),
      '点：日数を持たない支出'));
  card.appendChild(h('div', { class: 'kb-head', style: { marginBottom: '8px' } }, h('span', { class: 't', text: '支出のカバー期間' }), why));

  const grid = h('div', { class: 'kb-band-grid', style: { '--cols': cols } });
  const ruler = h('div', { class: 'kb-ruler' });
  const todayN = monthKey === todayDayKey.slice(0, 7) ? dayNum(todayDayKey) : -1;
  for (let d = 1; d <= cols; d++) {
    const dayKey = `${monthKey}-${String(d).padStart(2, '0')}`;
    const isWeekend = weekday(dayKey) === '土' || weekday(dayKey) === '日';
    ruler.appendChild(h('span', { class: d === todayN ? 'today' : isWeekend ? 'we' : '', text: String(d) }));
  }
  grid.appendChild(ruler);

  const stockSpans = coverage.spans.filter((s) => s.lane === 'STOCK');
  const byCategory = new Map();
  for (const s of stockSpans) {
    const list = byCategory.get(s.category) || [];
    list.push(s);
    byCategory.set(s.category, list);
  }
  for (const [category, spans] of byCategory) {
    grid.appendChild(h('div', { class: 'kb-lane-label' }, h('i', { class: 'sw', style: { background: catVar(category) } }), catLabel(category)));
    const rows = assignRows(spans);
    const maxRow = Math.max(1, ...rows.map((r) => r.row));
    const lane = h('div', { class: `kb-lane${maxRow > 1 ? ' two' : ''}` });
    for (const { span: s, row } of rows) {
      const fromN = dayNum(s.fromDayKey); const toN = dayNum(s.toDayKey);
      lane.appendChild(h('div', {
        class: `kb-span ${category.toLowerCase()}`,
        style: { gridRow: row, gridColumn: `${fromN} / ${toN + 1}` },
        text: `${s.name} ${fmtYen(s.amountYen || 0)} · ${toN - fromN + 1}日もった`,
      }));
      if (s.ghostKind) {
        const gFromN = toN + 1; const gToN = dayNum(s.ghostToDayKey);
        lane.appendChild(h('div', {
          class: `kb-ghost${s.ghostKind === 'OVER' ? ' over' : ''}`,
          style: { gridRow: row, gridColumn: `${gFromN} / ${gToN + 1}` },
          text: s.ghostKind === 'OVER' ? `+${gToN - gFromN + 1}` : `−${gToN - gFromN + 1}`,
        }));
      }
    }
    grid.appendChild(lane);
  }

  const bulkSpans = coverage.spans.filter((s) => s.lane === 'BULK');
  if (bulkSpans.length) {
    grid.appendChild(h('div', { class: 'kb-lane-label' }, h('i', { class: 'sw', style: { background: catVar('NONE') } }), 'まとめ登録'));
    const lane = h('div', { class: 'kb-lane' });
    for (const s of bulkSpans) {
      const fromN = dayNum(s.fromDayKey); const toN = dayNum(s.toDayKey);
      lane.appendChild(h('div', { class: 'kb-span nodetail', style: { gridColumn: `${fromN} / ${toN + 1}` }, text: 'まとめ' }));
    }
    grid.appendChild(lane);
  }

  if (coverage.dots.length) {
    grid.appendChild(h('div', { class: 'kb-lane-label', text: 'その日限り' }));
    const lane = h('div', { class: 'kb-lane', style: { height: '20px' } });
    for (const d of coverage.dots) {
      const n = dayNum(d.dayKey);
      lane.appendChild(h('div', { class: 'kb-dot', style: { gridColumn: `${n} / ${n + 1}` } }, h('i', { class: d.category.toLowerCase() })));
    }
    grid.appendChild(lane);
  }

  if (todayN > 0) {
    grid.appendChild(h('div', { class: 'kb-today-line', style: { left: `calc(${(todayN - 1) * 100}% / ${cols})` } }));
  }

  card.appendChild(h('div', { class: 'kb-band' }, grid));
  return card;
}

/** 同じカテゴリ内で期間が重なる span を2行までのレーンへ振り分ける（design-notes: grid-row 明示）。 */
function assignRows(spans) {
  const sorted = [...spans].sort((a, b) => (a.fromDayKey < b.fromDayKey ? -1 : 1));
  const rowEnd = [null, null];
  const out = [];
  for (const s of sorted) {
    let row = 1;
    if (rowEnd[0] && s.fromDayKey <= rowEnd[0]) row = 2;
    rowEnd[row - 1] = s.ghostToDayKey || s.toDayKey;
    out.push({ span: s, row });
  }
  return out;
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

// =========================================================================
// 日数を一括編集
// =========================================================================

export async function showEditDaysView(body, kctx) {
  const data = await kctx.fetchDayEdit(kctx.month);
  clear(body);

  const backBtn = h('button', { class: 'btn small', type: 'button', text: '← 履歴へ戻る' });
  backBtn.addEventListener('click', () => kctx.goto('hist'));
  body.appendChild(h('div', { class: 'section-head' }, h('h2', { text: '日数を一括編集' }), h('div', { class: 'row' }, backBtn)));

  const card = h('div', { class: 'kb-card', style: { marginBottom: '12px', padding: '14px 16px' } });
  card.appendChild(h('div', { class: 'kb-edit-row head' },
    h('span', { text: '買った日' }), h('span', { text: '名称' }), h('span', { style: { textAlign: 'right' }, text: '金額' }),
    h('span', { style: { textAlign: 'center' }, text: '予定日数' }), h('span', { style: { textAlign: 'center' }, text: '実績日数' }),
    h('span', { style: { textAlign: 'right' }, text: '日単価' }), h('span', {})));

  for (const r of data.rows) card.appendChild(renderEditRow(r, kctx));
  body.appendChild(card);

  for (const s of data.summaries) body.appendChild(renderSummaryRow(s, kctx));
}

function renderEditRow(r, kctx) {
  const wait = r.state === 'PENDING';
  const row = h('div', { class: `kb-edit-row${wait ? ' wait' : ''}` });
  row.appendChild(h('span', { class: 'd', text: `${fmtMD(r.day_key)} ${weekday(r.day_key)}` }));
  row.appendChild(h('span', { class: 'nm', text: r.name }));
  row.appendChild(h('span', { class: 'amt', text: fmtYen(r.amount_yen) }));

  const plannedVal = h('span', { class: 'v', text: `${r.planned_days} 日` });
  const pm = h('button', { type: 'button', text: '−' }); const pp = h('button', { type: 'button', text: '＋' });
  const update = async (patch) => { await api.kakeibo.updateEntry(r.id, patch); await kctx.refresh(); };
  pm.addEventListener('click', () => update({ plannedDays: Math.max(0, r.planned_days - 1) }));
  pp.addEventListener('click', () => update({ plannedDays: r.planned_days + 1 }));
  row.appendChild(h('span', { class: 'kb-days' }, pm, plannedVal, pp));

  if (r.state === 'PROVISIONAL') {
    row.appendChild(h('span', { class: 'muted', style: { fontSize: '12px' }, text: `${daysSince(r, kctx.todayDayKey)}日目 · 進行中` }));
  } else {
    const actualVal = h('span', { class: `v${wait ? '' : ''}`, text: `${r.actual_days || 0} 日` });
    const am = h('button', { type: 'button', text: '−' }); const ap = h('button', { type: 'button', text: '＋' });
    am.addEventListener('click', () => update({ actualDays: Math.max(1, (r.actual_days || 1) - 1) }));
    ap.addEventListener('click', () => update({ actualDays: (r.actual_days || 0) + 1 }));
    row.appendChild(h('span', { class: `kb-days${wait ? ' wait' : ''}` }, am, actualVal, ap));
  }

  const rate = r.actual_days ? Math.floor(r.amount_yen / r.actual_days) : r.planned_days ? Math.floor(r.amount_yen / r.planned_days) : null;
  row.appendChild(h('span', { class: `unit${r.actual_days ? '' : ' tmp'}`, text: rate != null ? `${fmtYen(rate)}/日` : '—' }));
  const badgeClass = r.state === 'CONFIRMED' ? 'ok' : r.state === 'PENDING' ? 'warn' : '';
  const badgeText = r.state === 'CONFIRMED' ? '確定' : r.state === 'PENDING' ? '未確定' : '暫定';
  row.appendChild(h('span', { class: `badge ${badgeClass}`, text: badgeText }));
  return row;
}

function renderSummaryRow(s, kctx) {
  const changeBtn = h('button', { class: 'btn small', type: 'button', text: '予想の計算基準を変える' });
  changeBtn.addEventListener('click', async () => {
    const { openSourceModal } = await import('./kakeibo.js');
    openSourceModal(s.name, kctx);
  });
  return h('div', { class: 'kb-sum' },
    h('span', {}, s.name, h('span', { class: 'kb-meta', text: ` 前回 ${s.lastRate.ratePerDay != null ? fmtYen(s.lastRate.ratePerDay) + '/日' : '—'} · 全体の平均 ${s.allAvgRate.ratePerDay != null ? fmtYen(s.allAvgRate.ratePerDay) + '/日' : '—'}` })),
    h('span', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'badge accent', text: basisLabel(s.currentBasis) }), changeBtn));
}
