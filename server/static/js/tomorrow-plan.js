// 明日の計画ビュー(spec: tomorrow-plan-capture)。振り返りワークスペースの左メイン第3ビュー。
//  - 本文の「明日」段落を素朴なヒューリスティックで短句候補チップへ分割し、タップで即登録。
//  - 大きな入力欄への直接入力 + Enter でも連続登録できる（IME 変換確定の Enter は無視）。
//  - 登録先は本物のカンバンの未着手(TODO)列・due=翌日の未完了タスク（別ストアは作らない）。
//  - 登録済みは余白のある縦リストで表示し、ドラッグ並べ替え・取り消しができる
//    （並べ替えは TODO 列全体へ interleave して保存し、他タスクの相対順序を壊さない）。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, addDays } from './util.js';
import { computeDue } from './kanban.js';

const MAX_CANDIDATES = 8;
const MIN_LEN = 2;
const MAX_LEN = 20;
// 句読点・代表的な接続詞・スラッシュで区切る（形態素解析は行わない・素朴なヒューリスティック）。
const SPLIT_RE = /[。、！？\n]|まず|次に|そして|その後|してから|したら|それから|なければ|あれば|／|\//;

/** 本文から「明日」段落を拾い、句読点・接続詞で分割した短句候補配列を返す（純関数）。 */
export function extractCandidates(bodyText) {
  const text = String(bodyText || '');
  if (!text.trim()) return [];
  const paragraphs = text.split(/\n{1,}/).map((p) => p.trim()).filter(Boolean);
  const target = paragraphs.find((p) => p.includes('明日')) || paragraphs[paragraphs.length - 1] || '';
  if (!target) return [];
  const parts = target.replace(/明日の?段取り[：:はも]?/g, '').split(SPLIT_RE);
  const seen = new Set();
  const out = [];
  for (let raw of parts) {
    let p = String(raw || '').trim().replace(/^[、,・はもがを]+/, '').trim();
    if (p.length < MIN_LEN) continue;
    if (p.length > MAX_LEN) p = p.slice(0, MAX_LEN);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

let ctx = null; // { container, candidates, tasks }
let draggingId = null;
let dropIndicator = null;

export function hide() {
  ctx = null;
  draggingId = null;
  dropIndicator = null;
}

/** 対象日の本文テキストから候補を抽出し、明日のタスク一覧（本物のカンバン）と併せて描画する。 */
export async function render(container, bodyText) {
  let tasks = [];
  try { tasks = await api.getTasks(); } catch { /* noop */ }
  ctx = { container, candidates: extractCandidates(bodyText), tasks };
  paint();
}

function tomorrowKey() {
  return addDays(state.today, 1);
}

function tomorrowTasksOf(tasks) {
  const tk = tomorrowKey();
  return (tasks || []).filter((t) => t.status === 'TODO' && t.due === tk);
}

function paint() {
  if (!ctx) return;
  const { container, candidates, tasks } = ctx;
  clear(container);
  const registered = new Set(tomorrowTasksOf(tasks).map((t) => t.title));

  const wrap = h('div', { class: 'rf-plan' });

  if (candidates.length) {
    wrap.appendChild(h('div', { class: 'rf-plan-section-lbl', text: '本文から拾えるもの（タップで追加）' }));
    const chipHost = h('div', { class: 'rf-plan-chips' });
    for (const c of candidates) {
      const done = registered.has(c);
      const chip = h('button', {
        class: `rf-plan-chip${done ? ' done' : ''}`, type: 'button', disabled: done,
        text: done ? `✓ ${c}` : `＋ ${c}`,
      });
      if (!done) chip.addEventListener('click', () => registerTask(c));
      chipHost.appendChild(chip);
    }
    wrap.appendChild(chipHost);
  }

  const input = h('input', { type: 'text', class: 'rf-plan-input', placeholder: '明日やることを入力して Enter で追加…' });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME 変換確定の Enter は登録しない。
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    registerTask(v);
  });
  wrap.appendChild(h('div', { class: 'rf-plan-input-wrap' }, input));

  wrap.appendChild(h('div', { class: 'rf-plan-section-lbl', text: '登録済み（ドラッグで並べ替え）' }));
  const list = h('div', { class: 'rf-plan-list' });
  const items = tomorrowTasksOf(tasks);
  if (!items.length) {
    list.appendChild(h('div', { class: 'rf-plan-empty', text: 'まだ明日のタスクはありません。' }));
  } else {
    for (const t of items) list.appendChild(planItemEl(t));
  }
  list.addEventListener('dragover', (e) => {
    if (draggingId == null) return;
    e.preventDefault();
    positionDropIndicator(list, e.clientY);
  });
  list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) removeDropIndicator(); });
  list.addEventListener('drop', (e) => onDrop(e, list));
  wrap.appendChild(list);

  container.appendChild(wrap);
}

async function registerTask(title) {
  if (!ctx) return;
  const dec = computeDue(null, 'TODO', true, state.today);
  try {
    const t = await api.createTask({ title, status: 'TODO', priority: 'low', due: dec.due, due_locked: 0 });
    ctx.tasks.push(t);
    paint();
  } catch (err) { toast(`追加に失敗: ${err.message}`, 'err'); }
}

async function removeTask(t) {
  if (!ctx) return;
  try {
    await api.deleteTask(t.id);
    ctx.tasks = ctx.tasks.filter((x) => x.id !== t.id);
    paint();
  } catch (err) { toast(`削除に失敗: ${err.message}`, 'err'); }
}

function planItemEl(t) {
  const item = h('div', { class: 'rf-plan-item', draggable: 'true', dataset: { id: String(t.id) } });
  item.appendChild(h('span', { class: 'rf-plan-item-handle', text: '⠿' }));
  item.appendChild(h('span', { class: 'rf-plan-item-dot' }));
  item.appendChild(h('span', { class: 'rf-plan-item-title', text: t.title }));
  item.appendChild(h('span', { class: 'rf-plan-item-tag', text: '明日' }));
  const del = h('button', { class: 'rf-plan-item-del', type: 'button', text: '×', title: '取り消し' });
  del.addEventListener('click', () => removeTask(t));
  item.appendChild(del);

  item.addEventListener('dragstart', (e) => {
    draggingId = t.id;
    try { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; } catch { /* noop */ }
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    draggingId = null;
    item.classList.remove('dragging');
    removeDropIndicator();
  });
  return item;
}

function positionDropIndicator(listEl, clientY) {
  if (dropIndicator && dropIndicator.parentElement) dropIndicator.remove();
  const items = [...listEl.querySelectorAll('.rf-plan-item:not(.dragging)')];
  let ref = null;
  for (const it of items) {
    const r = it.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { ref = it; break; }
  }
  if (!dropIndicator) dropIndicator = h('div', { class: 'rf-plan-drop-indicator' });
  if (ref) listEl.insertBefore(dropIndicator, ref);
  else listEl.appendChild(dropIndicator);
}

function removeDropIndicator() {
  if (dropIndicator && dropIndicator.parentElement) dropIndicator.remove();
}

function dropIndexIn(listEl, clientY) {
  const items = [...listEl.querySelectorAll('.rf-plan-item:not(.dragging)')];
  let idx = items.length;
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { idx = i; break; }
  }
  return idx;
}

/** ドロップ位置を確定し、TODO 列全体へ interleave して保存する（他タスクの相対順序は保つ）。 */
async function onDrop(e, listEl) {
  e.preventDefault();
  removeDropIndicator();
  const id = Number(e.dataTransfer.getData('text/plain')) || draggingId;
  draggingId = null;
  if (!ctx || id == null) return;
  const subset = tomorrowTasksOf(ctx.tasks);
  const t = subset.find((x) => x.id === id);
  if (!t) return;
  const idx = dropIndexIn(listEl, e.clientY);
  const without = subset.filter((x) => x.id !== id);
  without.splice(idx, 0, t);

  const fullTodo = ctx.tasks.filter((x) => x.status === 'TODO');
  const subsetIds = new Set(subset.map((x) => x.id));
  let si = 0;
  const newFull = fullTodo.map((x) => (subsetIds.has(x.id) ? without[si++] : x));
  const others = ctx.tasks.filter((x) => x.status !== 'TODO');
  ctx.tasks = [...newFull, ...others];
  paint();
  try { await api.reorder([{ status: 'TODO', ids: newFull.map((x) => x.id) }]); }
  catch (err) { toast(`並べ替えの保存に失敗: ${err.message}`, 'err'); }
}
