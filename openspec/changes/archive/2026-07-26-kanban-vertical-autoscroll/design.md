## Context

`server/static/js/kanban.js` はネイティブ HTML5 D&D(`draggable` + `dragstart`/`dragover`/`drop`)で実装されており、dnd-kit 等のライブラリは使っていない。列(`.kb-col`)は `.kb-board`(`display:flex; align-items:flex-start`)の子で、各列は自分のコンテンツ量に応じて高さが決まり、列間で高さは揃わない。`.kb-board-scroll`(`overflow-x: auto`)は横方向のみのスクロールコンテナで、縦方向はページ(document/window)自体がスクロールする。

「未着手」に多数のタスクが積まれると、その列の DOM 高さが他の列より大きく伸びる。ネイティブ D&D の `dragover` は「ポインタ直下の要素」にしか発火しないため、短い列(例:進行中)の描画範囲がビューポート外(ページ下方)にある間は、その列へドロップできない。ユーザーはページを一旦スクロールしてから掴み直す必要があり、これが issue #34 の症状。

既に issue #16 で「ボード表示領域(`.kb-board-scroll`)の左右端近傍でドラッグ中に自動横スクロールする」実装(`kanban-drag-autoscroll` spec, `kanban.js` 内 `startAutoScroll`/`autoScrollStep`/`stopAutoScroll`, 行 339-400 付近)が存在し、`requestAnimationFrame` ループで `scrollLeft` を直接操作することで `renderAll()` を挟まず(=ネイティブ D&D の内部状態を壊さず)動作している。

## Goals / Non-Goals

**Goals:**
- ドラッグ中にポインタがビューポート上端/下端近傍に入っている間、ページを自動的に縦スクロールし、画面外の列を表示領域内に引き込む。
- 既存の横スクロール実装(issue #16)と対称な設計・命名にし、保守性を保つ。
- 列レイアウト・列の高さ・`ref/kanban/Cadence Board.dc.html` に基づく見た目は変更しない。

**Non-Goals:**
- issue #34 で提示されたもう一方の案(列ごとの高さをビューポート全体に揃えてドロップ判定領域を広げる)は採用しない。列を等高化するとカードの少ない列に大きな空白ができ、参照デザインから外れるリスクがあるため。
- 列内での並び替え(`kanban-task-reorder` 相当)のロジック変更は行わない。

## Decisions

### 1. 横スクロール実装をそのまま縦方向にミラーする
`EDGE_ZONE`/`MAX_SPEED` と同じ考え方の定数、`startAutoScroll`/`autoScrollStep`/`stopAutoScroll` と対になる縦版の関数(例: `startVAutoScroll`/`vAutoScrollStep`)を追加する。横方向は `scrollLeft` を、縦方向は `window.scrollBy(0, dy)` (または `document.scrollingElement.scrollTop`)を操作する。
**代替案として検討**: 横スクロールの関数群を汎用化して軸(x/y)をパラメータ化することも考えたが、既存関数は `el.scrollLeft` 決め打ちで軸分岐を増やすと可読性が落ちる。件数も2軸のみなので、素直に縦版を並置する。

### 2. dragover リスナーは `document`(window)に付ける
縦スクロールは `.kb-board-scroll` の外、ページ全体が対象なので、既存のように特定コンテナへ付けるのではなく `document` に `dragover` リスナーを追加し、`e.clientY` とビューポート高さ(`window.innerHeight`)から上端/下端近傍を判定する。列側の `dragover`(挿入インジケータ計算, `dropIndexIn`)は `e.stopPropagation()` していないため、バブリングで `document` まで届く(横方向の実装が `.kb-board-scroll` で同様に拾えているのと同じ前提)。

### 3. 停止条件は横方向と揃える
`drop` / `dragend` / (ウィンドウ外への)`dragleave` で `stopVAutoScroll()` を呼ぶ。`dragleave` はウィンドウ外に完全に出たときのみ(`e.relatedTarget == null` かつ座標がビューポート外)反応させ、列間を移動しただけで止まらないようにする。

## Risks / Trade-offs

- [ページの自動スクロールが、意図せずビューポート最下部/最上部で暴走する] → 横方向と同じく `requestAnimationFrame` ループを都度 `S.draggingId` の有無でガードし、`stopAutoScroll` 相当の確実な停止パスを持たせる。
- [縦スクロールが `document.documentElement.scrollTop` と `document.body.scrollTop` のどちらに効くかはブラウザ依存] → `window.scrollBy` を使い、ブラウザの互換実装に委ねる(Playwright の Chromium でも同様)。
- [横スクロールと縦スクロールが同時にトリガーされる角(コーナー)でのちらつき] → 各軸は独立したループ・独立した停止条件を持つため相互に干渉しない。見た目の違和感が出た場合は今回のスコープ外として issue 化する。

## Open Questions

なし。実装方針は既存の横スクロール実装を踏襲することで確定している。
