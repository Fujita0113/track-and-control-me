// タスク一覧ビュー（spec: goal-blueprint）。目標ごとのタスクツリーをキーボードだけで組む場所。
//  - 行はカード。タイトルは常時編集できる <input>（ダブルクリック改名は廃止）。
//  - Enter 兄弟追加 / Tab 1段深く / Shift+Tab 1段浅く / Alt+C 完了 / ↑↓ 選択移動 / Ctrl+Enter 詳細。
//  - 既定の展開はサーバが返す openPath（現在地までのパス）だけ。手で開閉した状態は
//    この画面にいる間だけメモリに持ち、永続化しない（design D10）。
//  - デモ（お試し）モードは読み取り専用: 追加・改名・階層の変更・完了の切り替え・⋯ のいずれも出さない。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, attachTooltip } from './util.js';
import { isDemo } from './demo.js';
import { createMarkdownEditor } from './md-editor.js';

const MAX_VISUAL_DEPTH = 3; // 視覚的なインデントの頭打ち（design Risks）。それ以上は同じ深さで描く。
const BULK_PLACEHOLDER = '- 苦手な質問への回答を用意する\n  - 質問をピックアップする\n  - Notion にまとめる';

let S = null;

function fetchBlueprint(goalId) {
  return isDemo() ? api.demo.blueprint(goalId, state.demo.virtualDay) : api.getGoalBlueprint(goalId);
}

/**
 * @param {Element} root
 * @param {number} goalId
 * @param {{goalName?: string, canOpenReport?: boolean, onBack: () => void, onOpenReport?: () => void}} opts
 */
export async function render(root, goalId, opts = {}) {
  S = {
    root,
    goalId,
    goalName: opts.goalName || '',
    canOpenReport: !!opts.canOpenReport,
    onBack: opts.onBack || (() => {}),
    onOpenReport: opts.onOpenReport || null,
    demo: isDemo(),
    nodes: [],
    index: new Map(), // id -> { node, parentId, depth, siblingIds }（renderAll のたびに作り直す）
    visibleOrder: [], // ↑↓ で辿る、いま画面に見えているノード id の順序（renderAll のたびに作り直す）
    selId: null, // 選択中のノード id
    caret: null, // 選択中の入力のキャレット位置（再描画後に復元）
    addAfter: null, // { afterTaskId: number|null } … Enter / 末尾の＋で開いているエフェメラルな追加入力
    menuOpenId: null, // 「⋯」メニューが開いているノード id
    bulkOpen: false, // ヘッダの「まとめて追加」パネル
    detailId: null, // 詳細モーダルを開いているノード id
  };
  clear(root);
  root.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
  try {
    const bp = await fetchBlueprint(goalId);
    S.nodes = bp.nodes;
    S.openSet = new Set(bp.openPath || []);
    if (!S.nodes.length && !S.demo) S.addAfter = { afterTaskId: null };
  } catch (err) {
    clear(root);
    root.appendChild(h('div', { class: 'empty', text: `読み込み失敗: ${err.data?.error || err.message}` }));
    const back = h('button', { class: 'bp-back', type: 'button', text: '← 戻る' });
    back.addEventListener('click', S.onBack);
    root.appendChild(back);
    return;
  }
  renderAll();
}

export function unmount() {
  S = null;
}

async function reload() {
  if (!S) return;
  try {
    const bp = await fetchBlueprint(S.goalId);
    S.nodes = bp.nodes;
    // openSet（手で開閉した状態）はここでは触らない。この画面にいる間だけ保持する（spec）。
  } catch (err) {
    toast(`更新に失敗: ${err.message}`, 'err');
  }
  renderAll();
}

// --- ツリーの索引（親・深さ・兄弟）と可視順（design D9） --------------------

function buildIndex(nodes, parentId, depth, index) {
  const ids = nodes.map((n) => n.id);
  for (const n of nodes) {
    index.set(n.id, { node: n, parentId, depth, siblingIds: ids });
    buildIndex(n.children, n.id, depth + 1, index);
  }
}

function leafStats(node) {
  if (node.children.length === 0) {
    return { total: 1, done: node.done ? 1 : 0 };
  }
  let total = 0;
  let done = 0;
  for (const c of node.children) {
    const s = leafStats(c);
    total += s.total;
    done += s.done;
  }
  return { total, done };
}

function lastRootId() {
  return S.nodes.length ? S.nodes[S.nodes.length - 1].id : null;
}

function renderAll() {
  if (!S) return;
  const { root } = S;
  S.index = new Map();
  buildIndex(S.nodes, null, 0, S.index);
  S.visibleOrder = [];

  clear(root);
  const page = h('div', { class: 'bp-page' });

  const back = h('button', { class: 'bp-back', type: 'button', text: '← 戻る' });
  back.addEventListener('click', S.onBack);
  page.appendChild(back);

  const headActions = h('div', { class: 'bp-head-actions' });
  if (!S.demo) {
    const bulkBtn = h('button', { class: 'btn small', type: 'button', text: 'まとめて追加' });
    bulkBtn.addEventListener('click', () => {
      S.bulkOpen = !S.bulkOpen;
      renderAll();
    });
    headActions.appendChild(bulkBtn);
  }
  if (S.canOpenReport && S.onOpenReport) {
    const reportBtn = h('button', { class: 'btn small', type: 'button', text: 'レポートを開く' });
    reportBtn.addEventListener('click', S.onOpenReport);
    headActions.appendChild(reportBtn);
  }
  page.appendChild(h('header', { class: 'bp-head' },
    h('div', {},
      h('div', { class: 'bp-eyebrow', text: 'タスク一覧' }),
      h('h1', { class: 'bp-title', text: S.goalName })),
    headActions,
  ));

  if (S.bulkOpen && !S.demo) page.appendChild(bulkPanelEl());

  page.appendChild(progressEl());
  page.appendChild(treeEl());
  if (!S.demo) page.appendChild(legendEl());
  if (S.detailId != null) page.appendChild(detailModalEl());

  root.appendChild(page);
  restoreFocus();
}

/** 再描画のたびに、選択中のノード（またはエフェメラルな追加入力）へフォーカスとキャレットを戻す（design D9）。 */
function restoreFocus() {
  if (!S) return;
  if (S.addAfter) {
    const el = S.root.querySelector('.bp-add-input');
    if (el) el.focus();
    return;
  }
  if (S.selId == null) return;
  const el = S.root.querySelector(`.bp-node-row[data-id="${S.selId}"] .bp-node-title`);
  if (!el) return;
  el.focus();
  if (S.caret != null && typeof el.setSelectionRange === 'function') {
    try {
      el.setSelectionRange(S.caret, S.caret);
    } catch {
      /* noop */
    }
  }
}

// --- 進捗（葉の数が分母・design 4.9） ----------------------------------------

function progressEl() {
  const stats = S.nodes.reduce(
    (acc, n) => {
      const s = leafStats(n);
      acc.total += s.total;
      acc.done += s.done;
      return acc;
    },
    { total: 0, done: 0 },
  );
  const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
  return h('div', { class: 'bp-progress' },
    h('div', { class: 'bp-progress-track' }, h('div', { class: 'bp-progress-bar', style: { width: `${pct}%` } })),
    h('div', { class: 'bp-progress-label' }, h('b', { text: String(stats.done) }), ` / ${stats.total} 完了`));
}

// --- ツリー本体（design D7・D9・D10） ---------------------------------------

/** ノード列（根、または node.children）を描き、エフェメラルな追加入力を該当する兄弟の直後へ挟む。 */
function renderSiblingList(nodes, depth, container) {
  if (S.addAfter && S.addAfter.afterTaskId === null && nodes.length === 0) {
    container.appendChild(addInlineRowEl(depth));
  }
  for (const n of nodes) {
    container.appendChild(nodeEl(n, depth));
    if (S.addAfter && S.addAfter.afterTaskId === n.id) {
      container.appendChild(addInlineRowEl(depth));
    }
  }
}

function treeEl() {
  const wrap = h('div', { class: 'bp-tree-wrap' });
  wrap.addEventListener('keydown', onTreeKeydown);

  if (!S.nodes.length) {
    wrap.appendChild(h('div', { class: 'empty bp-empty', text: S.demo
      ? 'この目標にはまだタスクがありません。'
      : 'まだタスクがありません。Enter で足して Tab で潜らせられます。' }));
  }

  const tree = h('div', { class: 'bp-tree' });
  renderSiblingList(S.nodes, 0, tree);
  wrap.appendChild(tree);

  if (!S.demo) {
    const addBtn = h('button', { class: 'bp-add-btn', type: 'button' },
      h('span', { class: 'bp-add-btn-plus', text: '＋' }), 'タスクを追加');
    attachTooltip(addBtn, { label: 'タスクを追加', keys: ['Enter'] });
    addBtn.addEventListener('click', () => openAddAfter(lastRootId()));
    wrap.appendChild(addBtn);
  }
  return wrap;
}

function nodeEl(node, depth) {
  const isLeaf = node.children.length === 0;
  const depthCls = `bp-depth-${Math.min(depth, MAX_VISUAL_DEPTH)}`;
  const selected = S.selId === node.id;
  const row = h('div', {
    class: `bp-node-row ${depthCls}${selected ? ' sel' : ''}`,
    dataset: { id: String(node.id) },
  });
  S.visibleOrder.push(node.id);

  if (isLeaf) {
    row.appendChild(h('span', { class: 'bp-toggle-spacer' }));
  } else {
    const expanded = S.openSet.has(node.id);
    const toggle = h('button', {
      class: `bp-toggle${expanded ? ' open' : ''}`, type: 'button', text: expanded ? '▾' : '▸',
      onclick: () => {
        S.selId = node.id;
        if (expanded) S.openSet.delete(node.id); else S.openSet.add(node.id);
        renderAll();
      },
    });
    attachTooltip(toggle, { label: expanded ? '畳む' : '開く' });
    row.appendChild(toggle);
  }

  row.appendChild(checkboxEl(node));
  row.appendChild(nodeTitleEl(node));

  if (!isLeaf) {
    const stats = leafStats(node);
    row.appendChild(h('span', { class: 'bp-node-childcount', text: `${stats.done}/${stats.total}` }));
  }

  if (!S.demo) row.appendChild(nodeMenuEl(node));

  const wrapNode = h('div', { class: 'bp-node' }, row);
  if (isLeaf && node.notes) {
    wrapNode.appendChild(h('div', { class: 'bp-node-notes', text: node.notes }));
  }

  if (!isLeaf && S.openSet.has(node.id)) {
    const kids = h('div', { class: 'bp-node-children' });
    renderSiblingList(node.children, depth + 1, kids);
    wrapNode.appendChild(kids);
  }
  return wrapNode;
}

function checkboxEl(node) {
  const btn = h('button', {
    class: `bp-checkbox${node.done ? ' on' : ''}`, type: 'button', text: node.done ? '✓' : '',
    disabled: S.demo,
  });
  attachTooltip(btn, { label: node.done ? '完了を外す' : '完了にする', keys: ['Alt', 'C'] });
  if (!S.demo) {
    btn.addEventListener('click', () => {
      S.selId = node.id;
      handleToggleDone(node.id);
    });
  }
  return btn;
}

/** タイトル部。常時 <input>（design D7）。デモモードは編集できない素の表示にする。 */
function nodeTitleEl(node) {
  const cls = `bp-node-title${node.children.length ? ' container' : ''}${node.done ? ' done' : ''}`;
  if (S.demo) {
    return h('span', { class: cls, text: node.title });
  }
  const input = h('input', { class: cls, type: 'text', value: node.title });
  attachTooltip(input, { label: '詳細を開く', keys: ['Ctrl', 'Enter'] });
  input.addEventListener('focus', () => { S.selId = node.id; });
  input.addEventListener('input', () => { S.caret = input.selectionStart; });
  input.addEventListener('blur', () => { commitTitle(node, input); });
  return input;
}

async function commitTitle(node, input) {
  const next = input.value.trim();
  if (!next) {
    input.value = node.title; // 空文字は保存しない（design D7）
    return;
  }
  if (next === node.title) return; // 無変更なら投げない（design D7）
  input.disabled = true;
  try {
    await api.updateTask(node.id, { title: next });
    await reload();
  } catch (err) {
    toast(`保存に失敗: ${err.message}`, 'err');
    input.disabled = false;
  }
}

/** 行ホバーで出る「⋯」。削除だけを持つ1項目のメニュー（design D10）。 */
function nodeMenuEl(node) {
  const open = S.menuOpenId === node.id;
  const btn = h('button', {
    class: `bp-node-menu-btn${open ? ' open' : ''}`, type: 'button', text: '⋯',
  });
  attachTooltip(btn, { label: '操作メニュー' });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    S.selId = node.id;
    S.menuOpenId = open ? null : node.id;
    renderAll();
  });
  const wrap = h('span', { class: 'bp-node-menu' }, btn);
  if (!open) return wrap;

  const menu = h('div', { class: 'bp-menu' });
  menu.appendChild(h('button', {
    class: 'bp-menu-item danger', type: 'button', text: '削除',
    onclick: async (e) => {
      e.stopPropagation();
      S.menuOpenId = null;
      // 完了済み・子持ちノードの削除は事故が大きいので確認を挟む（design Risks・kanban の deleteTaskWithConfirm と同じ流儀）。
      const risky = node.done || node.children.length > 0;
      if (risky && !confirm('このタスクを削除しますか？（子は残り、親へ繰り上がります）')) {
        renderAll();
        return;
      }
      try {
        await api.deleteTask(node.id);
        S.openSet.delete(node.id);
        toast('削除しました', 'ok');
        await reload();
      } catch (err) {
        toast(`削除に失敗: ${err.message}`, 'err');
        renderAll();
      }
    },
  }));
  wrap.appendChild(menu);
  return wrap;
}

// --- エフェメラルな追加入力（Enter / 末尾の＋・design D5） -------------------

function openAddAfter(afterTaskId) {
  S.menuOpenId = null;
  S.bulkOpen = false;
  S.addAfter = { afterTaskId };
  if (afterTaskId != null) S.selId = afterTaskId;
  const info = afterTaskId != null ? S.index.get(afterTaskId) : null;
  if (info && info.parentId != null) S.openSet.add(info.parentId);
  renderAll();
}

function addInlineRowEl(depth) {
  const depthCls = `bp-depth-${Math.min(depth, MAX_VISUAL_DEPTH)}`;
  const row = h('div', { class: `bp-node-row bp-add-row ${depthCls}` });
  row.appendChild(h('span', { class: 'bp-toggle-spacer' }));
  row.appendChild(h('span', { class: 'bp-checkbox-spacer' }));
  const input = h('input', { class: 'bp-add-input', type: 'text', placeholder: 'タイトルを入力' });
  attachTooltip(input, { label: '追加', keys: ['Enter'] });
  input.addEventListener('keydown', async (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) { // 空文字の Enter は閉じるだけ（design Risks）。
        S.addAfter = null;
        renderAll();
        return;
      }
      input.disabled = true;
      await submitAdd(title);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      S.addAfter = null;
      renderAll();
    }
  });
  row.appendChild(input);
  return row;
}

async function submitAdd(title) {
  try {
    const created = S.addAfter.afterTaskId == null
      ? await api.createGoalBlueprintRoot(S.goalId, title)
      : await api.createSiblingTask(S.addAfter.afterTaskId, title);
    // S.addAfter は今作ったものの直後を指す（続けて次の入力を開く・design D5）。
    S.addAfter = { afterTaskId: created.id };
    S.selId = created.id;
    await reload();
  } catch (err) {
    toast(err.data?.error || `追加に失敗: ${err.message}`, 'err');
    S.addAfter = null;
    renderAll();
  }
}

// --- キーボード操作（design D4・D5・D6・D8・spec: キーボードだけで組める） --

async function onTreeKeydown(e) {
  if (!S || S.demo) return;
  if (e.target.closest('.bp-add-input')) return; // 専用ハンドラに任せる
  if (e.isComposing || e.keyCode === 229) return; // IME 変換確定の Enter は無視
  const row = e.target.closest('.bp-node-row[data-id]');
  const nodeId = row ? Number(row.dataset.id) : null;
  const info = nodeId != null ? S.index.get(nodeId) : null;
  const node = info ? info.node : null;

  // Ctrl/Cmd+Enter: 詳細モーダル（先に判定しないと下の Enter 節に食われる）。
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    if (!node) return;
    e.preventDefault();
    openDetailModal(node);
    return;
  }

  if (e.key === 'Enter') {
    if (!node) return;
    e.preventDefault();
    if (e.target.classList.contains('bp-node-title')) {
      await commitTitle(node, e.target);
    }
    openAddAfter(node.id);
    return;
  }

  if (e.key === 'Escape') {
    if (e.target.classList.contains('bp-node-title') && node) {
      e.preventDefault();
      e.target.value = node.title;
      e.target.blur();
    }
    return;
  }

  if (e.key === 'Tab') {
    if (!node) return;
    e.preventDefault();
    if (e.shiftKey) handleShiftTab(node.id); else handleTab(node.id);
    return;
  }

  if (e.altKey && e.key.toLowerCase() === 'c') {
    if (!node) return;
    e.preventDefault();
    handleToggleDone(node.id);
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    handleArrow('down');
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    handleArrow('up');
  }
}

function handleArrow(dir) {
  const order = S.visibleOrder;
  if (!order.length) return;
  const idx = order.indexOf(S.selId);
  let next;
  if (idx === -1) next = 0;
  else next = dir === 'down' ? Math.min(order.length - 1, idx + 1) : Math.max(0, idx - 1);
  S.selId = order[next];
  S.caret = null;
  renderAll();
}

async function handleTab(nodeId) {
  const info = S.index.get(nodeId);
  if (!info) return;
  const idx = info.siblingIds.indexOf(nodeId);
  if (idx <= 0) return; // 先頭では何もしない（エラーにしない・spec）
  const prevId = info.siblingIds[idx - 1];
  try {
    await api.setTaskTreePosition(nodeId, { parentId: prevId, afterTaskId: null });
    S.openSet.add(prevId); // 移動先の祖先は開いたままにする（task 4.7）
    S.selId = nodeId;
    await reload();
  } catch (err) {
    toast(err.data?.error || `移動に失敗: ${err.message}`, 'err');
  }
}

async function handleShiftTab(nodeId) {
  const info = S.index.get(nodeId);
  if (!info || info.parentId == null) return; // 根なら何もしない（エラーにしない・spec）
  const parentInfo = S.index.get(info.parentId);
  const grandParentId = parentInfo ? parentInfo.parentId : null;
  try {
    await api.setTaskTreePosition(nodeId, { parentId: grandParentId, afterTaskId: info.parentId });
    if (grandParentId != null) S.openSet.add(grandParentId);
    S.selId = nodeId;
    await reload();
  } catch (err) {
    toast(err.data?.error || `移動に失敗: ${err.message}`, 'err');
  }
}

async function handleToggleDone(nodeId) {
  const info = S.index.get(nodeId);
  if (!info) return;
  try {
    await api.setSubtreeDone(nodeId, !info.node.done);
    await reload();
  } catch (err) {
    toast(err.data?.error || `更新に失敗: ${err.message}`, 'err');
  }
}

// --- 詳細モーダル（design D8） -----------------------------------------------

function ancestorTitles(nodeId) {
  const titles = [];
  let info = S.index.get(nodeId);
  while (info) {
    titles.unshift(info.node.title);
    info = info.parentId != null ? S.index.get(info.parentId) : null;
  }
  return titles;
}

function openDetailModal(node) {
  S.detailId = node.id;
  renderAll();
}

function closeDetailModal() {
  const editor = S.detailEditor;
  const node = S.detailId != null ? S.index.get(S.detailId)?.node : null;
  S.detailId = null;
  S.detailEditor = null;
  if (node && editor) {
    api.updateTask(node.id, { notes: editor.getValue() }).catch((err) => {
      toast(`保存に失敗: ${err.message}`, 'err');
    });
  }
  reload();
}

function detailModalEl() {
  const node = S.index.get(S.detailId)?.node;
  if (!node) {
    S.detailId = null;
    return h('div');
  }
  const titles = ancestorTitles(S.detailId);
  const crumbParts = [S.goalName, ...titles.slice(0, -1)].filter(Boolean);

  const veil = h('div', { class: 'bp-detail-veil' });
  veil.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDetailModal();
    }
  });
  veil.addEventListener('mousedown', (e) => {
    if (e.target === veil) closeDetailModal();
  });

  const closeBtn = h('button', { class: 'bp-detail-close', type: 'button', text: '✕' });
  attachTooltip(closeBtn, { label: '閉じる', keys: ['Esc'] });
  closeBtn.addEventListener('click', closeDetailModal);

  const head = h('div', { class: 'bp-detail-head' },
    h('div', { style: { minWidth: '0' } },
      h('div', { class: 'bp-detail-crumb', text: crumbParts.join(' › ') }),
      h('div', { class: 'bp-detail-title', text: node.title })),
    closeBtn);

  const ph = h('div', { class: 'rf-ph', text: 'Markdown でメモを書く' });
  const editor = createMarkdownEditor({
    initial: node.notes || '',
    placeholder: 'Markdown でメモを書く',
    onChange: (raw) => { ph.style.display = raw.trim() === '' ? 'block' : 'none'; },
  });
  S.detailEditor = editor;
  const body = h('div', { class: 'bp-detail-body' }, h('div', { class: 'rf-ed-wrap bp-detail-ed' }, ph, editor.el));

  const foot = h('div', { class: 'bp-detail-foot' },
    h('span', {}, h('b', { text: 'Tab' }), ' インデント'),
    h('span', {}, h('b', { text: '- ' }), ' 箇条書きの継続'),
    h('span', { class: 'bp-detail-foot-right' }, h('b', { text: 'Esc' }), ' 閉じる'));

  const modal = h('div', { class: 'bp-detail-modal' }, head, body, foot);
  veil.appendChild(modal);
  setTimeout(() => editor.focus(), 0);
  return veil;
}

// --- まとめて追加（design D1・D3・ADDED「まとめて追加は根に足し、階層はあとから変える」） ---

function bulkPanelEl() {
  const wrap = h('div', { class: 'bp-bulk' });
  wrap.appendChild(h('p', { class: 'bp-import-hint' },
    'インデントの深さが階層になります。「- 」で始まる行がタスク、それ以外の行は直前のタスクの本文になります。',
    h('br'),
    '既存のタスクは書き換えません（追加のみ）。取り込んだ葉は既定で保留に入ります。既存の枝へ入れたい場合は、',
    '足したあとで Tab を押して1段深くしてください。'));
  const phEl = h('div', { class: 'rf-ph bp-import-ph', text: BULK_PLACEHOLDER });
  const btn = h('button', { class: 'btn primary', type: 'button', text: 'まとめて追加' });
  const cancelBtn = h('button', { class: 'btn small', type: 'button', text: 'キャンセル' });
  cancelBtn.addEventListener('click', () => {
    S.bulkOpen = false;
    renderAll();
  });
  const submit = async () => {
    const text = editor.getValue();
    if (!text.trim()) {
      toast('追加するテキストを入力してください', 'err');
      return;
    }
    btn.disabled = true;
    try {
      await api.importGoalBlueprint(S.goalId, text, null);
      toast('追加しました', 'ok');
      S.bulkOpen = false;
      await reload();
    } catch (err) {
      toast(err.data?.error || `失敗: ${err.message}`, 'err');
      btn.disabled = false;
    }
  };
  const editor = createMarkdownEditor({
    placeholder: BULK_PLACEHOLDER,
    onChange: (raw) => { phEl.style.display = raw.trim() === '' ? 'block' : 'none'; },
    onSubmit: submit,
  });
  attachTooltip(btn, { label: 'まとめて追加', keys: ['Ctrl', 'Enter'] });
  btn.addEventListener('click', submit);
  wrap.appendChild(h('div', { class: 'rf-ed-wrap bp-import-ed' }, phEl, editor.el));
  wrap.appendChild(h('div', { class: 'bp-bulk-actions' }, btn, cancelBtn));
  return wrap;
}

// --- 凡例（design 4.10・spec: キーボードだけで組める） -----------------------

function legendEl() {
  return h('div', { class: 'bp-legend' },
    h('span', {}, h('b', { text: 'Enter' }), ' 新規タスク'),
    h('span', {}, h('b', { text: 'Tab' }), ' 子タスク化'),
    h('span', {}, h('b', { text: 'Shift+Tab' }), ' 親に戻す'),
    h('span', {}, h('b', { text: 'Alt+C' }), ' 完了'),
    h('span', {}, h('b', { text: '↑↓' }), ' 選択移動'),
    h('span', {}, h('b', { text: 'Ctrl+Enter' }), ' 詳細を開く'));
}
