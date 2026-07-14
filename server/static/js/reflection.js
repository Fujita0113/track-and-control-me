// 振り返り(spec: reflection-journal). ref/reflection/振り返り.dc.html 忠実移植。
//  - 左: タイトル / 5 段階「気分」ピル / インライン・ライブ Markdown エディタ(md-editor.js)+ 下部クローム
//  - 右レール: 対象日(date) / 過去の振り返り(日付・気分・2 行抜粋)
//  - 保存: 手動「保存する」ボタン + 日付切替・過去選択・タブ離脱時に未保存分をフラッシュ
//  - スタイルは全て rf-* クラス + CSSOM(CSP: インライン style 属性なし)。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, emptyState, addDays, colorHex, fmtDur, fmtClock } from './util.js';
import { createMarkdownEditor } from './md-editor.js';
import { setTomorrowMode } from './kanban.js';
import { renderMarkdown } from './markdown.js';
import { isDemo } from './demo.js';
import { shrinkImage, isImageFile } from './images.js';

/** b − a の日数差（UTC 計算）。 */
function dayDiff(a, b) {
  const toUtc = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

const MOOD_LABELS = ['いまひとつ', 'まあまあ', 'ふつう', '良い', 'とても良い'];

/** 未記録スライス／ギャップ帯の中立色。 */
const NEUTRAL = '#c3cbd8';

let ctx = null;

export function hide() {
  flush();
  destroyOverview();
  document.body.classList.remove('rf-page');
  ctx = null;
}

/** 右オーバーレイパネルの DOM 破棄（多重生成・リーク防止）。 */
function destroyOverview() {
  if (!ctx) return;
  if (ctx.panel && ctx.panel.parentNode) ctx.panel.parentNode.removeChild(ctx.panel);
  ctx.panel = null;
}

/**
 * デモ: 目標ごとの記録コーナーの見え方を読み取り専用で表示（保存動線なし・spec: demo-mode）。
 * 仮想「今日」が目標期間内ならその日のサンプル記録を、期間外（開始前を含む）なら期間内の
 * 代表日のサンプル記録をプレビューとして表示する（デモ入場直後の空表示を解消）。
 */
async function showDemo(root) {
  ctx = null; // 書き込み ctx を持たない → hide() の flush は完全 no-op。
  document.body.classList.remove('rf-page');
  clear(root);
  const wrap = h('div', { class: 'stack' });
  root.appendChild(wrap);
  wrap.appendChild(h('div', { class: 'section-head' },
    h('h2', {}, '振り返り', h('span', { class: 'muted', style: { fontSize: '13px', fontWeight: '400' }, text: 'デモ・閲覧専用' })),
  ));

  const g = state.demo.goal;
  const vd = state.demo.virtualDay;
  if (!g) {
    wrap.appendChild(emptyState('サンプルを読み込めませんでした。設定タブで「サンプルをリセット」をお試しください。'));
    return;
  }

  const dayCount = g.dayCount || 30;
  const inPeriod = vd >= g.startDay && vd <= g.endDay;
  // 期間内はその仮想日付、期間外（開始前含む）は代表日（Day 4・習慣が回っている好調日）を表示する。
  const targetDay = inPeriod ? vd : addDays(g.startDay, 3);
  const dayNum = dayDiff(g.startDay, targetDay) + 1;

  const titleRow = h('div', { class: 'row' },
    h('div', { class: 'card-title', text: `${g.name} — Day ${dayNum}/${dayCount}（${targetDay}）の記録` }),
    h('div', { class: 'spacer' }),
  );
  if (!inPeriod) titleRow.appendChild(h('span', { class: 'badge', text: 'プレビュー' }));

  const bodyHost = h('div', { class: 'gr-reader-body' });
  wrap.appendChild(h('div', { class: 'card' }, titleRow, bodyHost));

  // 一日の配分バー（デモ DB・読み取り専用）。対象日の記録があれば非空で表示する
  // （reflection-alloc-group-identity: 同名同色グループが1本へ合算されるのを確認できる）。
  const allocWrap = h('div', { class: 'rf-alloc' });
  wrap.appendChild(allocWrap);
  api.demo.allocation(targetDay)
    .then((alloc) => allocWrap.appendChild(buildAllocCard(alloc)))
    .catch(() => { /* noop: 配分の失敗は日記閲覧を妨げない */ });

  let content = '';
  try { const r = await api.demo.journal(g.id, targetDay); content = r.content || ''; } catch { /* noop */ }
  if (content.trim()) bodyHost.appendChild(renderMarkdown(content));
  else bodyHost.appendChild(h('p', { class: 'muted', text: 'この日の記録はありません。' }));

  wrap.appendChild(h('p', { class: 'muted', text: inPeriod
    ? 'デモでは閲覧のみです。上部バーで日付を進めると、各日の日記を読み進められます。完走レポートの「毎日の日記」も同じ内容です。'
    : 'この仮想日付は目標期間外のため、記録コーナーの見え方を代表日のサンプルでプレビューしています。上部バーで進行中（開始〜完走の間）に進めると、その日の記録を閲覧できます。' }));
}

export async function show(root) {
  clear(root);
  // デモ中は進行中サンプルの記入済み日記を仮想日付で閲覧表示（保存動線は出さない）。
  if (isDemo()) { await showDemo(root); return; }
  document.body.classList.add('rf-page');

  // --- クローム更新（文字数・プレースホルダ・dirty） ---
  const phEl = h('div', { class: 'rf-ph', text: '今日はどんな一日でしたか。Markdown で自由にどうぞ。' });
  const countEl = h('span', { class: 'rf-count', text: '0 文字' });
  const onEditorChange = (rawText) => {
    countEl.textContent = [...rawText.replace(/\s/g, '')].length + ' 文字';
    phEl.style.display = rawText.trim() === '' ? 'block' : 'none';
    if (ctx && !ctx.loading) ctx.dirty = true;
  };

  const editor = createMarkdownEditor({
    placeholder: '今日はどんな一日でしたか。Markdown で自由にどうぞ。',
    onChange: onEditorChange,
    // Ctrl/Cmd+Enter で保存（saveBtn は後段で定義されるが、呼び出しは描画後のため参照解決済み）。
    onSubmit: () => doSave(saveBtn),
  });

  // --- 気分ピル ---
  const moodSegs = [];
  const moodGroup = h('div', { class: 'rf-mood' });
  const syncMood = () => moodSegs.forEach((s, i) => s.classList.toggle('on', i + 1 === ctx.satisfaction));
  MOOD_LABELS.forEach((label, idx) => {
    const val = idx + 1;
    const seg = h('span', { class: 'rf-mood-seg', text: label });
    seg.addEventListener('click', () => {
      ctx.satisfaction = ctx.satisfaction === val ? 0 : val;
      ctx.dirty = true;
      syncMood();
    });
    moodSegs.push(seg);
    moodGroup.appendChild(seg);
  });
  const moodRow = h('div', { class: 'rf-mood-row' },
    h('span', { class: 'rf-mood-label', text: '今日の気分' }), moodGroup);

  // --- エディタカード + クローム ---
  const savedEl = h('span', { class: 'rf-saved', text: '保存しました' });
  const saveBtn = h('button', { class: 'rf-save', type: 'button', text: '保存する' });
  // 就寝前リチュアル: 振り返り保存 → 明日の計画モード ON → カンバンへ遷移。
  const planBtn = h('button', { class: 'rf-save', type: 'button', text: '振り返りを終えて明日の計画へ →' });
  const hint = h('span', { class: 'rf-hint' });
  hint.append('# 見出し', sep(), '**太字**', sep(), '- 箇条書き', sep(), '> 引用', sep(), '`コード`');

  const card = h('div', { class: 'rf-card' },
    h('div', { class: 'rf-ed-wrap' }, phEl, editor.el),
    h('div', { class: 'rf-chrome' },
      hint,
      h('div', { class: 'rf-chrome-right' }, countEl, savedEl, saveBtn, planBtn),
    ),
  );

  // 目標日記コーナー（進行中の目標ごと）。本文エディタの下に置き、同じ保存動線に相乗りする。
  const journalsHost = h('div', { class: 'rf-journals' });

  // 一日の配分バー（エディタ上部・常設）＋ 右オーバーレイの縦帯タイムライン トグル。
  const allocHost = h('div', { class: 'rf-alloc' });
  // トグルは目立つアクセント色＋アイコン＋シェブロン（開閉状態が一目で分かる）。既定は開。
  const tlToggle = h('button', { class: 'rf-tl-toggle', type: 'button' },
    h('span', { class: 'rf-tl-ico', text: '▤' }),
    h('span', { class: 'rf-tl-lbl', text: 'タイムライン' }),
    h('span', { class: 'rf-tl-chevron', text: '❯' }),
  );
  const titleRow = h('div', { class: 'rf-head-row' },
    h('h1', { class: 'rf-title', text: '今日の振り返り' }),
    h('div', { class: 'spacer' }),
    tlToggle,
  );
  const left = h('section', { class: 'rf-left' }, titleRow, moodRow, allocHost, card, journalsHost);

  // 右オーバーレイの縦帯タイムライン パネル（既定は開・position:fixed、body 直下に配置）。
  const panelBody = h('div', { class: 'rf-tlpanel-body' });
  const panelClose = h('button', { class: 'rf-tlpanel-close', type: 'button', text: '×' });
  const panel = h('aside', { class: 'rf-tlpanel' },
    h('div', { class: 'rf-tlpanel-head' },
      h('span', { class: 'rf-tlpanel-title', text: 'タイムライン' }),
      panelClose,
    ),
    panelBody,
  );
  document.body.appendChild(panel);

  // --- 右レール ---
  const dateInput = h('input', { type: 'date', class: 'rf-cal', value: state.today });
  const historyHost = h('div', { class: 'rf-past-list' });
  const rail = h('aside', { class: 'rf-rail' },
    h('div', {},
      h('label', { class: 'rf-label', text: '対象日' }),
      dateInput,
    ),
    h('div', {},
      h('h2', { class: 'rf-past-h2', text: '過去の振り返り' }),
      historyHost,
    ),
  );

  root.appendChild(h('div', { class: 'rf-main' }, left, rail));

  // 既定でパネルを開く（issue #17: 初めは開いていてほしい／閉じられるようにはする）。
  ctx = { date: state.today, satisfaction: 0, dirty: false, loading: false, editor, dateInput, historyHost, savedEl, saveBtn, syncMood, renderHistory, journalsHost, journals: [], activeGoals: [],
    allocHost, panel, panelBody, panelOpen: true };
  panel.classList.add('open');
  tlToggle.classList.add('on');

  // --- 挙動配線 ---
  const togglePanel = () => {
    ctx.panelOpen = !ctx.panelOpen;
    ctx.panel.classList.toggle('open', ctx.panelOpen);
    tlToggle.classList.toggle('on', ctx.panelOpen);
    // 開いた時のみ対象日の timeline を取得（閉じている間はフェッチしない・task 4.5）。
    if (ctx.panelOpen) renderTimelinePanel(ctx.date);
  };
  tlToggle.addEventListener('click', togglePanel);
  panelClose.addEventListener('click', () => { if (ctx.panelOpen) togglePanel(); });
  saveBtn.addEventListener('click', () => doSave(saveBtn));
  planBtn.addEventListener('click', () => goToPlanning(planBtn));
  dateInput.addEventListener('change', () => { flush(); loadEditorForDate(dateInput.value || state.today); });
  dateInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      flush();
      loadEditorForDate(dateInput.value || state.today);
    }
  });

  // 進行中の目標を取得（日記コーナーの対象）。
  ctx.activeGoals = (await api.getGoals().catch(() => [])).filter((g) => g.status === 'active');

  await loadEditorForDate(state.today);
  await loadHistory();
}

/** 目標の日記コーナー（見出し + ライブ Markdown エディタ + 画像ゾーン）。本文保存は振り返りと同じ動線に相乗り。 */
function journalCorner(goal, content, date) {
  const entry = { goalId: goal.id, dirty: false, editor: null };
  const ph = h('div', { class: 'rf-ph', text: `${goal.name} の今日の記録。Markdown で自由にどうぞ。` });
  const editor = createMarkdownEditor({
    initial: content || '',
    placeholder: `${goal.name} の今日の記録`,
    onChange: (raw) => {
      ph.style.display = raw.trim() === '' ? 'block' : 'none';
      if (ctx && !ctx.loading) entry.dirty = true;
    },
    // Ctrl/Cmd+Enter で本文・全目標日記をまとめて保存（振り返りと同じ動線）。
    onSubmit: () => doSave(ctx.saveBtn),
  });
  entry.editor = editor;
  ctx.journals.push(entry);

  const corner = h('div', { class: 'rf-journal' },
    h('div', { class: 'rf-journal-head' },
      h('span', { class: 'rf-journal-title', text: goal.name }),
      h('span', { class: 'rf-journal-tag', text: `Day ${goal.dayNumber}/${goal.dayCount}` }),
    ),
    h('div', { class: 'rf-ed-wrap' }, ph, editor.el),
  );
  // 画像ゾーン（追加導線＋サムネイル一覧）。画像操作は本文の dirty/flush と独立（reflection_done 非汚染）。
  corner.appendChild(buildImageZone(goal.id, date, corner));
  return corner;
}

// --- 目標日記の画像ゾーン（design D7 / spec: goal-journal）------------------

/** 画像ゾーンを構築し、その日の画像を非同期で読み込む（本文編集を妨げない・失敗は局所表示）。 */
function buildImageZone(goalId, date, corner) {
  const thumbs = h('div', { class: 'rf-thumbs' });
  const errorEl = h('div', { class: 'rf-img-error', hidden: true });
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'rf-img-file' });
  const addLabel = h('label', { class: 'rf-img-add' }, '＋ 画像を追加', fileInput);
  const zone = { goalId, date, thumbs, errorEl };

  const el = h('div', { class: 'rf-imgzone' },
    h('div', { class: 'rf-imgzone-head' },
      h('span', { class: 'rf-imgzone-title', text: '画像' }),
      addLabel,
      h('span', { class: 'rf-img-hint', text: '貼り付け（Ctrl+V）・ドラッグ＆ドロップも可' }),
    ),
    errorEl,
    thumbs,
  );

  // ① ファイル選択。
  fileInput.addEventListener('change', () => {
    attachImages(fileInput.files, zone);
    fileInput.value = ''; // 同じファイルの再選択を可能に。
  });

  // ② ドラッグ＆ドロップ（ゾーン全体）。
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
  el.addEventListener('dragleave', (e) => { if (e.target === el) el.classList.remove('drag'); });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag');
    if (e.dataTransfer && e.dataTransfer.files) attachImages(e.dataTransfer.files, zone);
  });

  // ③ 貼り付け（コーナー内フォーカス時の Ctrl/Cmd+V）。エディタからバブルした paste も拾う。
  corner.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); } }
    if (files.length && files.some(isImageFile)) { e.preventDefault(); attachImages(files, zone); }
  });

  // その日の既存画像を読み込む（本文ロードと独立に失敗を握る）。
  api.listGoalJournalImages(goalId, date)
    .then((metas) => { for (const m of metas || []) thumbs.appendChild(thumbCell(zone, m)); })
    .catch(() => { /* 読み込み失敗は本文編集を妨げない（局所無表示） */ });

  return el;
}

/** 選択/貼付/ドロップで得た File 群を縮小 → 追加 → サムネイル反映する。 */
async function attachImages(files, zone) {
  const arr = [...(files || [])];
  const images = arr.filter(isImageFile);
  if (images.length < arr.length) showZoneError(zone, '画像ファイル以外は追加できません');
  for (const file of images) {
    let dataUrl;
    try {
      dataUrl = await shrinkImage(file);
    } catch (e) {
      showZoneError(zone, `画像を読み込めませんでした: ${e.message}`);
      continue;
    }
    try {
      const meta = await api.addGoalJournalImage(zone.goalId, zone.date, { dataUrl, caption: '' });
      zone.thumbs.appendChild(thumbCell(zone, meta));
      clearZoneError(zone);
    } catch (e) {
      showZoneError(zone, e.status === 400 ? (e.data?.error || '画像を追加できません')
        : e.status === 409 ? '進行中の目標にのみ画像を追加できます'
        : `追加に失敗: ${e.message}`);
    }
  }
}

/** サムネイル（画像＋キャプション入力＋削除）。キャプション/削除は即時反映・本文と独立。 */
function thumbCell(zone, meta) {
  const img = h('img', { class: 'rf-thumb-img', src: `/api/goals/${zone.goalId}/journal/images/${meta.imageId}`, alt: meta.caption || '', loading: 'lazy' });
  const cap = h('input', { type: 'text', class: 'rf-thumb-cap', value: meta.caption || '', placeholder: 'キャプション（任意）' });
  const commit = () => {
    const v = cap.value.trim();
    if (v === (meta.caption || '')) return;
    api.updateGoalJournalImageCaption(zone.goalId, meta.imageId, v)
      .then(() => { meta.caption = v; clearZoneError(zone); })
      .catch((e) => showZoneError(zone, `キャプション保存に失敗: ${e.message}`));
  };
  cap.addEventListener('blur', commit);
  cap.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME 変換確定の Enter は無視。
    if (e.key === 'Enter') { e.preventDefault(); cap.blur(); }
  });
  const del = h('button', { class: 'rf-thumb-del', type: 'button', title: '削除', text: '×' });
  const cell = h('div', { class: 'rf-thumb' }, img, cap, del);
  del.addEventListener('click', async () => {
    if (!confirm('この画像を削除しますか？')) return;
    try { await api.deleteGoalJournalImage(zone.goalId, meta.imageId); cell.remove(); clearZoneError(zone); }
    catch (e) { showZoneError(zone, `削除に失敗: ${e.message}`); }
  });
  return cell;
}

function showZoneError(zone, msg) {
  zone.errorEl.textContent = msg;
  zone.errorEl.hidden = false;
}
function clearZoneError(zone) {
  zone.errorEl.textContent = '';
  zone.errorEl.hidden = true;
}

/** 対象日 date に、その日書き込める進行中目標の日記コーナーを（再）構築する。 */
async function loadJournals(date) {
  if (!ctx) return;
  clear(ctx.journalsHost);
  ctx.journals = [];
  const goals = (ctx.activeGoals || []).filter((g) => g.startDay <= date && date <= g.endDay);
  if (!goals.length) return;
  ctx.journalsHost.appendChild(h('h2', { class: 'rf-journal-h2', text: '目標の日記' }));
  for (const g of goals) {
    let content = '';
    try { const r = await api.getGoalJournal(g.id, date); content = r.content || ''; } catch { /* noop */ }
    ctx.journalsHost.appendChild(journalCorner(g, content, date));
  }
}

function sep() { return h('span', { class: 'rf-hint-sep', text: '·' }); }

async function loadEditorForDate(date) {
  if (!ctx) return;
  ctx.loading = true;
  ctx.date = date;
  ctx.dateInput.value = date;
  let r = null;
  try { r = await api.getReflection(date); } catch { /* noop */ }
  ctx.editor.setValue(r && r.content ? r.content : '');
  ctx.satisfaction = r && r.satisfaction ? r.satisfaction : 0;
  ctx.syncMood();
  await loadJournals(date); // 同じ対象日の目標日記コーナーを再構築（loading 中は dirty を立てない）。
  ctx.loading = false;
  ctx.dirty = false;
  // 配分ドーナツ・（開いていれば）テキストタイムラインを対象日で再描画。
  // 本文ロードとは独立に失敗を握り、本文編集を妨げない（design D7）。
  renderDayOverview(date).catch(() => { /* noop */ });
}

/** 対象日連動の一日概観（配分ドーナツ＋開いていればテキストタイムライン）を再描画する。 */
async function renderDayOverview(date) {
  await renderAlloc(date);
  if (ctx && ctx.panelOpen) await renderTimelinePanel(date);
}

/**
 * 配分バーリスト（エディタ上部・常設）。持ち分秒を横棒で表示する。
 * 未記録以外は時間の長い順（降順）に上から並べ、未記録は常に最下部（中立色）に固定する。
 * 母数ゼロの日は棒を描かず空状態メッセージ。
 */
/**
 * 配分データ（getAllocation/デモ配分の戻り値）から配分カード要素を組み立てる（純関数）。
 * 本番の常設バー（renderAlloc）とデモの閲覧プレビュー（showDemo）で共用する。
 */
function buildAllocCard(alloc) {
  const head = h('div', { class: 'rf-alloc-head' },
    h('span', { class: 'rf-alloc-title', text: '一日の配分' }),
    h('span', { class: 'rf-alloc-sub', text: '覚醒時間中（記録の端〜端）' }),
  );

  if (!alloc || !alloc.totalSeconds || !alloc.slices) {
    return h('div', { class: 'rf-alloc-card' }, head,
      h('p', { class: 'rf-alloc-empty', text: 'この日はまだ記録がありません。作業や休憩が記録されると、一日の配分が表示されます。' }));
  }

  // 作業／自己申告スライスを時間降順に、未記録は常に最下部へ。
  const rows = [...alloc.slices]
    .sort((a, b) => b.seconds - a.seconds)
    .map((s) => ({ label: s.label, color: colorHex(s.color), seconds: s.seconds, gap: false }));
  if (alloc.untrackedSeconds > 0) {
    rows.push({ label: '未記録', color: NEUTRAL, seconds: alloc.untrackedSeconds, gap: true });
  }

  const total = alloc.totalSeconds;
  const bars = h('div', { class: 'rf-bars' });
  for (const r of rows) {
    const pct = total > 0 ? (r.seconds / total) * 100 : 0;
    const fill = h('div', { class: `rf-bar-fill${r.gap ? ' gap' : ''}`, style: { width: `${pct.toFixed(1)}%`, background: r.color } });
    bars.appendChild(h('div', { class: `rf-bar-row${r.gap ? ' gap' : ''}` },
      h('span', { class: 'rf-bar-label', text: r.label }),
      h('div', { class: 'rf-bar-track' }, fill),
      h('span', { class: 'rf-bar-val', text: fmtDur(r.seconds) }),
    ));
  }
  return h('div', { class: 'rf-alloc-card' }, head, bars);
}

async function renderAlloc(date) {
  if (!ctx) return;
  const host = ctx.allocHost;
  clear(host);

  let alloc = null;
  try { alloc = await api.getAllocation(date); } catch { /* noop */ }
  if (!ctx || ctx.date !== date) return; // 描画中に対象日が変わっていたら破棄。

  host.appendChild(buildAllocCard(alloc));
}

/**
 * 右オーバーレイのグラフィカル縦帯タイムライン（既存タイムラインの短縮版・読み取り専用）を対象日で再構築する。
 * 記録の端〜端を上→下の縦帯で表し、各ブロックの高さは持続時間に比例。同時作業（並行記録）は
 * 青×紫などの斜め縞ストライプ1本で表現し、未記録は中立色の帯で明示する。
 * 連続する同一構成の細切れブロックは1つに結合してコンパクトにする。
 */
async function renderTimelinePanel(date) {
  if (!ctx) return;
  const body = ctx.panelBody;
  clear(body);
  body.appendChild(h('div', { class: 'rf-tlpanel-date', text: date }));

  let tl = null;
  try { tl = await api.getTimeline(date); } catch { /* noop */ }
  if (!ctx || !ctx.panelOpen) return;

  const segs = buildRibbon(tl, date);
  if (!segs.length) {
    body.appendChild(h('p', { class: 'rf-tlpanel-empty', text: 'この日の記録はまだありません。' }));
    return;
  }
  const ribbon = h('div', { class: 'rf-ribbon' });
  for (const s of segs) {
    const bar = h('div', { class: `rf-seg-bar${s.gap ? ' gap' : ''}` });
    if (!s.gap) bar.style.background = s.colors.length > 1 ? stripeBg(s.colors) : s.colors[0];
    const seg = h('div', { class: 'rf-seg', style: { minHeight: `${segHeight(s.seconds)}px` } },
      bar,
      h('div', { class: 'rf-seg-main' },
        h('span', { class: 'rf-seg-time', text: `${fmtClock(s.startAt)}–${fmtClock(s.endAt)}` }),
        h('span', { class: `rf-seg-label${s.gap ? ' gap' : ''}`, text: s.label }),
      ),
    );
    ribbon.appendChild(seg);
  }
  body.appendChild(ribbon);
}

/** ブロック持続秒 → 縦帯の高さ px（短いブロックも読める下限・長すぎは上限でクランプ）。 */
function segHeight(seconds) {
  return Math.max(34, Math.min(150, Math.round((seconds / 60) * 0.9)));
}

/** 複数色 → 斜め縞（repeating-linear-gradient）。同時作業を1本の帯で表す。 */
function stripeBg(colors) {
  const band = 9; // px
  const stops = colors.map((c, i) => `${c} ${i * band}px ${(i + 1) * band}px`).join(', ');
  return `repeating-linear-gradient(45deg, ${stops})`;
}

/**
 * timeline ペイロード（auto/manual/gaps）→ グラフィカル縦帯のブロック配列。
 * 記録の端〜端に絞り、重なる記録はクラスタ（同時作業＝多色）へまとめ、gap（未記録）と合わせて
 * 時系列に並べ、連続する同一構成ブロックを結合して細切れを畳む。
 */
function buildRibbon(tl, date) {
  if (!tl) return [];
  const records = [];
  for (const b of tl.auto || []) records.push({ s: b.startAt, e: b.endAt, label: b.title, color: colorHex(b.color) });
  for (const m of tl.manual || []) records.push({ s: m.startAt, e: m.endAt, label: m.title, color: colorHex(m.color) });
  if (!records.length) return [];
  records.sort((a, b) => a.s - b.s || a.e - b.e);

  // 端〜端（対象日が当日なら現在時刻を上限に含める）。
  const extentStart = Math.min(...records.map((r) => r.s));
  let extentEnd = Math.max(...records.map((r) => r.e));
  if (date === state.today && tl.window && tl.window.now) extentEnd = Math.max(extentEnd, tl.window.now);

  // 重なる記録を1クラスタ（同時作業）へまとめる。
  const clusters = [];
  let cur = null;
  for (const r of records) {
    if (cur && r.s < cur.e) { cur.members.push(r); cur.e = Math.max(cur.e, r.e); }
    else { cur = { s: r.s, e: r.e, members: [r] }; clusters.push(cur); }
  }

  const blocks = [];
  for (const c of clusters) {
    // 構成＝重複ラベル除去（持続の長い順に色を並べ、主色が縞の先頭に来る）。
    const seen = new Set();
    const comp = [];
    for (const m of [...c.members].sort((a, b) => (b.e - b.s) - (a.e - a.s))) {
      if (seen.has(m.label)) continue;
      seen.add(m.label);
      comp.push(m);
    }
    blocks.push({ startAt: c.s, endAt: c.e, gap: false, labels: comp.map((m) => m.label), colors: comp.map((m) => m.color) });
  }
  for (const g of tl.gaps || []) {
    if (g.endAt <= extentStart || g.startAt >= extentEnd) continue; // 端〜端の外側は除外。
    blocks.push({ startAt: Math.max(g.startAt, extentStart), endAt: Math.min(g.endAt, extentEnd), gap: true, labels: ['（未記録）'], colors: [NEUTRAL] });
  }
  blocks.sort((a, b) => a.startAt - b.startAt);

  // 連続する同一構成ブロックを結合（閾値未満の細切れギャップを橋渡ししコンパクト化）。
  const merged = [];
  for (const b of blocks) {
    const key = b.gap ? 'gap' : [...b.labels].sort().join('|');
    const last = merged[merged.length - 1];
    if (last && last._key === key) { last.endAt = Math.max(last.endAt, b.endAt); }
    else { merged.push({ ...b, _key: key }); }
  }

  return merged.map((b) => ({
    startAt: b.startAt,
    endAt: b.endAt,
    gap: b.gap,
    seconds: (b.endAt - b.startAt) / 1000,
    colors: b.colors,
    label: b.gap ? '（未記録）' : b.labels.join(' ＋'),
  }));
}

async function loadHistory() {
  if (!ctx) return;
  let items = [];
  try { items = await api.getReflections(); } catch { /* noop */ }
  renderHistory(items);
}

function renderHistory(items) {
  const host = ctx.historyHost;
  clear(host);
  if (!items || !items.length) {
    host.appendChild(h('p', { class: 'rf-past-empty' }, '保存済みの振り返りは', h('br'), 'まだありません'));
    return;
  }
  for (const it of items) {
    const mood = it.satisfaction ? MOOD_LABELS[it.satisfaction - 1] || '' : '';
    const item = h('div', { class: 'rf-past-item' },
      h('div', { class: 'rf-past-top' },
        h('span', { class: 'rf-past-date', text: it.date }),
        h('span', { class: 'rf-past-mood', text: mood }),
      ),
      h('p', { class: 'rf-past-excerpt', text: it.excerpt || '' }),
    );
    item.addEventListener('click', () => { flush(); loadEditorForDate(it.date); });
    host.appendChild(item);
  }
}

/** 未保存分を非同期フラッシュ（fire-and-forget）。振り返り本文と目標日記の両方。 */
function flush() {
  if (!ctx) return;
  const date = ctx.date;
  if (ctx.dirty) {
    api.putReflection(date, ctx.editor.getValue(), ctx.satisfaction || null).catch(() => { /* noop */ });
    ctx.editor.markSaved();
    ctx.dirty = false;
  }
  for (const j of ctx.journals || []) {
    if (!j.dirty) continue;
    api.putGoalJournal(j.goalId, date, j.editor.getValue()).catch(() => { /* noop */ });
    j.editor.markSaved();
    j.dirty = false;
  }
}

async function doSave(saveBtn) {
  if (!ctx) return;
  saveBtn.disabled = true;
  try {
    await api.putReflection(ctx.date, ctx.editor.getValue(), ctx.satisfaction || null);
    ctx.editor.markSaved();
    ctx.dirty = false;
    // 目標日記も同時保存（変更があったものだけ）。
    for (const j of ctx.journals || []) {
      if (!j.dirty) continue;
      try {
        await api.putGoalJournal(j.goalId, ctx.date, j.editor.getValue());
        j.editor.markSaved();
        j.dirty = false;
      } catch (e) {
        toast(`日記の保存に失敗: ${e.message}`, 'err');
      }
    }
    showSaved();
    await loadHistory();
  } catch (err) {
    toast(`失敗: ${err.message}`, 'err');
  } finally {
    saveBtn.disabled = false;
  }
}

/** 振り返りを保存し、明日の計画モードへ移行してカンバンへ遷移する（design D5）。 */
async function goToPlanning(btn) {
  if (!ctx) return;
  const body = ctx.editor.getValue();
  if (!body.trim()) {
    // 空本文では reflection_done が成立しないため、まず記入を促す。
    toast('先に今日の振り返りを記入してください', 'err');
    ctx.editor.focus?.();
    return;
  }
  btn.disabled = true;
  try {
    await api.putReflection(ctx.date, body, ctx.satisfaction || null);
    ctx.editor.markSaved();
    ctx.dirty = false;
    setTomorrowMode(true); // 明日トグル ON（その日限り）
    const tab = document.querySelector('.tab[data-target="kanban"]');
    if (tab) tab.click();
    else toast('カンバンを開けませんでした', 'err');
  } catch (err) {
    toast(`失敗: ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

function showSaved() {
  const el = ctx.savedEl;
  el.classList.add('show');
  clearTimeout(ctx._savedTimer);
  ctx._savedTimer = setTimeout(() => { if (ctx) ctx.savedEl.classList.remove('show'); }, 2200);
}
