## 1. 共有基盤: 履歴スタック（md-editor.js）

- [x] 1.1 `undoStack` / `redoStack`（`{ raw, caret }` 配列）と上限定数（例: 200）を用意する
- [x] 1.2 `commitHistory()`（遅延コミット）: 現在の raw/caret を `undoStack` に push、`redoStack` をクリア、上限超過は古い側から破棄
- [x] 1.3 `undo()` / `redo()`: スタック間でスナップショットを移し替え `setRawAndCaret(raw, caret)` で復元（復元自体は履歴を積まない）

## 2. 共有基盤: 選択オフセット/選択再設定ヘルパ（D4/D5）

- [x] 2.1 `getCaret` の「点→グローバルオフセット」算出を `offsetForPoint(node, off)` として抽出する
- [x] 2.2 `getSelectionRange()`: selection の anchor/focus 両端に `offsetForPoint` を適用し `{start, end}`（start≤end に正規化、逆方向選択も吸収）を返す
- [x] 2.3 `placeIn` の「オフセット→{node, offset}」点探索を抽出し、`setSelection(start, end)` で 1 つの Range を `setStart`/`setEnd` 構築する

## 3. 共有基盤: onKeydown の Ctrl/Cmd 修飾ディスパッチ（D3）

- [x] 3.1 `onKeydown` 先頭（`composing`/`e.isComposing` ガード直後）に `(e.ctrlKey || e.metaKey)` の分岐点を設ける
- [x] 3.2 ここに undo/redo・装飾・チェック切替をぶら下げる土台を作り、各分岐は `e.preventDefault()` する。**順序**: チェック切替（Ctrl+Enter）→ 装飾（B/I/E）→ undo/redo（z/y）を、素の Enter/Backspace 分岐より前に置く

## 4. Undo/Redo 配線（D2/D14）

- [x] 4.1 `z`(Shift 無)=undo、`z`(Shift 有)/`y`=redo を 3.1 の分岐に配線
- [x] 4.2 構造変化（Enter/Shift+Enter 行操作・コードフェンス自動クローズ・todo ショートハンド・チェックボックストグル）の `setRawAndCaret` 直前で `commitHistory()` を呼ぶ
- [x] 4.3 通常入力（`onInput`→`render_`）は連続タイプ中コアレスし、次の構造変化まで個別 push しない
- [x] 4.4 IME: composition 中はスナップショットを取らず、`compositionend`→`render_` 後のみ履歴化（二重 push ガード）
- [x] 4.5 `setValue` で `undoStack`/`redoStack` を両方リセット（別日の内容へ戻る事故防止）
- [x] 4.6 undo/redo の本文変化を既存 `afterUserChange`（`dirty`＋`onChange`）に通す

## 5. プレーンテキスト貼り付け（D6）

- [x] 5.1 `paste` リスナ: `e.preventDefault()` → `getData('text/plain')` → `\r\n?`→`\n` 正規化
- [x] 5.2 `getSelectionRange()`（2.2）で `{start,end}` を取り `raw.slice(0,start)+pasted+raw.slice(end)` を作成
- [x] 5.3 `commitHistory()`→`setRawAndCaret(next, start + pasted.length)` で差し込み・キャレット再設定
- [x] 5.4 取得失敗・空クリップボードは no-op（既定を壊さない）

## 6. Shift+Enter 素の改行（バグ修正・D7）

- [x] 6.1 Enter ハンドラ判定を `e.key==='Enter' && !e.shiftKey` → `e.key==='Enter'` に拡張し、マーカー継続は `!e.shiftKey` のときだけ実行する
- [x] 6.2 Shift+Enter は既存「通常改行」パス（`before/after` 分割→`splice(li,1,before,after)`→`commitHistory()`→`setRawAndCaret`）を通し、`<br>` 混入による行融合を無くす

## 7. 行移動 Alt+↑ / Alt+↓（D8）

- [x] 7.1 `composing` ガード後に `Alt+ArrowUp/ArrowDown` 分岐を追加、`preventDefault`
- [x] 7.2 `locate` で `li`/`col` を得て `dest=li∓1`。先頭/末尾は no-op
- [x] 7.3 `lines` を swap、`newCol=Math.min(col, lines[dest].length)` でクランプ、`commitHistory()`→`setRawAndCaret(next.join('\n'), offsetOf(next, dest, newCol))`

## 8. Tab / Shift+Tab インデント（D9）

- [x] 8.1 `Tab` 分岐を追加し `preventDefault`（フォーカス移動を止める）。現在行が `LIST_RE` のときのみ処理
- [x] 8.2 Tab=先頭に 2 スペース付与（col+2）、Shift+Tab=先頭 2 スペース剥がし（無ければ据え置き・col は 0 クランプ）、`commitHistory()`→`setRawAndCaret`
- [x] 8.3 描画のネスト段差（`buildLine` の `paddingLeft`）に反映されることを確認（レンダラ変更不要）

## 9. 選択ラップ Ctrl+B / Ctrl+I / Ctrl+E（D10）

- [x] 9.1 3.1 の Ctrl 分岐に `b`/`i`/`e` を配線、`preventDefault` で execCommand を無効化
- [x] 9.2 `getSelectionRange()` の範囲が対象マーカー（`**`/`*`/`` ` ``）で囲まれていれば剥がす、なければ囲む（トグル）。`commitHistory()`→`setRawAndCaret`→`setSelection` で範囲復元
- [x] 9.3 collapsed 時は空ペアを挿入しキャレットを内側へ

## 10. チェック切替 Ctrl/Cmd+Enter（D11）

- [x] 10.1 3.1 の Ctrl 分岐で、**素の Enter 分岐より前**に `Enter` を処理し return
- [x] 10.2 `locate` した行が `TASK_RE` なら `[ ]`⇄`[x]` を長さ不変で置換（キャレット厳密保持）、`commitHistory()`→`setRawAndCaret`。非タスク行は `preventDefault`+return（改行を入れない）
- [x] 10.3 （任意）`rf-ed-check` span に `role='checkbox'`/`aria-checked` を付与

## 11. モデル経由 cut（D12）

- [x] 11.1 `cut` リスナ: `composing` ガード後 `getSelectionRange()` の `{start,end}`。`start===end` は no-op
- [x] 11.2 `raw.slice(start,end)` を `e.clipboardData.setData('text/plain', …)`、`preventDefault`→`commitHistory()`→`setRawAndCaret(raw.slice(0,start)+raw.slice(end), start)`

## 12. getValue の IME 整合（バグ修正・D13）

- [x] 12.1 `getValue` を `() => raw` から `() => composing ? getContent(editor) : raw` に変更（1 行）

## 13. 検証（reference-impl-in-ref-dir 方針・スクショ）

- [x] 13.1 入力→`Ctrl+Z`→`Ctrl+Shift+Z`/`Ctrl+Y` が効き、ページ全体が巻き戻らない
- [x] 13.2 4 行箇条書きの貼り付けが 4 ブロックになる／行途中貼り付けで前後保持
- [x] 13.3 `Shift+Enter` で文字が融合・欠落しない
- [x] 13.4 `Alt+↑/↓`・`Tab`/`Shift+Tab`・`Ctrl+B/I/E`（ラップ＆解除）・`Ctrl+Enter`・`Ctrl+X` が各々 1 回の `Ctrl+Z` で戻せる
- [x] 13.5 IME 変換確定前の保存で最終行が消えない／日付切替後に前日内容へ undo で戻らない
- [x] 13.6 公開 API 不変（`reflection.js` 無改修）で保存/dirty・文字数・プレースホルダが従来どおり動く

## 14. 構造付き HTML 貼り付けの Markdown 化（issue #6 追加コメント・D15）

- [x] 14.1 `htmlToMarkdown(html)`（DOMParser・タグ駆動・クラス非依存・detached read-only）をモジュールスコープに追加し export
- [x] 14.2 `<ul>/<ol>/<li>` のバレット/番号/ネスト（2 スペース/段）、`<h1-6>`→`#`、`<blockquote>`→`> `、`<pre>`→フェンス、inline 装飾（`**`/`*`/`` ` ``/`~~`/リンク、Google Docs の font-weight/style span）を Markdown 化
- [x] 14.3 to-do 検出（Notion `to-do-list`/`checkbox`/`to-do-children`・GFM `input[type=checkbox]`・素の `[ ]` glyph の OR、状態は優先順で判定）で `- [ ] `/`- [x] `
- [x] 14.4 `onPaste` を「構造タグを含む `text/html` 優先 → `text/plain` フォールバック」に変更（inline のみ HTML では text/plain の改行を保持するガード）。`commitHistory`→`setRawAndCaret` の undo 境界・キャレットは踏襲
- [x] 14.5 検証: 変換器単体（jsdom, 19+4 ケース）・paste フロー e2e（jsdom, 4 行 Notion 箇条書き→4 バレット/to-do/行途中/1 回 Ctrl+Z 復元/フォールバック）

## 15. タスクチェックボックスの Notion 風表示（issue #6 追加コメント・D16）

- [x] 15.1 `.rf-ed-task > .rf-ed-marker` を子結合子で非表示（本文中の装飾マーカーは残す）
- [x] 15.2 `.rf-ed-check` を 16px ボックス化（`::before` 枠線/塗り・`::after` 白チェックは回転ボーダーで描画＝画像アセット不要 CSP 安全）。角括弧文字は font-size:0 で不可視化し textContent は保持
- [x] 15.3 チェック済み行本文の取り消し線＋ミュート表示
- [x] 15.4 検証: Chrome ヘッドレスでスクショ（未/済/ネスト/本文装飾/通常バレット）＋実 Chromium で `Range.toString()` のオフセット不変性 PASS（隠しテキストも計上）
