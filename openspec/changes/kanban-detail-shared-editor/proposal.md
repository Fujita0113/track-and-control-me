## Why

かんばんカード詳細のノートは、行ごとに「非編集行＝静的 span／編集中行＝textarea、行をクリックすると全再描画」する独自エディタで、複数ブロックにまたがる範囲選択・Ctrl+A・コピーがネイティブに成立しない。ユーザーはダブルクリック＋ドラッグでもブロック単位でしか選択できず、コピペのたびに強くいら立っている（issue #57）。振り返り側は既に単一 contenteditable の共有エディタ（`md-editor.js` の `createMarkdownEditor`）でこの問題を解決済みで、かんばんだけが古い実装のまま取り残されている。

## What Changes

- かんばんカード詳細のノート編集を、独自の行ブロック×textarea エディタから、振り返りと同じ共有エディタ `createMarkdownEditor`（単一 contenteditable）へ置き換える。
- これにより、複数ブロックをまたぐドラッグ選択・ダブルクリック＋ドラッグ・Ctrl+A の全選択・コピー・切り取り・貼り付けがネイティブに成立する（#57 の解消）。
- ノートの自動保存を共有エディタの `onChange` 経由（`writeNotes`/`scheduleSave`）へ接続し、チェックボックスのトグルもエディタ内モデル更新→保存の一経路に統一する。
- **BREAKING（内部実装のみ）**: 独自エディタ固有の「行 textarea の差し替え」「プレビュー⇄編集のトグル」という編集モデルは廃止する。ユーザーから見た保存内容（`notes` の raw Markdown 文字列）は不変で、データ移行は不要。

## Capabilities

### New Capabilities
<!-- なし（新規ケイパビリティは導入しない） -->

### Modified Capabilities
- `kanban-note-editor`: ノート編集を単一 contenteditable の共有エディタへ移行する。複数ブロックをまたぐ範囲選択・全選択・コピー／切り取り／貼り付けの成立を新規要件として追加し、行 textarea 差し替え前提の「再描画をまたぐカーソル維持」「エディタ外フォーカス時のみ編集終了（プレビュー⇄編集トグル）」の旧要件を、常時ライブ編集モデルに合わせて改訂・削除する。

## Impact

- コード: `server/static/js/kanban.js`（詳細パネルのノート描画・編集経路 `buildEditorInto`/`editorBlockEl`/`renderEditor` ほか一連の独自エディタ関数、`onContentChange`/`onBlockKey`/`onLineBlur`/`toggleCheckbox` 等）を共有エディタ利用へ置換。`server/static/js/md-editor.js`（`createMarkdownEditor`）を import して再利用。
- CSS: `server/static/css/app.css` の `.kb-ed-*` 系スタイルは、共有エディタの `.rf-ed*` へ寄せる／詳細パネル内で見た目を保つ最小調整。
- 依存: 新規ライブラリ追加なし（既存の社内モジュールを再利用）。
- データ/API: `notes`（raw Markdown）フォーマット・保存 API は不変。移行不要。
- テスト: 既存 e2e（かんばん詳細まわり）の回帰確認と、範囲選択・コピペに関する動作確認を追加。
