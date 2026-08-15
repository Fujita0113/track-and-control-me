## Why

長期目標のタスク一覧（`goal-blueprint`）は `Tab`/`Shift+Tab` で階層（深さ）を動かせるが、**同じ深さの兄弟どうしの並び順だけ**を入れ替える手段が無い。順序を変えたい場合、いったん子にして戻す・削除して打ち直すといった遠回りしかできない。issue #104 の要望どおり、`Alt+↑`/`Alt+↓` で同じ親の中の並び順だけを動かせるようにする。

## What Changes

- タスク一覧で `Alt+↑` / `Alt+↓` を押すと、いまのノードが**同じ親を持つ兄弟の中**で1つ前/後ろの兄弟と位置を入れ替わる。
- 先頭で `Alt+↑`、末尾で `Alt+↓` を押しても何もしない（エラーにしない。`Tab`/`Shift+Tab` の境界挙動と同じ扱い）。
- 深さ（親）は変えない。兄弟の並び替えは既存の階層移動（`Tab`/`Shift+Tab`）とは別の操作として扱う。
- 画面常時表示の凡例（`legendEl`）に `Alt+↑↓ 並べ替え` を追加する。

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `goal-blueprint`: 「タスク一覧はキーボードだけで組める」要件のキー一覧に `Alt+↑`/`Alt+↓`（兄弟内の並べ替え）を追加する。
- `task-tree`: 兄弟の並び順（`tree_order`）を、深さを変えずに1つ前/後ろの兄弟と入れ替えられることを明文化する（既存の `setTreePosition` が担う）。

## Impact

- `server/static/js/blueprint.js`: `onTreeKeydown` に `Alt+ArrowUp`/`Alt+ArrowDown` の分岐、`handleMoveSibling` の追加、`legendEl` の凡例追加。既存の `api.setTaskTreePosition`（`PATCH /api/tasks/:id/tree-position`）をそのまま使うため、API・サービス層の新規コードは無い想定。
- `server/src/services/task-tree.test.ts`: `setTreePosition` を「深さを変えず同じ親内で並び替える」呼び出し方をした場合の挙動（前後入れ替え・端での no-op 相当・子孫が一緒に付いてくる）を確認するテストを追加する。
