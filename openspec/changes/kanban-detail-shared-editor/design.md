## Context

かんばんカード詳細（`server/static/js/kanban.js` の `detailEl`）のノートは、独自の行ブロック式エディタで描画している。`buildEditorInto` が各行を個別の `div.kb-ed-blk` として並べ、非編集行は静的 `span`、`S.editLine` に一致するアクティブ行だけを `textarea`（`kb-ed-input`）に差し替える。ブロックへの `mousedown`（`startEdit`）が `preventDefault` + `renderEditor`（全再描画）を走らせるため、ドラッグ選択が再描画で破棄され、かつ `textarea` は隣接ブロックへ選択を貫通できない。結果として複数ブロックにまたがる選択・Ctrl+A・コピペが成立しない（issue #57）。

一方、振り返り（`server/static/js/reflection.js`）は単一 contenteditable の共有エディタ `createMarkdownEditor`（`server/static/js/md-editor.js`）を使い、範囲選択・Ctrl+A・コピー／切り取り／貼り付けをネイティブに解決済み。IME ガード・Undo/Redo・リスト継続・`[ ]` todo 化・貼り付け HTML→Markdown 変換なども内包する。かんばんだけが古い実装で取り残されている。

制約: CSP 適合（innerHTML/inline style 不使用、`h()` によるノード構築）。`notes` は raw Markdown 文字列で保存され、既存フォーマット・保存 API は変えない。保存はデバウンス自動保存（`scheduleSave`/`flushSaves`）。

## Goals / Non-Goals

**Goals:**
- かんばんカード詳細のノート編集を共有エディタ `createMarkdownEditor` に置き換え、複数ブロックまたぎの範囲選択・Ctrl+A・コピー／切り取り／貼り付けをネイティブに成立させる。
- ノートの自動保存（`writeNotes`→`scheduleSave`）と、詳細を閉じる／フォーカス離脱時の確定保存を維持する。
- チェックボックスのトグル・見出し／リスト／引用など既存 Markdown 表現の見た目を実用上維持する。
- かんばん独自のエディタ関数群（`buildEditorInto`/`editorBlockEl`/`renderEditor`/`onContentChange`/`onBlockKey`/`onLineBlur`/`toggleCheckbox` ほか）を除去し、重複を削減する。

**Non-Goals:**
- 振り返り側エディタや `md-editor.js` 本体の機能拡張（本 change は「かんばんが共有エディタを使う」ことに限定）。
- ノートのデータモデル／保存 API の変更、既存ノートの移行。
- タイトル入力・優先度ピル・期限ピッカーなどノート以外の詳細 UI の変更。

## Decisions

### 決定1: 独自ブロックエディタを共有 `createMarkdownEditor` へ置換（パッチではなく統一）
- **理由**: ブロック×textarea 構造は選択貫通が原理的に困難で、局所修正しても `md-editor.js` が既に解決済みのロジック（選択・コピペ・IME・Undo/Redo）を再実装することになる。共有化で重複を消し、振り返りと挙動を揃えられる。
- **代替案**: (a) ドラッグ中は textarea 化しない＋全ブロックを単一の選択可能コンテナで描画する局所修正、(b) 「本文をコピー」ボタンのみ追加。いずれも #57 のダブルクリック＋ドラッグ選択体験を根本解決せず、保守負債が残るため見送り（方針決定でユーザーも共有エディタ統一を選択）。

### 決定2: 詳細パネルへの組み込み方
- `detailEl` の本文（`body`）で、`buildEditorInto(ed, t)` の代わりに `createMarkdownEditor({ initial: t.notes || '', placeholder: 'クリックして入力…   # 見出し ／ [ ] チェック ／ - リスト', onChange, onSubmit })` を生成し、`editor.el` を挿入する。
- `onChange: (raw) => writeNotes(t, raw)` で従来のデバウンス自動保存（`scheduleSave(t, 'notes')`）に接続。エディタ内チェックボックスのトグルも共有エディタが raw を書き換えて `onChange` を発火するため、保存経路は一本化される。
- `onSubmit`（Ctrl/Cmd+Enter）: 詳細では確定保存（`flushSaves`）＋必要なら詳細を閉じる、で振り返りと整合。
- タイトル入力の Enter でノートへ入る既存挙動（`enterEdit(t,0,0)`）は `editor.focus()` に置き換える。

### 決定3: 状態・デッドコードの整理
- `S.editLine` / `S.pendingCaret` / `blurTimer` とそれに紐づく編集セッション管理（`enterEdit`/`startEdit`/`onLineBlur`/`focusEditorLine`）は共有エディタでは不要になるため削除。`openDetail`/`closeDetail`/削除処理での `S.editLine = -1` 等の参照も除去する。
- 独自パーサ／レンダラ（`parseBlock`/`blockToLine`/`detectShortcut`/`orderedNumber`/`contentClass`/`editorPlaceholder`/`mdInlineNodes`/`editorBlockEl`/`buildEditorInto`/`renderEditor`/`getClickOffset`/`textOffsetWithin`/`onContentChange`/`onBlockKey`/`toggleCheckbox`）を削除（他所参照がないことを grep で確認してから）。

### 決定4: スタイル
- 共有エディタは `.rf-ed*` クラスを前提とするため、詳細パネル内で `.rf-ed` を適用しつつ、詳細本文の余白・最小高さ・見出し／リストのサイズが現行 `.kb-ed*` と実用上そろうよう、`.kb-detail-body` スコープの最小 CSS 調整を行う。`.kb-ed*` の未使用スタイルは削除する。

## Risks / Trade-offs

- [かんばん固有挙動の回帰（タイトル Enter→ノート移動、IME、Undo/Redo、リスト継続、自動保存タイミング）] → 置換後に主要フローを手動＋既存 e2e（かんばん詳細系）で回帰確認。`onChange`→`scheduleSave`、`closeDetail`→`flushSaves` の確定保存経路を明示的にテスト。
- [見た目の差異（`.rf-ed` と `.kb-ed` のフォント／余白差）] → 置換前後でスクリーンショット比較し、詳細本文スコープの CSS で視覚パリティを取る（参照実装を ref/ で確認する既存方針に沿う）。
- [チェックボックス・トグルの保存経路変更] → トグルが raw を書き換え `onChange`→`writeNotes` で保存されることを実機確認。旧 `toggleCheckbox`（タスク側状態への波及がないこと）を確認のうえ削除。
- [空ノート時のプレースホルダ体験の差] → 共有エディタの `placeholder` で現行の入力ヒント文言を踏襲。

## Migration Plan

- フロントエンドのみの置換。`notes`（raw Markdown）フォーマット・保存 API は不変で、既存データの移行は不要。
- デプロイは静的アセット差し替えのみ。ロールバックは本 change のコミットを revert すれば旧エディタに戻る（データ非依存）。

## Open Questions

- Ctrl/Cmd+Enter（`onSubmit`）は「保存して詳細を閉じる」か「確定保存のみ」か。既存のショートカット方針（`shortcut-hints`）と整合する側に寄せる。
- `.kb-ed*` の CSS を全面削除するか、`.rf-ed` に別名で寄せるか（視覚パリティ確認の結果で確定）。
