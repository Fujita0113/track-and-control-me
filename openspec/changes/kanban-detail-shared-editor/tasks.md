## 1. 共有エディタの組み込み

- [ ] 1.1 `kanban.js` に `md-editor.js` の `createMarkdownEditor` を import する
- [ ] 1.2 `detailEl` の本文で `buildEditorInto(ed, t)` を廃し、`createMarkdownEditor({ initial: t.notes || '', placeholder, onChange, onSubmit })` を生成して `editor.el` を挿入する
- [ ] 1.3 `onChange: (raw) => writeNotes(t, raw)` を接続し、従来のデバウンス自動保存（`scheduleSave(t, 'notes')`）が働くことを確認する
- [ ] 1.4 `onSubmit`（Ctrl/Cmd+Enter）で確定保存（`flushSaves`）を行う（`shortcut-hints` 方針に合わせ、閉じるか否かを確定）
- [ ] 1.5 詳細パネルからノートへ入る導線を更新（タイトル Enter の `enterEdit(t,0,0)` を `editor.focus()` に置換）

## 2. 状態・デッドコードの整理

- [ ] 2.1 `openDetail`/`closeDetail`/削除処理の `S.editLine` / `S.pendingCaret` 参照を除去する
- [ ] 2.2 編集セッション管理（`enterEdit`/`startEdit`/`onLineBlur`/`focusEditorLine`/`blurTimer`）を削除する
- [ ] 2.3 独自パーサ／レンダラ（`parseBlock`/`blockToLine`/`detectShortcut`/`orderedNumber`/`contentClass`/`editorPlaceholder`/`mdInlineNodes`/`editorBlockEl`/`buildEditorInto`/`renderEditor`/`getClickOffset`/`textOffsetWithin`/`onContentChange`/`onBlockKey`/`toggleCheckbox`）を、他所参照が無いことを grep で確認のうえ削除する
- [ ] 2.4 `closeDetail` 等の離脱経路で `flushSaves` による確定保存が走ることを確認する

## 3. スタイル調整

- [ ] 3.1 詳細本文（`.kb-detail-body`）内で共有エディタ（`.rf-ed*`）を適用し、余白・最小高さ・見出し／リスト／引用のサイズが現行と実用上そろうよう最小 CSS 調整を行う
- [ ] 3.2 未使用になった `.kb-ed*` CSS を `app.css` から削除する
- [ ] 3.3 置換前後で詳細ノートのスクリーンショットを比較し、視覚パリティを確認する

## 4. 検証

- [ ] 4.1 複数ブロックをまたぐドラッグ選択・ダブルクリック＋ドラッグ・Ctrl+A の全選択・コピー／切り取り／貼り付けが成立することを実機で確認する（#57 の再現手順で確認）
- [ ] 4.2 Enter 改行・リスト継続・`[ ]` todo 化・チェックボックストグル・IME 入力・Undo/Redo の回帰確認
- [ ] 4.3 チェックボックストグルが `onChange`→`writeNotes` 経由で保存されることを確認する
- [ ] 4.4 かんばん詳細まわりの既存 e2e を実行し、必要なら選択・コピペ観点のケースを追加する
