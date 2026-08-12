// 分析サブタブ: 重要度の帯 + カテゴリ→名称→明細の3段ドリル（design D15・spec: kakeibo-analysis）。
import { h, clear, emptyState } from './util.js';
import { isDemo } from './demo.js';
import { fmtYen, catVar, catLabel, monthLabel, openDetailModal } from './kakeibo.js';

function prevMonthKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function isFutureMonth(monthKey, todayDayKey) { return monthKey > todayDayKey.slice(0, 7); }

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

function fmtMD(dayKey) { const [, m, d] = dayKey.split('-'); return `${Number(m)}/${Number(d)}`; }

export async function showAnalysisView(body, kctx) {
  const data = await kctx.fetchAnalysis(kctx.month);
  clear(body);

  body.appendChild(h('div', { class: 'section-head' }, h('h2', { text: monthLabel(kctx.month) }), h('div', { class: 'row' }, ...monthNav(kctx))));

  body.appendChild(renderImportanceCard(data.importance));
  body.appendChild(renderTreeCard(data.tree, kctx));
}

function renderImportanceCard(imp) {
  const card = h('div', { class: 'kb-card', style: { marginBottom: '16px' } });
  card.appendChild(h('div', { class: 'kb-head', style: { marginBottom: '10px' } }, h('span', { class: 't', text: '重要度' }), h('span', { class: 'kb-meta', text: `変動費の合計 ${fmtYen(imp.totalYen)}` })));
  if (imp.totalYen === 0) {
    card.appendChild(emptyState('この月の記録はまだありません'));
    return card;
  }
  const stack = h('div', {
    class: 'kb-stack', role: 'img',
    'aria-label': `必須 ${imp.must.amountYen}円 ${imp.must.pct}%、準必須 ${imp.semi.amountYen}円 ${imp.semi.pct}%、無駄遣い ${imp.waste.amountYen}円 ${imp.waste.pct}%、内訳未入力 ${imp.noDetail.amountYen}円 ${imp.noDetail.pct}%`,
  });
  stack.appendChild(h('span', { class: 'must', style: { flex: Math.max(imp.must.pct, 0.1) }, text: `必須 ${imp.must.pct}%` }));
  stack.appendChild(h('span', { class: 'semi', style: { flex: Math.max(imp.semi.pct, 0.1) }, text: `${imp.semi.pct}%` }));
  stack.appendChild(h('span', { class: 'none', style: { flex: Math.max(imp.waste.pct, 0.1) }, text: `無駄遣い ${imp.waste.pct}%` }));
  stack.appendChild(h('span', { class: 'nodetail', style: { flex: Math.max(imp.noDetail.pct, 0.1) }, text: `内訳未入力 ${imp.noDetail.pct}%` }));
  card.appendChild(stack);
  card.appendChild(h('div', { class: 'kb-stack-foot' },
    h('span', {}, h('i', { class: 'kb-imp must', style: { verticalAlign: '-1px' } }), ' 必須 ', h('b', { text: fmtYen(imp.must.amountYen) })),
    h('span', {}, h('i', { class: 'kb-imp semi', style: { verticalAlign: '-1px' } }), ' 準必須 ', h('b', { text: fmtYen(imp.semi.amountYen) })),
    h('span', {}, h('i', { class: 'kb-imp none', style: { verticalAlign: '-1px' } }), ' 無駄遣い ', h('b', { text: fmtYen(imp.waste.amountYen) })),
    h('span', {}, h('i', { class: 'kb-imp nodetail', style: { verticalAlign: '-1px' } }), ' 内訳未入力 ', h('b', { text: fmtYen(imp.noDetail.amountYen) }))));
  return card;
}

function renderTreeCard(tree, kctx) {
  const card = h('div', { class: 'kb-card' });
  card.appendChild(h('div', { class: 'kb-head', style: { marginBottom: '6px' } },
    h('span', { class: 't', text: 'カテゴリ → 名称 → 明細' }),
    h('span', { class: 'kb-meta', text: '% は一段上に対する割合 · 明細を押すと内訳・レシート' })));

  if (tree.length === 0) {
    card.appendChild(emptyState('この月の記録はまだありません'));
    return card;
  }

  const treeEl = h('div', { class: 'kb-tree' });
  for (const c of tree) {
    treeEl.appendChild(h('div', { class: 'kb-node lv1' },
      h('span', { class: 'chev' }), h('span', { class: 'nm' }, h('i', { class: 'sw', style: { background: catVar(c.category) } }), catLabel(c.category)),
      h('span', { class: 'track' }, h('i', { style: { width: `${c.pct}%`, background: catVar(c.category) } })),
      h('span', { class: 'v', text: fmtYen(c.amountYen) }), h('span', { class: 'p', text: `${c.pct}%` })));

    for (const n of c.names) {
      const chev = h('span', { class: 'chev', text: '▶' });
      const nameBtn = h('button', { class: 'kb-node lv2 clickable', type: 'button' },
        chev, h('span', { class: 'nm', text: n.name || '名称なし' }),
        h('span', { class: 'track' }, h('i', { style: { width: `${n.pct}%`, background: catVar(c.category) } })),
        h('span', { class: 'v', text: fmtYen(n.amountYen) }), h('span', { class: 'p', text: `${n.pct}%` }));
      const kids = h('div', { class: 'kb-kids' });
      nameBtn.addEventListener('click', () => { chev.textContent = kids.classList.toggle('open') ? '▼' : '▶'; });
      treeEl.appendChild(nameBtn);

      for (const e of n.entries) {
        const openable = e.has_detail || e.has_receipt;
        const marks = h('span', { class: 'marks' });
        if (e.has_detail) marks.appendChild(h('span', {}, '内訳 '));
        if (e.has_receipt) marks.appendChild(h('span', {}, 'レシート'));
        const leaf = h('button', { class: 'kb-leaf', type: 'button', disabled: !openable },
          h('span', {}), h('span', { class: 'd', text: fmtMD(e.day_key) }), h('span', { text: n.name || '（内訳未入力）' }),
          h('i', { class: `kb-imp ${e.importance ? e.importance.toLowerCase() : 'nodetail'}`, title: e.importance || '内訳未入力' }),
          marks,
          h('span', { class: 'v', text: fmtYen(e.amount_yen) }));
        if (openable) leaf.addEventListener('click', () => openDetailModal({ ...e, category: c.category, name: n.name || e.name }, kctx));
        kids.appendChild(leaf);
      }
      treeEl.appendChild(kids);
    }
  }
  card.appendChild(treeEl);
  return card;
}
