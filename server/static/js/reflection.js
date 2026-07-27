// 振り返り(spec: reflection-journal / reflection-day-overview / reflection-timeline-workspace)。
// タイムラインタブ統合後の統合ワークスペース: 左＝メイン(ビュー切替の横スクロール:
// タイムライン(完全版)/一日の配分/明日の計画)＋右＝振り返りサイドバー(常時表示)、上部＝日付ストリップ。
// 対象日(activeDate)はワークスペースが単一所有し、全ビュー＋サイドバーへ同期する(design D2)。
// スタイルは全て rf-* クラス + CSSOM(CSP: インライン style 属性なし)。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, emptyState, addDays, colorHex, fmtDur, attachTooltip } from './util.js';
import { createMarkdownEditor } from './md-editor.js';
import { renderMarkdown } from './markdown.js';
import { isDemo } from './demo.js';
import { buildGoalRulesBlock } from './rule-form.js';
import { buildFreezeBlock, isFrozenNow, buildFreezeReadOnly } from './goal-freeze.js';
import { shrinkImage, isImageFile } from './images.js';
import * as timeline from './timeline.js';
import * as planView from './tomorrow-plan.js';

/** b − a の日数差（UTC 計算）。 */
function dayDiff(a, b) {
  const toUtc = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

const MOOD_LABELS = ['いまひとつ', 'まあまあ', 'ふつう', '良い', 'とても良い'];
// 気分ドット色（低→高）。日付ストリップの各日チップに使う（design: 気分ドット付き日付ストリップ）。
const MOOD_COLORS = ['#d9714e', '#e0a23c', '#c9b23f', '#6fae5c', '#3f9d5c'];

/** 未記録スライス／ギャップ帯の中立色。 */
const NEUTRAL = '#c3cbd8';

const VIEW_ORDER = ['timeline', 'alloc', 'plan'];
const VIEW_META = {
  timeline: { icon: '▤', label: 'タイムライン' },
  alloc: { icon: '◑', label: '一日の配分' },
  plan: { icon: '✎', label: '明日の計画' },
};
const STRIP_RADIUS = 3; // 日付ストリップに表示する前後日数

// 左メインの現在ビューが、右サイドバーのタブ構成と日付ストリップの有効性を駆動する
// 単一の写像（design D2 / spec: 左ビューによるサイドバーと日付ストリップの駆動）。
const SB_TAB_META = { journal: '本文', detail: '詳細', log: 'ログ' };
const VIEW_CHROME = {
  timeline: { strip: true, sidebarTabs: ['journal'] },
  alloc: { strip: true, sidebarTabs: ['journal'] },
  plan: { strip: false, sidebarTabs: ['journal', 'detail', 'log'] },
};
function viewChrome(view) { return VIEW_CHROME[view] || VIEW_CHROME.timeline; }

let ctx = null;

export function hide() {
  flush();
  document.body.classList.remove('rf-page');
  try { timeline.hide(); } catch { /* noop */ }
  try { planView.hide(); } catch { /* noop */ }
  ctx = null;
}

/**
 * デモ: 目標ごとの記録コーナーの見え方を読み取り専用で表示（保存動線なし・spec: demo-mode）。
 * 仮想「今日」が目標期間内ならその日のサンプル記録を、期間外（開始前を含む）なら期間内の
 * 代表日のサンプル記録をプレビューとして表示する（デモ入場直後の空表示を解消）。
 * デモは統合ワークスペースのビュー切替を持たない単一ページの読み取り専用表示のまま
 * （明日の計画の作成導線は元々出していないため、そのまま要件を満たす）。
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

  // チュートリアル: 単発ルールの当日通知（spec: demo-rule-tutorial）。目標コーナーは唯一デモでも
  // 書き込みを許す場所＝実際にルールを1つ作って「1日後」を押すと通知が出るのを体験できる。
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title', text: 'チュートリアル: 単発ルールの通知を試す' }),
    h('p', { class: 'muted', text: '下の「＋ 追加」から、種類は「📷 写真を出す」か「💬 質問に答える」のどちらかで「単発」・明日開始のルールを1つ作ってみましょう（理由も忘れずに）。作ったら上部バーの「＋1日」を押すと、その日はじめてダッシュボードを開いた扱いでトーストが出ます（この通知は写真/質問ルール専用です）。' }),
  ));
  let fullGoal = g;
  try { fullGoal = await api.demo.goal(g.id, vd); } catch { /* noop: 取得失敗時はメタのみで続行 */ }
  // 一時凍結は閲覧専用で表示する（操作導線は出さない・spec: goal-freeze / demo-mode）。
  const quota = await api.demo.freezeQuota(vd).catch(() => null);
  wrap.appendChild(buildFreezeReadOnly(fullGoal, quota));
  wrap.appendChild(buildGoalRulesBlock(fullGoal, vd, null));
}

export async function show(root) {
  clear(root);
  // デモ中は進行中サンプルの記入済み日記を仮想日付で閲覧表示（保存動線は出さない）。
  if (isDemo()) { await showDemo(root); return; }
  document.body.classList.add('rf-page');

  // ディープリンク: #timeline?from=&to= を読み取り、対象日とドラフト自動オープンに引き継ぐ
  // （spec: タイムラインタブの振り返りタブへの統合とナビゲーション。リンク切れにしない）。
  const link = timeline.consumeHashParams();
  const initialDate = link && link.from ? timeline.deriveDayKey(link.from) : state.today;

  // --- 右サイドバー: クローム（文字数・プレースホルダ・dirty） ---
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
  // サイドバーは幅が狭いため、Markdown 記法ヒントは表示しない（issue #61: 保存ボタンが縦積みになる
  // 原因でもあった）。ショートカット自体（# 見出し等）は md-editor.js の挙動として引き続き使える。
  const savedEl = h('span', { class: 'rf-saved', text: '保存しました' });
  const saveBtn = h('button', { class: 'rf-save', type: 'button', text: '保存する' });
  attachTooltip(saveBtn, { label: '保存', keys: ['Ctrl', 'Enter'] });

  const card = h('div', { class: 'rf-card' },
    h('div', { class: 'rf-ed-wrap' }, phEl, editor.el),
    h('div', { class: 'rf-chrome' },
      h('div', { class: 'rf-chrome-right' }, countEl, savedEl, saveBtn),
    ),
  );

  // 目標日記コーナー（進行中の目標ごと）。本文エディタの下に置き、同じ保存動線に相乗りする。
  const journalsHost = h('div', { class: 'rf-journals' });

  // --- 右サイドバー: タブ器（design D2）。journal は常時、detail/log は plan ビューのときのみ。
  // detail/log は kanban.js（埋め込み盤面）が内容を供給する外部ホスト（design D1 asideHost）。
  const journalPane = h('div', { class: 'rf-sb-pane active', dataset: { pane: 'journal' } }, moodRow, card, journalsHost);
  const detailPane = h('div', { class: 'rf-sb-pane', dataset: { pane: 'detail' } });
  const logPane = h('div', { class: 'rf-sb-pane', dataset: { pane: 'log' } });
  const sbTabsHost = h('div', { class: 'rf-sb-tabs' });
  const sidebar = h('aside', { class: 'rf-sidebar' }, sbTabsHost, journalPane, detailPane, logPane);

  // --- 左メイン: ビュータブ切替（横スクロール・スナップは廃止・design D3）。
  const tabButtons = {};
  const viewPrev = h('button', { class: 'rf-viewnav', type: 'button', text: '‹' });
  const viewNext = h('button', { class: 'rf-viewnav', type: 'button', text: '›' });
  const tabsRow = h('div', { class: 'rf-viewtabs' }, viewPrev);
  for (const key of VIEW_ORDER) {
    const meta = VIEW_META[key];
    const btn = h('button', { class: 'rf-viewtab', type: 'button' },
      h('span', { class: 'rf-viewtab-ico', text: meta.icon }),
      h('span', { class: 'rf-viewtab-lbl', text: meta.label }));
    btn.addEventListener('click', () => switchView(key));
    tabButtons[key] = btn;
    tabsRow.appendChild(btn);
  }
  tabsRow.appendChild(viewNext);

  // アクティブなビューのみを描画するホスト（design D3: デッキ/scroll-snap は持たない）。
  // 各ビューの DOM は viewHosts に保持し、非表示中は viewHost から外して状態を保つ
  // （タイムラインのスクロール位置等を、タブ往復のたびに失わないため）。
  const viewHosts = {};
  for (const key of VIEW_ORDER) viewHosts[key] = h('section', { class: 'rf-view', dataset: { view: key } });
  const viewHost = h('div', { class: 'rf-view-host' });

  viewPrev.addEventListener('click', () => {
    const idx = Math.max(0, VIEW_ORDER.indexOf(ctx.currentView) - 1);
    switchView(VIEW_ORDER[idx]);
  });
  viewNext.addEventListener('click', () => {
    const idx = Math.min(VIEW_ORDER.length - 1, VIEW_ORDER.indexOf(ctx.currentView) + 1);
    switchView(VIEW_ORDER[idx]);
  });

  const main = h('div', { class: 'rf-main' }, tabsRow, viewHost);

  // --- 上部: 日付ストリップ（明日の計画ビューでは無効化・design D2）---
  const stripHost = h('div', { class: 'rf-strip-host' });

  root.appendChild(h('div', { class: 'rf-workspace' }, stripHost,
    h('div', { class: 'rf-split' }, main, sidebar)));

  ctx = {
    activeDate: initialDate, satisfaction: 0, dirty: false, loading: false,
    editor, savedEl, saveBtn, syncMood, journalsHost, journals: [], activeGoals: [],
    tabButtons, viewHosts, viewHost, stripHost, currentView: 'timeline',
    sidebarTab: 'journal', sbTabsHost, journalPane, detailPane, logPane,
    viewDates: { timeline: null, alloc: null, plan: null },
    reflectionsByDate: new Map(),
  };

  saveBtn.addEventListener('click', () => doSave(saveBtn));
  updateTabsUI();
  applyViewChrome(ctx.currentView);

  // 進行中の目標を取得（日記コーナーの対象）。
  ctx.activeGoals = (await api.getGoals().catch(() => [])).filter((g) => g.status === 'active');

  await loadReflectionsMap();
  await loadEditorForDate(initialDate);
  await ensureViewRendered('timeline');

  // 描画完了後にディープリンク区間の記録ポップオーバーを開く（timeline.js が URL を消費済み）。
  if (link && link.from && link.to) {
    timeline.openDraftForRange(link.from, link.to);
  }
}

function updateTabsUI() {
  if (!ctx) return;
  for (const key of VIEW_ORDER) ctx.tabButtons[key].classList.toggle('active', key === ctx.currentView);
}

/** 右サイドバーのタブ構成（journal / detail / log）を現在ビューに合わせて再構築する（design D2）。 */
function buildSidebarTabs() {
  if (!ctx) return;
  clear(ctx.sbTabsHost);
  const chrome = viewChrome(ctx.currentView);
  if (chrome.sidebarTabs.length <= 1) { ctx.sbTabsHost.hidden = true; return; }
  ctx.sbTabsHost.hidden = false;
  for (const key of chrome.sidebarTabs) {
    const btn = h('button', {
      class: `rf-sb-tab${ctx.sidebarTab === key ? ' active' : ''}`, type: 'button', text: SB_TAB_META[key],
    });
    btn.addEventListener('click', () => setSidebarTab(key));
    ctx.sbTabsHost.appendChild(btn);
  }
}

/** 右サイドバーの表示タブを切り替える（journal は常に維持し、内容の dirty 状態を保つ）。 */
function setSidebarTab(key) {
  if (!ctx) return;
  ctx.sidebarTab = key;
  ctx.journalPane.classList.toggle('active', key === 'journal');
  ctx.detailPane.classList.toggle('active', key === 'detail');
  ctx.logPane.classList.toggle('active', key === 'log');
  buildSidebarTabs();
}

/** 左ビューが決まるたび、日付ストリップの有効性とサイドバーのタブ構成を単一の規則で更新する（design D2）。 */
function applyViewChrome(view) {
  if (!ctx) return;
  const chrome = viewChrome(view);
  ctx.stripHost.hidden = !chrome.strip;
  if (!chrome.sidebarTabs.includes(ctx.sidebarTab)) setSidebarTab('journal');
  else buildSidebarTabs();
}

/** ビュー切替は対象日を変えない（design D2/spec: 左メインのビュー切替）。横スクロールは持たない（design D3）。 */
function switchView(key) {
  if (!ctx) return;
  const prev = ctx.currentView;
  ctx.currentView = key;
  updateTabsUI();
  applyViewChrome(key);
  // 明日の計画ビューから離れるときは埋め込み盤面を確実に unmount する（design D1/design Risks）。
  if (prev === 'plan' && key !== 'plan') { try { planView.hide(); } catch { /* noop */ } }
  void ensureViewRendered(key);
}

/** 現在アクティブなビューのみを viewHost へ描画/接続する（design D3: デッキ廃止・アクティブビューのみ描画）。
 * 明日の計画ビューは本文の最新状態を見せたいため、訪れるたびに常に再描画する。 */
async function ensureViewRendered(key) {
  if (!ctx) return;
  const host = ctx.viewHosts[key];
  if (key !== 'plan' && ctx.viewDates[key] === ctx.activeDate) {
    attachView(host);
    return;
  }
  ctx.viewDates[key] = ctx.activeDate;
  if (key === 'timeline') await timeline.render(host, ctx.activeDate);
  else if (key === 'alloc') await renderAllocView(host, ctx.activeDate);
  else if (key === 'plan') {
    await planView.render(host, ctx.editor.getValue(), {
      detailHost: ctx.detailPane,
      logHost: ctx.logPane,
      onDetailOpen: () => setSidebarTab('detail'),
      onArchived: () => setSidebarTab('log'),
    });
  }
  attachView(host);
}

/** viewHost の内容をアクティブなビューの DOM 一つだけへ入れ替える（他ビューは detached のまま状態を保つ）。 */
function attachView(host) {
  if (!ctx) return;
  clear(ctx.viewHost);
  ctx.viewHost.appendChild(host);
}

// --- 日付ストリップ（対象日ナビゲーション・spec: 日付ストリップによる対象日ナビゲーション） ---
function buildStrip() {
  if (!ctx) return;
  clear(ctx.stripHost);
  const prevBtn = h('button', { class: 'rf-strip-arrow', type: 'button', text: '‹' });
  const nextBtn = h('button', { class: 'rf-strip-arrow', type: 'button', text: '›' });
  prevBtn.addEventListener('click', () => setActiveDate(addDays(ctx.activeDate, -1)));
  nextBtn.addEventListener('click', () => setActiveDate(addDays(ctx.activeDate, 1)));

  const chips = h('div', { class: 'rf-strip-chips' });
  for (let i = -STRIP_RADIUS; i <= STRIP_RADIUS; i++) {
    chips.appendChild(dateChipEl(addDays(ctx.activeDate, i)));
  }

  const todayBtn = h('button', { class: 'rf-strip-today', type: 'button', text: '今日' });
  todayBtn.addEventListener('click', () => setActiveDate(state.today));

  const picker = h('input', { type: 'date', class: 'rf-strip-pick', value: ctx.activeDate });
  picker.addEventListener('change', () => { if (picker.value) setActiveDate(picker.value); });

  ctx.stripHost.appendChild(h('div', { class: 'rf-strip' }, prevBtn, chips, nextBtn, todayBtn, picker));
}

function dateChipEl(d) {
  const dt = new Date(`${d}T00:00:00`);
  const wd = ['日', '月', '火', '水', '木', '金', '土'][dt.getDay()];
  const cls = ['rf-chip-date'];
  if (d === ctx.activeDate) cls.push('active');
  if (d > state.today) cls.push('future');
  const sat = ctx.reflectionsByDate.get(d);
  const dot = sat
    ? h('span', { class: 'rf-chip-dot' })
    : h('span', { class: 'rf-chip-dot rf-chip-dot-empty' });
  if (sat) dot.style.background = MOOD_COLORS[Math.max(0, Math.min(4, sat - 1))];
  const chip = h('button', { class: cls.join(' '), type: 'button' },
    h('span', { class: 'rf-chip-wd', text: wd }),
    h('span', { class: 'rf-chip-day', text: String(dt.getDate()) }),
    dot);
  chip.addEventListener('click', () => setActiveDate(d));
  return chip;
}

async function loadReflectionsMap() {
  if (!ctx) return;
  let items = [];
  try { items = await api.getReflections(); } catch { /* noop */ }
  ctx.reflectionsByDate = new Map(items.map((it) => [it.date, it.satisfaction || 0]));
  buildStrip();
}

/** 対象日を切り替え、現在ビュー＋右サイドバーを同期再描画する（spec: 対象日への追従）。 */
async function setActiveDate(d) {
  if (!ctx || d === ctx.activeDate) return;
  flush();
  ctx.activeDate = d;
  buildStrip();
  ctx.viewDates.timeline = null;
  ctx.viewDates.alloc = null;
  ctx.viewDates.plan = null;
  await loadEditorForDate(d);
  await ensureViewRendered(ctx.currentView);
}

/** 目標の日記コーナー（見出し + ライブ Markdown エディタ + 画像ゾーン）。本文保存は振り返りと同じ動線に相乗り。 */
function journalCorner(goal, content, date, quota) {
  const entry = { goalId: goal.id, dirty: false, editor: null };
  const ph = h('div', { class: 'rf-ph', text: `${goal.name} の今日の記録。Markdown で自由にどうぞ。` });
  const editor = createMarkdownEditor({
    initial: content || '',
    placeholder: `${goal.name} の今日の記録`,
    onChange: (raw) => {
      ph.style.display = raw.trim() === '' ? 'block' : 'none';
      if (ctx && !ctx.loading) entry.dirty = true;
    },
    onSubmit: () => doSave(ctx.saveBtn),
  });
  entry.editor = editor;
  ctx.journals.push(entry);

  const corner = h('div', { class: 'rf-journal' },
    h('div', { class: 'rf-journal-head' },
      h('span', { class: 'rf-journal-title', text: goal.name }),
      h('span', { class: 'rf-journal-tag', text: `Day ${goal.dayNumber}/${goal.dayCount}` }),
    ),
  );
  // 一時凍結ブロック＋ルール一覧＋追加・変更・削除を日記の**上**に置く（spec: goal-freeze /
  // editable-rule-registry）。対象日が今日のときだけ出す（過去日を遡って操作することはできない）。
  // デモは閲覧専用なので作成・凍結の操作導線を出さない（spec: demo-mode）。
  if (date === state.today && !isDemo()) {
    const onFreezeChanged = async () => { await loadJournals(date); };
    corner.appendChild(buildFreezeBlock(goal, quota, onFreezeChanged, ctx.activeGoals));
    // 凍結中はルール操作ブロックを畳む（カード自体・日記・画像は残す・spec: goal-freeze）。
    if (isFrozenNow(goal)) {
      corner.appendChild(h('details', { class: 'gf-rules-collapse' },
        h('summary', { text: 'ルール（凍結中は編集できません）' }),
        buildGoalRulesBlock(goal, date, null),
      ));
    } else {
      corner.appendChild(buildGoalRulesBlock(goal, date, null));
    }
  }
  // 日記エディタは今までどおりその下に。
  corner.appendChild(h('div', { class: 'rf-ed-wrap' }, ph, editor.el));
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
  // 対象日が今日なら目標一覧を取り直す（凍結の予約/延長/解除で status/freeze/endDay が変わるため）。
  if (date === state.today && !isDemo()) {
    ctx.activeGoals = (await api.getGoals().catch(() => ctx.activeGoals)).filter((g) => g.status === 'active');
  }
  const goals = (ctx.activeGoals || []).filter((g) => g.startDay <= date && date <= g.endDay);
  if (!goals.length) return;
  ctx.journalsHost.appendChild(h('h2', { class: 'rf-journal-h2', text: '目標の日記' }));
  // 月枠はアプリ全体で1つ（すべての目標カードに表示・spec: goal-freeze）。1回だけ取得して使い回す。
  let quota = null;
  if (date === state.today && !isDemo()) {
    quota = await api.getFreezeQuota().catch(() => null);
  }
  for (const g of goals) {
    let content = '';
    try { const r = await api.getGoalJournal(g.id, date); content = r.content || ''; } catch { /* noop */ }
    ctx.journalsHost.appendChild(journalCorner(g, content, date, quota));
  }
}

async function loadEditorForDate(date) {
  if (!ctx) return;
  ctx.loading = true;
  let r = null;
  try { r = await api.getReflection(date); } catch { /* noop */ }
  ctx.editor.setValue(r && r.content ? r.content : '');
  ctx.satisfaction = r && r.satisfaction ? r.satisfaction : 0;
  ctx.syncMood();
  await loadJournals(date); // 同じ対象日の目標日記コーナーを再構築（loading 中は dirty を立てない）。
  ctx.loading = false;
  ctx.dirty = false;
}

/**
 * 配分データ（getAllocation/デモ配分の戻り値）から配分カード要素を組み立てる（純関数）。
 * 左メインの「一日の配分」ビュー（renderAllocView）とデモの閲覧プレビュー（showDemo）で共用する。
 * 未記録以外は時間の長い順（降順）に上から並べ、未記録は常に最下部（中立色）に固定する。
 * 母数ゼロの日は棒を描かず空状態メッセージ。
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

/** 左メイン「一日の配分」ビュー（独立全幅ビュー・design: エディタ上部常設バーからの昇格）。 */
async function renderAllocView(container, date) {
  clear(container);
  let alloc = null;
  try { alloc = await api.getAllocation(date); } catch { /* noop */ }
  if (!ctx || ctx.activeDate !== date) return; // 描画中に対象日が変わっていたら破棄。
  container.appendChild(buildAllocCard(alloc));
}

/** 未保存分を非同期フラッシュ（fire-and-forget）。振り返り本文と目標日記の両方。 */
function flush() {
  if (!ctx) return;
  const date = ctx.activeDate;
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
    await api.putReflection(ctx.activeDate, ctx.editor.getValue(), ctx.satisfaction || null);
    ctx.editor.markSaved();
    ctx.dirty = false;
    // 目標日記も同時保存（変更があったものだけ）。
    for (const j of ctx.journals || []) {
      if (!j.dirty) continue;
      try {
        await api.putGoalJournal(j.goalId, ctx.activeDate, j.editor.getValue());
        j.editor.markSaved();
        j.dirty = false;
      } catch (e) {
        toast(`日記の保存に失敗: ${e.message}`, 'err');
      }
    }
    showSaved();
    await loadReflectionsMap(); // 気分ドットを最新化。
  } catch (err) {
    toast(`失敗: ${err.message}`, 'err');
  } finally {
    saveBtn.disabled = false;
  }
}

function showSaved() {
  const el = ctx.savedEl;
  el.classList.add('show');
  clearTimeout(ctx._savedTimer);
  ctx._savedTimer = setTimeout(() => { if (ctx) ctx.savedEl.classList.remove('show'); }, 2200);
}
