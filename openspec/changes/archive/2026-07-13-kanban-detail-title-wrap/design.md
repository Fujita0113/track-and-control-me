## Context

カード詳細パネルのタイトルは `detailEl()`（`server/static/js/kanban.js`）内で `h('input', { class: 'kb-detail-title', type: 'text' })` として生成されている。`<input>` は本質的に単一行のため、パネル幅を超える長いタイトルは横に見切れ、全文を確認できない（issue #23）。CSS は `input.kb-detail-title`（`server/static/css/app.css`）で font-size 18 / weight 700 のスタイルを与えている。

タイトル input には既存の挙動が結び付いている:
- `input` イベント: `t.title` 更新 → `scheduleSave` → カラム内カード名 (`.kb-card-title`) の即時同期。
- `keydown`: IME ガード（`e.isComposing || e.keyCode === 229`）の後、素の Enter で `flushSaves()` → `titleInp.blur()` → `enterEdit(t, 0, 0)`（ノート本文の編集へ移動）。これは `enter-submit-ime-guard` 仕様の「単一行フォームの Enter=主要アクション」に沿ったもの。

## Goals / Non-Goals

**Goals:**
- 長いタイトルを詳細パネルで折り返し表示し、全文を見える／編集できるようにする。
- 内容量に応じて欄の高さを自動調整し、欄内スクロールを出さない。
- 既存の見た目（フォント・余白）と保存＋カード名同期、Enter=確定してノートへ、の挙動を維持する。

**Non-Goals:**
- カラム内カード名 (`.kb-card-title`) の表示変更（既に折り返せているため対象外）。
- タイトルへの改行保存やリッチテキスト化（タイトルは単一行文字列のまま）。
- 保存 API・データモデルの変更。

## Decisions

### 決定1: `<input>` を `<textarea>` へ置換（contenteditable ではなく）

タイトル欄を `<textarea class="kb-detail-title">` に変更する。textarea は折り返し・複数行を素直に扱え、`value` はプレーンテキストのままなので既存の `t.title = el.value` / `scheduleSave` ロジックをほぼそのまま再利用できる。

- 代替案: `contenteditable` div。→ innerText/HTML の扱いが増え、貼り付け時のサニタイズや caret 管理が複雑になる。単一行文字列を保持したいだけなので過剰。却下。
- 代替案: input のまま CSS だけで折り返す。→ input は仕様上単一行で折り返し不可。実現できないため却下。

### 決定2: 自動高さ調整は「auto→scrollHeight」方式

`resize: none`・`overflow: hidden` とし、内容変化時に `el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'` で高さを再計算する小関数 `autosize(el)` を用意する。呼び出しタイミング:
- パネル生成時（初期タイトルに必要な高さで表示）。ただし要素が DOM に挿入されるまで `scrollHeight` が正しく出ないため、生成直後だけでなくパネル挿入後（`renderAll` の描画後）にも一度実行する。
- `input` イベント毎（編集で行数が増減したとき）。

- 代替案: CSS の `field-sizing: content`。→ 対応ブラウザが限られ、本アプリの対象環境で保証できない（バージョンチェックポリシー上、確実な JS 実装を採用）。将来的な簡素化候補としてのみ記録。

### 決定3: Enter=確定・改行は挿入しない（既存挙動の維持）

textarea は素の Enter で改行が入るのが既定だが、タイトルは単一行セマンティクスを保つため、keydown ハンドラで従来通り IME ガード後に `e.preventDefault()` して `flushSaves()` → `blur()` → `enterEdit(t, 0, 0)` を実行する。これにより `enter-submit-ime-guard` の要件（タイトル欄の Enter=前進アクション）を要素変更後も満たす。`enter-submit-ime-guard` が「素の Enter=改行維持」と列挙するのは md-editor と `kb-ed-input` のみで、タイトル欄は含まれないため矛盾しない。

### 決定4: 改行入りテキストの貼り付けは単一行へ畳む

`paste` イベントまたは `input` 時に、値へ混入した改行（`\r?\n`）を単一スペースへ置換してから `t.title` に反映する。これにより保存されるタイトルが常に改行を含まない単一行文字列に保たれ、カラム内カード名との一貫性も保たれる。

## Risks / Trade-offs

- [初期表示時に `scrollHeight` が 0 になり高さが潰れる] → 要素が DOM 挿入された後（描画完了後）に `autosize` を再実行する。パネルは開くたびに再生成されるため、生成時＋挿入後の 2 回呼びで確実に初期高さを確定する。
- [textarea 化でフォーカスリング等の既定スタイルが出る] → 既存の `outline: none` 等を textarea セレクタへ引き継ぎ、見た目の差分を出さない。`rows` 既定値ではなく高さ計算で制御する。
- [enter-submit-ime-guard 仕様との整合] → タイトル欄の Enter は従来通り「確定→ノートへ」を維持するため要件変更はなし。デルタspecには含めない。

## Migration Plan

UI のみの変更でデータ移行不要。デプロイは静的アセット差し替えのみ。問題があれば `kanban.js` / `app.css` の当該差分を revert すれば元の input 実装へ即戻せる。
