// 設計図ビュー（spec: goal-blueprint）。目標ごとのタスクツリーを1画面で見る場所。
//  - プレビュー（階層カード・折りたたみ）と取り込み（テキスト貼り付け）の2モード。
//  - 既定の展開はサーバが返す openPath（現在地までのパス）だけ。手で開閉した状態は
//    この画面にいる間だけメモリに持ち、永続化しない（design D10）。
//  - デモ（お試し）モードは読み取り専用: モード切替・チェック・枝の操作をすべて出さない。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast, attachTooltip } from './util.js';
import { isDemo } from './demo.js';
import { promptReason } from './rule-form.js';
import { createMarkdownEditor } from './md-editor.js';

const MAX_VISUAL_DEPTH = 3; // 視覚的なインデントの頭打ち（design Risks）。それ以上は同じ深さで描く。

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
    mode: 'preview',
    nodes: [],
  };
  clear(root);
  root.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
  try {
    const bp = await fetchBlueprint(goalId);
    S.nodes = bp.nodes;
    S.openSet = new Set(bp.openPath || []);
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

function renderAll() {
  if (!S) return;
  const { root } = S;
  clear(root);
  const page = h('div', { class: 'bp-page' });

  const back = h('button', { class: 'bp-back', type: 'button', text: '← 戻る' });
  back.addEventListener('click', S.onBack);
  page.appendChild(back);

  const headActions = h('div', { class: 'bp-head-actions' });
  if (S.canOpenReport && S.onOpenReport) {
    const reportBtn = h('button', { class: 'btn small', type: 'button', text: 'レポートを開く' });
    reportBtn.addEventListener('click', S.onOpenReport);
    headActions.appendChild(reportBtn);
  }
  page.appendChild(h('header', { class: 'bp-head' },
    h('h1', { class: 'bp-title', text: `設計図${S.goalName ? ` — ${S.goalName}` : ''}` }),
    headActions,
  ));

  if (!S.demo) page.appendChild(modeToggleEl());

  if (S.mode === 'import' && !S.demo) {
    page.appendChild(importEl());
  } else {
    page.appendChild(previewEl());
  }

  root.appendChild(page);
}

function modeToggleEl() {
  const wrap = h('div', { class: 'bp-mode-toggle' });
  for (const m of [{ key: 'preview', label: 'プレビュー' }, { key: 'import', label: '取り込み' }]) {
    wrap.appendChild(h('button', {
      class: `bp-mode-btn${S.mode === m.key ? ' on' : ''}`, type: 'button', text: m.label,
      onclick: () => { S.mode = m.key; renderAll(); },
    }));
  }
  return wrap;
}

// --- プレビュー -------------------------------------------------------------

function previewEl() {
  if (!S.nodes.length) {
    return h('div', { class: 'empty bp-empty', text: S.demo
      ? 'この目標にはまだ設計図がありません。'
      : 'まだ設計図がありません。「取り込み」からタスクのツリーを作れます。' });
  }
  const tree = h('div', { class: 'bp-tree' });
  for (const n of S.nodes) tree.appendChild(nodeEl(n, 0));
  return tree;
}

function nodeEl(node, depth) {
  const isLeaf = node.children.length === 0;
  const depthCls = `bp-depth-${Math.min(depth, MAX_VISUAL_DEPTH)}`;
  const row = h('div', { class: `bp-node-row ${depthCls}` });

  if (isLeaf) {
    row.appendChild(h('span', { class: 'bp-toggle-spacer' }));
  } else {
    const expanded = S.openSet.has(node.id);
    row.appendChild(h('button', {
      class: `bp-toggle${expanded ? ' open' : ''}`, type: 'button', text: expanded ? '▾' : '▸',
      onclick: () => {
        if (expanded) S.openSet.delete(node.id); else S.openSet.add(node.id);
        renderAll();
      },
    }));
  }

  const checkbox = h('input', {
    type: 'checkbox', class: 'bp-checkbox', checked: node.done, disabled: !isLeaf || S.demo,
    title: isLeaf ? undefined : '容れ物の完了は子から自動的に決まります',
  });
  if (isLeaf && !S.demo) {
    checkbox.addEventListener('change', () => toggleLeaf(node, checkbox.checked));
  }
  row.appendChild(checkbox);
  row.appendChild(h('span', { class: `bp-node-title${node.done ? ' done' : ''}`, text: node.title }));
  if (!isLeaf && !S.demo) row.appendChild(branchActionsEl(node));

  const wrap = h('div', { class: 'bp-node' }, row);
  if (isLeaf && node.notes) {
    wrap.appendChild(h('div', { class: 'bp-node-notes', text: node.notes }));
  }
  if (!isLeaf && S.openSet.has(node.id)) {
    const kids = h('div', { class: 'bp-node-children' });
    for (const c of node.children) kids.appendChild(nodeEl(c, depth + 1));
    wrap.appendChild(kids);
  }
  return wrap;
}

async function toggleLeaf(node, checked) {
  try {
    await api.updateTask(node.id, { status: checked ? 'DONE' : 'TODO' });
    await reload();
  } catch (err) {
    toast(`保存に失敗: ${err.message}`, 'err');
    renderAll();
  }
}

function branchActionsEl(node) {
  const wrap = h('span', { class: 'bp-branch-actions' });
  const startBtn = h('button', { class: 'bp-branch-btn', type: 'button', text: 'この枝に着手する' });
  startBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    startBtn.disabled = true;
    try {
      await api.startBranch(node.id);
      toast('着手しました', 'ok');
      await reload();
    } catch (err) {
      toast(err.data?.error || `失敗: ${err.message}`, 'err');
      startBtn.disabled = false;
    }
  });
  const dropBtn = h('button', { class: 'bp-branch-btn danger', type: 'button', text: 'この枝を打ち切る' });
  dropBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const reason = promptReason('打ち切る理由を入力してください');
    if (reason == null) return;
    dropBtn.disabled = true;
    try {
      await api.dropBranch(node.id, reason);
      toast('打ち切りました', 'ok');
      await reload();
    } catch (err) {
      toast(err.data?.error || `失敗: ${err.message}`, 'err');
      dropBtn.disabled = false;
    }
  });
  wrap.appendChild(startBtn);
  wrap.appendChild(dropBtn);
  return wrap;
}

// --- 取り込み ---------------------------------------------------------------

function importEl() {
  const wrap = h('div', { class: 'bp-import' });
  wrap.appendChild(h('p', { class: 'bp-import-hint' },
    'インデントの深さが階層になります。「- 」で始まる行がタスク、それ以外の行は直前のタスクの本文になります。',
    h('br'),
    '既存のタスクは書き換えません（追加のみ）。取り込んだ葉は既定で保留に入ります。'));
  // 素の textarea だと Enter で箇条書きが継続せず Tab でインデントもできない（issue #91）。
  // 振り返り・カード詳細と同じ共有エディタを使う。行頭2スペース/段という Tab の単位が
  // parseBlueprintText のインデント解釈とそのまま一致する（md-editor.js の indentLine）。
  const PLACEHOLDER = '- 苦手な質問への回答を用意する\n  - 質問をピックアップする\n  - Notion にまとめる';
  const phEl = h('div', { class: 'rf-ph bp-import-ph', text: PLACEHOLDER });
  const btn = h('button', { class: 'btn primary', type: 'button', text: '取り込む' });
  const submit = async () => {
    const text = editor.getValue();
    if (!text.trim()) {
      toast('取り込むテキストを入力してください', 'err');
      return;
    }
    btn.disabled = true;
    try {
      await api.importGoalBlueprint(S.goalId, text);
      toast('取り込みました', 'ok');
      S.mode = 'preview';
      await reload();
    } catch (err) {
      toast(err.data?.error || `失敗: ${err.message}`, 'err');
      btn.disabled = false;
    }
  };
  const editor = createMarkdownEditor({
    placeholder: PLACEHOLDER,
    onChange: (raw) => { phEl.style.display = raw.trim() === '' ? 'block' : 'none'; },
    onSubmit: submit,
  });
  attachTooltip(btn, { label: '取り込む', keys: ['Ctrl', 'Enter'] });
  btn.addEventListener('click', submit);
  wrap.appendChild(h('div', { class: 'rf-ed-wrap bp-import-ed' }, phEl, editor.el));
  wrap.appendChild(btn);
  return wrap;
}
