// 振り返り(spec: reflection-journal). ref/reflection/振り返り.dc.html 忠実移植。
//  - 左: タイトル / 5 段階「気分」ピル / インライン・ライブ Markdown エディタ(md-editor.js)+ 下部クローム
//  - 右レール: 対象日(date) / 過去の振り返り(日付・気分・2 行抜粋)
//  - 保存: 手動「保存する」ボタン + 日付切替・過去選択・タブ離脱時に未保存分をフラッシュ
//  - スタイルは全て rf-* クラス + CSSOM(CSP: インライン style 属性なし)。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast } from './util.js';
import { createMarkdownEditor } from './md-editor.js';
import { setTomorrowMode } from './kanban.js';

const MOOD_LABELS = ['いまひとつ', 'まあまあ', 'ふつう', '良い', 'とても良い'];

let ctx = null;

export function hide() {
  flush();
  document.body.classList.remove('rf-page');
  ctx = null;
}

export async function show(root) {
  clear(root);
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
  const left = h('section', { class: 'rf-left' }, h('h1', { class: 'rf-title', text: '今日の振り返り' }), moodRow, card, journalsHost);

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

  ctx = { date: state.today, satisfaction: 0, dirty: false, loading: false, editor, dateInput, historyHost, savedEl, syncMood, renderHistory, journalsHost, journals: [], activeGoals: [] };

  // --- 挙動配線 ---
  saveBtn.addEventListener('click', () => doSave(saveBtn));
  planBtn.addEventListener('click', () => goToPlanning(planBtn));
  dateInput.addEventListener('change', () => { flush(); loadEditorForDate(dateInput.value || state.today); });

  // 進行中の目標を取得（日記コーナーの対象）。
  ctx.activeGoals = (await api.getGoals().catch(() => [])).filter((g) => g.status === 'active');

  await loadEditorForDate(state.today);
  await loadHistory();
}

/** 目標の日記コーナー（見出し + ライブ Markdown エディタ）。保存は振り返りと同じ動線に相乗り。 */
function journalCorner(goal, content) {
  const entry = { goalId: goal.id, dirty: false, editor: null };
  const ph = h('div', { class: 'rf-ph', text: `${goal.name} の今日の記録。Markdown で自由にどうぞ。` });
  const editor = createMarkdownEditor({
    initial: content || '',
    placeholder: `${goal.name} の今日の記録`,
    onChange: (raw) => {
      ph.style.display = raw.trim() === '' ? 'block' : 'none';
      if (ctx && !ctx.loading) entry.dirty = true;
    },
  });
  entry.editor = editor;
  ctx.journals.push(entry);
  return h('div', { class: 'rf-journal' },
    h('div', { class: 'rf-journal-head' },
      h('span', { class: 'rf-journal-title', text: goal.name }),
      h('span', { class: 'rf-journal-tag', text: `Day ${goal.dayNumber}/${goal.dayCount}` }),
    ),
    h('div', { class: 'rf-ed-wrap' }, ph, editor.el),
  );
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
    ctx.journalsHost.appendChild(journalCorner(g, content));
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
