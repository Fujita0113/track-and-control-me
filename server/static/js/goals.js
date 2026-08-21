// 目標（30日チャレンジ）タブ: 一覧・新規作成・進捗グラフ
//  (spec: goal-challenge / goal-burnup). 合否・スコアの語や演出は出さない（「完走」のみ）。
//  スタイルは gr-*（一覧・大きい沿革）/ bu-*（進捗グラフ）クラス + CSSOM（CSP: インライン style 属性なし）。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, openModal, closeModal, emptyState, fmtDur, fmtHM, addDays, attachTooltip, ctrlEnterToSave, colorHex } from './util.js';
import { buildRuleForm, ruleDisplayLabel, ruleKindIcon, shortDay } from './rule-form.js';
import { isDemo } from './demo.js';
import { shrinkImage, isImageFile } from './images.js';
import { render as renderBlueprint } from './blueprint.js';
import { renderBurnup } from './goal-burnup-view.js';

// デモ中は取得先を /api/demo/* + 仮想日付へ切替（通常モードは既存経路のまま）。
function fetchGoals() {
  return isDemo() ? api.demo.goals(state.demo.virtualDay).then((r) => r.goals) : api.getGoals();
}
function fetchHistory() {
  return isDemo() ? api.demo.history(state.demo.virtualDay) : api.getGoalHistory();
}
/** 終える呼び出し（進行中・完走どちらも同じ経路・spec: goal-lifecycle-fork）。 */
function endGoalApi(goalId, b) {
  return isDemo() ? api.demo.endGoal(goalId, b, state.demo.virtualDay) : api.endGoal(goalId, b);
}

export function hide() {
  /* 進捗グラフの後始末は goal-burnup-view.js 側（モーダル閉じのみ）。 */
}

export async function show(root) {
  await renderList(root);
}

// --- 一覧 -----------------------------------------------------------------
async function renderList(root) {
  clear(root);

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
const HISTORY_KIND_VERB = { created: 'をはじめた', ended: 'を終えた', resumed: 'を再開した', completed: 'を走りきった' };

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
  // カード一覧と同じ幅・同じ器（.card）に置く。
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
  // 大きい沿革の行から開く先は進捗グラフ（レポートは存在しない・spec: goal-history MODIFIED）。
  // 沿革の行は必ず既に開始済みの目標を指すため、status は canOpenBurnup 判定用のプレースホルダで足りる。
  for (const entry of entries) list.appendChild(historyRow(entry, (goalId) => openBurnup({ id: goalId, name: entry.name, status: 'active' }, root)));
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
  // 再開予約中（再開したが未発効）。状態は終了のままで、発効日を併記する（spec: goal-challenge MODIFIED）。
  if (g.resumingOn) meta.appendChild(h('span', { class: 'badge', text: `再開予約中（${shortDay(g.resumingOn)} から）` }));
  // 一時凍結中を badge で示す（spec: goal-freeze MODIFIED・予約フェーズは廃止）。
  if (g.freeze && g.freeze.state === 'frozen') {
    meta.appendChild(h('span', { class: 'badge gf-badge', text: '❄ 凍結中' }));
  }

  const head = h('div', { class: 'row' },
    h('h3', { text: g.name }),
    meta,
    h('div', { class: 'spacer' }),
  );

  // 導線の数は増やさない（design: goal-burnup D1）。完走後・未回答のカードだけ「続ける」に
  // 差し替わる（＝レポート先頭にあった続ける／終えるフォークの片方をここへ移す・design D1-b）。
  // それ以外（進行中・完走後の決定済み・終了後）は進捗グラフを開く。開始前は出さない。
  if (g.status === 'completed' && g.showLifecycleFork) {
    const contBtn = h('button', { class: 'btn small primary', text: '続ける', type: 'button' });
    contBtn.addEventListener('click', async () => {
      contBtn.disabled = true;
      try {
        const newGoal = isDemo() ? await api.demo.continueGoal(g.id, state.demo.virtualDay) : await api.continueGoal(g.id);
        toast(`新しい目標「${newGoal.name}」を Day 1 で作りました`, 'ok');
        openBurnup({ id: newGoal.id, name: newGoal.name, status: 'active' }, root);
      } catch (err) {
        toast(err.data?.error || `失敗: ${err.message}`, 'err');
        contBtn.disabled = false;
      }
    });
    head.appendChild(contBtn);
  } else if (g.status !== 'upcoming') {
    const openBtn = h('button', { class: 'btn small primary', text: '進捗グラフ', type: 'button' });
    openBtn.addEventListener('click', () => openBurnup(g, root));
    head.appendChild(openBtn);
  }
  // タスク一覧（spec: goal-blueprint）。走る前に組むものなので、開始前の目標でも出す。
  const blueprintBtn = h('button', { class: 'btn small', text: 'タスク一覧', type: 'button' });
  blueprintBtn.addEventListener('click', () => openBlueprint(g, root));
  head.appendChild(blueprintBtn);
  // 開始前は進捗グラフを開けない（まだ1日も走っていない）ので導線を出さない。

  // 「終える」導線（進行中・完走どちらからも。終了済み・終了予約中には出さない）。
  // 終了予約中は代わりに「終了を取り消す」を出す（発効前だけ取り消せる・design D7・D11）。
  // 完走フォーク（続ける／終える）の「終える」だけは、続ける同様デモでも叩ける
  // （demo-rule-tutorial の完走フォークチュートリアル・デモ DB 限定の書き込み）。
  const forkEnd = g.status === 'completed' && g.showLifecycleFork;
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
  } else if ((!isDemo() || forkEnd) && (g.status === 'active' || g.status === 'completed')) {
    const endBtn = h('button', { class: 'btn small', text: '終える', type: 'button' });
    endBtn.addEventListener('click', () => openEndDialog(g, () => renderList(root)));
    head.appendChild(endBtn);
  }

  // 「再開する」導線（発効済みの終了のみ・spec: goal-lifecycle-fork ADDED）。
  // 再開予約中は代わりに「再開を取り消す」を出す（発効前だけ取り消せる・design D4）。
  if (!isDemo() && g.status === 'ended' && g.resumingOn) {
    const cancelResumeBtn = h('button', { class: 'btn small', text: '再開を取り消す', type: 'button' });
    attachTooltip(cancelResumeBtn, { label: `${shortDay(g.resumingOn)} の発効前なら取り消せます` });
    cancelResumeBtn.addEventListener('click', async () => {
      if (!confirm(`「${g.name}」の再開を取り消しますか？`)) return;
      cancelResumeBtn.disabled = true;
      try { await api.cancelResumeGoal(g.id); toast('再開を取り消しました', 'ok'); renderList(root); }
      catch (err) { toast(err.data?.error || `失敗: ${err.message}`, 'err'); cancelResumeBtn.disabled = false; }
    });
    head.appendChild(cancelResumeBtn);
  } else if (!isDemo() && g.status === 'ended') {
    const resumeBtn = h('button', { class: 'btn small', text: '再開する', type: 'button' });
    resumeBtn.addEventListener('click', () => openResumeDialog(g, () => renderList(root)));
    head.appendChild(resumeBtn);
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
  if (g.targetHours) {
    const pace = paceBlock(g, g.status === 'active' || g.status === 'upcoming');
    card.appendChild(pace);
    // 隣に完了予想日を1行だけ足す（バーンアップの平均値そのものはカードへ出さない・design D7 Risks）。
    if (g.status !== 'upcoming') attachForecastLine(pace, g.id);
  }

  const chips = h('div', { class: 'gr-chips' });
  for (const r of g.rules) chips.appendChild(h('span', { class: 'gr-chip', text: `${ruleKindIcon(r.target)} ${ruleDisplayLabel(r)}` }));
  card.appendChild(chips);
  return card;
}

/** 進捗グラフを開く（spec: goal-burnup）。タスク一覧とは別のビューへ行き来できる（design D10）。 */
function openBurnup(g, root) {
  renderBurnup(root, g.id, {
    onBack: () => renderList(root),
    onOpenBlueprint: () => openBlueprint(g, root),
  });
}

/** タスク一覧を開く（spec: goal-blueprint）。進捗グラフとは別のビューへ行き来できる（design D10）。 */
function openBlueprint(g, root) {
  renderBlueprint(root, g.id, {
    goalName: g.name,
    canOpenBurnup: g.status !== 'upcoming',
    onBack: () => renderList(root),
    onOpenBurnup: () => openBurnup(g, root),
  });
}

function fetchBurnupFor(goalId) {
  return isDemo() ? api.demo.burnup(goalId, state.demo.virtualDay) : api.getGoalBurnup(goalId);
}

/** ペースブロックの隣に完了予想日を1行だけ非同期で足す（design D7 Risks）。無ければ何も出さない。 */
function attachForecastLine(paceEl, goalId) {
  const line = h('p', { class: 'gr-pace-forecast muted' });
  paceEl.appendChild(line);
  fetchBurnupFor(goalId)
    .then((v) => {
      if (!v || !v.overall || !v.overall.projectedDay) { line.remove(); return; }
      line.textContent = `完了予想 ${v.overall.projectedDay}（全体平均ペース）`;
    })
    .catch(() => line.remove());
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

// --- 再開する（発効済みの終了のみ・spec: goal-lifecycle-fork ADDED）-------------------------

/** 再開導線。理由（必須）だけを問う。発効は翌日で、発効するまでは取り消せる旨を明示する（design D4）。 */
function openResumeDialog(g, onDone) {
  const body = h('div', { class: 'modal-body stack' });
  body.appendChild(h('p', { class: 'muted' },
    `「${g.name}」を再開します。`,
    h('strong', { text: '明日からパスワードの条件に戻ります' }),
    '。発効するまでは取り消せます。',
  ));

  const reasonInp = h('textarea', { class: 'gr-textarea gr-end-reason-input', rows: '2', placeholder: '例: コーディングテストが終わったので再開したい' });
  body.appendChild(h('label', { class: 'gr-flabel', text: '理由（必須）' }));
  body.appendChild(reasonInp);

  const save = h('button', { class: 'btn primary', text: 'この目標を再開する', type: 'button' });
  save.addEventListener('click', async () => {
    const reason = reasonInp.value.trim();
    if (!reason) { toast('理由を入力してください', 'err'); return; }
    save.disabled = true;
    try {
      await api.resumeGoal(g.id, { reason });
      toast('明日からこの目標を再開します', 'ok');
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
  ctrlEnterToSave(body, save, '再開する');
  openModal(body, '目標を再開する');
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
  // キャプションは大きい沿革（goal-history）の Before/After のグループ化キーになる（design D4-c）。
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

