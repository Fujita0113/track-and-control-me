// 最小 Markdown レンダラ(自前・依存追加なし・CSP connect-src 'self' 適合).
// 対応: 見出し(#..###)/箇条書き(-,*)/番号(1.)/引用(>)/チェックボックス([ ],[x])/
//       水平線(---)/コードブロック(```)/強調(**,*)/インラインコード(`)。
// すべて DOM API(textContent/createTextNode)で構築するため HTML は自動エスケープされる。
import { h } from './util.js';

/** Markdown 文字列 → DOM ノード(div.md-body)。 */
export function renderMarkdown(src) {
  const root = h('div', { class: 'md-body' });
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let list = null; // { el, ordered }

  const closeList = () => { if (list) { root.appendChild(list.el); list = null; } };

  while (i < lines.length) {
    const line = lines[i];

    // コードブロック ```
    if (/^```/.test(line)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 終端 ``` を消費
      root.appendChild(h('pre', { class: 'md-pre' }, h('code', { text: buf.join('\n') })));
      continue;
    }

    // 空行
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    // 水平線
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeList(); root.appendChild(h('hr', {})); i++; continue; }

    // 見出し
    const hm = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hm) {
      closeList();
      const tag = `h${hm[1].length + 2}`; // # → h3, ## → h4, ### → h5(既存 h スケールに合わせる)
      root.appendChild(h(tag, { class: 'md-h' }, ...inline(hm[2])));
      i++; continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      root.appendChild(h('blockquote', { class: 'md-quote' }, ...inline(buf.join(' '))));
      continue;
    }

    // チェックボックス
    const cm = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (cm) {
      if (!list || list.ordered) { closeList(); list = { el: h('ul', { class: 'md-list md-task' }), ordered: false }; }
      const box = h('input', { type: 'checkbox' });
      box.checked = cm[1].toLowerCase() === 'x';
      box.disabled = true;
      list.el.appendChild(h('li', { class: 'md-task-item' }, box, h('span', {}, ...inline(cm[2]))));
      i++; continue;
    }

    // 箇条書き
    const um = /^[-*]\s+(.*)$/.exec(line);
    if (um) {
      if (!list || list.ordered) { closeList(); list = { el: h('ul', { class: 'md-list' }), ordered: false }; }
      list.el.appendChild(h('li', {}, ...inline(um[1])));
      i++; continue;
    }

    // 番号付き
    const om = /^\d+\.\s+(.*)$/.exec(line);
    if (om) {
      if (!list || !list.ordered) { closeList(); list = { el: h('ol', { class: 'md-list' }), ordered: true }; }
      list.el.appendChild(h('li', {}, ...inline(om[1])));
      i++; continue;
    }

    // 段落
    closeList();
    root.appendChild(h('p', { class: 'md-p' }, ...inline(line)));
    i++;
  }
  closeList();
  return root;
}

/** インライン装飾: **強調** / *斜体* / `コード`。テキストはノード化で自動エスケープ。 */
function inline(text) {
  const nodes = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
    if (m[2] != null) nodes.push(h('strong', { text: m[2] }));
    else if (m[4] != null) nodes.push(h('em', { text: m[4] }));
    else if (m[6] != null) nodes.push(h('code', { class: 'md-code', text: m[6] }));
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}
