// 振り返り(spec: reflection-journal). カンバンとはタブ分離。
//  - 上部: その日の満足度 5 段階(1〜5 クリック選択)
//  - 下部: Markdown ライブプレビュー(自前レンダラ・CDN 非依存)
//  - 保存: { content, satisfaction } を putReflection へ
//  - 過去参照: GET /api/reflections の日付一覧 → 選択で該当日の満足度・本文を表示
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, emptyState } from './util.js';
import { renderMarkdown } from './markdown.js';

const SAT_LABELS = ['最悪', '低い', '普通', '良い', '最高'];

export function hide() {}

export async function show(root) {
  clear(root);
  const dateInput = h('input', { type: 'date', value: state.today });
  root.appendChild(h('div', { class: 'section-head' },
    h('h2', {}, '振り返り'),
    h('div', { class: 'row' }, h('label', { class: 'field' }, '対象日', dateInput)),
  ));

  const layout = h('div', { class: 'rf-layout' });
  const editorCol = h('div', { class: 'rf-editor' });
  const historyCol = h('div', { class: 'rf-history' });
  layout.appendChild(editorCol);
  layout.appendChild(historyCol);
  root.appendChild(layout);

  const loadHistory = () => renderHistory(historyCol, (date) => {
    dateInput.value = date;
    renderEditor(editorCol, date, loadHistory);
  });

  dateInput.addEventListener('change', () => renderEditor(editorCol, dateInput.value || state.today, loadHistory));

  await renderEditor(editorCol, dateInput.value || state.today, loadHistory);
  await loadHistory();
}

async function renderEditor(col, date, onSaved) {
  clear(col);
  col.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
  const reflection = await api.getReflection(date);
  clear(col);

  // --- 満足度 5 段階 ---
  let satisfaction = reflection && reflection.satisfaction ? reflection.satisfaction : 0;
  const satWrap = h('div', { class: 'rf-sat' });
  const satNote = h('div', { class: 'rf-sat-note muted' });
  const dots = [];
  const syncSat = () => {
    dots.forEach((d, idx) => d.classList.toggle('on', idx < satisfaction));
    satNote.textContent = satisfaction ? `${satisfaction} / 5 — ${SAT_LABELS[satisfaction - 1]}` : '未評価';
  };
  for (let n = 1; n <= 5; n++) {
    const dot = h('button', { class: 'rf-sat-dot', type: 'button', text: '★', title: `${n}` });
    dot.addEventListener('click', () => { satisfaction = (satisfaction === n) ? 0 : n; syncSat(); });
    dots.push(dot);
    satWrap.appendChild(dot);
  }
  syncSat();

  const satCard = h('div', { class: 'card' },
    h('div', { class: 'card-title', text: `満足度 (${date})` }),
    h('div', { class: 'row' }, satWrap, satNote),
  );

  // --- Markdown ライブプレビュー ---
  const ta = h('textarea', { placeholder: '今日の振り返りを Markdown で記述…' });
  ta.value = reflection && reflection.content ? reflection.content : '';
  const preview = h('div', { class: 'md-preview' });
  const syncPreview = () => { clear(preview); preview.appendChild(renderMarkdown(ta.value)); };
  ta.addEventListener('input', syncPreview);
  syncPreview();

  const save = h('button', { class: 'btn primary', text: '保存', type: 'button' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api.putReflection(date, ta.value, satisfaction || null);
      toast('保存しました', 'ok');
      if (onSaved) onSaved();
    } catch (err) { toast(`失敗: ${err.message}`, 'err'); }
    finally { save.disabled = false; }
  });

  const editorCard = h('div', { class: 'card' },
    h('div', { class: 'card-title', text: 'Markdown ライブプレビュー' }),
    h('div', { class: 'rf-split' },
      h('div', { class: 'rf-split-in' }, h('div', { class: 'muted md-preview-label', text: '入力' }), ta),
      h('div', { class: 'rf-split-out' }, h('div', { class: 'muted md-preview-label', text: 'プレビュー' }), preview),
    ),
    h('div', { class: 'row', style: { marginTop: '10px' } }, save),
  );

  col.appendChild(satCard);
  col.appendChild(editorCard);
}

async function renderHistory(col, onPick) {
  clear(col);
  const card = h('div', { class: 'card' }, h('div', { class: 'card-title', text: '過去の振り返り' }));
  const list = h('div', { class: 'list' });
  card.appendChild(list);
  col.appendChild(card);

  let items = [];
  try { items = await api.getReflections(); } catch { /* noop */ }
  if (!items.length) {
    list.appendChild(emptyState('保存済みの振り返りはまだありません'));
    return;
  }
  for (const it of items) {
    const stars = it.satisfaction ? '★'.repeat(it.satisfaction) + '☆'.repeat(5 - it.satisfaction) : '—';
    const row = h('button', { class: 'rf-hist-row', type: 'button' },
      h('span', { class: 'rf-hist-date', text: it.date }),
      h('span', { class: 'rf-hist-stars', text: stars }),
    );
    row.addEventListener('click', () => onPick(it.date));
    list.appendChild(row);
  }
}
