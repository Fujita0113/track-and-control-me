// 目標（30日チャレンジ）タブ: 一覧・新規作成・完了レポート
//  (spec: goal-challenge / goal-report). 合否・スコアの語や演出は出さない（「完走」のみ）。
//  スタイルは gr-* クラス + CSSOM（CSP: インライン style 属性なし）。② は同梱 Chart.js。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, openModal, closeModal, emptyState, fmtDur, fmtHM, addDays, attachTooltip, ctrlEnterToSave, colorHex } from './util.js';
import { ruleNiceLabel } from './targets.js';
import { buildRuleForm, ruleDisplayLabel, ruleScheduleText, ruleKindIcon, shortDay, promptReason } from './rule-form.js';
import { renderMarkdown } from './markdown.js';
import { isDemo } from './demo.js';
import { shrinkImage, isImageFile } from './images.js';

// デモ中は取得先を /api/demo/* + 仮想日付へ切替（通常モードは既存経路のまま）。
function fetchGoals() {
  return isDemo() ? api.demo.goals(state.demo.virtualDay).then((r) => r.goals) : api.getGoals();
}
function fetchReport(id) {
  return isDemo() ? api.demo.report(id, state.demo.virtualDay) : api.getGoalReport(id);
}
function fetchHistory() {
  return isDemo() ? api.demo.history(state.demo.virtualDay) : api.getGoalHistory();
}
/** 終える呼び出し（進行中・完走どちらも同じ経路・spec: goal-lifecycle-fork）。 */
function endGoalApi(goalId, b) {
  return isDemo() ? api.demo.endGoal(goalId, b, state.demo.virtualDay) : api.endGoal(goalId, b);
}

let charts = [];
function destroyCharts() {
  for (const c of charts) {
    try { c.destroy(); } catch { /* noop */ }
  }
  charts = [];
}

// --- ①のホバープレビュー（spec: goal-report-day-detail / design D1）------------------------
// body 直下に1つだけツールチップ DOM を持ち回す（util.js の attachTooltip と同じ流儀）。
// 表示内容はレポート取得済みの rep.days をそのまま使い、新規のネットワーク取得は行わない。
let dayTipEl = null;
function ensureDayTip() {
  if (dayTipEl) return dayTipEl;
  dayTipEl = h('div', { class: 'gr-daytip', role: 'tooltip' });
  document.body.appendChild(dayTipEl);
  return dayTipEl;
}
function positionDayTip(el) {
  const tip = dayTipEl;
  const r = el.getBoundingClientRect();
  tip.classList.add('show');
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const gap = 8;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let top = r.bottom + gap;
  if (top + th > vh - 4) top = r.top - gap - th;
  if (top < 4) top = 4;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(4, Math.min(left, vw - tw - 4));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}
function hideDayTip() {
  if (dayTipEl) dayTipEl.classList.remove('show');
}
/** ①のマス／ヘッダに、その日の文面プレビューをホバーで出す。新規取得はしない（design D1）。 */
function attachDayHoverPreview(el, day) {
  el.addEventListener('mouseenter', () => {
    const tip = ensureDayTip();
    clear(tip);
    tip.appendChild(h('div', { class: 'gr-daytip-head', text: `Day ${day.dayNumber}（${day.dayKey}）` }));
    tip.appendChild(h('div', { class: 'gr-daytip-body', text: day.text && day.text.trim() ? day.text : '未記入' }));
    positionDayTip(el);
  });
  el.addEventListener('mouseleave', hideDayTip);
}

export function hide() {
  destroyCharts();
}

export async function show(root) {
  destroyCharts();
  await renderList(root);
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
    // 期間は日付指定（30日は既定でも上限でもない・spec: goal-challenge）ので「30日チャレンジ」とは名乗らない。
    h('h2', {}, '目標', isDemo() ? h('span', { class: 'muted', style: { fontSize: '13px', fontWeight: '400' }, text: 'デモ・閲覧専用' }) : null),
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
      : 'まだ目標がありません。「＋ 新しい目標」から、めざす状態と期限を決めて、その場でルール（守ること）も一緒に作れます。'));
    return;
  }

  const active = goals.filter((g) => g.status === 'active');
  const upcoming = goals.filter((g) => g.status === 'upcoming');
  const completed = goals.filter((g) => g.status === 'completed');
  const ended = goals.filter((g) => g.status === 'ended');

  if (active.length) body.appendChild(goalGroup('進行中', active, root));
  if (upcoming.length) body.appendChild(goalGroup('開始前', upcoming, root));
  if (completed.length) body.appendChild(goalGroup('完走', completed, root));
  if (ended.length) body.appendChild(goalGroup('終了', ended, root));

  // 大きい沿革（目標そのものの年表・カード一覧の下・spec: goal-history）。
  root.appendChild(await goalHistorySection(root));
}

// --- 大きい沿革（目標そのものの年表・spec: goal-history）------------------
//
// 目標の作成・終了・完走を day_key 昇順で縦一覧にする（横スクロールUIは次の change）。
// 終了・完走の行は「数字（到達/未達）・自己申告（めざした状態）・証拠写真」の3つを並べる。
// ✓/× はここでだけ使ってよい（診断であって断罪ではない・design D7-b）。合否・スコア・紙吹雪は出さない。
// 行頭は記号ではなく過去形の文にする。「＋作成」は「＋ 新しい目標」ボタンと同じ記号＋動詞で、
// 押せる操作に見えてしまっていた。年表なので「起きたこと」として読ませる。
const HISTORY_KIND_VERB = { created: 'をはじめた', ended: 'を終えた', completed: 'を走りきった' };

function goalHistoryPhotoPair(imgBase, photos) {
  if (!photos || (!photos.before && !photos.after)) return null;
  const fig = (tag, p) => (p
    ? h('figure', { class: 'gr-fig' }, h('img', { class: 'gr-fig-img', src: `${imgBase}/images/${p.imageId}`, alt: tag, loading: 'lazy' }), h('figcaption', { class: 'gr-fig-cap', text: tag }))
    : null);
  return h('div', { class: 'gr-ba-pair' }, fig('Before', photos.before), fig('After', photos.after));
}

/** 終了・完走の行: 到達/未達（✓/×）・めざした状態の答え・証拠写真を並べる（欠けは欠けたまま）。 */
function historyOutcomeRow(entry, imgBase) {
  const parts = [];
  if (entry.pace) {
    const mark = entry.pace.met ? '✓' : '×';
    parts.push(h('span', { class: `gr-hist-tag ${entry.pace.met ? 'ok' : 'miss'}`, text: `${mark} 平均 ${fmtDur(entry.pace.averageSeconds)} / ${fmtDur(entry.pace.targetSecondsPerDay)}` }));
  }
  if (entry.outcomeMet !== null) {
    const mark = entry.outcomeMet ? '✓' : '×';
    parts.push(h('span', { class: `gr-hist-tag ${entry.outcomeMet ? 'ok' : 'miss'}`, text: `${mark} めざした状態: ${entry.outcomeMet ? 'できた' : 'できなかった'}` }));
  }
  const wrap = h('div', { class: 'stack', style: { gap: '6px' } });
  if (parts.length) wrap.appendChild(h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, ...parts));
  const photoPair = goalHistoryPhotoPair(imgBase(entry.goalId), entry.photos);
  if (photoPair) wrap.appendChild(photoPair);
  return wrap.childNodes.length ? wrap : null;
}

function historyRow(entry, onOpen) {
  // 見出し行: 日付 ｜ 種別ドット ｜「目標名 を◯◯した」。レポート⑤沿革（読み物・明朝の1件42px）とは
  // 用途が違う（並べて眺める索引）ので、CSS も DOM も共有しない。
  const main = h('div', { class: 'gr-hist-main' },
    h('p', { class: 'gr-hist-stmt' },
      h('span', { class: 'gr-hist-name', text: entry.name }),
      ' ',
      h('span', { class: 'gr-hist-verb', text: HISTORY_KIND_VERB[entry.kind] }),
      // 終了は翌日発効。発効前の行は「予約中」と発効日を添えて事実どおりに並べる（spec: goal-history）。
      entry.pending ? h('span', { class: 'gr-hist-pending', text: `予約中（${shortDay(entry.dayKey)} から）` }) : null,
    ),
  );

  if (entry.kind === 'created') {
    if (entry.purpose) main.appendChild(h('p', { class: 'gr-hist-line', text: `めざす状態: ${entry.purpose}` }));
    if (entry.reason) main.appendChild(h('p', { class: 'gr-hist-reason', text: entry.reason }));
    if (entry.targetHours) main.appendChild(h('p', { class: 'gr-hist-line', text: `目標時間: ${entry.targetHours.labels.join(' or ')} 1日あたり ${fmtDur(entry.targetHours.secondsPerDay)}` }));
    // imgBase は文字列（関数を渡すと src が壊れて画像が出ない）。
    const photoPair = goalHistoryPhotoPair(`${isDemo() ? '/api/demo/goals/' : '/api/goals/'}${entry.goalId}/journal`, { before: entry.photos.before, after: null });
    if (photoPair) main.appendChild(photoPair);
  } else {
    if (entry.reason) main.appendChild(h('p', { class: 'gr-hist-reason', text: entry.reason }));
    const outcome = historyOutcomeRow(entry, (goalId) => `${isDemo() ? '/api/demo/goals/' : '/api/goals/'}${goalId}/journal`);
    if (outcome) main.appendChild(outcome);
  }

  const row = h('article', { class: `gr-hist-row ${entry.kind}`, role: 'button', tabindex: '0' },
    h('time', { class: 'gr-hist-date', text: shortDay(entry.dayKey) }),
    h('span', { class: 'gr-hist-dot', 'aria-hidden': 'true' }),
    main,
  );
  row.addEventListener('click', () => onOpen(entry.goalId));
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') onOpen(entry.goalId); });
  return row;
}

async function goalHistorySection(root) {
  // カード一覧と同じ幅・同じ器（.card）に置く。レポート画面用の .gr-card（820px 中央寄せ）は使わない。
  const card = h('section', { class: 'card gr-history' });
  card.appendChild(h('div', { class: 'card-title', text: 'これまでの目標' }));

  let entries = [];
  try { entries = await fetchHistory(); }
  catch (e) { card.appendChild(emptyState(`読み込み失敗: ${e.message}`)); return card; }

  if (!entries.length) {
    card.appendChild(h('p', { class: 'muted', text: 'まだ目標の作成・終了・完走はありません。' }));
    return card;
  }
  const list = h('div', { class: 'gr-hist-list' });
  for (const entry of entries) list.appendChild(historyRow(entry, (goalId) => renderReport(root, goalId)));
  card.appendChild(list);
  return card;
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
  else if (g.status === 'ended') meta.appendChild(h('span', { class: 'badge', text: '終了' }));
  else meta.appendChild(h('span', { class: 'badge ok', text: '完走' }));
  // 終了予約中（終えたが未発効）。状態は進行中/完走のままで、発効日を併記する（spec: goal-challenge MODIFIED）。
  if (g.endingOn) meta.appendChild(h('span', { class: 'badge', text: `終了予約中（${shortDay(g.endingOn)} から）` }));
  // 一時凍結の状態（凍結中・予約中）を badge で示す（spec: goal-freeze）。
  if (g.freeze && g.freeze.state === 'frozen') {
    meta.appendChild(h('span', { class: 'badge gf-badge', text: g.freeze.kind === 'same_day' ? '❄ 今日だけ凍結中' : '❄ 凍結中' }));
  } else if (g.freeze && g.freeze.state === 'reserved') {
    meta.appendChild(h('span', { class: 'badge gf-badge', text: '凍結予約中' }));
  }

  const head = h('div', { class: 'row' },
    h('h3', { text: g.name }),
    meta,
    h('div', { class: 'spacer' }),
  );

  // 完走後・進行中・終了後のいずれもレポートへ遷移できる（走行中プレビュー・spec: goal-report）。
  // 同じ画面だが、文言を状態で分けて「まだ途中の姿」であることを一目で伝える。
  if (g.status !== 'upcoming') {
    const label = g.status === 'active' ? 'レポートプレビュー' : 'レポートを開く';
    const openBtn = h('button', { class: 'btn small primary', text: label, type: 'button' });
    openBtn.addEventListener('click', () => renderReport(root, g.id));
    head.appendChild(openBtn);
  }
  // 開始前はレポートを開けない（まだ1日も走っていない）ので導線を出さない。

  // 「終える」導線（進行中・完走どちらからも。終了済み・終了予約中には出さない）。
  // 終了予約中は代わりに「終了を取り消す」を出す（発効前だけ取り消せる・design D7・D11）。
  if (!isDemo() && g.endingOn) {
    const cancelBtn = h('button', { class: 'btn small', text: '終了を取り消す', type: 'button' });
    attachTooltip(cancelBtn, { label: `${shortDay(g.endingOn)} の発効前なら取り消せます` });
    cancelBtn.addEventListener('click', async () => {
      if (!confirm(`「${g.name}」の終了を取り消しますか？（取り消しても凍結予約は戻りません）`)) return;
      cancelBtn.disabled = true;
      try { await api.cancelEndGoal(g.id); toast('終了を取り消しました', 'ok'); renderList(root); }
      catch (err) { toast(err.data?.error || `失敗: ${err.message}`, 'err'); cancelBtn.disabled = false; }
    });
    head.appendChild(cancelBtn);
  } else if (!isDemo() && (g.status === 'active' || g.status === 'completed')) {
    const endBtn = h('button', { class: 'btn small', text: '終える', type: 'button' });
    endBtn.addEventListener('click', () => openEndDialog(g, () => renderList(root)));
    head.appendChild(endBtn);
  }

  // 削除の表示条件はサーバの削除ガード（`ended_day_key != null` で拒否）と一致させる。
  // 終了予約中も隠す（発効前でも終了を申し込んだ目標は削除できない・design D11）。
  if (!isDemo() && g.canDelete && !g.endingOn && g.status !== 'completed' && g.status !== 'ended') {
    // デモは閲覧専用（削除手段を出さない・spec: 閲覧専用）。
    const del = h('button', { class: 'btn small danger', text: '削除', type: 'button' });
    del.addEventListener('click', async () => {
      if (!confirm(`「${g.name}」を削除しますか？（作成当日のみ可能）`)) return;
      try { await api.deleteGoal(g.id); toast('削除しました', 'ok'); renderList(root); }
      catch (err) {
        if (err.status === 409) {
          toast(err.data?.error === '終了した目標は削除できません' ? '終了した目標は削除できません' : '作成当日以外は削除できません', 'err');
        } else {
          toast(`失敗: ${err.message}`, 'err');
        }
      }
    });
    head.appendChild(del);
  }
  card.appendChild(head);

  // めざす状態は常時表示（design D4-c: 目標時間の有無で処理を場合分けしない・任意の purpose と違い必須）。
  card.appendChild(h('p', { class: 'muted gr-purpose' }, h('strong', { text: 'めざす状態: ' }), g.purpose));
  card.appendChild(h('div', { class: 'period muted', text: `${g.startDay} 〜 ${g.endDay}` }));

  // ペースブロック（目標時間を持つ場合のみ・目標時間を持たない目標には出さない・spec: goal-target-hours）。
  if (g.targetHours) card.appendChild(paceBlock(g, g.status === 'active' || g.status === 'upcoming'));

  const chips = h('div', { class: 'gr-chips' });
  for (const r of g.rules) chips.appendChild(h('span', { class: 'gr-chip', text: `${ruleKindIcon(r.target)} ${ruleDisplayLabel(r)}` }));
  card.appendChild(chips);
  return card;
}

/**
 * 目標時間のペースブロック（対象名・目標時間・現在の平均・進捗バー・今日あと・spec: goal-target-hours）。
 * 「ゲートに効く／効かない」等の内部語彙は出さず、「パスワードの条件になりません」で統一する。
 */
function paceBlock(g, running) {
  const th = g.targetHours;
  const label = th.labels.join(' or ');
  const wrap = h('div', { class: 'gr-pace' },
    h('div', { class: 'gr-pace-head' },
      h('span', { class: 'gr-pace-label', text: label }),
      h('span', { class: 'muted gr-pace-note', text: 'パスワードの条件になりません' }),
    ),
  );
  const p = g.pace;
  if (!p) {
    wrap.appendChild(h('p', { class: 'muted', text: `目標 1日あたり ${fmtDur(th.secondsPerDay)}` }));
    return wrap;
  }
  const pct = Math.min(100, Math.round((p.averageSeconds / p.targetSecondsPerDay) * 100));
  const bar = h('div', { class: 'progress' }, h('span', {}));
  bar.firstChild.style.width = `${pct}%`;
  wrap.appendChild(h('div', { class: 'gr-pace-nums' },
    h('span', { text: `平均 ${fmtDur(p.averageSeconds)} / ${fmtDur(p.targetSecondsPerDay)}` }),
  ));
  wrap.appendChild(bar);
  // 終了・完走した目標に「今日 あと …」は出さない（もう今日は無い）。事実だけを残す。
  // 記号（✓/×）は大きい沿革の外へ持ち出さない（spec: goal-history）。
  if (!running) wrap.appendChild(h('p', { class: 'gr-pace-remain gr-pace-final', text: p.met ? '到達' : '未達' }));
  else wrap.appendChild(h('p', { class: 'gr-pace-remain', text: p.met ? '✓ 到達' : `今日 あと ${fmtDur(p.todayRemainSeconds)} で到達` }));
  return wrap;
}

// --- 終える（進行中・完走どちらも同じダイアログ・spec: goal-lifecycle-fork ADDED）-----------

/**
 * 終える導線。めざした状態（3値）・証拠写真（`outcomeCaption` があるときのみ）・理由（必須）を問う。
 * 発効は翌日で、今夜のノルマは今夜のノルマとして残る旨を明示する（design D5・D11）。
 * 今夜ノルマを外したいときは一時凍結（当日凍結）が受け皿になる。
 */
function openEndDialog(g, onDone) {
  const body = h('div', { class: 'modal-body stack' });
  // 発効が翌日であることが一番大事なので、そこだけ太字で立てる（注記を括弧で足すと読み飛ばされる・issue #89）。
  body.appendChild(h('p', { class: 'muted' },
    `「${g.name}」を終えます。永続ルールは`,
    h('strong', { text: '明日からパスワードの条件を外れます' }),
    '。発効するまでは取り消せます。',
  ));

  body.appendChild(h('label', { class: 'gr-flabel', text: `めざした状態は「${g.purpose}」できましたか？（任意）` }));
  let outcomeMet; // undefined=答えない, true/false
  const outcomeSeg = h('div', { class: 'gr-start-seg' });
  [
    { v: undefined, label: '答えない' },
    { v: true, label: 'できた' },
    { v: false, label: 'できなかった' },
  ].forEach(({ v, label }) => {
    const b = h('button', { class: 'gr-start-btn', type: 'button', text: label });
    if (v === outcomeMet) b.classList.add('on');
    b.addEventListener('click', () => {
      outcomeMet = v;
      for (const x of outcomeSeg.children) x.classList.toggle('on', x === b);
    });
    outcomeSeg.appendChild(b);
  });
  body.appendChild(outcomeSeg);

  let photoDataUrl = null;
  if (g.outcomeCaption) {
    const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'rf-img-file' });
    const addLabel = h('label', { class: 'rf-img-add' }, `＋ 証拠写真を出す（${g.outcomeCaption}）`, fileInput);
    const thumbHost = h('div', { class: 'rf-thumbs' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file || !isImageFile(file)) return;
      try {
        photoDataUrl = await shrinkImage(file);
        clear(thumbHost);
        thumbHost.appendChild(h('div', { class: 'rf-thumb' }, h('img', { class: 'rf-thumb-img', src: photoDataUrl, alt: g.outcomeCaption })));
      } catch (e) { toast(`画像を読み込めません: ${e.message}`, 'err'); }
    });
    body.appendChild(h('label', { class: 'gr-flabel', text: '証拠写真（任意・後から出すこともできます）' }));
    body.appendChild(h('div', { class: 'rf-imgzone' }, addLabel, thumbHost));
  }

  const reasonInp = h('textarea', { class: 'gr-textarea gr-end-reason-input', rows: '2', placeholder: '例: 試験勉強はもう大丈夫。設計に切り替えたい' });
  body.appendChild(h('label', { class: 'gr-flabel', text: '理由（必須）' }));
  body.appendChild(reasonInp);

  const save = h('button', { class: 'btn primary', text: 'この目標を終える', type: 'button' });
  save.addEventListener('click', async () => {
    const reason = reasonInp.value.trim();
    if (!reason) { toast('理由を入力してください', 'err'); return; }
    save.disabled = true;
    try {
      await endGoalApi(g.id, { reason, outcomeMet, photo: photoDataUrl ? { dataUrl: photoDataUrl } : undefined });
      toast('明日からこの目標を終えます', 'ok');
      closeModal();
      onDone();
    } catch (err) {
      toast(err.data?.error || `失敗: ${err.message}`, 'err');
      save.disabled = false;
    }
  });
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', text: 'キャンセル', type: 'button', onclick: closeModal }),
    save,
  ));
  ctrlEnterToSave(body, save, '終える');
  openModal(body, '目標を終える');
}

// --- 新規作成フォーム -----------------------------------------------------

/**
 * 作成フォームの「初期写真（Before）」ステージング（design D4-c）。goalId 未確定のため縮小済み
 * data URL をクライアントに溜め、作成成功後に Day1 へ保存する。3方式（ファイル/貼付/D&D）対応。
 * 証拠写真は「作成時に決めたキャプション1つ」に固定されるため（design D1）、キャプション編集欄は
 * 持たず1枚のみを保持する（複数貼っても最後の1枚に置き換わる）。
 */
function buildCreateImageStager() {
  const staged = [];
  const thumbs = h('div', { class: 'rf-thumbs' });
  const errorEl = h('div', { class: 'rf-img-error', hidden: true });
  const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'rf-img-file' });
  const addLabel = h('label', { class: 'rf-img-add' }, '＋ 初期写真を追加（任意）', fileInput);
  const zone = h('div', { class: 'rf-imgzone gr-stage' },
    h('div', { class: 'rf-imgzone-head' },
      h('span', { class: 'rf-imgzone-title', text: '初期写真（任意・Before）' }),
      addLabel,
      h('span', { class: 'rf-img-hint', text: '貼り付け・ドラッグ＆ドロップも可。作成時に Day1 へ保存されます' }),
    ),
    errorEl,
    thumbs,
  );
  const showErr = (m) => { errorEl.textContent = m; errorEl.hidden = false; };
  const clearErr = () => { errorEl.hidden = true; };
  const setThumb = (item) => {
    clear(thumbs);
    staged.length = 0;
    if (!item) return;
    staged.push(item);
    const del = h('button', { class: 'rf-thumb-del', type: 'button', title: '削除', text: '×' });
    const cell = h('div', { class: 'rf-thumb' }, h('img', { class: 'rf-thumb-img', src: item.dataUrl, alt: '' }), del);
    del.addEventListener('click', () => setThumb(null));
    thumbs.appendChild(cell);
  };
  const stage = async (files) => {
    const arr = [...(files || [])];
    const images = arr.filter(isImageFile);
    if (images.length < arr.length) showErr('画像ファイル以外は追加できません');
    const file = images[0];
    if (!file) return;
    try {
      setThumb({ dataUrl: await shrinkImage(file) });
      clearErr();
    } catch (e) { showErr(`画像を読み込めません: ${e.message}`); }
  };
  fileInput.addEventListener('change', () => { stage(fileInput.files); fileInput.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', (e) => { if (e.target === zone) zone.classList.remove('drag'); });
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); if (e.dataTransfer) stage(e.dataTransfer.files); });
  zone.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); } }
    if (files.length && files.some(isImageFile)) { e.preventDefault(); stage(files); }
  });
  return { el: zone, staged };
}

/** 作成フォームの節（見出し＋中身）。縦一列の羅列を4つの塊に畳んで読める量にする。 */
function formSection(title, ...kids) {
  return h('section', { class: 'gr-fsec' },
    h('h4', { class: 'gr-fsec-title', text: title }),
    ...kids,
  );
}

/**
 * 任意項目の開閉行。チェックが入るまで中身を出さない（既定は1行だけ）。
 * チェックボックス自体は e2e とキーボード操作のため実体のまま残す。
 */
function optionalToggle(check, label, note, bodyEl) {
  bodyEl.hidden = true;
  check.addEventListener('change', () => { bodyEl.hidden = !check.checked; });
  return h('div', { class: 'gr-opt' },
    h('label', { class: 'gr-opt-head' },
      check,
      h('span', { class: 'gr-opt-label', text: label }),
      note ? h('span', { class: 'muted gr-opt-note', text: note }) : null,
    ),
    bodyEl,
  );
}

async function openCreateForm(onDone) {
  const body = h('div', { class: 'modal-body stack gr-create-form' });
  const introEl = h('p', { class: 'muted gr-fsec-note' });

  const nameInp = h('input', { type: 'text', class: 'gr-input', placeholder: '目標名（例: メンタルを安定させる）' });
  const purposeInp = h('input', { type: 'text', class: 'gr-input gr-purpose-input', placeholder: '例: アルゴリズムを一通り自力で実装できるようになっている' });
  const startReasonInp = h('textarea', { class: 'gr-textarea gr-startreason-input', rows: '2', placeholder: '例: 試験前だが手は止めたくない' });
  body.appendChild(formSection('めざすこと',
    h('label', { class: 'gr-flabel', text: '目標名' }),
    nameInp,
    h('label', { class: 'gr-flabel', text: 'めざす状態（必須）' }),
    purposeInp,
    h('p', { class: 'muted gr-fsec-note', text: '終わるときに「これができたか」を聞かれます。' }),
    h('label', { class: 'gr-flabel', text: 'なぜ始めるのか（必須）' }),
    startReasonInp,
  ));

  // --- いつまで（開始日＋期限を1つの節に畳む）-----------------------------
  // 今日開始は当日を Day1 として即「進行中」。
  // 期限は日付指定・自由。1週間/2週間/30日は入力補助のボタンにすぎない（spec: goal-challenge）。
  let start = 'today';
  const startSeg = h('div', { class: 'gr-start-seg' });
  [
    { v: 'today', label: '今日から' },
    { v: 'tomorrow', label: '明日から' },
  ].forEach(({ v, label }) => {
    const b = h('button', { class: 'gr-start-btn', type: 'button', text: label });
    if (v === start) b.classList.add('on');
    b.addEventListener('click', () => {
      if (start === v) return;
      start = v;
      for (const x of startSeg.children) x.classList.toggle('on', x === b);
      syncIntro();
      syncEndQuickButtons();
    });
    startSeg.appendChild(b);
  });
  const syncIntro = () => {
    introEl.textContent = start === 'today'
      ? '今日から始まり、当日が Day 1 になります。ここで作ったルールはこの目標へ自動で紐づきます。'
      : '明日から始まります。ここで作ったルールはこの目標へ自動で紐づきます。';
  };
  syncIntro();

  const today = state.today;
  const startDayFor = () => (start === 'tomorrow' ? addDays(today, 1) : today);
  const endInp = h('input', { type: 'date', class: 'gr-input gr-end-day-input', min: startDayFor() });
  const endQuickRow = h('div', { class: 'gr-start-seg' });
  for (const { label, days } of [{ label: '1週間', days: 6 }, { label: '2週間', days: 13 }, { label: '30日', days: 29 }]) {
    const b = h('button', { class: 'gr-start-btn', type: 'button', text: label });
    b.addEventListener('click', () => { endInp.value = addDays(startDayFor(), days); });
    endQuickRow.appendChild(b);
  }
  const syncEndQuickButtons = () => { endInp.min = startDayFor(); };
  endInp.value = addDays(startDayFor(), 29); // 既定値（30日相当）。あくまで初期値で、自由に変更できる。
  body.appendChild(formSection('いつまで',
    h('div', { class: 'gr-period-row' }, startSeg, h('span', { class: 'muted gr-period-sep', text: '〜' }), endInp),
    endQuickRow,
    introEl,
  ));

  // --- はかりかた（任意・目標時間／証拠写真。既定は閉じたまま1行ずつ）------
  // 目標時間はパスワードの条件になりません（D3・ゲートに合流しない）。下限ルールとは別物。
  const groups = await api.getGroupsRecent().catch(() => []);
  const thKindSel = h('select', { class: 'pc-input' },
    h('option', { value: 'GROUP_SET', text: 'グループ（複数を or で束ねられます）' }),
    h('option', { value: 'TOTAL_WORK', text: '総作業時間' }),
    h('option', { value: 'TIMELINE', text: 'カテゴリ' }),
  );
  const thMinutesInp = h('input', { type: 'number', class: 'pc-input pc-input-num gr-th-minutes-input', min: '1', step: '5', value: '120' });
  // グループは色ドットつきのチップで選ぶ。identity は「名前＋色」なので、同名で色違いの
  // グループが並ぶことがある。色を出さないと見分けがつかない（spec: group-identity-registry）。
  const thGroupsHost = h('div', { class: 'gr-th-groups' },
    ...groups.map((g) => {
      const box = h('input', { type: 'checkbox', value: String(g.id), class: 'gr-th-group-check' });
      const chip = h('label', { class: 'gr-th-chip' },
        box,
        h('span', { class: 'gr-th-dot' }),
        h('span', { text: g.name }),
      );
      chip.querySelector('.gr-th-dot').style.background = colorHex(g.color);
      box.addEventListener('change', () => chip.classList.toggle('on', box.checked));
      return chip;
    }),
  );
  const thTimelineInp = h('input', { type: 'text', class: 'pc-input', placeholder: '例: 運動' });
  const thExtra = h('div', {});
  const syncThKind = () => {
    clear(thExtra);
    if (thKindSel.value === 'GROUP_SET') thExtra.appendChild(thGroupsHost);
    else if (thKindSel.value === 'TIMELINE') thExtra.appendChild(thTimelineInp);
  };
  thKindSel.addEventListener('change', syncThKind);
  syncThKind();
  const thBody = h('div', { class: 'stack gr-th-body' },
    h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
      h('span', { class: 'muted', text: '対象' }), thKindSel,
      h('span', { class: 'muted', text: '1日あたり(分)' }), thMinutesInp,
    ),
    thExtra,
  );
  const thCheck = h('input', { type: 'checkbox', class: 'gr-th-check' });

  // 証拠写真: 「終わるときに写真を出す」を決め、求めるならキャプションを1つ決める。
  // キャプションはレポート③の Before/After のグループ化キーになる（③の実装は触らない・design D4-c）。
  const outcomeCaptionInp = h('input', { type: 'text', class: 'gr-input gr-outcome-caption-input', placeholder: '例: AtCoder レーティング', maxlength: '60' });
  const stager = buildCreateImageStager();
  const outcomeBody = h('div', { class: 'stack gr-outcome-body' },
    h('label', { class: 'gr-flabel', text: '何を証拠にするか（キャプション・必須）' }),
    outcomeCaptionInp,
    stager.el,
  );
  const outcomeCheck = h('input', { type: 'checkbox', class: 'gr-outcome-check' });

  body.appendChild(formSection('はかりかた（任意）',
    optionalToggle(thCheck, '1日あたりの目標時間を決める', 'パスワードの条件になりません', thBody),
    optionalToggle(outcomeCheck, '終わるときに証拠写真を出す', null, outcomeBody),
  ));

  // --- ルール（この目標で守ること。その場で新規作成のみ・「採用」は無い）--------
  // グループ選択肢は直近30日に実測された identity から（tab_group の UUID 行は使わない・spec: goal-inline-condition）。
  const formsHost = h('div', { class: 'list gr-newconds' });
  const forms = [];
  const addRuleForm = () => {
    const form = buildRuleForm({ todayKey: today, groups });
    form.el.classList.add('gr-newcond-editor');
    const rm = h('button', { class: 'icon-btn', type: 'button', text: '🗑', title: '削除' });
    rm.addEventListener('click', () => { row.remove(); const i = forms.indexOf(form); if (i >= 0) forms.splice(i, 1); });
    const row = h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '8px' } }, form.el, rm);
    forms.push(form);
    formsHost.appendChild(row);
  };
  const addBtn = h('button', { class: 'btn small', type: 'button', text: '＋ ルールを追加' });
  addBtn.addEventListener('click', addRuleForm);
  const rulesSec = formSection('毎日守ること', formsHost);
  rulesSec.querySelector('.gr-fsec-title').appendChild(h('span', { class: 'muted gr-fsec-note-inline', text: 'パスワードの条件になります' }));
  rulesSec.querySelector('.gr-fsec-title').appendChild(addBtn);
  body.appendChild(rulesSec);
  addRuleForm(); // 最初の1件は既定で出しておく。

  const save = h('button', { class: 'btn primary', text: '作成', type: 'button' });
  attachTooltip(save, { label: '作成', keys: ['Ctrl', 'Enter'] });
  save.addEventListener('click', async () => {
    const name = nameInp.value.trim();
    if (!name) { toast('目標名を入力してください', 'err'); return; }
    const purpose = purposeInp.value.trim();
    if (!purpose) { toast('めざす状態を入力してください', 'err'); return; }
    const startReason = startReasonInp.value.trim();
    if (!startReason) { toast('なぜ始めるのかを入力してください', 'err'); return; }
    const endDay = endInp.value;
    if (!endDay) { toast('期限を指定してください', 'err'); return; }
    const rules = forms.map((f) => f.read());
    if (!rules.length) { toast('ルールを1つ以上追加してください', 'err'); return; }
    if (rules.some((r) => !r.reason)) { toast('各ルールの理由を入力してください', 'err'); return; }

    let outcomeCaption = null;
    if (outcomeCheck.checked) {
      outcomeCaption = outcomeCaptionInp.value.trim();
      if (!outcomeCaption) { toast('何を証拠にするか（キャプション）を入力してください', 'err'); return; }
    }

    let targetHours = null;
    if (thCheck.checked) {
      const secondsPerDay = (Number(thMinutesInp.value) || 0) * 60;
      if (secondsPerDay <= 0) { toast('目標時間は1分以上で指定してください', 'err'); return; }
      if (thKindSel.value === 'GROUP_SET') {
        const groupIdentityIds = [...thGroupsHost.querySelectorAll('input[type=checkbox]')]
          .filter((b) => b.checked)
          .map((b) => Number(b.value));
        if (!groupIdentityIds.length) { toast('目標時間の対象グループを1つ以上選んでください', 'err'); return; }
        targetHours = { kind: 'GROUP_SET', secondsPerDay, groupIdentityIds };
      } else if (thKindSel.value === 'TIMELINE') {
        const timelineLabel = thTimelineInp.value.trim();
        if (!timelineLabel) { toast('目標時間のカテゴリ名を入力してください', 'err'); return; }
        targetHours = { kind: 'TIMELINE', secondsPerDay, timelineLabel };
      } else {
        targetHours = { kind: 'TOTAL_WORK', secondsPerDay };
      }
    }

    save.disabled = true;
    try {
      const g = await api.createGoal({
        name,
        purpose,
        startReason,
        endDay,
        rules,
        start,
        targetHours,
        outcomeCaption,
        outcomeImage: outcomeCaption && stager.staged[0] ? { dataUrl: stager.staged[0].dataUrl } : null,
      });
      toast('目標を作成しました', 'ok');
      closeModal();
      onDone();
    } catch (err) {
      toast(err.data?.error || `失敗: ${err.message}`, 'err');
      save.disabled = false;
    }
  });
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', text: 'キャンセル', type: 'button', onclick: closeModal }),
    save,
  ));
  // Ctrl/Cmd+Enter で作成（IME 変換確定・disabled 中は無視）。
  ctrlEnterToSave(body, save);
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

  // ヘッダ。進行中は「完走」ではなく現在の Day を出す（まだ途中の姿であることを一目で伝える）。
  const running = rep.goal.status === 'active';
  const frozenNow = rep.goal.freeze && rep.goal.freeze.state === 'frozen';
  page.appendChild(h('header', { class: 'gr-header' },
    h('div', { class: 'gr-eyebrow', text: running ? `Day ${rep.goal.dayNumber}/${rep.goal.dayCount}` : '完走' },
      frozenNow ? h('span', { class: 'badge gf-badge', style: { marginLeft: '8px' }, text: '❄ 凍結中' }) : null),
    h('h1', { class: 'gr-h1', text: rep.goal.name }),
    rep.goal.purpose ? h('p', { class: 'gr-purpose-line', text: rep.goal.purpose }) : null,
    h('div', { class: 'gr-header-meta' },
      h('span', { text: `${rep.goal.startDay} 〜 ${rep.goal.endDay}` }),
      h('span', { class: 'gr-dot', text: '·' }),
      // 進行中の達成日数は「その時点まで」の事実（分母は現時点までの日数。凍結日は分母にも分子にも入らない）。
      h('span', { class: 'gr-achieved', text: running
        ? `達成 ${rep.goal.achievedDays}/${rep.goal.elapsedDays}（現時点）`
        : `達成 ${rep.goal.achievedDays}/${rep.goal.dayCount}` }),
    ),
  ));

  // 完走フォーク（続ける／終える）。レポート先頭に出す（spec: goal-lifecycle-fork）。
  const forkBlock = blockLifecycleFork(rep, root);
  if (forkBlock) page.appendChild(forkBlock);

  // 読み手状態（④ で使う。①のマス/日付セレクタから連動）。
  const readerState = { selected: 1, cellsByDay: new Map(), headerByDay: new Map(), renderReader: null };

  // 画像バイナリのベース URL（デモは /api/demo/… 経路へ切替・design D8）。
  const imgBase = `${isDemo() ? '/api/demo/goals/' : '/api/goals/'}${rep.goal.id}/journal`;

  // ① 達成カレンダー
  page.appendChild(blockCalendar(rep, readerState, root));
  // ② 時間の推移（時間型ルールがある場合のみ）
  if (rep.hasTimeType) page.appendChild(blockTimeSeries(rep));
  // ③ Before / After（2モード＋最終日CTA）
  page.appendChild(blockBeforeAfter(rep, imgBase));
  // ④ 日記リーダー
  page.appendChild(blockReader(rep, readerState, imgBase));
  // ⑤ 沿革（ルール操作の年表。日記は載らない）
  page.appendChild(blockChronicle(rep, imgBase));

  readerState.renderReader();
}

// 完走フォーク（続ける／終える・spec: goal-lifecycle-fork）。
// 未決定なら分岐ボタンを、決定済みならその結果を静かに示す。
function blockLifecycleFork(rep, root) {
  const g = rep.goal;
  if (!g.showLifecycleFork && !g.lifecycleChoice) return null;
  const card = h('section', { class: 'gr-card gr-fork' });

  if (g.lifecycleChoice === 'continued') {
    card.appendChild(h('p', { class: 'gr-fork-lead', text: `${g.name} を続けています（新しい30日目標が Day 1/30 で作られました）。` }));
    return card;
  }
  if (g.lifecycleChoice === 'ended') {
    card.appendChild(h('p', { class: 'gr-fork-lead', text: `${g.name} をここで終えました。` }));
    if (g.lifecycleReason) card.appendChild(h('p', { class: 'muted', text: g.lifecycleReason }));
    return card;
  }

  card.appendChild(h('p', { class: 'gr-fork-lead', text: `${g.name} の1ヶ月が終わりました。続けますか？` }));
  const contBtn = h('button', { class: 'btn primary', type: 'button', text: '続ける' });
  const endBtn = h('button', { class: 'btn', type: 'button', text: 'ここで終える' });
  contBtn.addEventListener('click', async () => {
    contBtn.disabled = true;
    try {
      const newGoal = isDemo() ? await api.demo.continueGoal(g.id, state.demo.virtualDay) : await api.continueGoal(g.id);
      toast(`新しい30日目標「${newGoal.name}」を Day 1/30 で作りました`, 'ok');
      await renderReport(root, newGoal.id);
    } catch (err) {
      toast(err.data?.error || `失敗: ${err.message}`, 'err');
      contBtn.disabled = false;
    }
  });
  // 進行中の「終える」と同じダイアログ（めざした状態・証拠写真・理由）を使う（design D6）。
  endBtn.addEventListener('click', () => openEndDialog(g, () => renderReport(root, g.id)));
  card.appendChild(h('div', { class: 'actions' }, endBtn, contBtn));
  return card;
}

// ⑤ 沿革（spec: goal-chronicle）
//
// ルール操作（追加・変更・削除）を時系列に並べる。写真ルールには画像、質問ルールには Q&A のペアが
// ぶら下がる。削除は理由つきで残す（消さない＝逃げた事実そのものが歴史）。
// **日記は載せない**（載る／載らないの線引きは「大きさ」ではなく「検証がぶら下がるか」）。
// スコア・演出（紙吹雪・バッジ・合否の語）は出さず、素の時系列リストとして静かに提示する。
function blockChronicle(rep, imgBase) {
  const card = grCard('⑤ 沿革');
  const entries = (rep.chronicle && rep.chronicle.entries) || [];
  const freezes = (rep.chronicle && rep.chronicle.freezes) || [];
  if (!entries.length && !freezes.length) {
    card.appendChild(h('p', { class: 'gr-empty', text: 'まだルールの変更はありません。振り返りタブの目標コーナーでルールを足すと、ここに積み上がります。' }));
    return card;
  }
  // ルール操作と一時凍結イベントを sortKey で安定併合する（design: goal-freeze D6）。
  const merged = [
    ...entries.map((e) => ({ sortKey: e.sortKey, el: chronicleEntry(e, imgBase) })),
    ...freezes.map((f) => ({ sortKey: f.sortKey, el: freezeEntryEl(f) })),
  ].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const list = h('div', { class: 'gr-chr' });
  for (const m of merged) list.appendChild(m.el);
  if (rep.chronicle.endedNote) {
    list.appendChild(chronicleEndedNote(rep, rep.chronicle.endedNote));
  }
  card.appendChild(list);
  return card;
}

/** b - a の日数差＋1（凍結解除の「凍結 N 日」表示用。b が a より前なら 0）。 */
function freezeDayCount(startDay, endDay) {
  if (!startDay || !endDay || endDay < startDay) return 0;
  const toUtc = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(endDay) - toUtc(startDay)) / 86400000) + 1;
}

const FREEZE_KIND_LABEL = {
  reserve: '凍結を予約',
  cancel: '凍結の予約を取消',
  activate: '凍結が発効',
  extend: '凍結を延長',
  release: '凍結を解除',
};

/**
 * 一時凍結イベント1件を沿革の1エントリとして組む（spec: goal-chronicle / goal-freeze）。
 * 合否・スコアに相当する語や演出は使わない（起きた事実と理由だけを静かに示す）。
 */
function freezeEntryEl(f) {
  const dateCol = h('div', { class: 'gr-chr-date' },
    h('div', { class: 'gr-chr-day-label', text: 'Day' }),
    h('div', { class: 'gr-chr-day-num', text: String(f.dayNumber) }),
    h('div', { class: 'gr-chr-date-sub', text: shortDay(f.dayKey) }),
  );
  let text = FREEZE_KIND_LABEL[f.kind] || f.kind;
  if (f.kind === 'reserve' || f.kind === 'activate') text += `（${shortDay(f.startDay)}〜${shortDay(f.afterEndDay)}）`;
  else if (f.kind === 'extend') text += `（${shortDay(f.beforeEndDay)} → ${shortDay(f.afterEndDay)}）`;
  else if (f.kind === 'release') text += `（凍結 ${freezeDayCount(f.startDay, f.afterEndDay)} 日）`;
  const stmt = h('p', { class: 'gr-chr-stmt', text: `❄ ${text}` });
  if (f.reason) stmt.appendChild(h('span', { class: 'gr-chr-reason', text: f.reason }));
  return h('article', { class: 'gr-chr-entry gr-chr-freeze' }, dateCol, h('div', { class: 'gr-chr-main' }, stmt));
}

/** update 操作の変更前後を短い一文へ（閾値・グループ差し替え・スケジュール変更）。 */
function changeDiffText(change) {
  if (change.op !== 'update' || !change.before || !change.after) return null;
  const parts = [];
  const b = change.before, a = change.after;
  if ((b.thresholdSeconds ?? null) !== (a.thresholdSeconds ?? null) && (b.thresholdSeconds != null || a.thresholdSeconds != null)) {
    parts.push(`${fmtHM(b.thresholdSeconds || 0)} → ${fmtHM(a.thresholdSeconds || 0)}`);
  }
  if ((b.groupIdentityId ?? null) !== (a.groupIdentityId ?? null) || (b.stableGroupId ?? null) !== (a.stableGroupId ?? null)) {
    parts.push('グループを差し替え');
  }
  if (b.label !== a.label && a.label) parts.push(`${b.label || '?'} → ${a.label}`);
  if (b.startDay !== a.startDay || b.endDay !== a.endDay) parts.push('スケジュールを変更');
  return parts.join('・') || null;
}

/**
 * 沿革のルール操作1件を「社史・年表」の1エントリとして組む。
 * 左列＝日付（Day 番号を主役に）、右列＝操作＋理由（明朝）＋配下の答え合わせ（写真/質問ルールのみ）。
 */
function chronicleEntry(entry, imgBase) {
  const removed = entry.change.op === 'remove';
  const opLabel = entry.change.op === 'add' ? '＋追加' : entry.change.op === 'remove' ? '−削除' : '✎変更';
  const dayNum = entry.change.dayNumber;

  const dateCol = h('div', { class: 'gr-chr-date' },
    h('div', { class: 'gr-chr-day-label', text: 'Day' }),
    h('div', { class: 'gr-chr-day-num', text: dayNum != null ? String(dayNum) : '—' }),
    h('div', { class: 'gr-chr-date-sub', text: shortDay(entry.change.dayKey) }),
    removed ? h('span', { class: 'gr-chr-flag', text: '削除' }) : null,
  );

  const diff = changeDiffText(entry.change);
  const stmt = h('p', { class: 'gr-chr-stmt', text: `${opLabel} ${ruleKindIcon(entry.target)} ${entry.label}${diff ? `（${diff}）` : ''}` });
  if (entry.change.reason) stmt.appendChild(h('span', { class: 'gr-chr-reason', text: entry.change.reason }));

  const main = h('div', { class: 'gr-chr-main' }, stmt);
  if (entry.answers && entry.answers.length) main.appendChild(chronicleAnswers(entry, imgBase));

  return h('article', { class: `gr-chr-entry${removed ? ' off' : ''}` }, dateCol, main);
}

/** 写真ルールは画像を図版として、質問ルールは Q&A のペアとして時系列に並べる。 */
function chronicleAnswers(entry, imgBase) {
  const wrap = h('div', { class: 'gr-chr-ev' });
  if (entry.target === 'PHOTO') {
    const plates = h('div', { class: 'gr-chr-plates' });
    for (const a of entry.answers.filter((x) => x.imageId != null)) {
      plates.appendChild(h('figure', { class: 'gr-chr-plate' },
        h('img', { class: 'gr-chr-plate-img', src: `${imgBase}/images/${a.imageId}`, alt: entry.label, loading: 'lazy' }),
        h('figcaption', { text: shortDay(a.dayKey) }),
      ));
    }
    wrap.appendChild(plates);
  } else {
    for (const a of entry.answers) {
      wrap.appendChild(h('div', { class: 'gr-chr-qa' },
        h('time', { text: shortDay(a.dayKey) }),
        h('p', { text: a.answerText || '' }),
      ));
    }
  }
  return wrap;
}

/** 完走フォークで理由つきに「終える」を選んだときの最終エントリ（design D7）。 */
function chronicleEndedNote(rep, note) {
  const dateCol = h('div', { class: 'gr-chr-date' },
    h('div', { class: 'gr-chr-day-label', text: 'Day' }),
    h('div', { class: 'gr-chr-day-num', text: String(note.dayNumber) }),
  );
  const stmt = h('p', { class: 'gr-chr-stmt', text: `${rep.goal.name} をここで終える` },
    h('span', { class: 'gr-chr-reason', text: note.reason }));
  return h('article', { class: 'gr-chr-entry' }, dateCol, h('div', { class: 'gr-chr-main' }, stmt));
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
function blockCalendar(rep, rs, root) {
  const card = grCard('① 達成カレンダー');
  const scroll = h('div', { class: 'gr-cal-scroll' });
  const grid = h('div', { class: 'gr-cal' });
  grid.style.gridTemplateColumns = `minmax(92px, 132px) repeat(${rep.goal.dayCount}, 17px)`;

  // クリックで開く日別詳細モーダル（既存の④選択・ハイライトは維持したまま追加で開く・design D5）。
  // デモモードは本番用の GET /api/summary・GET/PUT /api/reflection/:date を持たないため開かない（design D6）。
  const onDayClick = (dayNumber) => {
    rs.renderReader(dayNumber);
    if (!isDemo()) openDayDetailModal(rep, dayNumber, () => renderReport(root, rep.goal.id));
  };

  // ヘッダ行（空 + Day 番号）
  grid.appendChild(h('div', { class: 'gr-cal-corner' }));
  for (let d = 1; d <= rep.goal.dayCount; d++) {
    const head = h('div', { class: 'gr-cal-dh', text: String(d) });
    head.addEventListener('click', () => onDayClick(d));
    attachDayHoverPreview(head, rep.days[d - 1]);
    rs.headerByDay.set(d, head);
    grid.appendChild(head);
  }

  // ルールごとの行。未到来（future）は空白マスにする＝走行中プレビューで残りを黒星で埋めない。
  // 対象外（inactive・開始前／削除後）も同様に空白マスにする（design: goal-report）。
  // 凍結（frozen）は対象外の一種だが、開始前・削除後とは見分けがつく見た目で描く（spec: goal-report）。
  for (const p of rep.rules) {
    grid.appendChild(h('div', { class: 'gr-cal-label', text: `${ruleKindIcon(p.target)} ${ruleNiceLabel(p.target, p.label)}`, title: p.label }));
    for (const cell of p.cells) {
      const blank = cell.future || cell.inactive;
      const kind = cell.frozen ? 'frozen' : blank ? 'future' : cell.met ? 'done' : 'miss';
      const label = cell.frozen ? '凍結中（対象外）' : blank ? 'まだ来ていない／対象外' : cell.met ? 'やった' : 'やってない';
      const el = h('button', {
        class: `gr-cell ${kind}`,
        type: 'button',
        title: `Day ${cell.dayNumber}: ${label}`,
      });
      el.addEventListener('click', () => onDayClick(cell.dayNumber));
      attachDayHoverPreview(el, rep.days[cell.dayNumber - 1]);
      if (!rs.cellsByDay.has(cell.dayNumber)) rs.cellsByDay.set(cell.dayNumber, []);
      rs.cellsByDay.get(cell.dayNumber).push(el);
      grid.appendChild(el);
    }
  }
  scroll.appendChild(grid);
  card.appendChild(scroll);
  const legend = h('div', { class: 'gr-legend' },
    h('span', {}, h('span', { class: 'gr-cell done gr-legend-swatch' }), 'やった'),
    h('span', {}, h('span', { class: 'gr-cell miss gr-legend-swatch' }), 'やってない'),
  );
  // 未到来・対象外が1マスでもあるときだけ凡例に足す。完走レポートの凡例は従来どおり2値。
  if (rep.rules.some((p) => p.cells.some((c) => c.future || c.inactive)))
    legend.appendChild(h('span', {}, h('span', { class: 'gr-cell future gr-legend-swatch' }), 'まだ来ていない／対象外'));
  if (rep.rules.some((p) => p.cells.some((c) => c.frozen)))
    legend.appendChild(h('span', {}, h('span', { class: 'gr-cell frozen gr-legend-swatch' }), '凍結（対象外）'));
  card.appendChild(legend);
  return card;
}

const DAY_DETAIL_MOOD_LABELS = ['いまひとつ', 'まあまあ', 'ふつう', '良い', 'とても良い'];

/**
 * ①のマスをクリックしたときに開く日別詳細モーダル（spec: goal-report-day-detail）。
 * ブロック1「この日にやったこと」はレポート取得済みの rep.rules[*].cells をそのまま使い、
 * 新規のルール評価はしない（design D2）。ブロック2「時間の内訳」・ブロック3「気分・振り返り」は
 * この日1件ぶんだけ、モーダルを開くたびに都度フェッチする（全日先読みしない・design D2）。
 * 編集・保存できるのは振り返り（ブロック3）だけ。保存後は差分更新せずレポート全体を再取得する（design D4）。
 */
async function openDayDetailModal(rep, dayNumber, onSaved) {
  const day = rep.days[dayNumber - 1];
  const dayKey = day.dayKey;

  const body = h('div', { class: 'modal-body stack gr-daymodal' });

  // ブロック1: この日にやったこと。
  const doneList = h('div', { class: 'gr-daymodal-rules' });
  for (const p of rep.rules) {
    const cell = p.cells[dayNumber - 1];
    const blank = cell.future || cell.inactive;
    const statusClass = cell.frozen ? 'frozen' : blank ? 'future' : cell.met ? 'done' : 'miss';
    const statusText = cell.frozen ? '凍結中（対象外）' : blank ? 'まだ来ていない／対象外' : cell.met ? 'やった' : 'やってない';
    doneList.appendChild(h('div', { class: 'gr-daymodal-rule' },
      h('span', { class: 'gr-daymodal-rule-label', text: `${ruleKindIcon(p.target)} ${ruleNiceLabel(p.target, p.label)}` }),
      p.isTimeType && cell.actualSeconds != null
        ? h('span', { class: 'gr-daymodal-rule-nums', text: `${fmtHM(cell.actualSeconds)} / ${cell.thresholdSeconds != null ? fmtHM(cell.thresholdSeconds) : '—'}` })
        : null,
      h('span', { class: `gr-daymodal-rule-status ${statusClass}`, text: statusText }),
    ));
  }
  body.appendChild(h('div', { class: 'gr-daymodal-sec' },
    h('h4', { class: 'gr-fsec-title', text: 'この日にやったこと' }),
    doneList,
  ));

  // ブロック2: 時間の内訳（GET /api/summary?date= を都度フェッチ）。
  const timeList = h('div', { class: 'gr-daymodal-time' }, h('p', { class: 'gr-empty', text: '読み込み中…' }));
  body.appendChild(h('div', { class: 'gr-daymodal-sec' },
    h('h4', { class: 'gr-fsec-title', text: '時間の内訳' }),
    timeList,
  ));

  // ブロック3: 気分・振り返り（GET/PUT /api/reflection/:date）。編集できるのはここだけ（design D3）。
  let satisfaction = 0;
  const moodSegs = [];
  const moodGroup = h('div', { class: 'rf-mood' });
  const syncMood = () => moodSegs.forEach((s, i) => s.classList.toggle('on', i + 1 === satisfaction));
  DAY_DETAIL_MOOD_LABELS.forEach((label, idx) => {
    const val = idx + 1;
    const seg = h('span', { class: 'rf-mood-seg', text: label });
    seg.addEventListener('click', () => { satisfaction = satisfaction === val ? 0 : val; syncMood(); });
    moodSegs.push(seg);
    moodGroup.appendChild(seg);
  });
  const textarea = h('textarea', { class: 'gr-textarea', rows: '4', placeholder: '今日はどんな一日でしたか。' });
  body.appendChild(h('div', { class: 'gr-daymodal-sec' },
    h('h4', { class: 'gr-fsec-title', text: '気分・振り返り' }),
    h('div', { class: 'rf-mood-row' }, h('span', { class: 'rf-mood-label', text: '気分' }), moodGroup),
    textarea,
  ));

  // 目標日記が別に存在する日は読み取り専用で追加表示。編集導線は出さない（design D3）。
  if (day.source === 'journal') {
    body.appendChild(h('div', { class: 'gr-daymodal-journal' },
      h('h4', { class: 'gr-fsec-title', text: '📔 この目標の日記（読み取り専用）' }),
      h('p', { class: 'muted', text: 'これは目標日記です。編集は振り返りタブ／目標コーナーから行えます。' }),
      h('div', { class: 'gr-daymodal-journal-text', text: day.text }),
    ));
  }

  const saveBtn = h('button', { class: 'btn primary', type: 'button', text: '保存' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await api.putReflection(dayKey, textarea.value, satisfaction || null);
      toast('保存しました', 'ok');
      closeModal();
      await onSaved();
    } catch (err) {
      toast(err.data?.error || `失敗: ${err.message}`, 'err');
      saveBtn.disabled = false;
    }
  });
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', type: 'button', text: '閉じる', onclick: closeModal }),
    saveBtn,
  ));

  openModal(body, `Day ${dayNumber}（${dayKey}）`);

  // 時間の内訳（モーダルを開いてからこの日1件ぶんだけ取得・design D2）。
  try {
    const summary = await api.getSummary(dayKey);
    clear(timeList);
    if (!summary.groups.length) {
      timeList.appendChild(h('p', { class: 'gr-empty', text: 'この日の記録はありません' }));
    } else {
      for (const g of summary.groups) {
        timeList.appendChild(h('div', { class: 'gr-daymodal-time-row' },
          h('span', { class: 'gr-daymodal-time-name', text: g.name }),
          h('span', { class: 'gr-daymodal-time-sec', text: fmtDur(g.seconds) }),
        ));
      }
    }
    const targetHours = rep.goal.targetHours;
    if (targetHours) {
      const actual = targetHours.kind === 'TOTAL_WORK'
        ? summary.totalWorkSeconds
        : summary.groups.filter((g) => targetHours.labels.includes(g.name)).reduce((s, g) => s + g.seconds, 0);
      timeList.appendChild(h('div', { class: 'gr-daymodal-time-target' },
        h('span', { text: `目標（1日ぶん） ${fmtDur(targetHours.secondsPerDay)}` }),
        h('span', { text: `実測 ${fmtDur(actual)}` }),
      ));
    }
  } catch (err) {
    clear(timeList);
    timeList.appendChild(h('p', { class: 'gr-empty', text: `時間の内訳を取得できません: ${err.message}` }));
  }

  // 気分・振り返り本文（rep.days の合成テキストとは別に、生の reflection_entry を取得する・design D2）。
  try {
    const r = await api.getReflection(dayKey);
    textarea.value = r && r.content ? r.content : '';
    satisfaction = r && r.satisfaction ? r.satisfaction : 0;
    syncMood();
  } catch { /* noop */ }
}

/**
 * このレポートのルール `p` が、目標時間の対象と一致するか（水準線をどのチャートに足すか・design D2）。
 * `ReportRule` は identity 参照を持たないため、現在の表示名（都度解決済み）で照合する。
 */
function targetHoursMatches(targetHours, p) {
  if (!targetHours) return false;
  if (targetHours.kind === 'TOTAL_WORK') return p.target === 'TOTAL_WORK';
  if (targetHours.kind === 'TIMELINE') return p.target === 'TIMELINE' && p.label === targetHours.labels[0];
  if (targetHours.kind === 'GROUP_SET') return p.target === 'GROUP' && targetHours.labels.includes(p.label);
  return false;
}

// ② 時間型ルールの実測と閾値の推移（＋理由マーカー）
function blockTimeSeries(rep) {
  const card = grCard('② 時間の推移');
  const timeRules = rep.rules.filter((p) => p.isTimeType);
  const targetHours = rep.goal.targetHours;
  for (const p of timeRules) {
    const sub = h('div', { class: 'gr-ts' });
    sub.appendChild(h('div', { class: 'gr-ts-label', text: `${ruleKindIcon(p.target)} ${ruleNiceLabel(p.target, p.label)}` }));
    const canvas = h('canvas', {});
    sub.appendChild(h('div', { class: 'gr-chart-wrap' }, canvas));

    const labels = p.cells.map((c) => c.dayNumber);
    const actualMin = p.cells.map((c) => (c.actualSeconds == null ? null : Math.round(c.actualSeconds / 60)));
    const threshMin = p.cells.map((c) => (c.thresholdSeconds == null ? null : Math.round(c.thresholdSeconds / 60)));
    const datasets = [
      { label: '実測', data: actualMin, borderColor: '#3b5bb5', backgroundColor: 'rgba(59,91,181,0.10)', fill: true, tension: 0.25, pointRadius: 2, spanGaps: false },
      { label: '閾値', data: threshMin, borderColor: '#b06000', borderDash: [5, 4], stepped: true, pointRadius: 0, spanGaps: true },
    ];
    // 目標時間の水準線（1本のみ・design D2）。パスワードの条件ではないため下限の閾値とは
    // 視覚的に区別する見た目（緑・実線・太め）にする。目標時間が無ければ描かない。
    if (targetHoursMatches(targetHours, p)) {
      const levelMin = Math.round(targetHours.secondsPerDay / 60);
      datasets.push({
        label: '目標時間（パスワードの条件になりません）',
        data: labels.map(() => levelMin),
        borderColor: '#2f9e5c', borderWidth: 3, pointRadius: 0, spanGaps: true,
      });
    }
    charts.push(new window.Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
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
    const changes = rep.ruleChanges.filter((t) => t.ruleId === p.ruleId);
    for (const t of changes) {
      const oldS = t.before && t.before.thresholdSeconds != null ? t.before.thresholdSeconds : null;
      const newS = t.after && t.after.thresholdSeconds != null ? t.after.thresholdSeconds : null;
      sub.appendChild(h('div', { class: 'gr-marker' },
        h('span', { class: 'gr-marker-day', text: `Day ${t.dayNumber}` }),
        h('span', { class: 'gr-marker-delta', text: `${oldS == null ? '—' : fmtHM(oldS)} → ${newS == null ? '—' : fmtHM(newS)}` }),
        h('span', { class: 'gr-marker-reason', text: t.reason }),
      ));
    }
    card.appendChild(sub);
  }
  return card;
}

// ③ Before / After（文面並置 ＋ 2モードの画像比較 ＋ 最終日CTA・design D6/D6b）
function blockBeforeAfter(rep, imgBase) {
  const card = h('section', { class: 'gr-card' });
  const state = { mode: 'default' }; // 'default'（最古/最新）| 'all'（全枚数）

  // 見出し＋モード切替トグル。
  const modeSeg = h('div', { class: 'gr-mode-seg' });
  const modeBtns = [
    { v: 'default', label: 'Before / After' },
    { v: 'all', label: '全部くらべる' },
  ].map(({ v, label }) => {
    const b = h('button', { class: 'gr-mode-btn', type: 'button', text: label });
    if (v === state.mode) b.classList.add('on');
    b.addEventListener('click', () => {
      if (state.mode === v) return;
      state.mode = v;
      for (const x of modeSeg.children) x.classList.toggle('on', x === b);
      renderImgs();
    });
    modeSeg.appendChild(b);
    return b;
  });
  const hasImages = () => (rep.reportImages || []).length > 0;
  card.appendChild(h('div', { class: 'gr-block-head' },
    h('h2', { class: 'gr-block-title', style: { margin: '0' }, text: '③ Before / After' }),
    h('div', { class: 'spacer' }),
    hasImages() ? modeSeg : null,
  ));

  // 文面並置（画像とは独立）。After は完走後なら最終日、進行中なら「最も新しい記録のある日」。
  const first = rep.days[0];
  const last = rep.days[(rep.goal.afterDayNumber || rep.days.length) - 1] || rep.days[rep.days.length - 1];
  card.appendChild(h('div', { class: 'gr-ba' }, baCol('Before', first), baCol('After', last)));

  // 最終日（Day30）の写真を追加する CTA。**完走後のみ**（進行中は最終日がまだ来ていない）。
  // デモは閲覧専用なので出さない。
  if (!isDemo() && rep.goal.showFinalPhotoCta)
    card.appendChild(finalPhotoCta(rep, () => { syncToggleVisibility(); renderImgs(); }));

  // 画像領域（モードで再描画）。
  const imgHost = h('div', { class: 'gr-img-host' });
  card.appendChild(imgHost);
  const renderImgs = () => {
    clear(imgHost);
    const el = state.mode === 'all' ? renderAllMode(rep, imgBase) : renderDefaultMode(rep, imgBase);
    if (el) imgHost.appendChild(el);
    // 進行中は最終日 CTA を出していないので、それを案内する文言も出さない。
    else imgHost.appendChild(h('p', { class: 'gr-empty', text: !isDemo() && rep.goal.showFinalPhotoCta
      ? 'まだ写真がありません。上の「＋ 最終日の写真を追加」から追加できます。'
      : 'まだ写真がありません。' }));
  };
  // CTA で最初の1枚が入るとトグルが必要になるので表示を同期する。
  const syncToggleVisibility = () => {
    const head = card.querySelector('.gr-block-head');
    if (hasImages() && !head.contains(modeSeg)) head.appendChild(modeSeg);
  };
  renderImgs();
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

/**
 * reportImages を trim 済みキャプションでグループ化する（design D6）。
 * 空キャプションは各1枚を単独グループ扱い。グループ内は reportImages の並び（dayNumber→sortOrder）を保つ。
 */
function groupImagesByCaption(reportImages) {
  const byCap = new Map();
  const singles = [];
  for (const im of reportImages || []) {
    const cap = (im.caption || '').trim();
    if (!cap) { singles.push({ caption: '', images: [im] }); continue; }
    if (!byCap.has(cap)) byCap.set(cap, []);
    byCap.get(cap).push(im);
  }
  return [...[...byCap.entries()].map(([caption, images]) => ({ caption, images })), ...singles];
}

/** デフォルト: 各グループの最古(Before)/最新(After)の2枚を左右並置（1枚なら単独）。 */
function renderDefaultMode(rep, imgBase) {
  const groups = groupImagesByCaption(rep.reportImages);
  if (!groups.length) return null;
  const wrap = h('div', { class: 'gr-ba-imgs' });
  for (const g of groups) {
    const oldest = g.images[0];
    const newest = g.images[g.images.length - 1];
    if (g.images.length === 1) {
      wrap.appendChild(h('div', { class: 'gr-ba-pair' },
        imgFig(imgBase, oldest, `Before · Day ${oldest.dayNumber}`), h('div', { class: 'gr-ba-figslot' })));
    } else {
      wrap.appendChild(h('div', { class: 'gr-ba-pair' },
        imgFig(imgBase, oldest, `Before · Day ${oldest.dayNumber}`),
        imgFig(imgBase, newest, `After · Day ${newest.dayNumber}`)));
    }
  }
  return wrap;
}

/** 全比較: グループ＝行、古い→新しい順に全枚数を横スクロールで並置。 */
function renderAllMode(rep, imgBase) {
  const groups = groupImagesByCaption(rep.reportImages);
  if (!groups.length) return null;
  const wrap = h('div', { class: 'gr-allrows' });
  for (const g of groups) {
    const row = h('div', { class: 'gr-allrow' });
    row.appendChild(h('div', { class: 'gr-allrow-cap', text: g.caption || '（キャプションなし）' }));
    const strip = h('div', { class: 'gr-allstrip' });
    for (const im of g.images) strip.appendChild(imgFig(imgBase, im, `Day ${im.dayNumber}`));
    row.appendChild(strip);
    wrap.appendChild(row);
  }
  return wrap;
}

/**
 * 最終日（Day30＝end_day）の写真を追加する CTA（3方式）。追加後 `onAdded(meta)` を呼ぶ。
 * 完走後でも保存できる（サーバの D4b により status 不問）。
 */
function finalPhotoCta(rep, onAdded) {
  const goalId = rep.goal.id;
  const endDay = rep.goal.endDay;
  const capInp = h('input', { type: 'text', class: 'gr-cta-cap', placeholder: 'キャプション（例: 体・正面）' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'gr-cta-file' });
  const addLabel = h('label', { class: 'gr-cta-btn' }, '＋ 最終日の写真を追加', fileInput);
  const errorEl = h('div', { class: 'gr-cta-error', hidden: true });
  const el = h('div', { class: 'gr-cta' },
    h('div', { class: 'gr-cta-lead' },
      h('span', { class: 'gr-cta-title', text: '最終日の写真を残しましょう' }),
      h('span', { class: 'gr-cta-sub', text: `Day ${rep.goal.dayCount}（${endDay}）の姿を撮って、初日と並べて変化を確かめられます。` }),
    ),
    h('div', { class: 'gr-cta-form' }, capInp, addLabel),
    errorEl,
  );

  const showErr = (m) => { errorEl.textContent = m; errorEl.hidden = false; };
  const clearErr = () => { errorEl.hidden = true; };
  const attach = async (files) => {
    const arr = [...(files || [])];
    const images = arr.filter(isImageFile);
    if (images.length < arr.length) showErr('画像ファイル以外は追加できません');
    for (const file of images) {
      let dataUrl;
      try { dataUrl = await shrinkImage(file); } catch (e) { showErr(`画像を読み込めません: ${e.message}`); continue; }
      try {
        const meta = await api.addGoalJournalImage(goalId, endDay, { dataUrl, caption: capInp.value.trim() });
        // レポートのメタへ反映（Day30・末尾）→ ③再描画に使う。
        const dayNumber = rep.goal.dayCount;
        rep.reportImages = rep.reportImages || [];
        rep.reportImages.push({ imageId: meta.imageId, caption: meta.caption, dayKey: endDay, dayNumber, sortOrder: meta.sortOrder });
        rep.reportImages.sort((a, b) => (a.caption || '').trim().localeCompare((b.caption || '').trim()) || a.dayNumber - b.dayNumber || a.sortOrder - b.sortOrder);
        const lastDay = rep.days[rep.days.length - 1];
        if (lastDay) { lastDay.images = lastDay.images || []; lastDay.images.push({ imageId: meta.imageId, caption: meta.caption }); }
        clearErr();
        capInp.value = '';
        onAdded(meta);
      } catch (e) {
        showErr(e.status === 400 ? (e.data?.error || '画像を追加できません') : `追加に失敗: ${e.message}`);
      }
    }
  };
  fileInput.addEventListener('change', () => { attach(fileInput.files); fileInput.value = ''; });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
  el.addEventListener('dragleave', (e) => { if (e.target === el) el.classList.remove('drag'); });
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drag'); if (e.dataTransfer) attach(e.dataTransfer.files); });
  el.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); } }
    if (files.length && files.some(isImageFile)) { e.preventDefault(); attach(files); }
  });
  return el;
}

/** 画像1枚（バイナリ URL ＋ タグ／キャプション）。imgBase は `/api/[demo/]goals/:id/journal`。 */
function imgFig(imgBase, meta, tag) {
  const cap = (meta.caption || '').trim();
  const fig = h('figure', { class: 'gr-fig' },
    h('img', { class: 'gr-fig-img', src: `${imgBase}/images/${meta.imageId}`, alt: cap, loading: 'lazy' }),
  );
  if (tag || cap) {
    fig.appendChild(h('figcaption', { class: 'gr-fig-cap' },
      tag ? h('span', { class: 'gr-fig-tag', text: tag }) : null,
      cap ? h('span', { class: 'gr-fig-text', text: cap }) : null,
    ));
  }
  return fig;
}

// ④ 日記リーダー（常に1件）
function blockReader(rep, rs, imgBase) {
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
    // 選択日の画像（読み取り専用・他日の画像は出さない・design D6 / 7.2）。
    const imgs = (day && day.images) || [];
    if (imgs.length) {
      const gallery = h('div', { class: 'gr-reader-imgs' });
      for (const m of imgs) gallery.appendChild(imgFig(imgBase, m, ''));
      bodyHost.appendChild(gallery);
    }
  };
  return card;
}
