## Context

振り返りエディタ `server/static/js/md-editor.js` は単一 `contenteditable` 上の「1 行 = 1 ブロック div」モデル。入力・キー操作のたびに `getContent()` で raw テキストを読み直し、`editor.replaceChildren(...buildBlocks(raw))` で DOM を丸ごと再構築する（`render_` / `setRawAndCaret`）。この全置換により **ブラウザ標準の undo 履歴が毎回リセット**され、`Ctrl+Z` は実質使えない。貼り付けも paste ハンドラが無く、既定の `text/html` 挿入がブロック div の内側に `<div>`/`<br>`/スタイル span を作り、`getContent()`（トップレベル `.children` の `textContent` を `\n` 連結）が行数を復元できず潰れる（issue #6）。

編集モデルの単一の真実は `raw`（文字列）と「グローバル文字オフセット」で表すキャレット。既存の `getCaret`/`setCaret`/`locate`/`offsetOf`/`setRawAndCaret`/`placeIn` がこのモデルを担う。

本 change は Undo/Redo・paste に加え、**同じ関数（`onKeydown` / `setRawAndCaret` / 新規 paste・cut リスナ）を触る一群のキーボード/クリップボード操作**を同梱する（ユーザー選択: Tier A 全部）。理由は 3 点: (1) いずれも `onKeydown` にキーを足して raw を書き換える操作であり、**undo のコミット境界として結線しないと「その操作だけ Undo できない」**不整合になる、(2) いずれも「ブラウザ既定を横取りして raw モデルへ置換する」paste と同型の安全修正、(3) 調査で見つかった 2 件のサイレントなデータ欠損バグ（Shift+Enter の行融合、IME 中 `getValue` の旧値返却）が同じコードに数行で同居できる。

制約: CSP（`style-src 'self'`、インライン `style=` 禁止。静的はクラス、動的は CSSOM）、バニラ JS（ライブラリ追加なし）、公開 API（`el`/`getValue`/`setValue`/`focus`/`isDirty`/`markSaved`）不変、raw/caret モデル維持、IME（compositionstart/end ガード）維持。

## Goals / Non-Goals

**Goals:**
- `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` を raw + caret スナップショットの自前履歴で実現。連続入力コアレス、構造変化＝コミット境界。
- 複数行 Markdown 貼り付けを「1 行 = 1 ブロック」へ正しく反映（plain text 化 + 改行正規化 + 選択置換）。
- 同一コードに相乗りする Tier A 操作を追加: Shift+Enter 素の改行（バグ修正）／行移動 Alt+↑↓／Tab・Shift+Tab インデント／Ctrl+B・I・E 装飾ラップ／Ctrl+Cmd+Enter チェック切替／モデル経由 cut／`getValue` IME 整合（バグ修正）。
- 上記すべてを既存 Notion 風挙動・IME ガード・保存/dirty・公開 API と一貫させる。

**Non-Goals（本 change では扱わない。fast-follow / later）:**
- ブロック内の真のソフト改行（`<br>`）表現。Shift+Enter は raw の `\n`（＝新ブロック）とする。
- 引用 `>` の Enter 継続、番号リストの自動振り直し、ブロック種別変換ショートカット（Ctrl+Alt+数字等）。
- `[text](url)` のインライン描画、Ctrl+K、URL スマート貼り付け、プレーンテキストの glyph/タブ正規化（構造付き `text/html` の Markdown 化は D15 で取り込み済み）。
- 複数行選択の一括インデント、選択中に `* ` `` ` `` `_ ~` を打ってラップ（beforeinput 系）。
- ドラッグ&ドロップ、slash メニュー、空行プレースホルダ、a11y（:focus-visible / aria-live）。
- textarea 方式への差し戻し等、エディタ方式そのものの変更。

## Decisions

### D1: 自前の Undo/Redo 履歴スタック（raw + caret スナップショット）
DOM 全置換で標準履歴が壊れるため、`{ raw, caret }` のスナップショット配列（`undoStack` / `redoStack`）を持つ。復元は既存 `setRawAndCaret(raw, caret)` に流すだけでモデルに一貫して乗る。上限（例: 200）を設けリング状に古い側を破棄。**代替案**: `execCommand('undo')` / `inputType: historyUndo` は replaceChildren で機能せず却下。ライブラリ（ProseMirror 等）は CSP/バニラ方針・移植コストに見合わず却下。

### D2: コミット境界とコアレス
「1 タイプ = 1 履歴」を避けるため遅延コミット方式。`commitHistory()` が「現在の raw/caret を `undoStack` に push し `redoStack` をクリア」する。境界（＝直前状態を確定 push）は **構造変化のすべて**: Enter/Shift+Enter 行操作、paste、cut、チェックトグル（クリック/キー）、コードフェンス自動クローズ、todo ショートハンド、行移動、インデント変更、装飾ラップ。通常文字入力は境界まで 1 まとまりにコアレス。IME 変換中はスナップショットを取らず `compositionend`→`render_` 後を履歴化（二重 push ガード）。**Tier A の各操作は必ず `setRawAndCaret` の前に `commitHistory()` を呼ぶ**ことで undo 境界を自動継承する（この結線を今一括で行うのが同梱の主目的）。

### D3: `onKeydown` 冒頭の Ctrl/Cmd 修飾ディスパッチ
`onKeydown` 先頭（`composing` ガード直後）で `(e.ctrlKey || e.metaKey)` を判定する分岐点を設ける。ここに `z`/`Shift+z`/`y`（undo/redo）、`b`/`i`/`e`（装飾）、`Enter`（チェック切替）をぶら下げる。各分岐は `e.preventDefault()` で execCommand/既定を殺す。`composing`/`e.isComposing` 中は無視。Mac 対応で `metaKey` も許容。**順序が正しさの肝**: `Ctrl+Enter`（チェック切替）は `shiftKey=false` のため、素の Enter 分岐より**前**で処理して return しないと改行が入ってしまう。

### D4: 選択オフセットの共有ヘルパ `offsetForPoint(node, off)`
paste の選択置換・Ctrl+B/I/E・cut は「選択の start/end をグローバル文字オフセットで得る」必要がある。既存 `getCaret`（102–124）は collapsed 前提なので、その「点 → オフセット」算出を `offsetForPoint(node, off)` として抽出し、`selection.anchorNode/anchorOffset` と `focusNode/focusOffset` の両端に適用、start/end を正規化する `getSelectionRange()` を作る。**これを 1 つに揃えて 3 機能で共有するのが同梱の技術的な主フック**（別々に実装すると重複・ズレの温床）。

### D5: 選択再設定ヘルパ `setSelection(start, end)`
装飾ラップ後に対象範囲を再選択して連続トグルを可能にする。既存 `placeIn`（140–159）は collapsed 専用なので、TreeWalker の「オフセット → {node, offset}」点探索を切り出し、start と end で 1 つの Range を `setStart`/`setEnd` 構築する。

### D6: paste は preventDefault + text/plain 差し込み（選択置換は D4 を使用）
`paste` で `e.preventDefault()`、`e.clipboardData.getData('text/plain')` を取得、`\r\n?`→`\n` 正規化。`getSelectionRange()`（D4）で `{start,end}` を得て `raw.slice(0,start) + pasted + raw.slice(end)` を作り、`commitHistory()`→`setRawAndCaret(next, start + pasted.length)`。取得失敗/空は no-op で既定を壊さない。

### D7: Shift+Enter 素の改行（バグ修正）
現状 `onKeydown`(211) は `e.key==='Enter' && !e.shiftKey` のみ横取り。Shift+Enter は既定に落ち block div 内へ `<br>` を挿入 → `getContent` が `<br>` を改行として拾えず**次の render_ で 2 行融合＝内容欠損**。修正: 判定を `e.key==='Enter'` に広げ、マーカー継続は `!e.shiftKey` のときだけ。Shift 時は既存の「通常改行」パス（`before/after` 分割 → `splice(li,1,before,after)` → `setRawAndCaret`）を逐語で通す。真のソフト `<br>` は 1 行=1 ブロック不変条件を壊すため採らない（Non-Goal）。契約: **Shift+Enter = マーカー無しの素の行、Enter = マーカー継続**。

### D8: 行移動 Alt+↑ / Alt+↓
`composing` ガード直後に分岐。`getCaret`→`locate` で行 index `li` と桁 `col` を得て、`lines` を swap（`dest = li∓1`）。**先頭/末尾では no-op**。`newCol = Math.min(col, lines[dest].length)` でクランプ（クランプ無しだと過長オフセットが `setCaret` のブロック走査で後続行へ落ちる）。`commitHistory()`→`setRawAndCaret(next.join('\n'), offsetOf(next, dest, newCol))`、`preventDefault`。番号再採番はしない（現状も未実施のため回帰でない）。

### D9: Tab / Shift+Tab インデント
`onKeydown` に `Tab` 分岐。現在行が `LIST_RE`（bullet/number/task）に一致するとき、Tab は `lines[li]` 先頭に 2 スペース付与（col +2）、Shift+Tab は先頭 2 スペースを剥がす（無ければ据え置き、col は 0 でクランプ）。`preventDefault` 必須（さもないと Tab がフォーカスを外へ移す）。インデントは raw の実スペースとして持ち、`buildLine` の `paddingLeft = 4 + indent.length*20`（70/82 行）で描画に反映。既存 Enter 継続は `indent` を次マーカーへ引き継ぐ（218 行）ので自然に協調。MVP は collapsed キャレット単一行（複数行一括は Non-Goal）。

### D10: 選択ラップ Ctrl+B / Ctrl+I / Ctrl+E
D3 の Ctrl 分岐に載せ、`e.preventDefault()` で `execCommand('bold'/'italic')` を無効化（IME ガードも D3 で自動享受）。`getSelectionRange()`（D4）で `{start,end}`。選択が既に対象マーカー（`**`/`*`/`` ` ``）で囲まれていれば剥がす（トグル）、なければ囲む。`raw` を差し替え `commitHistory()`→`setRawAndCaret`→`setSelection`（D5）で範囲を復元。collapsed 時は空ペア挿入しキャレットを内側へ。非入れ子の既存 inline RE（27 行）は `**word**`/`*word*`/`` `code` `` を既に一致するので描画不変。

### D11: チェック切替 Ctrl/Cmd+Enter
D3 の Ctrl 分岐で、**素の Enter 分岐より前**に配置し return（D3 の順序注記）。`locate` した行が `TASK_RE` なら `[ ]`⇄`[x]` を**長さ不変**で置換（`toggleCheckboxAt` は行末 snap するので流用せず replace を複製し、キャレットを厳密保持）。`commitHistory()`→`setRawAndCaret`。非タスク行でも `preventDefault`+return で chord を飲む（改行を入れない）。任意で `rf-ed-check` span に `role='checkbox'`/`aria-checked` を付与（2 行・無害）。

### D12: モデル経由 cut（cut のみ、drop は Non-Goal）
`cut` リスナで `composing` ガード後、`getSelectionRange()` の `{start,end}` を取り、`raw.slice(start,end)` を `e.clipboardData.setData('text/plain', …)`（cut イベント内なので合法）、`e.preventDefault()`→`commitHistory()`→`setRawAndCaret(raw.slice(0,start)+raw.slice(end), start)`。`start===end` は no-op。ネイティブ cut は `input`→`render_`（＝コアレス単位で境界でない）に落ち「cut→打鍵」が個別 undo 不能になる既存の穴を塞ぐ。drop 半分は point→offset 新ヘルパ・dragover 防御・内部ドラッグ所有が要り L のため切り離す。

### D13: `getValue` の IME 整合（バグ修正）
`getValue: () => raw` を `() => composing ? getContent(editor) : raw` に変更（1 行）。`raw` は composition ガード付きパスでのみ更新されるため、変換中の `flush()`（reflection.js:151）/日付切替/`goToPlanning` が**最終行の未確定文字を落とす**。`getContent`（96 行）は `render_` が raw 再構築に信頼する純読み取りで、DOM 上の未確定テキストを含む。純読みで caret/DOM/履歴に触れない保険。`setValue` の compositionend 遅延は履歴リセット境界と衝突し M のため Non-Goal。

### D15: 構造付き HTML 貼り付けの Markdown 化（issue #6 追加コメント）
paste の text/plain だけでは Notion/Google Docs の箇条書き・チェックリスト・見出しがマーカーを失い素の段落に潰れる（`text/plain` に構造マーカーが乗らないため）。`htmlToMarkdown(html)` を追加し、`DOMParser().parseFromString(html,'text/html')` の **detached document をタグ駆動・クラス非依存**で走査して「1 行 = 1 ブロック」の raw Markdown を生成する。`<ul>/<ol>>li` → `- `/`N. `、ネスト list → 2 スペース/段（`indentLine` の単位・`LIST_RE` の `(\s*)` と一致）、to-do（`input[type=checkbox]` / Notion の `to-do-list`・`div.checkbox`・`span.to-do-children` / 素の `[ ]` glyph の OR）→ `- [ ] `/`- [x] `（`TASK_RE` 準拠）、`<h1-6>` → `#`、`<blockquote>` → 行ごと `> `、inline は `**`/`*`/`` ` ``/`~~`/リンク＋Google Docs の font-weight/style span。`onPaste` は **構造タグ（`ul|ol|li|h1-6|blockquote|pre`）を含む text/html のときだけ**変換を採用し、無ければ `text/plain` にフォールバック（inline のみ HTML で text/plain の改行を潰さないガード）。D6 の `getSelectionRange`→`commitHistory`→`setRawAndCaret` の tail をそのまま再利用し undo 境界・キャレットを継承。**クラス完全一致に依存しない**（Notion の undocumented class は将来変わりうるがタグ構造は安定）。live DOM へ HTML を注入しない（read-only 走査のみ）ため CSP/XSS 安全。**代替案**: text/plain のヒューリスティック整形は Notion の構造を復元できず却下。

### D16: タスクチェックボックスの Notion 風表示（issue #6 追加コメント / CSS のみ）
生の `[ ]`/`[x]`・先頭 `- ` は `getContent` の raw 復元とグローバルオフセットの土台なので **DOM の textContent から消してはならない**。よって CSS のみで視覚差し替えする: `.rf-ed-task > .rf-ed-marker { display:none }`（**子結合子**必須—子孫結合子だと `.rf-ed-task-text` 内の装飾 `.rf-ed-marker` まで隠す）、`.rf-ed-check` を 16px の inline-block ボックス化し角括弧文字を `font-size:0` で不可視化（textContent には残る）、`::before` で角丸枠/塗り、`::after` の回転ボーダーで白チェック（画像アセット不要 = CSP 安全）、チェック済み行本文は取り消し線＋ミュート。`display:none`/`font-size:0` は textContent も **`Range.toString()` も変えない**（データ由来・レイアウト非依存）ため `getCaret`/`getSelectionRange`/`offsetForPoint`/`pointForOffset` のオフセット計算は不変（実 Chromium で `Range.toString()` が隠しテキストを計上することを確認済み）。`vertical-align:middle` で行内に整列。**代替案**: 描画時に `[ ]` を別要素へ置換して textContent を変える案は raw モデルを壊すため却下。

### D14: 公開 API・保存/dirty との整合
`setValue`（日付ロード・過去エントリ選択で呼ばれる）は `undoStack`/`redoStack` を**両方リセット**（別日の内容へ undo で戻れる事故防止）。`markSaved`/`isDirty` の意味は不変。undo/redo・行移動・インデント・ラップ・チェック切替・cut・paste による本文変化はすべて既存 `afterUserChange`（`dirty=true`＋`onChange`）を通し、文字数・プレースホルダ・`ctx.dirty` に反映。

## Risks / Trade-offs

- [Ctrl 系分岐の順序] `Ctrl+Enter` を素の Enter より後に置くと改行が混入 → D3/D11 の順序を厳守し、チェック切替→装飾→undo/redo の順で先頭ディスパッチに集約。
- [選択オフセットのズレ] `offsetForPoint`/`getSelectionRange` を誤ると paste/cut/ラップが全滅 → 3 機能で**単一ヘルパを共有**し、途中挿入・全選択・逆方向選択（focus<anchor）を重点テスト。
- [Tab とネスト整合] Tab で番号項目の階層が変わっても本 change は再採番しない（Non-Goal） → 現状も未採番のため回帰ではない旨を spec に明記。将来 renumber を足すときの結合点として `offsetOf` 吸収を design に残す。
- [コアレス粒度] 大雑把だと戻しすぎ/戻せなさすぎ → 「構造変化＝境界、通常入力は境界まで 1 まとまり」で実装し実機で手触り調整。
- [IME 競合] composition 中のスナップショット破棄、`compositionend`→`render_` 後のみ履歴化。Tier A 操作は全て `composing` ガード後に配置。
- [メモリ] 履歴上限でリング破棄（固定上限）。
- [clipboard 差異] `e.clipboardData` はデスクトップ Chromium/Firefox で利用可。取得失敗は no-op。

## Migration Plan

- 変更は `md-editor.js` に閉じ、公開 API 不変のため `reflection.js` は無改修。DB/API/スキーマ変更なし。ロールバックは当該コミットの revert のみ。
- 手動確認（`reference-impl-in-ref-dir` 方針、スクショ検証）:
  1. 入力→`Ctrl+Z`→`Ctrl+Shift+Z`/`Ctrl+Y`（ページ全体が巻き戻らない）
  2. 4 行箇条書きの貼り付け／行途中貼り付け（前後保持）
  3. `Shift+Enter` で文字が融合・欠落しない
  4. `Alt+↑/↓` 行移動、`Tab`/`Shift+Tab` ネスト、`Ctrl+B/I/E` ラップ＆解除、`Ctrl+Enter` チェック切替、`Ctrl+X` cut — いずれも 1 回の `Ctrl+Z` で戻せる
  5. IME 変換確定前に保存しても最終行が消えない／日付切替後に前日内容へ undo で戻らない

## Open Questions

- コアレスにアイドルタイマ（例: 500ms 無入力で境界確定）を入れるか、構造変化境界のみで十分か。まず後者で実装し手触りで判断。
- 装飾ラップの collapsed 時の挙動（空ペア挿入）で `Ctrl+E` は `` `` `` 1 対を入れる想定。追加要望が無ければこのまま。
- `Ctrl+Enter` は既存の「振り返りを終えて明日の計画へ」ボタン（planBtn）等と衝突しないか要確認（エディタ内 keydown で `preventDefault` するためグローバルには波及しない想定）。
