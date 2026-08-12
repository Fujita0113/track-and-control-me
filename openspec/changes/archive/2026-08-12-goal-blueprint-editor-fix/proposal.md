## Why

issue #99: 長期目標のタスク一覧（`goal-blueprint`）で2つのバグが報告されている。①タイトルの編集後、別のところをクリックしても入力枠にフォーカスが戻り続け、編集状態から抜けられない。これにより↑↓でのタスク移動もできなくなる。②Detail モーダルに書いた本文（`task.notes`）が、一覧の行の下にプレビューとして漏れて表示されてしまう。②は `openspec/specs/goal-blueprint/spec.md` にも `ref/goal-blueprint/task-tree-mock.html` にも存在しない挙動で、仕様外の実装ミス。

## What Changes

- `blueprint.js` の `restoreFocus()` を、再描画の直前に**フォーカスがまだツリーの中にあった場合だけ**選択ノードへフォーカスを戻すように変更する。ユーザーがツリーの外へ明示的にクリックして離脱したあとの非同期な再描画（タイトル確定後の `reload()` など）が、その離脱を上書きして入力枠へフォーカスを奪い返さないようにする。
- 既存の「編集操作の直後は触っているノードにフォーカスが戻る」「1件足したら続けて打てる」といったキーボード駆動の継続性（`openspec/specs/goal-blueprint/spec.md` 200行目台）は変えない。ツリー内で完結する操作（Enter 追加・Tab・Alt+C・↑↓ など)は今まで通りフォーカスが戻る。
- 葉ノードの行の下に本文プレビューを描画している `.bp-node-notes` の表示を削除する。本文は Detail モーダル（`Ctrl+Enter`）でのみ表示・編集する、という既存仕様に一致させる。

## Capabilities

### New Capabilities
(なし)

### Modified Capabilities
- `goal-blueprint`: タイトル編集後にツリー外へフォーカスが移った状態を、再描画がプログラム的に奪い返さないことを明文化する。行の下に本文プレビューを出さないことを明文化する（もともと仕様には無かった実装ミスの除去だが、再発防止のため明示する）。

## Impact

- `server/static/js/blueprint.js`: `restoreFocus()` のフォーカス条件、`nodeEl()` の本文プレビュー描画（`.bp-node-notes` 生成部分）。
- `server/static/css/app.css`: `.bp-node-notes` ルールは未使用になるため削除。
- サーバ側（API・DB・services）への変更は無し。フロントエンドの表示・フォーカス制御のみ。
- 既存 e2e（`e2e/` 配下に `blueprint` 関連の spec があれば）への影響を要確認。
