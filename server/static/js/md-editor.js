// Notion 風インライン・ライブ Markdown エディタ（ref/reflection/振り返り.dc.html 忠実移植 + 追加挙動）。
//  - 単一 contenteditable。1 行 = 1 ブロック div。構文マーカーは淡色表示しつつ整形結果を同じ行にインライン描画。
//  - すべて DOM ノード構築（h()）+ CSSOM。innerHTML 文字列やインライン style 属性は使わない（CSP 適合）。
//  - 本文は raw Markdown テキスト（getContent = 各ブロックの textContent を \n 連結）として保持。
//  - IME（日本語）: compositionstart/end ガードで変換中の再描画を抑止。
//  - 追加した Notion 挙動: リスト継続 / 空行抜け / ``` 自動クローズ / [ ] todo / Backspace1回削除 / □トグル。
//    いずれも「caret→行/桁を算出→raw を変換→再描画→caret 再設定」で raw/caret モデルに一貫して乗る。
import { h } from './util.js';

const LIST_RE = /^(\s*)([-*+]|\d+\.)(\s+)(?:\[([ xX])\](\s+))?(.*)$/;
const TASK_RE = /^(\s*)([-*+])(\s+)\[([ xX])\](\s+)(.*)$/;

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
      const check = h('span', { class: `rf-ed-check${checked ? ' on' : ''}`, text: `[${mark}]` });
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

  function getCaret(root) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const node = r.startContainer, off = r.startOffset;
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

  function setCaret(root, offset) {
    const sel = window.getSelection();
    const children = [...root.children];
    let acc = 0;
    for (let bi = 0; bi < children.length; bi++) {
      const block = children[bi];
      const len = block.textContent.length;
      if (offset <= acc + len) { placeIn(block, offset - acc, sel); return; }
      acc += len + 1;
    }
    const last = children[children.length - 1];
    if (last) placeIn(last, last.textContent.length, sel);
  }

  function placeIn(block, within, sel) {
    const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    let t, acc = 0, last = null;
    while ((t = w.nextNode())) {
      last = t;
      if (acc + t.textContent.length >= within) {
        const r = document.createRange();
        r.setStart(t, Math.max(0, within - acc));
        r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        return;
      }
      acc += t.textContent.length;
    }
    const r = document.createRange();
    if (last) r.setStart(last, last.textContent.length);
    else r.setStart(block, 0);
    r.collapse(true);
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
    const caret = getCaret(editor);
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
    setRawAndCaret(lines.join('\n'), offsetOf(lines, idx, lines[idx].length));
  }

  // ---- キーボード（Notion 風挙動） ----
  function onKeydown(e) {
    if (composing || e.isComposing) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const caret = getCaret(editor); if (caret == null) return;
      const { lines, li, col } = locate(getContent(editor), caret);
      const line = lines[li];
      const m = line.match(LIST_RE);
      if (m) {
        const [, indent, bullet, , , , content] = m;
        const isTask = m[4] !== undefined;
        if (content.trim() === '') {
          // 空マーカー行 → マーカーを外して抜ける
          const next = lines.slice(); next[li] = '';
          setRawAndCaret(next.join('\n'), offsetOf(next, li, 0));
          return;
        }
        let marker;
        if (/^\d+\.$/.test(bullet)) marker = indent + (parseInt(bullet, 10) + 1) + '. ';
        else if (isTask) marker = indent + bullet + ' [ ] ';
        else marker = indent + bullet + ' ';
        const before = line.slice(0, col), after = line.slice(col);
        const next = lines.slice(); next.splice(li, 1, before, marker + after);
        setRawAndCaret(next.join('\n'), offsetOf(next, li + 1, marker.length));
        return;
      }
      // 通常改行（block モデルを保つため自前で \n 挿入）
      const before = line.slice(0, col), after = line.slice(col);
      const next = lines.slice(); next.splice(li, 1, before, after);
      setRawAndCaret(next.join('\n'), offsetOf(next, li + 1, 0));
      return;
    }

    if (e.key === 'Backspace') {
      const caret = getCaret(editor); if (caret == null) return;
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
          setRawAndCaret(next.join('\n'), offsetOf(next, li, 0));
          return;
        }
      }
      // それ以外は既定の Backspace → input → render_ で block を再構築
    }
  }

  function onInput() {
    if (composing) return;
    const caret = getCaret(editor);
    const src = getContent(editor);
    const { lines, li, col } = locate(src, caret);
    const line = lines[li];

    // ``` 自動クローズ: 3 連バッククォート確定時に閉じフェンスを下に生成
    if (line === '```' && col === 3 && lines[li + 1] !== '```') {
      const next = lines.slice();
      next.splice(li + 1, 0, '', '```');
      setRawAndCaret(next.join('\n'), offsetOf(next, li + 1, 0));
      return;
    }
    // [ ] todo ショートハンド: 行頭の `[ ] `/`[] `（`- ` 有無不問）→ `- [ ] `
    const tm = line.match(/^(\s*)(?:- )?\[ ?\]\s$/);
    if (tm && col === line.length) {
      const conv = tm[1] + '- [ ] ';
      const next = lines.slice(); next[li] = conv;
      setRawAndCaret(next.join('\n'), offsetOf(next, li, conv.length));
      return;
    }

    render_();
  }

  editor.addEventListener('compositionstart', () => { composing = true; });
  editor.addEventListener('compositionend', () => { composing = false; render_(); });
  editor.addEventListener('input', onInput);
  editor.addEventListener('keydown', onKeydown);

  // 初期化
  raw = String(initial ?? '');
  editor.replaceChildren(...buildBlocks(raw));
  emitChrome();

  return {
    el: editor,
    getValue: () => raw,
    setValue: (v) => {
      raw = String(v ?? '');
      editor.replaceChildren(...buildBlocks(raw));
      dirty = false;
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
