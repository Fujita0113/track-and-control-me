// 目標（30日チャレンジ）タブ: 一覧・新規作成・完了レポート
//  (spec: goal-challenge / goal-report). 合否・スコアの語や演出は出さない（「完走」のみ）。
//  スタイルは gr-* クラス + CSSOM（CSP: インライン style 属性なし）。② は同梱 Chart.js。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, openModal, closeModal, emptyState, fmtHM, attachTooltip, ctrlEnterToSave } from './util.js';
import { planningSignalLabel } from './targets.js';
import { condEditorRow } from './rules.js';
import { renderMarkdown } from './markdown.js';
import { isDemo } from './demo.js';
import { shortDay, checkWhenText } from './plan-check.js';
import { shrinkImage, isImageFile } from './images.js';

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
      : 'まだ目標がありません。「＋ 新しい目標」から、開始日（今日／明日）の実効ルールの実践を採用して30日チャレンジを始められます。'));
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

  // 完走後・進行中のどちらもレポートへ遷移できる（走行中プレビュー・spec: goal-report）。
  // 同じ画面だが、文言を状態で分けて「まだ途中の姿」であることを一目で伝える。
  if (g.status === 'completed' || g.status === 'active') {
    const label = g.status === 'completed' ? 'レポートを開く' : 'レポートプレビュー';
    const openBtn = h('button', { class: 'btn small primary', text: label, type: 'button' });
    openBtn.addEventListener('click', () => renderReport(root, g.id));
    head.appendChild(openBtn);
  }
  // 開始前はレポートを開けない（まだ1日も走っていない）ので導線を出さない。

  if (!isDemo() && g.canDelete && g.status !== 'completed') {
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

/**
 * 作成フォームの「初日写真」ステージング（design D7）。goalId 未確定のため縮小済み data URL を
 * クライアントに溜め、作成成功後に Day1 へ保存する。3方式（ファイル/貼付/D&D）対応。
 * 返り値の `staged` は `{ dataUrl, caption }` の配列（作成ハンドラが参照）。
 */
function buildCreateImageStager() {
  const staged = [];
  const thumbs = h('div', { class: 'rf-thumbs' });
  const errorEl = h('div', { class: 'rf-img-error', hidden: true });
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'rf-img-file' });
  const addLabel = h('label', { class: 'rf-img-add' }, '＋ 写真を追加', fileInput);
  const zone = h('div', { class: 'rf-imgzone gr-stage' },
    h('div', { class: 'rf-imgzone-head' },
      h('span', { class: 'rf-imgzone-title', text: '初日の写真（任意・Before）' }),
      addLabel,
      h('span', { class: 'rf-img-hint', text: '貼り付け・ドラッグ＆ドロップも可。作成時に Day1 へ保存されます' }),
    ),
    errorEl,
    thumbs,
  );
  const showErr = (m) => { errorEl.textContent = m; errorEl.hidden = false; };
  const clearErr = () => { errorEl.hidden = true; };
  const addThumb = (item) => {
    const cap = h('input', { type: 'text', class: 'rf-thumb-cap', value: item.caption, placeholder: 'キャプション（任意）' });
    cap.addEventListener('input', () => { item.caption = cap.value; });
    const del = h('button', { class: 'rf-thumb-del', type: 'button', title: '削除', text: '×' });
    const cell = h('div', { class: 'rf-thumb' },
      h('img', { class: 'rf-thumb-img', src: item.dataUrl, alt: item.caption }), cap, del);
    del.addEventListener('click', () => { const i = staged.indexOf(item); if (i >= 0) staged.splice(i, 1); cell.remove(); });
    thumbs.appendChild(cell);
  };
  const stage = async (files) => {
    const arr = [...(files || [])];
    const images = arr.filter(isImageFile);
    if (images.length < arr.length) showErr('画像ファイル以外は追加できません');
    for (const file of images) {
      try {
        const dataUrl = await shrinkImage(file);
        const item = { dataUrl, caption: '' };
        staged.push(item);
        addThumb(item);
        clearErr();
      } catch (e) { showErr(`画像を読み込めません: ${e.message}`); }
    }
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

async function openCreateForm(onDone) {
  const body = h('div', { class: 'modal-body stack' });
  const introEl = h('p', { class: 'muted' });
  body.appendChild(introEl);

  const nameInp = h('input', { type: 'text', class: 'gr-input', placeholder: '目標名（例: メンタルを安定させる）' });
  const purposeInp = h('input', { type: 'text', class: 'gr-input', placeholder: '目的の一文（任意）' });
  body.appendChild(h('label', { class: 'gr-flabel', text: '目標名' }));
  body.appendChild(nameInp);
  body.appendChild(h('label', { class: 'gr-flabel', text: '目的' }));
  body.appendChild(purposeInp);

  // --- 開始日の選択（今日から／明日から・既定=今日から）------------------
  // 今日開始は当日を Day1 として即「進行中」。採用候補は選んだ開始日の実効ルールから解決する。
  let start = 'today';
  body.appendChild(h('label', { class: 'gr-flabel', text: '開始日' }));
  const startSeg = h('div', { class: 'gr-start-seg' });
  const startBtns = [
    { v: 'today', label: '今日から' },
    { v: 'tomorrow', label: '明日から' },
  ].map(({ v, label }) => {
    const b = h('button', { class: 'gr-start-btn', type: 'button', text: label });
    if (v === start) b.classList.add('on');
    b.addEventListener('click', () => {
      if (start === v) return;
      start = v;
      for (const x of startSeg.children) x.classList.toggle('on', x === b);
      syncIntro();
      loadCandidates();
    });
    startSeg.appendChild(b);
    return b;
  });
  body.appendChild(startSeg);
  const syncIntro = () => {
    introEl.textContent = start === 'today'
      ? '目標は今日から30日間の固定期間で始まり、当日を Day 1 として進行します。採用した実践は期間中ジャンル固定になります（当日に採用した条件は当日から固定・閾値の変更は理由つきで可能）。'
      : '目標は明日から30日間の固定期間で始まります。採用した実践は期間中ジャンル固定になります（閾値の変更は理由つきで可能）。';
  };
  syncIntro();

  // --- 毎日やること（既存項目の選択 ＋ その場で新規作成を1ブロックに統合）--------
  // 見出し横の＋から、今日タブと同じ条件エディタ（condEditorRow）で全5ターゲットを新規作成できる。
  // 既存の実効ルール項目はチェックで選び、新規行は「これから作成」として開始日ルールへ追記される。
  const groups = await api.getGroups().catch(() => []);

  // ＋で追加する新規行のホスト（condEditorRow をそのまま挿す）。
  const addHost = h('div', { class: 'list gr-newconds' });
  const addBtn = h('button', {
    class: 'btn small', type: 'button', text: '＋ 追加', title: '毎日やることを追加', 'aria-label': '毎日やることを追加',
  });
  addBtn.addEventListener('click', () => {
    // 既定は TIMELINE（カテゴリ＋分数）。種別セレクトで全5ターゲットへ切替できる。削除も可能。
    const row = condEditorRow({ target: 'TIMELINE', label: '', minutes: 30 }, groups, false);
    row.classList.add('gr-newcond-editor');
    addHost.appendChild(row);
  });
  body.appendChild(h('div', { class: 'section-head gr-daily-head' },
    h('label', { class: 'gr-flabel', text: '毎日やること' }),
    addBtn,
  ));
  const noteEl = h('p', { class: 'muted', style: { fontSize: '12px', margin: '0' } });
  body.appendChild(noteEl);

  const candHost = h('div', { class: 'list' });
  body.appendChild(candHost);
  body.appendChild(addHost);

  // 開始日に連動して既存項目（実効ルール）を解決・再描画する。＋の新規行は開始日に依らないので保持する。
  const loadCandidates = async () => {
    noteEl.textContent = start === 'today'
      ? '今日の実効ルールにある項目を選ぶか、＋から新しく作れます（作成すると今日のルールに加わります）。'
      : '明日の実効ルールにある項目を選ぶか、＋から新しく作れます（作成すると明日のルールに加わります）。';
    clear(candHost);
    candHost.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
    let candidates = [];
    try { candidates = await api.getGoalCandidates(start); } catch { candidates = []; }
    clear(candHost);
    if (!candidates.length) {
      candHost.appendChild(emptyState(start === 'today'
        ? '今日の実効ルールに選べる項目がありません。＋から新しく作れます。'
        : '明日の実効ルールに選べる項目がありません。＋から新しく作れます。'));
      return;
    }
    for (const c of candidates) {
      // value=condition_key（total_work / group:… / timeline:… / manual:…）が作成 POST に入る。
      const box = h('input', { type: 'checkbox', value: c.conditionKey });
      const label = niceLabel(c.target, c.conditionKey, c.label);
      // 時間型（TOTAL_WORK/GROUP）のみ「≥ 時間」サブラベルを付ける。
      // MANUAL_CHECK は非時間型（チェックのテキストのみ）、TIMELINE は閾値がラベルに含まれる。
      const sub = (c.target === 'TOTAL_WORK' || c.target === 'GROUP') && c.thresholdSeconds
        ? `　≥ ${fmtHM(c.thresholdSeconds)}` : '';
      candHost.appendChild(h('label', { class: 'cond' },
        box,
        h('div', { class: 'cond-main' }, h('div', { class: 'cond-title', text: label + sub })),
      ));
    }
  };
  await loadCandidates();

  // 初日写真のステージング（作成時に Day1 へ保存）。
  const stager = buildCreateImageStager();
  body.appendChild(h('label', { class: 'gr-flabel', text: '初日の写真（任意）' }));
  body.appendChild(stager.el);

  const save = h('button', { class: 'btn primary', text: '作成', type: 'button' });
  attachTooltip(save, { label: '作成', keys: ['Ctrl', 'Enter'] });
  save.addEventListener('click', async () => {
    const name = nameInp.value.trim();
    if (!name) { toast('目標名を入力してください', 'err'); return; }
    const practices = [...candHost.querySelectorAll('input[type="checkbox"]:checked')].map((b) => b.value);
    // ＋で追加した各行の _get()（{target, thresholdSeconds?, stableGroupId?, label?, signalKey?}）をそのまま送る。
    const newConditions = [...addHost.querySelectorAll('.cond-editor')].map((row) => row._get && row._get()).filter(Boolean);
    if (!practices.length && !newConditions.length) { toast('毎日やることを1つ以上選ぶか、＋から追加してください', 'err'); return; }
    save.disabled = true;
    try {
      const g = await api.createGoal({ name, purpose: purposeInp.value.trim(), practices, newConditions, start });
      // ステージ済みの初日写真を Day1（start_day）へ保存（個別失敗はトーストのみ・作成は成立済み）。
      for (const item of stager.staged) {
        try { await api.addGoalJournalImage(g.id, g.startDay, { dataUrl: item.dataUrl, caption: (item.caption || '').trim() }); }
        catch (e) { toast(`写真の保存に失敗: ${e.data?.error || e.message}`, 'err'); }
      }
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
  page.appendChild(h('header', { class: 'gr-header' },
    h('div', { class: 'gr-eyebrow', text: running ? `Day ${rep.goal.dayNumber}/${rep.goal.dayCount}` : '完走' }),
    h('h1', { class: 'gr-h1', text: rep.goal.name }),
    rep.goal.purpose ? h('p', { class: 'gr-purpose-line', text: rep.goal.purpose }) : null,
    h('div', { class: 'gr-header-meta' },
      h('span', { text: `${rep.goal.startDay} 〜 ${rep.goal.endDay}` }),
      h('span', { class: 'gr-dot', text: '·' }),
      // 進行中の達成日数は「その時点まで」の事実（分母は現時点までの日数）。
      h('span', { class: 'gr-achieved', text: running
        ? `達成 ${rep.goal.achievedDays}/${rep.goal.elapsedDays}（現時点）`
        : `達成 ${rep.goal.achievedDays}/${rep.goal.dayCount}` }),
    ),
  ));

  // 読み手状態（④ で使う。①のマス/日付セレクタから連動）。
  const readerState = { selected: 1, cellsByDay: new Map(), headerByDay: new Map(), renderReader: null };

  // 画像バイナリのベース URL（デモは /api/demo/… 経路へ切替・design D8）。
  const imgBase = `${isDemo() ? '/api/demo/goals/' : '/api/goals/'}${rep.goal.id}/journal`;

  // ① 達成カレンダー
  page.appendChild(blockCalendar(rep, readerState));
  // ② 時間の推移（時間型実践がある場合のみ）
  if (rep.hasTimeType) page.appendChild(blockTimeSeries(rep));
  // ③ Before / After（2モード＋最終日CTA）
  page.appendChild(blockBeforeAfter(rep, imgBase));
  // ④ 日記リーダー
  page.appendChild(blockReader(rep, readerState, imgBase));
  // ⑤ 沿革（Plan と Check の答え合わせ。日記は載らない）
  page.appendChild(blockChronicle(rep, imgBase));

  readerState.renderReader();
}

// ⑤ 沿革（spec: goal-chronicle）
//
// Plan を時系列に並べ、その下に Check を入れ子で置く。写真は画像、質問は Q&A のペア。
// 取り下げは理由つきで残す（消さない＝逃げた事実そのものが歴史）。
// **日記は載せない**（載る／載らないの線引きは「大きさ」ではなく「検証がぶら下がるか」）。
// スコア・演出（紙吹雪・バッジ・合否の語）は出さず、素の時系列リストとして静かに提示する。
function blockChronicle(rep, imgBase) {
  const card = grCard('⑤ 沿革');
  const plans = (rep.chronicle && rep.chronicle.plans) || [];
  if (!plans.length) {
    card.appendChild(h('p', { class: 'gr-empty', text: 'まだ Plan はありません。振り返りタブで賭けを立てると、ここに積み上がります。' }));
    return card;
  }
  const list = h('div', { class: 'gr-chr' });
  for (const p of plans) list.appendChild(chroniclePlan(p, rep, imgBase));
  card.appendChild(list);
  return card;
}

/**
 * 沿革の Plan 1件を「社史・年表」の1エントリとして組む。
 * 左列＝日付（Day 番号を主役に）、右列＝賭けの一文（明朝）＋配下 Check。
 * 縦罫を貫く小さな菱形の節で時系列をつなぐ（色分け・絵文字は使わない）。
 */
function chroniclePlan(plan, rep, imgBase) {
  const withdrawn = plan.status === 'withdrawn';
  const dayNum = dayNumberOf(rep, plan.dayKey);

  const dateCol = h('div', { class: 'gr-chr-date' },
    h('div', { class: 'gr-chr-day-label', text: 'Day' }),
    h('div', { class: 'gr-chr-day-num', text: dayNum != null ? String(dayNum) : '—' }),
    h('div', { class: 'gr-chr-date-sub', text: shortDay(plan.dayKey) }),
    // 取り下げは貶めず、社史が終了事業を淡々と載せるのと同じ扱い（日付脇の小さな標）。
    withdrawn ? h('span', { class: 'gr-chr-flag', text: '取り下げ' }) : null,
  );

  const stmt = h('p', { class: 'gr-chr-stmt', text: plan.body });
  if (withdrawn)
    stmt.appendChild(h('span', { class: 'gr-chr-reason', text: plan.withdrawReason || '' }));

  const main = h('div', { class: 'gr-chr-main' }, stmt);
  for (const c of plan.checks) main.appendChild(chronicleCheck(c, imgBase, withdrawn));

  return h('article', { class: `gr-chr-entry${withdrawn ? ' off' : ''}` }, dateCol, main);
}

/** 沿革の Check 1件。種別は色でなく「形」で分ける（写真＝図版プレート／問い＝Q&A の文）。 */
function chronicleCheck(check, imgBase, planWithdrawn) {
  const cancelled = check.status === 'cancelled';
  const isPhoto = check.kind === 'photo';
  const label = isPhoto ? check.caption : check.questionText;

  const ev = h('div', { class: `gr-chr-ev${cancelled ? ' off' : ''}` },
    h('div', { class: 'gr-chr-cap' },
      h('span', { class: 'gr-chr-cap-kind', text: isPhoto ? '写真 ── ' : '問い ── ' }),
      h('b', { text: label }),
    ),
  );

  // Check 単体の取り下げのみ理由をここに出す。Plan ごとの取り下げは左列の標＋Plan の理由で示すため、
  // 配下 Check に同じ理由を重ねて出さない（重複を避ける）。
  if (cancelled && !planWithdrawn)
    ev.appendChild(h('p', { class: 'gr-chr-quit', text: check.cancelReason || '' }));

  if (isPhoto) {
    // 提出画像を読み取り専用の図版として時系列に並べる。
    const imgs = check.results.filter((r) => r.imageId != null);
    if (imgs.length) {
      const plates = h('div', { class: 'gr-chr-plates' });
      for (const r of imgs) {
        plates.appendChild(h('figure', { class: 'gr-chr-plate' },
          h('img', { class: 'gr-chr-plate-img', src: `${imgBase}/images/${r.imageId}`, alt: label, loading: 'lazy' }),
          h('figcaption', { text: shortDay(r.dayKey) }),
        ));
      }
      ev.appendChild(plates);
    }
  } else {
    // 質問は Q&A（工夫→結果の記録そのもの）。
    for (const r of check.results) {
      ev.appendChild(h('div', { class: 'gr-chr-qa' },
        h('time', { text: shortDay(r.dayKey) }),
        h('p', { text: r.answerText || '' }),
      ));
    }
  }

  // 範囲Check は事実の件数を静かに添える（未回答日を美化も負債化もしない）。
  if (check.schedule === 'range')
    ev.appendChild(h('div', { class: 'gr-chr-note', text: `${check.spanDays}日のうち${check.results.length}日。` }));

  return ev;
}

/** rep.days から Plan の day_key の Day 番号を引く（期間外・不明は null）。 */
function dayNumberOf(rep, dayKey) {
  const d = (rep.days || []).find((x) => x.dayKey === dayKey);
  return d ? d.dayNumber : null;
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

  // 実践ごとの行。未到来（future）は空白マスにする＝走行中プレビューで残りを黒星で埋めない。
  for (const p of rep.practices) {
    grid.appendChild(h('div', { class: 'gr-cal-label', text: niceLabel(p.target, p.conditionKey, p.label), title: p.label }));
    for (const cell of p.cells) {
      const kind = cell.future ? 'future' : cell.met ? 'done' : 'miss';
      const el = h('button', {
        class: `gr-cell ${kind}`,
        type: 'button',
        title: `Day ${cell.dayNumber}: ${cell.future ? 'まだ来ていない' : cell.met ? 'やった' : 'やってない'}`,
      });
      el.addEventListener('click', () => rs.renderReader(cell.dayNumber));
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
  // 未到来が1マスでもある（＝進行中）ときだけ凡例に足す。完走レポートの凡例は従来どおり2値。
  if (rep.practices.some((p) => p.cells.some((c) => c.future)))
    legend.appendChild(h('span', {}, h('span', { class: 'gr-cell future gr-legend-swatch' }), 'まだ来ていない'));
  card.appendChild(legend);
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
