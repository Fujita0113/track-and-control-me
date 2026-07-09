// カンバン(spec: kanban-board). Cadence Board 準拠:
//  - 4 列: 保留(HOLD) / 未着手(TODO) / 進行中(DOING) / 完了(DONE)
//  - カード: 優先度バッジ(高/中/低) + 期限ラベル + タイトル
//  - HTML5 draggable による列間 D&D → updateTask(status)
//  - 完了列ドロップで祝福演出 + 当日アクティビティログ(サウンドは設定トグル既定 OFF)
//  - カード詳細: 優先度セレクタ / 期限ピッカー / Markdown ノート編集
//  - 当日進捗ドーナツ(完了/総数) + アクティビティログ(当日完了・新しい順)
import { api } from './api.js';
import { state } from './state.js';
import {
  h, clear, addDays, localDateKey, toast, openModal, closeModal, emptyState,
} from './util.js';
import { renderMarkdown } from './markdown.js';

const COLUMNS = [
  { key: 'HOLD', label: '保留' },
  { key: 'TODO', label: '未着手' },
  { key: 'DOING', label: '進行中' },
  { key: 'DONE', label: '完了' },
];
const PRIORITY = {
  high: { label: '高', cls: 'p-high' },
  mid: { label: '中', cls: 'p-mid' },
  low: { label: '低', cls: 'p-low' },
};
const SOUND_KEY = 'tcm_kanban_sound';

export function hide() {}

export async function show(root) {
  clear(root);
  root.appendChild(h('div', { class: 'section-head' }, h('h2', {}, 'カンバン')));
  const body = h('div', {});
  root.appendChild(body);
  await render(body);
}

async function render(body) {
  clear(body);
  body.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
  const tasks = await api.getTasks();
  clear(body);

  const reload = () => render(body);

  body.appendChild(addForm(reload));

  const layout = h('div', { class: 'kb-layout' });
  layout.appendChild(boardEl(tasks, reload));
  layout.appendChild(sideEl(tasks));
  body.appendChild(layout);
}

// --- 追加フォーム --------------------------------------------------------
function addForm(reload) {
  const titleInp = h('input', { type: 'text', placeholder: 'タスク名' });
  const colSel = h('select', {}, ...COLUMNS.map((c) => h('option', { value: c.key }, c.label)));
  const priSel = h('select', {},
    h('option', { value: 'high' }, '優先度: 高'),
    h('option', { value: 'mid' }, '優先度: 中'),
    h('option', { value: 'low' }, '優先度: 低'),
  );
  priSel.value = 'mid';
  const dueInp = h('input', { type: 'date', title: '期限(任意)' });
  const tomorrowBtn = h('button', { class: 'btn small', text: '翌日期限', type: 'button', title: '期限を翌日に設定' });
  tomorrowBtn.addEventListener('click', () => { dueInp.value = addDays(state.today, 1); });
  const addBtn = h('button', { class: 'btn primary small', text: '追加', type: 'button' });
  addBtn.addEventListener('click', async () => {
    if (!titleInp.value.trim()) { toast('タスク名は必須', 'err'); return; }
    try {
      await api.createTask({
        title: titleInp.value.trim(),
        status: colSel.value,
        priority: priSel.value,
        due: dueInp.value || null,
      });
      toast('追加しました', 'ok');
      reload();
    } catch (err) { toast(`失敗: ${err.message}`, 'err'); }
  });

  const soundChk = h('input', { type: 'checkbox' });
  soundChk.checked = localStorage.getItem(SOUND_KEY) === '1';
  soundChk.addEventListener('change', () => {
    localStorage.setItem(SOUND_KEY, soundChk.checked ? '1' : '0');
  });

  return h('div', { class: 'kb-toolbar' },
    titleInp, colSel, priSel,
    h('label', { class: 'field' }, '期限', dueInp),
    tomorrowBtn, addBtn,
    h('div', { class: 'spacer' }),
    h('label', { class: 'inline', title: '完了時の効果音(既定 OFF)' }, soundChk, '完了サウンド'),
  );
}

// --- ボード(4 列) --------------------------------------------------------
function boardEl(tasks, reload) {
  const board = h('div', { class: 'kb-board' });
  const byCol = new Map(COLUMNS.map((c) => [c.key, []]));
  for (const t of tasks) {
    const bucket = byCol.get(t.status) || byCol.get('TODO');
    bucket.push(t);
  }
  for (const col of COLUMNS) {
    const items = byCol.get(col.key);
    const colEl = h('div', { class: 'kb-col', dataset: { col: col.key } },
      h('div', { class: 'kb-col-head' },
        h('span', { text: col.label }),
        h('span', { class: 'kb-count', text: String(items.length) }),
      ),
    );
    const listEl = h('div', { class: 'kb-col-list' });
    if (!items.length) listEl.appendChild(h('div', { class: 'empty', text: '—' }));
    for (const t of items) listEl.appendChild(cardEl(t, reload));
    colEl.appendChild(listEl);

    // ドロップ受け入れ。
    colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('drop-over'); });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('drop-over'));
    colEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      colEl.classList.remove('drop-over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      const task = tasks.find((t) => t.id === id);
      if (!task || task.status === col.key) return;
      const wasDone = task.status === 'DONE';
      try {
        await api.updateTask(id, { status: col.key });
        if (col.key === 'DONE' && !wasDone) {
          celebrate(colEl);
          toast('完了！お疲れさまでした', 'ok');
        } else {
          toast('移動しました', 'ok');
        }
        reload();
      } catch (err) { toast(`失敗: ${err.message}`, 'err'); }
    });
    board.appendChild(colEl);
  }
  return board;
}

function cardEl(t, reload) {
  const pri = PRIORITY[t.priority] || PRIORITY.low;
  const card = h('div', { class: 'kb-card', draggable: 'true', dataset: { id: String(t.id) } });
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(t.id));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  const badges = h('div', { class: 'kb-card-badges' },
    h('span', { class: `kb-pri ${pri.cls}`, text: pri.label }),
    t.due ? h('span', { class: `kb-due${isOverdue(t) ? ' overdue' : ''}`, text: `期限 ${t.due.slice(5)}` }) : null,
  );
  card.appendChild(badges);
  card.appendChild(h('div', { class: 'kb-card-title', text: t.title }));
  if (t.notes && t.notes.trim()) card.appendChild(h('div', { class: 'kb-card-note', text: '📝 ノートあり' }));

  card.addEventListener('click', () => openDetail(t, reload));
  return card;
}

function isOverdue(t) {
  if (!t.due || t.status === 'DONE') return false;
  return t.due < state.today;
}

// --- サイド(進捗ドーナツ + アクティビティログ) --------------------------
function sideEl(tasks) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'DONE').length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const ring = h('div', { class: 'kb-donut' });
  ring.style.background = `conic-gradient(var(--accent) ${pct * 3.6}deg, var(--line-2) 0)`;
  ring.appendChild(h('div', { class: 'kb-donut-center' },
    h('div', { class: 'kb-donut-num', text: `${done}/${total}` }),
    h('div', { class: 'kb-donut-lbl', text: '完了' }),
  ));
  const progressCard = h('div', { class: 'card' },
    h('div', { class: 'card-title', text: '当日進捗' }),
    h('div', { class: 'kb-donut-wrap' }, ring),
    h('p', { class: 'muted', style: { textAlign: 'center' }, text: `達成率 ${pct}%` }),
  );

  // アクティビティログ: 当日完了(done_at がローカル当日)を新しい順。
  const today = state.today;
  const doneToday = tasks
    .filter((t) => t.status === 'DONE' && t.done_at && localDateKey(new Date(t.done_at)) === today)
    .sort((a, b) => b.done_at - a.done_at);
  const logCard = h('div', { class: 'card' }, h('div', { class: 'card-title', text: '当日アクティビティ' }));
  if (!doneToday.length) {
    logCard.appendChild(emptyState('本日の完了はまだありません'));
  } else {
    const list = h('div', { class: 'list' });
    for (const t of doneToday) {
      list.appendChild(h('div', { class: 'kb-log-row' },
        h('span', { class: 'kb-log-time', text: fmtLocalTime(t.done_at) }),
        h('span', { class: 'grow', text: t.title }),
      ));
    }
    logCard.appendChild(list);
  }

  return h('div', { class: 'kb-side' }, progressCard, logCard);
}

function fmtLocalTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// --- カード詳細(優先度/期限/ノート) --------------------------------------
function openDetail(t, reload) {
  const priSel = h('select', {},
    h('option', { value: 'high' }, '高'),
    h('option', { value: 'mid' }, '中'),
    h('option', { value: 'low' }, '低'),
  );
  priSel.value = PRIORITY[t.priority] ? t.priority : 'low';
  const statusSel = h('select', {}, ...COLUMNS.map((c) => h('option', { value: c.key }, c.label)));
  statusSel.value = t.status;
  const dueInp = h('input', { type: 'date', value: t.due || '' });
  const titleInp = h('input', { type: 'text', value: t.title });

  const notesInp = h('textarea', { placeholder: 'Markdown で記述…' });
  notesInp.value = t.notes || '';
  const preview = h('div', { class: 'md-preview' });
  const syncPreview = () => { clear(preview); preview.appendChild(renderMarkdown(notesInp.value)); };
  notesInp.addEventListener('input', syncPreview);
  syncPreview();

  const save = h('button', { class: 'btn primary', text: '保存', type: 'button' });
  save.addEventListener('click', async () => {
    if (!titleInp.value.trim()) { toast('タイトルは必須', 'err'); return; }
    save.disabled = true;
    try {
      await api.updateTask(t.id, {
        title: titleInp.value.trim(),
        status: statusSel.value,
        priority: priSel.value,
        due: dueInp.value || null,
        notes: notesInp.value,
      });
      toast('保存しました', 'ok');
      closeModal();
      reload();
    } catch (err) { toast(`失敗: ${err.message}`, 'err'); save.disabled = false; }
  });
  const del = h('button', { class: 'btn danger', text: '削除', type: 'button' });
  del.addEventListener('click', async () => {
    if (!confirm('このタスクを削除しますか?')) return;
    try { await api.deleteTask(t.id); toast('削除しました', 'ok'); closeModal(); reload(); }
    catch (err) { toast(`失敗: ${err.message}`, 'err'); }
  });

  const body = h('div', { class: 'modal-body' },
    h('label', { class: 'field' }, 'タイトル', titleInp),
    h('div', { class: 'grid grid-3' },
      h('label', { class: 'field' }, '列', statusSel),
      h('label', { class: 'field' }, '優先度', priSel),
      h('label', { class: 'field' }, '期限', dueInp),
    ),
    h('label', { class: 'field' }, 'ノート (Markdown)', notesInp),
    h('div', { class: 'md-preview-label muted', text: 'プレビュー' }),
    preview,
    h('div', { class: 'actions' }, del, h('div', { class: 'spacer' }),
      h('button', { class: 'btn', text: 'キャンセル', type: 'button', onclick: closeModal }), save),
  );
  openModal(body, 'タスクの詳細');
}

// --- 完了演出(軽量 confetti + 任意サウンド) ------------------------------
function celebrate(anchor) {
  const rect = anchor.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + 40;
  const colors = ['#1a73e8', '#188038', '#f9ab00', '#d93025', '#a142f4', '#d01884'];
  for (let i = 0; i < 18; i++) {
    const p = h('div', { class: 'kb-confetti' });
    p.style.left = `${cx}px`;
    p.style.top = `${cy}px`;
    p.style.backgroundColor = colors[i % colors.length];
    document.body.appendChild(p);
    const angle = (Math.PI * 2 * i) / 18 + (i % 3) * 0.3;
    const dist = 60 + (i % 5) * 22;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist + 40;
    // 次フレームで目標状態へ transition(CSP 適合: CSSOM のみ)。
    requestAnimationFrame(() => {
      p.style.transform = `translate(${dx}px, ${dy}px) rotate(${dist}deg)`;
      p.style.opacity = '0';
    });
    setTimeout(() => p.remove(), 750);
  }
  if (localStorage.getItem(SOUND_KEY) === '1') playChime();
}

function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const notes = [523.25, 659.25, 783.99]; // C5 E5 G5
    notes.forEach((f, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(g); g.connect(ac.destination);
      const t0 = ac.currentTime + i * 0.09;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      o.start(t0); o.stop(t0 + 0.3);
    });
    setTimeout(() => ac.close(), 800);
  } catch { /* noop */ }
}
