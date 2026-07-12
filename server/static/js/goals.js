// 目標（30日チャレンジ）タブ: 一覧・新規作成・完了レポート
//  (spec: goal-challenge / goal-report). 合否・スコアの語や演出は出さない（「完走」のみ）。
//  スタイルは gr-* クラス + CSSOM（CSP: インライン style 属性なし）。② は同梱 Chart.js。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, openModal, closeModal, emptyState, fmtHM } from './util.js';
import { planningSignalLabel } from './targets.js';
import { renderMarkdown } from './markdown.js';
import { isDemo } from './demo.js';

// デモ中は取得先を /api/demo/* + 仮想日付へ切替（通常モードは既存経路のまま）。
function fetchGoals() {
  return isDemo() ? api.demo.goals(state.demo.virtualDay).then((r) => r.goals) : api.getGoals();
}
function fetchReport(id) {
  return isDemo() ? api.demo.report(id, state.demo.virtualDay) : api.getGoalReport(id);
}

let charts = [];
function destroyCharts() {
  for (const c of charts) {
    try { c.destroy(); } catch { /* noop */ }
  }
  charts = [];
}

export function hide() {
  destroyCharts();
}

export async function show(root) {
  destroyCharts();
  await renderList(root);
}

// --- 実践ラベル（PLANNING は signal_key を日本語化）---------------------
function niceLabel(target, conditionKey, fallback) {
  if (target === 'PLANNING' && String(conditionKey).startsWith('planning:')) {
    return planningSignalLabel(conditionKey.slice('planning:'.length));
  }
  return fallback || conditionKey;
}

// --- 一覧 -----------------------------------------------------------------
async function renderList(root) {
  clear(root);
  destroyCharts();

  // デモは閲覧専用（追加ボタンを出さない・spec: 閲覧専用）。
  const headRow = h('div', { class: 'row' });
  if (!isDemo()) {
    const newBtn = h('button', { class: 'btn primary', text: '＋ 新しい目標', type: 'button' });
    newBtn.addEventListener('click', () => openCreateForm(() => renderList(root)));
    headRow.appendChild(newBtn);
  }
  root.appendChild(h('div', { class: 'section-head' },
    h('h2', {}, '目標', h('span', { class: 'muted', style: { fontSize: '13px', fontWeight: '400' }, text: isDemo() ? '30日チャレンジ（デモ・閲覧専用）' : '30日チャレンジ' })),
    headRow,
  ));

  const body = h('div', { class: 'stack' });
  root.appendChild(body);
  body.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));

  let goals = [];
  try { goals = await fetchGoals(); } catch (e) { clear(body); body.appendChild(emptyState(`読み込み失敗: ${e.message}`)); return; }
  clear(body);

  if (!goals.length) {
    body.appendChild(emptyState(isDemo()
      ? 'サンプルを読み込めませんでした。設定タブで「サンプルをリセット」をお試しください。'
      : 'まだ目標がありません。「＋ 新しい目標」から、翌日の実効ルールの実践を採用して30日チャレンジを始められます。'));
    return;
  }

  const active = goals.filter((g) => g.status === 'active');
  const upcoming = goals.filter((g) => g.status === 'upcoming');
  const completed = goals.filter((g) => g.status === 'completed');

  if (active.length) body.appendChild(goalGroup('進行中', active, root));
  if (upcoming.length) body.appendChild(goalGroup('開始前', upcoming, root));
  if (completed.length) body.appendChild(goalGroup('完走', completed, root));
}

function goalGroup(title, goals, root) {
  const wrap = h('div', { class: 'stack' });
  wrap.appendChild(h('div', { class: 'card-title', style: { marginTop: '6px' }, text: title }));
  for (const g of goals) wrap.appendChild(goalCard(g, root));
  return wrap;
}

function goalCard(g, root) {
  const card = h('div', { class: 'card gr-goal-card' });

  const meta = h('div', { class: 'gr-goal-meta' });
  if (g.status === 'active') meta.appendChild(h('span', { class: 'badge accent', text: `Day ${g.dayNumber}/${g.dayCount}` }));
  else if (g.status === 'upcoming') meta.appendChild(h('span', { class: 'badge', text: `${g.startDay} 開始` }));
  else meta.appendChild(h('span', { class: 'badge ok', text: '完走' }));

  const head = h('div', { class: 'row' },
    h('h3', { text: g.name }),
    meta,
    h('div', { class: 'spacer' }),
  );

  if (g.status === 'completed') {
    const openBtn = h('button', { class: 'btn small primary', text: 'レポートを開く', type: 'button' });
    openBtn.addEventListener('click', () => renderReport(root, g.id));
    head.appendChild(openBtn);
  } else if (!isDemo() && g.canDelete) {
    // デモは閲覧専用（削除手段を出さない・spec: 閲覧専用）。
    const del = h('button', { class: 'btn small danger', text: '削除', type: 'button' });
    del.addEventListener('click', async () => {
      if (!confirm(`「${g.name}」を削除しますか？（作成当日のみ可能）`)) return;
      try { await api.deleteGoal(g.id); toast('削除しました', 'ok'); renderList(root); }
      catch (err) { toast(err.status === 409 ? '作成当日以外は削除できません' : `失敗: ${err.message}`, 'err'); }
    });
    head.appendChild(del);
  }
  card.appendChild(head);

  if (g.purpose) card.appendChild(h('p', { class: 'muted gr-purpose', text: g.purpose }));
  card.appendChild(h('div', { class: 'period muted', text: `${g.startDay} 〜 ${g.endDay}` }));

  const chips = h('div', { class: 'gr-chips' });
  for (const p of g.practices) chips.appendChild(h('span', { class: 'gr-chip', text: niceLabel(p.target, p.conditionKey, p.label) }));
  card.appendChild(chips);
  return card;
}

// --- 新規作成フォーム -----------------------------------------------------
async function openCreateForm(onDone) {
  const body = h('div', { class: 'modal-body stack' });
  body.appendChild(h('p', { class: 'muted', text: '目標は翌日から30日間の固定期間で始まります。採用した実践は期間中ジャンル固定になります（閾値の変更は理由つきで可能）。' }));

  const nameInp = h('input', { type: 'text', class: 'gr-input', placeholder: '目標名（例: メンタルを安定させる）' });
  const purposeInp = h('input', { type: 'text', class: 'gr-input', placeholder: '目的の一文（任意）' });
  body.appendChild(h('label', { class: 'gr-flabel', text: '目標名' }));
  body.appendChild(nameInp);
  body.appendChild(h('label', { class: 'gr-flabel', text: '目的' }));
  body.appendChild(purposeInp);

  body.appendChild(h('label', { class: 'gr-flabel', text: '採用する実践（翌日の実効ルールから）' }));
  const candHost = h('div', { class: 'list' });
  body.appendChild(candHost);
  candHost.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));

  let candidates = [];
  try { candidates = await api.getGoalCandidates(); } catch { candidates = []; }
  clear(candHost);
  if (!candidates.length) {
    candHost.appendChild(emptyState('翌日の実効ルールに採用できる実践がありません。先に「今日」タブでルールを作成してください。'));
  } else {
    for (const c of candidates) {
      const box = h('input', { type: 'checkbox', value: c.conditionKey });
      const label = niceLabel(c.target, c.conditionKey, c.label);
      const sub = (c.target === 'TOTAL_WORK' || c.target === 'GROUP') && c.thresholdSeconds
        ? `　≥ ${fmtHM(c.thresholdSeconds)}` : '';
      candHost.appendChild(h('label', { class: 'cond' },
        box,
        h('div', { class: 'cond-main' }, h('div', { class: 'cond-title', text: label + sub })),
      ));
    }
  }

  // --- その場で作る習慣（新規 TIMELINE 条件）を採用する（D5）--------------
  // 既存候補の採用に加え、カテゴリ＋分数で新規条件を作り、作成時に翌日ルールへ追記して採用する。
  body.appendChild(h('label', { class: 'gr-flabel', text: 'その場で作る習慣（タイムライン記録）' }));
  body.appendChild(h('p', { class: 'muted', style: { fontSize: '12px', margin: '0' }, text: 'まだルールに無いカテゴリを「◯分以上」の習慣として追加します。作成すると翌日のルールに加わり、この目標に採用されます。' }));

  const newRows = []; // { label, minutes }
  const newHost = h('div', { class: 'stack gr-newconds' });

  // カテゴリ補完用 datalist（GET /api/categories・自由入力可）。
  const catListId = 'goal-new-cat-list';
  const datalist = h('datalist', { id: catListId });
  api.getCategories().then((rows) => {
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (r && r.name) datalist.appendChild(h('option', { value: r.name }));
    }
  }).catch(() => { /* 補完が無くても自由入力できる */ });

  const renderNewRows = () => {
    clear(newHost);
    newRows.forEach((r, i) => {
      const rm = h('button', { class: 'btn small', text: '削除', type: 'button' });
      rm.addEventListener('click', () => { newRows.splice(i, 1); renderNewRows(); });
      newHost.appendChild(h('div', { class: 'gr-newcond-row' },
        h('span', { class: 'gr-newcond-badge', text: 'これから作成' }),
        h('span', { class: 'gr-newcond-text', text: `${r.label} ${r.minutes}分以上` }),
        h('div', { class: 'spacer' }),
        rm,
      ));
    });
  };

  const catInp = h('input', { type: 'text', class: 'gr-input', placeholder: 'カテゴリ（例: 掃除）', list: catListId });
  const minInp = h('input', { type: 'number', class: 'gr-input gr-min-input', placeholder: '分', min: '1', step: '1' });
  const addBtn = h('button', { class: 'btn', text: '＋ 習慣を追加', type: 'button' });
  const addNewRow = () => {
    const label = catInp.value.trim();
    const minutes = Math.floor(Number(minInp.value));
    if (!label) { toast('カテゴリ名を入力してください', 'err'); return; }
    if (!(minutes > 0)) { toast('分数は1以上で入力してください', 'err'); return; }
    newRows.push({ label, minutes });
    catInp.value = ''; minInp.value = '';
    renderNewRows();
    catInp.focus();
  };
  addBtn.addEventListener('click', addNewRow);
  // 分数欄で Enter 追加（IME 変換確定の Enter は無視）。
  minInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addNewRow(); }
  });
  body.appendChild(h('div', { class: 'gr-newcond-form' }, catInp, minInp, addBtn));
  body.appendChild(datalist);
  body.appendChild(newHost);

  const save = h('button', { class: 'btn primary', text: '作成', type: 'button' });
  save.addEventListener('click', async () => {
    const name = nameInp.value.trim();
    if (!name) { toast('目標名を入力してください', 'err'); return; }
    const practices = [...candHost.querySelectorAll('input[type="checkbox"]:checked')].map((b) => b.value);
    const newConditions = newRows.map((r) => ({ target: 'TIMELINE', label: r.label, thresholdSeconds: r.minutes * 60 }));
    if (!practices.length && !newConditions.length) { toast('実践を1つ以上選ぶか、習慣を追加してください', 'err'); return; }
    save.disabled = true;
    try {
      await api.createGoal({ name, purpose: purposeInp.value.trim(), practices, newConditions });
      toast('目標を作成しました', 'ok');
      closeModal();
      onDone();
    } catch (err) {
      // 400（バリデーション・閾値理由）／409（ジャンル固定・凍結）をそのままトースト表示。
      toast(err.data?.error || `失敗: ${err.message}`, 'err');
      save.disabled = false;
    }
  });
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', text: 'キャンセル', type: 'button', onclick: closeModal }),
    save,
  ));
  openModal(body, '新しい目標');
}

// --- 完了レポート（ヘッダ + 4ブロック・1カラム）-------------------------
async function renderReport(root, goalId) {
  clear(root);
  destroyCharts();
  root.appendChild(h('div', { class: 'empty', text: 'レポートを読み込み中…' }));

  let rep;
  try { rep = await fetchReport(goalId); }
  catch (err) { clear(root); root.appendChild(emptyState(`レポートを開けません: ${err.data?.error || err.message}`)); backLink(root); return; }
  clear(root);

  const page = h('div', { class: 'gr-report' });
  root.appendChild(page);

  const back = h('button', { class: 'gr-back', type: 'button', text: '← 目標一覧へ' });
  back.addEventListener('click', () => renderList(root));
  page.appendChild(back);

  // ヘッダ
  page.appendChild(h('header', { class: 'gr-header' },
    h('div', { class: 'gr-eyebrow', text: '完走' }),
    h('h1', { class: 'gr-h1', text: rep.goal.name }),
    rep.goal.purpose ? h('p', { class: 'gr-purpose-line', text: rep.goal.purpose }) : null,
    h('div', { class: 'gr-header-meta' },
      h('span', { text: `${rep.goal.startDay} 〜 ${rep.goal.endDay}` }),
      h('span', { class: 'gr-dot', text: '·' }),
      h('span', { class: 'gr-achieved', text: `達成 ${rep.goal.achievedDays}/${rep.goal.dayCount}` }),
    ),
  ));

  // 読み手状態（④ で使う。①のマス/日付セレクタから連動）。
  const readerState = { selected: 1, cellsByDay: new Map(), headerByDay: new Map(), renderReader: null };

  // ① 達成カレンダー
  page.appendChild(blockCalendar(rep, readerState));
  // ② 時間の推移（時間型実践がある場合のみ）
  if (rep.hasTimeType) page.appendChild(blockTimeSeries(rep));
  // ③ Before / After
  page.appendChild(blockBeforeAfter(rep));
  // ④ 日記リーダー
  page.appendChild(blockReader(rep, readerState));

  readerState.renderReader();
}

function backLink(root) {
  const back = h('button', { class: 'gr-back', type: 'button', text: '← 目標一覧へ' });
  back.addEventListener('click', () => renderList(root));
  root.appendChild(back);
}

function grCard(title) {
  const card = h('section', { class: 'gr-card' });
  card.appendChild(h('h2', { class: 'gr-block-title', text: title }));
  return card;
}

// ① 30日 × 実践の達成カレンダー
function blockCalendar(rep, rs) {
  const card = grCard('① 達成カレンダー');
  const scroll = h('div', { class: 'gr-cal-scroll' });
  const grid = h('div', { class: 'gr-cal' });
  grid.style.gridTemplateColumns = `minmax(92px, 132px) repeat(${rep.goal.dayCount}, 17px)`;

  // ヘッダ行（空 + Day 番号）
  grid.appendChild(h('div', { class: 'gr-cal-corner' }));
  for (let d = 1; d <= rep.goal.dayCount; d++) {
    const head = h('div', { class: 'gr-cal-dh', text: String(d) });
    head.addEventListener('click', () => rs.renderReader(d));
    rs.headerByDay.set(d, head);
    grid.appendChild(head);
  }

  // 実践ごとの行
  for (const p of rep.practices) {
    grid.appendChild(h('div', { class: 'gr-cal-label', text: niceLabel(p.target, p.conditionKey, p.label), title: p.label }));
    for (const cell of p.cells) {
      const el = h('button', {
        class: `gr-cell ${cell.met ? 'done' : 'miss'}`,
        type: 'button',
        title: `Day ${cell.dayNumber}: ${cell.met ? 'やった' : 'やってない'}`,
      });
      el.addEventListener('click', () => rs.renderReader(cell.dayNumber));
      if (!rs.cellsByDay.has(cell.dayNumber)) rs.cellsByDay.set(cell.dayNumber, []);
      rs.cellsByDay.get(cell.dayNumber).push(el);
      grid.appendChild(el);
    }
  }
  scroll.appendChild(grid);
  card.appendChild(scroll);
  card.appendChild(h('div', { class: 'gr-legend' },
    h('span', {}, h('span', { class: 'gr-cell done gr-legend-swatch' }), 'やった'),
    h('span', {}, h('span', { class: 'gr-cell miss gr-legend-swatch' }), 'やってない'),
  ));
  return card;
}

// ② 時間型実践の実測と閾値の推移（＋理由マーカー）
function blockTimeSeries(rep) {
  const card = grCard('② 時間の推移');
  const timePractices = rep.practices.filter((p) => p.isTimeType);
  for (const p of timePractices) {
    const sub = h('div', { class: 'gr-ts' });
    sub.appendChild(h('div', { class: 'gr-ts-label', text: niceLabel(p.target, p.conditionKey, p.label) }));
    const canvas = h('canvas', {});
    sub.appendChild(h('div', { class: 'gr-chart-wrap' }, canvas));

    const labels = p.cells.map((c) => c.dayNumber);
    const actualMin = p.cells.map((c) => (c.actualSeconds == null ? null : Math.round(c.actualSeconds / 60)));
    const threshMin = p.cells.map((c) => (c.thresholdSeconds == null ? null : Math.round(c.thresholdSeconds / 60)));
    charts.push(new window.Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '実測', data: actualMin, borderColor: '#3b5bb5', backgroundColor: 'rgba(59,91,181,0.10)', fill: true, tension: 0.25, pointRadius: 2, spanGaps: false },
          { label: '閾値', data: threshMin, borderColor: '#b06000', borderDash: [5, 4], stepped: true, pointRadius: 0, spanGaps: true },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false }, title: { display: true, text: 'Day' } },
          y: { beginAtZero: true, ticks: { callback: (v) => `${Math.round(v / 60)}h` } },
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? '—' : fmtHM(ctx.parsed.y * 60)}` } },
        },
      },
    }));

    // 閾値変更マーカー（「下げて、続けた」という事実。否定的な装飾はしない）。
    const changes = rep.thresholdChanges.filter((t) => t.conditionKey === p.conditionKey);
    for (const t of changes) {
      sub.appendChild(h('div', { class: 'gr-marker' },
        h('span', { class: 'gr-marker-day', text: `Day ${t.dayNumber}` }),
        h('span', { class: 'gr-marker-delta', text: `${t.oldSeconds == null ? '—' : fmtHM(t.oldSeconds)} → ${t.newSeconds == null ? '—' : fmtHM(t.newSeconds)}` }),
        h('span', { class: 'gr-marker-reason', text: t.reason }),
      ));
    }
    card.appendChild(sub);
  }
  return card;
}

// ③ Before / After（Day1 / Day30 の文面並置）
function blockBeforeAfter(rep) {
  const card = grCard('③ Before / After');
  const first = rep.days[0];
  const last = rep.days[rep.days.length - 1];
  card.appendChild(h('div', { class: 'gr-ba' },
    baCol('Before', first),
    baCol('After', last),
  ));
  return card;
}

function baCol(tag, day) {
  const col = h('div', { class: 'gr-ba-col' });
  col.appendChild(h('div', { class: 'gr-ba-head' },
    h('span', { class: 'gr-ba-tag', text: tag }),
    h('span', { class: 'gr-ba-day', text: day ? `Day ${day.dayNumber}` : '' }),
  ));
  if (day && day.text.trim()) col.appendChild(renderMarkdown(day.text));
  else col.appendChild(h('p', { class: 'gr-empty', text: '記録なし' }));
  return col;
}

// ④ 日記リーダー（常に1件）
function blockReader(rep, rs) {
  const card = grCard('④ 毎日の日記');

  const sel = h('select', { class: 'gr-day-select' });
  for (const d of rep.days) sel.appendChild(h('option', { value: String(d.dayNumber) }, `Day ${d.dayNumber}（${d.dayKey}）`));
  sel.addEventListener('change', () => rs.renderReader(Number(sel.value)));

  const srcTag = h('span', { class: 'gr-reader-src' });
  const head = h('div', { class: 'gr-reader-head' },
    h('label', { class: 'gr-flabel', text: '日付', style: { margin: '0' } }),
    sel,
    srcTag,
  );
  const bodyHost = h('div', { class: 'gr-reader-body' });
  card.appendChild(head);
  card.appendChild(bodyHost);

  rs.renderReader = (dayNumber) => {
    if (dayNumber) rs.selected = dayNumber;
    const day = rep.days[rs.selected - 1];
    sel.value = String(rs.selected);
    // ① のマス / ヘッダの選択ハイライトを更新。
    for (const [d, cells] of rs.cellsByDay) {
      const on = d === rs.selected;
      for (const c of cells) c.classList.toggle('sel', on);
      const hd = rs.headerByDay.get(d);
      if (hd) hd.classList.toggle('sel', on);
    }
    clear(bodyHost);
    srcTag.textContent = day && day.source === 'journal' ? '日記' : day && day.source === 'reflection' ? '振り返り' : '';
    srcTag.className = `gr-reader-src${day && day.source ? ' on' : ''}`;
    if (day && day.text.trim()) bodyHost.appendChild(renderMarkdown(day.text));
    else bodyHost.appendChild(h('p', { class: 'gr-empty', text: 'この日の記録はありません' }));
  };
  return card;
}
