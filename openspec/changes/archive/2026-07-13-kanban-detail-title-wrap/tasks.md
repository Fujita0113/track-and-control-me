## 1. タイトル欄を textarea 化（kanban.js）

- [x] 1.1 `detailEl()` のタイトル生成を `h('input', { class: 'kb-detail-title', type: 'text', ... })` から `h('textarea', { class: 'kb-detail-title', rows: '1', placeholder: 'タイトル' })` へ変更し、`titleInp.value = t.title` の初期化を維持する
- [x] 1.2 `input` イベントハンドラ（`t.title` 更新 → `scheduleSave(t, 'title')` → `.kb-card-title` 同期）はそのまま維持する
- [x] 1.3 `keydown` ハンドラを維持する: 先頭で IME ガード（`e.isComposing || e.keyCode === 229` で return）、素の Enter（`e.key === 'Enter' && !e.shiftKey`）で `preventDefault` → `flushSaves()` → `titleInp.blur()` → `enterEdit(t, 0, 0)`

## 2. 自動高さ調整

- [x] 2.1 高さ再計算の小関数 `autosize(el)` を用意する（`el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'`）
- [x] 2.2 `input` イベント時に `autosize(titleInp)` を呼び、編集で行数が増減しても高さが追従するようにする
- [x] 2.3 パネルが DOM に挿入・描画された後に `autosize(titleInp)` を一度実行し、初期タイトルに必要な高さで表示されるようにする（`scrollHeight` が確定するタイミングで呼ぶ）

## 3. 単一行セマンティクスの維持

- [x] 3.1 値に混入した改行（`\r?\n`）を単一スペースへ畳む処理を入れる（`input`／`paste` 時に `t.title` へ反映する前に置換し、`titleInp.value` にも反映）
- [x] 3.2 保存されるタイトルが改行を含まない単一行文字列であることを確認する

## 4. スタイル更新（app.css）

- [x] 4.1 `input.kb-detail-title` セレクタを `textarea.kb-detail-title` に更新し、既存の見た目（font-size 18 / weight 700 / color / line-height / padding / `outline: none` / `background: transparent`）を引き継ぐ
- [x] 4.2 textarea 向けに `width: 100%`・`box-sizing: border-box`・`resize: none`・`overflow: hidden`・折り返し（`word-break`/`overflow-wrap`）・`font-family: inherit` を設定し、横スクロールやクリップが出ないようにする
- [x] 4.3 `textarea.kb-detail-title:focus` の枠・アウトライン無効化を維持する

## 5. 動作確認

- [x] 5.1 長いタイトル（issue #23 の「webエンジニアリングEx8：実装完了、成果物確認次第次へ」相当）のカードを開き、詳細パネルのタイトルが折り返して全文表示され、見切れないことを確認する（実CSS＋autosizeをEdge headlessでレンダリング検証: 折り返し=true・横スクロールなし=true。空白なし長文字列も overflow-wrap で折り返し確認）
- [x] 5.2 タイトル編集で行が増減したとき欄の高さが追従し、欄内スクロールが出ないことを確認する（autosizeが height=scrollHeight を設定し縦スクロールなし=true をレンダリング検証。同関数を input 毎に呼ぶため編集時も追従）
- [x] 5.3 素の Enter で改行が入らず確定してノート編集へ移ること、IME 変換確定 Enter で誤確定しないことを確認する（keydown で IME ガード→Enter preventDefault→flush→blur→enterEdit を維持。既存 enter-submit-ime-guard と同一ロジック）
- [x] 5.4 改行を含むテキストを貼り付けてもタイトルが単一行に畳まれ、カラム内カード名と一致することを確認する（`\r?\n`→スペース畳み込みを実測: "line1\r\nline2\nline3"→"line1 line2 line3"。input で .kb-card-title へ同値を同期）
