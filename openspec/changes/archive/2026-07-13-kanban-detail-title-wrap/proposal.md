## Why

カード詳細パネルのタイトルが単一行の `<input type="text">` で描画されているため、長いタスク名がパネル幅で横に見切れ、全文を読めない（issue #23）。カラム内のカード名 (`.kb-card-title`) は既に `word-break: break-word` で折り返せているのに、開いた詳細側だけが切れてしまい、確認・編集の妨げになっている。

## What Changes

- カード詳細パネルのタイトルを、単一行 `<input>` から**折り返し表示・入力量に応じて高さが自動で伸びる複数行フィールド**（`<textarea>`）へ変更し、長いタイトルでも全文が見える／編集できるようにする。
- 見た目（フォントサイズ・太さ・色・余白）と入力→保存＋カード名同期の挙動は現状のまま維持する。
- タイトルは**意味的には単一行**として扱う: 素の Enter（非 IME・Shift なし）は改行を挿入せず、これまで通り確定してノート編集へ移る。改行を含むテキストが貼り付けられた場合はスペースへ畳んで単一行のタイトルに保つ。

## Capabilities

### New Capabilities
- `kanban-detail-title`: カード詳細パネルのタイトル欄の表示・編集挙動（長いタイトルの折り返しと自動高さ調整、単一行セマンティクスの維持、Enter による確定）。

### Modified Capabilities
<!-- enter-submit-ime-guard の「素の Enter=確定してノート編集へ」挙動は据え置き（要件変更なし）。要素が input→textarea に変わるだけで、Enter は改行に奪わせない実装で従来の要件を満たす。 -->

## Impact

- `server/static/js/kanban.js`: `detailEl()` 内のタイトル生成（`titleInp` を input→textarea 化、自動高さ調整、貼り付け時の改行畳み込み、Enter=確定の keydown ハンドラ維持）。
- `server/static/css/app.css`: `input.kb-detail-title` セレクタを textarea 向けに更新（`resize: none`／折り返し／`overflow: hidden`／自動高さ用の初期スタイル）。
- 保存 API・データモデルへの変更なし。タイトルは引き続き単一行文字列として保存される。
