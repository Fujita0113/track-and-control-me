// Notion 風インライン・ライブ Markdown エディタ（ref/reflection/振り返り.dc.html 忠実移植 + 追加挙動）。
//  - 単一 contenteditable。1 行 = 1 ブロック div。構文マーカーは淡色表示しつつ整形結果を同じ行にインライン描画。
//  - すべて DOM ノード構築（h()）+ CSSOM。innerHTML 文字列やインライン style 属性は使わない（CSP 適合）。
//  - 本文は raw Markdown テキスト（getContent = 各ブロックの textContent を \n 連結）として保持。
//  - IME（日本語）: compositionstart/end ガードで変換中の再描画を抑止。
//  - 追加した Notion 挙動: リスト継続 / 空行抜け / ``` 自動クローズ / [ ] todo / Backspace1回削除 / □トグル。
//    いずれも「caret→行/桁を算出→raw を変換→再描画→caret 再設定」で raw/caret モデルに一貫して乗る。
//  - Undo/Redo は DOM 全置換で失われる標準履歴の代わりに { raw, caret } スナップショットの自前スタックで実現。
//    構造変化は setRawAndCaret の直前で commitHistory() を呼びコミット境界にし、通常入力はコアレスする。
//  - paste/cut はブラウザ既定を横取りし text/plain を raw モデルへ差し込む（1 行 = 1 ブロックを保つ）。
import { h } from './util.js';

const LIST_RE = /^(\s*)([-*+]|\d+\.)(\s+)(?:\[([ xX])\](\s+))?(.*)$/;
const TASK_RE = /^(\s*)([-*+])(\s+)\[([ xX])\](\s+)(.*)$/;
const HISTORY_LIMIT = 200;

// ---- 貼り付け HTML → Markdown 変換（D6 拡張 / issue #6）--------------------------
//  Notion/Google Docs/web からの text/html を「1 行 = 1 ブロック」の raw Markdown へ落とす。
//  タグ駆動・クラス非依存（Notion の undocumented class に依存しない）。DOMParser の
//  detached document を読み取るだけで live DOM へは一切注入しない（CSP/XSS 安全）。
const MD_WRAPPER = new Set(['DIV', 'SPAN', 'FONT', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION', 'BODY']);

function mdCollapseWs(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function mdSep(out) { if (out.length && out[out.length - 1] !== '') out.push(''); } // ブロック間に空行 1 つ
function mdHasBlockChild(el) { return !!el.querySelector('p,div,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,pre,hr,table,li'); }
function mdOwnEl(li, sel) { // この li 自身に属する子孫（ネスト li の子孫は除外）
  for (const e of li.querySelectorAll(sel)) { if (e.closest('li') === li) return e; }
  return null;
}
function mdOwnLists(li) { return [...li.querySelectorAll('ul,ol')].filter((l) => l.closest('li') === li); }
function mdIsBold(el) { const w = el.style && el.style.fontWeight; return w === 'bold' || w === 'bolder' || parseInt(w, 10) >= 600; }
function mdIsItalic(el) { return !!(el.style && el.style.fontStyle === 'italic'); }
function mdWrap(inner, m) { return inner.trim() ? m + inner + m : inner; } // 空 **** を出さない

// インライン子を走査してマーカー付きテキストへ（改行は返さない = 1 行 = 1 ブロックを保つ）
function mdInlineText(node, excludeLists, brNL) {
  let s = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) { s += c.nodeValue; continue; } // Text
    if (c.nodeType !== 1) continue; // コメント（CF_HTML の StartFragment 等）を無視
    const tag = c.tagName;
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') continue;
    if (excludeLists && (tag === 'UL' || tag === 'OL')) continue; // ネスト list は再帰で処理
    if (tag === 'BR') { s += brNL ? '\n' : ' '; continue; }
    if (tag === 'INPUT') continue; // チェックボックスの control 自体に文字は無い
    const inner = mdInlineText(c, excludeLists, brNL);
    if (tag === 'STRONG' || tag === 'B') s += mdWrap(inner, '**');
    else if (tag === 'EM' || tag === 'I') s += mdWrap(inner, '*');
    else if (tag === 'CODE') s += mdWrap(inner, '`');
    else if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') s += mdWrap(inner, '~~');
    else if (tag === 'A') { const href = c.getAttribute('href'); s += href ? `[${inner}](${href})` : inner; }
    else if (tag === 'SPAN' && mdIsBold(c)) s += mdWrap(inner, '**'); // Google Docs の font-weight run
    else if (tag === 'SPAN' && mdIsItalic(c)) s += mdWrap(inner, '*'); // Google Docs の font-style run
    else s += inner; // div/span/font/checkbox-div 等は透過
  }
  return s;
}

// li が to-do か・チェック状態か（複数シグナルの OR、優先順で状態判定）
function mdDetectTodo(li, ownText) {
  const input = mdOwnEl(li, 'input[type="checkbox"]');
  const role = mdOwnEl(li, '[role="checkbox"]');
  const ulCls = (li.closest('ul') || {}).className || '';
  const cbEl = mdOwnEl(li, '[class*="checkbox"]'); // Notion の <div class="checkbox ...">
  const chEl = mdOwnEl(li, '[class*="to-do-children"]'); // Notion の <span class="to-do-children-...">
  const glyph = mdCollapseWs(ownText).match(/^\[([ xX]?)\]\s?/); // 素の "[ ] "/"[x] "
  const isTodo = !!(input || role || /to-do-list/.test(ulCls) || cbEl || chEl || glyph);
  let checked = false;
  if (input) checked = input.checked || input.hasAttribute('checked');
  else if (role) checked = role.getAttribute('aria-checked') === 'true';
  else if (mdOwnEl(li, '[class*="checkbox-on"], [class*="to-do-children-checked"]')) checked = true;
  else if (glyph) checked = /[xX]/.test(glyph[1]);
  return { isTodo, checked, glyph: !!glyph };
}

// blockquote は行ごとに "> " を付ける（1 ブロックに \n を埋め込まない）
function mdBlockquoteLines(el) {
  const lines = [];
  const blocks = [...el.children].filter((c) => /^(P|DIV|H[1-6])$/.test(c.tagName));
  if (blocks.length) { for (const b of blocks) { const t = mdCollapseWs(mdInlineText(b, false)); if (t) lines.push(t); } }
  else { for (const seg of mdInlineText(el, false, true).split('\n')) { const t = mdCollapseWs(seg); if (t) lines.push(t); } }
  if (!lines.length) { const t = mdCollapseWs(mdInlineText(el, false)); if (t) lines.push(t); }
  return lines;
}

// list を 2 スペース/段のインデントで出力（indentLine の単位・Enter の連番と一致）
function mdEmitList(listEl, ordered, depth, out) {
  let counter = ordered ? (parseInt(listEl.getAttribute('start'), 10) || 1) : 1;
  const items = [...listEl.children].filter((c) => c.tagName === 'LI');
  for (const li of items) {
    const raw0 = mdInlineText(li, true); // この li 自身のインライン内容（ネスト list 除外）
    const det = mdDetectTodo(li, raw0);
    let text = mdCollapseWs(raw0);
    if (det.isTodo && det.glyph) text = text.replace(/^\[[ xX]?\]\s?/, ''); // 先頭 glyph の二重化を防ぐ
    const nested = mdOwnLists(li);
    const indent = '  '.repeat(depth);
    if (text === '' && nested.length) { // 純コンテナ li: 空マーカーを出さず同段で再帰
      for (const n of nested) mdEmitList(n, n.tagName === 'OL', depth, out);
      continue;
    }
    const marker = det.isTodo ? (det.checked ? '- [x] ' : '- [ ] ')
      : ordered ? (counter++) + '. '
        : '- ';
    out.push(indent + marker + text);
    for (const n of nested) mdEmitList(n, n.tagName === 'OL', depth + 1, out);
  }
}

function mdEmitBlock(el, out) {
  const tag = el.tagName;
  if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'META' || tag === 'LINK') return;
  let hm;
  if ((hm = /^H([1-6])$/.exec(tag))) {
    const lvl = Math.min(6, +hm[1]);
    mdSep(out); out.push('#'.repeat(lvl) + ' ' + mdCollapseWs(mdInlineText(el, false)));
  } else if (tag === 'UL' || tag === 'OL') {
    mdSep(out); mdEmitList(el, tag === 'OL', 0, out);
  } else if (tag === 'BLOCKQUOTE') {
    mdSep(out); for (const ln of mdBlockquoteLines(el)) out.push('> ' + ln);
  } else if (tag === 'PRE') { // コード内改行はそれぞれ独立行として保持
    mdSep(out); out.push('```');
    for (const ln of String(el.textContent).replace(/\r/g, '').split('\n')) out.push(ln);
    out.push('```');
  } else if (tag === 'HR') {
    mdSep(out); out.push('---');
  } else if (tag === 'P') {
    const t = mdCollapseWs(mdInlineText(el, false)); if (t) { mdSep(out); out.push(t); }
  } else if (MD_WRAPPER.has(tag)) {
    if (mdHasBlockChild(el)) mdEmitChildren(el, out); // 構造ラッパは透過して降りる
    else { const t = mdCollapseWs(mdInlineText(el, false)); if (t) { mdSep(out); out.push(t); } } // inline のみ → 段落
  } else { // TABLE/LI/未知 → 1 行にフラット化
    const t = mdCollapseWs(mdInlineText(el, false)); if (t) { mdSep(out); out.push(t); }
  }
}

function mdEmitChildren(container, out) {
  for (const c of container.childNodes) {
    if (c.nodeType === 3) { const t = mdCollapseWs(c.nodeValue); if (t) { mdSep(out); out.push(t); } continue; }
    if (c.nodeType === 1) mdEmitBlock(c, out);
  }
}

/** クリップボード HTML を「1 行 = 1 ブロック」の raw Markdown 文字列へ変換。内容が無ければ ''。 */
export function htmlToMarkdown(html) {
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch { return ''; }
  const body = doc && doc.body;
  if (!body) return '';
  const out = [];
  mdEmitChildren(body, out);
  const md = out.join('\n').replace(/\r/g, '');
  return md.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

/** Markdown エディタを生成。root(el)・getValue/setValue・focus・isDirty/markSaved を返す。 */
export function createMarkdownEditor({ initial = '', placeholder = '', onChange } = {}) {
  const editor = h('div', {
    class: 'rf-ed',
    contenteditable: 'true',
    spellcheck: 'false',
    'aria-label': placeholder || 'Markdown editor',
  });

  let raw = '';
  let dirty = false;
  let composing = false;

  // ---- Undo/Redo 履歴（{ raw, caret } スナップショットの自前スタック） ----
  let undoStack = [];
  let redoStack = [];
  let typingBurst = false; // 連続入力を 1 履歴にコアレスするためのフラグ

  /** 現在の raw/caret を undoStack に積みコミット境界を作る。redo は破棄。連続同一 raw は二重 push しない。 */
  function commitHistory() {
    typingBurst = false;
    const snap = { raw, caret: getCaret(editor) };
    const top = undoStack[undoStack.length - 1];
    if (top && top.raw === snap.raw) { redoStack = []; return; } // 二重 push ガード（IME 等）
    undoStack.push(snap);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
  }

  /** 直前のコミット境界へ戻す（復元自体は履歴を積まない）。 */
  function undo() {
    typingBurst = false;
    if (!undoStack.length) return;
    redoStack.push({ raw, caret: getCaret(editor) });
    const prev = undoStack.pop();
    setRawAndCaret(prev.raw, prev.caret);
  }

  /** 取り消した編集をやり直す。 */
  function redo() {
    typingBurst = false;
    if (!redoStack.length) return;
    undoStack.push({ raw, caret: getCaret(editor) });
    const next = redoStack.pop();
    setRawAndCaret(next.raw, next.caret);
  }

  // ---- inline 装飾: `code` / **bold** / ~~strike~~ / *italic* / _italic_ ----
  const RE = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(~~[^~]+?~~)|(\*[^*\n]+?\*)|(_[^_\n]+?_)/g;
  function mk(s) { return h('span', { class: 'rf-ed-marker', text: s }); }
  function inline(text) {
    const nodes = [];
    let last = 0;
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(text)) !== null) {
      if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
      if (m[1] != null) { const g = m[1].slice(1, -1); nodes.push(mk('`'), h('code', { class: 'rf-ed-code', text: g }), mk('`')); }
      else if (m[2] != null) { const g = m[2].slice(2, -2); nodes.push(mk('**'), h('strong', { class: 'rf-ed-strong', text: g }), mk('**')); }
      else if (m[3] != null) { const g = m[3].slice(2, -2); nodes.push(mk('~~'), h('span', { class: 'rf-ed-strike', text: g }), mk('~~')); }
      else if (m[4] != null) { const g = m[4].slice(1, -1); nodes.push(mk('*'), h('em', { class: 'rf-ed-em', text: g }), mk('*')); }
      else if (m[5] != null) { const g = m[5].slice(1, -1); nodes.push(mk('_'), h('em', { class: 'rf-ed-em', text: g }), mk('_')); }
      last = RE.lastIndex;
    }
    if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
    if (!nodes.length) nodes.push(document.createTextNode(''));
    return nodes;
  }

  // ---- 1 行 → ブロック div ----
  function buildLine(line) {
    if (line === '') return h('div', { class: 'rf-ed-line' }, h('br'));

    let m;
    // 見出し
    if ((m = line.match(/^(#{1,6})(\s+)(.*)$/))) {
      return h('div', { class: `rf-ed-line rf-ed-h${m[1].length}` }, mk(m[1] + m[2]), ...inline(m[3]));
    }
    // 水平線
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      return h('div', { class: 'rf-ed-line rf-ed-hr' }, mk(line));
    }
    // 引用
    if ((m = line.match(/^(>)(\s?)(.*)$/))) {
      return h('div', { class: 'rf-ed-line rf-ed-quote' }, mk(m[1] + m[2]), ...inline(m[3]));
    }
    // タスク（チェックボックス）
    if ((m = line.match(TASK_RE))) {
      const [, indent, bullet, sp1, mark, sp2, text] = m;
      const checked = mark.toLowerCase() === 'x';
      const div = h('div', { class: `rf-ed-line rf-ed-task${checked ? ' checked' : ''}` });
      div.style.paddingLeft = (4 + indent.length * 20) + 'px';
      const check = h('span', {
        class: `rf-ed-check${checked ? ' on' : ''}`,
        text: `[${mark}]`,
        role: 'checkbox',
        'aria-checked': String(checked),
      });
      check.addEventListener('mousedown', (e) => e.preventDefault()); // caret 移動/blur を防ぐ
      check.addEventListener('click', (e) => { e.preventDefault(); toggleCheckboxAt(div); });
      div.append(mk(indent + bullet + sp1), check, document.createTextNode(sp2),
        h('span', { class: 'rf-ed-task-text' }, ...inline(text)));
      return div;
    }
    // 箇条書き / 番号
    if ((m = line.match(LIST_RE))) {
      const [, indent, bullet, sp, , , text] = m;
      const div = h('div', { class: 'rf-ed-line rf-ed-listline' });
      div.style.paddingLeft = (4 + indent.length * 20) + 'px';
      div.append(h('span', { class: 'rf-ed-list-marker', text: indent + bullet }), document.createTextNode(sp), ...inline(text));
      return div;
    }
    // 段落
    return h('div', { class: 'rf-ed-line' }, ...inline(line));
  }

  function buildBlocks(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    return lines.map(buildLine);
  }

  // ---- content + caret（設計から逐語移植） ----
  function getContent(root) {
    const blocks = [...root.children];
    if (!blocks.length) return root.textContent || '';
    return blocks.map((b) => b.textContent).join('\n');
  }

  /** DOM の「点（node, off）」→ 本文先頭からのグローバル文字オフセット。 */
  function offsetForPoint(node, off) {
    const root = editor;
    if (node === root) {
      let acc = 0;
      for (let i = 0; i < off && i < root.children.length; i++) acc += root.children[i].textContent.length + 1;
      return acc;
    }
    let block = node;
    while (block.parentNode && block.parentNode !== root) block = block.parentNode;
    const children = [...root.children];
    const bi = children.indexOf(block);
    if (bi < 0) return null;
    let acc = 0;
    for (let i = 0; i < bi; i++) acc += children[i].textContent.length + 1;
    const range = document.createRange();
    range.selectNodeContents(block);
    try { range.setEnd(node, off); } catch { return acc; }
    acc += range.toString().length;
    return acc;
  }

  function getCaret() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return offsetForPoint(r.startContainer, r.startOffset);
  }

  /** 現在の選択範囲を {start, end}（start≤end に正規化・逆方向選択も吸収）で返す。 */
  function getSelectionRange() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const a = offsetForPoint(sel.anchorNode, sel.anchorOffset);
    const b = offsetForPoint(sel.focusNode, sel.focusOffset);
    if (a == null || b == null) return null;
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  /** グローバルオフセット → DOM の点 {node, offset}（描画済み DOM 上で探索）。 */
  function pointForOffset(offset) {
    const children = [...editor.children];
    let acc = 0;
    for (let bi = 0; bi < children.length; bi++) {
      const block = children[bi];
      const len = block.textContent.length;
      if (offset <= acc + len) {
        const within = offset - acc;
        const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
        let t, a2 = 0, last = null;
        while ((t = w.nextNode())) {
          last = t;
          if (a2 + t.textContent.length >= within) return { node: t, offset: Math.max(0, within - a2) };
          a2 += t.textContent.length;
        }
        if (last) return { node: last, offset: last.textContent.length };
        return { node: block, offset: 0 };
      }
      acc += len + 1;
    }
    const last = children[children.length - 1];
    if (last) return { node: last, offset: last.textContent.length };
    return { node: editor, offset: 0 };
  }

  function setCaret(root, offset) {
    const { node, offset: off } = pointForOffset(offset);
    const sel = window.getSelection();
    const r = document.createRange();
    try { r.setStart(node, off); } catch { return; }
    r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
  }

  /** start..end を 1 つの Range として再選択する（装飾ラップ後の範囲復元用）。 */
  function setSelection(start, end) {
    const s = pointForOffset(start);
    const e2 = pointForOffset(end);
    const sel = window.getSelection();
    const r = document.createRange();
    try { r.setStart(s.node, s.offset); r.setEnd(e2.node, e2.offset); } catch { return; }
    sel.removeAllRanges(); sel.addRange(r);
  }

  // ---- 行/桁 ⇄ グローバルオフセット ----
  function locate(src, offset) {
    const lines = src.split('\n');
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i].length;
      if (offset <= acc + len) return { lines, li: i, col: offset - acc };
      acc += len + 1;
    }
    const li = lines.length - 1;
    return { lines, li, col: lines[li].length };
  }
  function offsetOf(lines, li, col) {
    let acc = 0;
    for (let i = 0; i < li; i++) acc += lines[i].length + 1;
    return acc + col;
  }

  // ---- 描画 ----
  function emitChrome() { if (onChange) onChange(raw); }
  function afterUserChange() { dirty = true; emitChrome(); }

  function render_() {
    const caret = getCaret();
    raw = getContent(editor);
    editor.replaceChildren(...buildBlocks(raw));
    if (caret != null) { try { setCaret(editor, caret); } catch { /* noop */ } }
    afterUserChange();
  }

  /** raw を反映しキャレットを offset（null=移動なし）へ。ユーザー操作由来なので dirty を立てる。 */
  function setRawAndCaret(next, offset) {
    raw = next;
    editor.replaceChildren(...buildBlocks(raw));
    if (offset != null) { try { setCaret(editor, offset); } catch { /* noop */ } }
    afterUserChange();
  }

  function toggleCheckboxAt(block) {
    const idx = [...editor.children].indexOf(block);
    if (idx < 0) return;
    const lines = getContent(editor).split('\n');
    lines[idx] = lines[idx].replace(/\[([ xX])\]/, (mm, g) => (g === ' ' ? '[x]' : '[ ]'));
    commitHistory();
    setRawAndCaret(lines.join('\n'), offsetOf(lines, idx, lines[idx].length));
  }

  // ---- Tier A 操作 ----

  /** Ctrl/Cmd+Enter: タスク行の [ ]⇄[x] を長さ不変で置換（キャレット厳密保持）。非タスク行は no-op。 */
  function toggleCheckKeyboard() {
    const caret = getCaret(); if (caret == null) return;
    const { lines, li, col } = locate(getContent(editor), caret);
    if (!TASK_RE.test(lines[li])) return; // 非タスク行 → 改行を入れず消費（呼び出し側で preventDefault 済み）
    const next = lines.slice();
    next[li] = next[li].replace(/\[([ xX])\]/, (mm, g) => (g === ' ' ? '[x]' : '[ ]'));
    commitHistory();
    setRawAndCaret(next.join('\n'), offsetOf(next, li, col));
  }

  /** Ctrl/Cmd+B/I/E: 選択を marker で囲む/解除（トグル）。collapsed 時は空ペア挿入。 */
  function wrapSelection(marker) {
    const range = getSelectionRange();
    if (!range) return;
    const { start, end } = range;
    const mlen = marker.length;

    if (start === end) {
      // collapsed → 空ペアを挿入しキャレットを内側へ
      const next = raw.slice(0, start) + marker + marker + raw.slice(end);
      commitHistory();
      setRawAndCaret(next, start + mlen);
      return;
    }

    const selected = raw.slice(start, end);
    // (a) 選択がマーカーを内包（例: **word** を選択）→ 内側を残して剥がす
    if (selected.length >= 2 * mlen && selected.startsWith(marker) && selected.endsWith(marker)) {
      const inner = selected.slice(mlen, selected.length - mlen);
      commitHistory();
      setRawAndCaret(raw.slice(0, start) + inner + raw.slice(end), start);
      setSelection(start, start + inner.length);
      return;
    }
    // (b) 選択の外側がマーカー（例: word を選択、周囲が **）→ 剥がす
    const before = raw.slice(Math.max(0, start - mlen), start);
    const after = raw.slice(end, end + mlen);
    if (before === marker && after === marker) {
      commitHistory();
      setRawAndCaret(raw.slice(0, start - mlen) + selected + raw.slice(end + mlen), start - mlen);
      setSelection(start - mlen, end - mlen);
      return;
    }
    // (c) それ以外 → 囲む
    commitHistory();
    setRawAndCaret(raw.slice(0, start) + marker + selected + marker + raw.slice(end), start + mlen);
    setSelection(start + mlen, end + mlen);
  }

  /** Alt+↑/↓: 現在行を上下の行と入れ替える。端は no-op。 */
  function moveLine(dir) {
    const caret = getCaret(); if (caret == null) return;
    const { lines, li, col } = locate(getContent(editor), caret);
    const dest = li + dir;
    if (dest < 0 || dest >= lines.length) return; // 先頭/末尾は no-op
    const next = lines.slice();
    const tmp = next[li]; next[li] = next[dest]; next[dest] = tmp;
    const newCol = Math.min(col, next[dest].length);
    commitHistory();
    setRawAndCaret(next.join('\n'), offsetOf(next, dest, newCol));
  }

  /** Tab/Shift+Tab: リスト/タスク行の行頭 2 スペースを増減してネスト。 */
  function indentLine(outdent) {
    const caret = getCaret(); if (caret == null) return false;
    const { lines, li, col } = locate(getContent(editor), caret);
    if (!LIST_RE.test(lines[li])) return false; // 非リスト行は既定に委ねる
    const next = lines.slice();
    if (outdent) {
      if (!next[li].startsWith('  ')) { return true; } // これ以上減らせない（先頭で止まる・消費のみ）
      next[li] = next[li].slice(2);
      commitHistory();
      setRawAndCaret(next.join('\n'), offsetOf(next, li, Math.max(0, col - 2)));
    } else {
      next[li] = '  ' + next[li];
      commitHistory();
      setRawAndCaret(next.join('\n'), offsetOf(next, li, col + 2));
    }
    return true;
  }

  // ---- キーボード（Notion 風挙動 + Tier A） ----
  function onKeydown(e) {
    if (composing || e.isComposing) return;

    // (D3) Ctrl/Cmd 修飾ディスパッチ。順序: チェック切替 → 装飾 → undo/redo。各分岐は既定を殺す。
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (e.key === 'Enter') { e.preventDefault(); toggleCheckKeyboard(); return; }
      if (k === 'b') { e.preventDefault(); wrapSelection('**'); return; }
      if (k === 'i') { e.preventDefault(); wrapSelection('*'); return; }
      if (k === 'e') { e.preventDefault(); wrapSelection('`'); return; }
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (k === 'y') { e.preventDefault(); redo(); return; }
      return; // その他の Ctrl/Cmd（A/C/V/X 等）は既定・paste/cut イベントに委ねる
    }

    // (D8) 行移動 Alt+↑/↓
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveLine(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }

    // (D9) Tab / Shift+Tab インデント（リスト行のみ横取り）
    if (e.key === 'Tab') {
      if (indentLine(e.shiftKey)) { e.preventDefault(); return; }
      return; // 非リスト行は既定（フォーカス移動）に委ねる
    }

    // (D7) Enter: Shift 有無に関わらず自前で改行。マーカー継続は Shift 無しのときだけ。
    if (e.key === 'Enter') {
      e.preventDefault();
      const caret = getCaret(); if (caret == null) return;
      const { lines, li, col } = locate(getContent(editor), caret);
      const line = lines[li];
      const m = !e.shiftKey ? line.match(LIST_RE) : null;
      if (m) {
        const [, indent, bullet, , , , content] = m;
        const isTask = m[4] !== undefined;
        if (content.trim() === '') {
          // 空マーカー行 → マーカーを外して抜ける
          const next = lines.slice(); next[li] = '';
          commitHistory();
          setRawAndCaret(next.join('\n'), offsetOf(next, li, 0));
          return;
        }
        let marker;
        if (/^\d+\.$/.test(bullet)) marker = indent + (parseInt(bullet, 10) + 1) + '. ';
        else if (isTask) marker = indent + bullet + ' [ ] ';
        else marker = indent + bullet + ' ';
        const before = line.slice(0, col), after = line.slice(col);
        const next = lines.slice(); next.splice(li, 1, before, marker + after);
        commitHistory();
        setRawAndCaret(next.join('\n'), offsetOf(next, li + 1, marker.length));
        return;
      }
      // 通常改行 / Shift+Enter の素の改行（block モデルを保つため自前で \n 挿入）
      const before = line.slice(0, col), after = line.slice(col);
      const next = lines.slice(); next.splice(li, 1, before, after);
      commitHistory();
      setRawAndCaret(next.join('\n'), offsetOf(next, li + 1, 0));
      return;
    }

    if (e.key === 'Backspace') {
      const caret = getCaret(); if (caret == null) return;
      const { lines, li, col } = locate(getContent(editor), caret);
      const line = lines[li];
      const m = line.match(LIST_RE);
      if (m) {
        const content = m[6];
        const markerLen = line.length - content.length; // 接頭辞（indent+bullet+[ ]+空白）の長さ
        // 空項目（末尾）or マーカー直後 → 接頭辞ごと 1 回で削除、前行結合はしない
        if ((content.trim() === '' && col === line.length) || col === markerLen) {
          e.preventDefault();
          const next = lines.slice(); next[li] = content;
          commitHistory();
          setRawAndCaret(next.join('\n'), offsetOf(next, li, 0));
          return;
        }
      }
      // それ以外は既定の Backspace → input → render_ で block を再構築（下のコアレス境界で履歴化）
    }

    // 通常入力のコアレス: バースト先頭で pre-edit スナップショットを 1 回だけコミット。
    // ナビゲーションキーはバーストを終端し、次の入力を新しい履歴グループにする。
    const isContent = (e.key.length === 1 && !e.altKey) || e.key === 'Backspace' || e.key === 'Delete';
    const isNav = e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp'
      || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End'
      || e.key === 'PageUp' || e.key === 'PageDown';
    if (isContent) {
      if (!typingBurst) { commitHistory(); typingBurst = true; }
    } else if (isNav) {
      typingBurst = false;
    }
  }

  function onInput() {
    if (composing) return;
    const caret = getCaret();
    const src = getContent(editor);
    const { lines, li, col } = locate(src, caret);
    const line = lines[li];

    // ``` 自動クローズ: 3 連バッククォート確定時に閉じフェンスを下に生成
    if (line === '```' && col === 3 && lines[li + 1] !== '```') {
      const next = lines.slice();
      next.splice(li + 1, 0, '', '```');
      commitHistory();
      setRawAndCaret(next.join('\n'), offsetOf(next, li + 1, 0));
      return;
    }
    // [ ] todo ショートハンド: 行頭の `[ ] `/`[] `（`- ` 有無不問）→ `- [ ] `
    const tm = line.match(/^(\s*)(?:- )?\[ ?\]\s$/);
    if (tm && col === line.length) {
      const conv = tm[1] + '- [ ] ';
      const next = lines.slice(); next[li] = conv;
      commitHistory();
      setRawAndCaret(next.join('\n'), offsetOf(next, li, conv.length));
      return;
    }

    render_();
  }

  // ---- 貼り付け: 構造付き text/html を優先し Markdown 化、無ければ text/plain（D6 + issue #6） ----
  function onPaste(e) {
    if (composing) return;
    const cd = e.clipboardData;
    if (!cd) return; // 取得失敗 → 既定に委ねる
    e.preventDefault(); // 以降は自前で貼り付けを所有
    const html = cd.getData('text/html');
    let pasted = '';
    // list/heading/quote 等の構造タグを含むときだけ HTML を採用（inline のみの HTML で
    // text/plain の改行を潰さないためのガード。Slack 等の段落崩れ回帰を防ぐ）。
    if (html && /<(ul|ol|li|h[1-6]|blockquote|pre)\b/i.test(html)) {
      try { pasted = htmlToMarkdown(html); } catch { pasted = ''; }
    }
    if (!pasted) pasted = cd.getData('text/plain') || ''; // フォールバック
    if (!pasted) return; // 両方空 → no-op（既定は preventDefault 済み）
    pasted = pasted.replace(/\r\n?/g, '\n'); // 改行正規化（1 行 = 1 ブロック維持）
    const range = getSelectionRange();
    if (!range) return;
    const { start, end } = range;
    commitHistory();
    setRawAndCaret(raw.slice(0, start) + pasted + raw.slice(end), start + pasted.length);
  }

  // ---- モデル経由の切り取り（D12） ----
  function onCut(e) {
    if (composing) return;
    const range = getSelectionRange();
    if (!range) return;
    const { start, end } = range;
    if (start === end) return; // 選択なし → no-op
    const cut = raw.slice(start, end);
    if (e.clipboardData) e.clipboardData.setData('text/plain', cut);
    e.preventDefault();
    commitHistory();
    setRawAndCaret(raw.slice(0, start) + raw.slice(end), start);
  }

  editor.addEventListener('compositionstart', () => { composing = true; commitHistory(); });
  editor.addEventListener('compositionend', () => { composing = false; render_(); });
  editor.addEventListener('input', onInput);
  editor.addEventListener('keydown', onKeydown);
  editor.addEventListener('paste', onPaste);
  editor.addEventListener('cut', onCut);

  // 初期化
  raw = String(initial ?? '');
  editor.replaceChildren(...buildBlocks(raw));
  emitChrome();

  return {
    el: editor,
    getValue: () => (composing ? getContent(editor) : raw),
    setValue: (v) => {
      raw = String(v ?? '');
      editor.replaceChildren(...buildBlocks(raw));
      dirty = false;
      undoStack = [];
      redoStack = [];
      typingBurst = false;
      emitChrome();
    },
    focus: () => {
      editor.focus();
      const last = editor.children[editor.children.length - 1];
      if (last) { try { setCaret(editor, getContent(editor).length); } catch { /* noop */ } }
    },
    isDirty: () => dirty,
    markSaved: () => { dirty = false; },
  };
}
