## Context

タスク一覧（`server/static/js/blueprint.js`）は `S.index`（`id -> { node, parentId, depth, siblingIds }`）をクライアント側に持ち、`siblingIds` は同じ親を持つ兄弟の id を `tree_order` 順に並べた配列（自分自身を含む）。既存の `handleTab`/`handleShiftTab` はこの `siblingIds` から挿入位置を計算し、`api.setTaskTreePosition(nodeId, { parentId, afterTaskId })`（`PATCH /api/tasks/:id/tree-position` → サービス層 `setTreePosition`）を呼んで階層（深さ）ごと動かしている。

`setTreePosition` は `parentId` が変わらない呼び出し（＝深さを変えず、同じ親の中で `afterTaskId` だけ変える）もそのまま扱える。`insertOrderAfter` は対象の兄弟の `tree_order` を +1 ずつずらして挿入位置を空けるだけで、`parentId` が既存と同じかどうかを区別しない。根（`parentId === null`）の場合も `findTreeRootGoalId` は既に根であるノードに対しては自分自身の `goal_id` をそのまま返すため、根どうしの並べ替えでも `goal_id` が壊れない。したがって**サーバー側の新規コードは不要**で、クライアントから既存 API を呼ぶだけで実現できる（`server/src/services/task-tree.test.ts` の `setTreePosition: 深さを変えず同じ親の中で並び替える` で検証済み）。

**`afterTaskId` の意味論に関する落とし穴（実装前の検証で判明）**: `insertOrderAfter` は「参照ノード（`afterTaskId`）の**現在の** `tree_order` の直後」に対象を置き、それ以降の兄弟を +1 する。対象自身の**元の位置は考慮しない**（対象を一度取り除いてから挿し直すわけではない）。このため「対象を先頭にしたいときは `afterTaskId: null` を渡せばよい」という直感は誤りだった: `afterTaskId: null` は `insertOrderAfter` 内で `nextTreeOrder`（= 兄弟の `tree_order` の MAX+1）を返す＝**末尾**に置く、という意味であり「先頭に置く」ではない。素朴に「対象の2つ前の兄弟を参照する（無ければ `null`）」で `Alt+↑` を組むと、先頭境界（2番目のノードを1番目と入れ替える操作）で対象が末尾へ吹っ飛ぶ不具合になる（この落とし穴は `setTreePosition: 深さを変えず同じ親の中で並び替える > 落とし穴` のテストで再現・固定した）。

## Goals / Non-Goals

**Goals:**
- `Alt+↑` / `Alt+↓` で、いまのノードを**同じ親を持つ兄弟の中**で1つ前/後ろの兄弟と入れ替える。
- 先頭/末尾での `Alt+↑`/`Alt+↓` はエラーにせず何もしない（`Tab`/`Shift+Tab` の境界挙動と対称）。
- 子孫（部分木）は対象と一緒に動く（`parent_task_id` は変わらないため、これは自動的に成り立つ）。

**Non-Goals:**
- 兄弟をまたいだ複数段の移動（一度に3つ分動かす等）は対象外。1回の操作で1つ隣と入れ替えるだけ。
- 深さを変える操作（`Tab`/`Shift+Tab`）との統合・置き換えは行わない。別の操作として共存させる。
- ドラッグ&ドロップでの並べ替えは対象外（キーボード操作のみ）。

## Decisions

- **既存 API をそのまま再利用する。「隣接する2件のうち前を、後ろの直後へ移す」という単一のパターンに両方向を還元する**: `handleMoveSibling(nodeId, dir)` を新設する。`parentId` は常に現在の親のまま変えない。
  - `Alt+↓`（下へ）: `idx = siblingIds.indexOf(nodeId)`。`idx === -1 || idx === siblingIds.length - 1` なら何もしない。そうでなければ `nextId = siblingIds[idx + 1]` として `api.setTaskTreePosition(nodeId, { parentId: info.parentId, afterTaskId: nextId })` を呼ぶ（**対象自身**を、後ろの兄弟の直後へ移す）。
  - `Alt+↑`（上へ）: `idx = siblingIds.indexOf(nodeId)`。`idx <= 0` なら何もしない。そうでなければ `prevId = siblingIds[idx - 1]` として `api.setTaskTreePosition(prevId, { parentId: info.parentId, afterTaskId: nodeId })` を呼ぶ（**対象ではなく前の兄弟**を、対象の直後へ移す）。こうすると常に実在する id（対象自身）を参照するため、上の「落とし穴」（`afterTaskId: null` が先頭ではなく末尾になる）を踏まない。副作用として、対象自身の行は更新されない（前の兄弟の行だけが更新される）が、見た目の並び順は正しく入れ替わる。
  - 代替案1: `Alt+↑` を「対象の2つ前の兄弟を参照（無ければ `null`）」で組む案は、上記の落とし穴により先頭境界で壊れるため却下（実装前にテストで確認して破棄）。
  - 代替案2: サーバー側に「1つ前/後ろと入れ替える」専用エンドポイントを新設する案は、`setTreePosition` が「前を後ろの直後へ移す」呼び方で正しく処理できるため、新規コードを増やすだけで得るものが無く却下。
- **選択と展開状態**: `Alt+↑`/`Alt+↓` のどちらでも、選択中のノード自身の id は変わらない（`Alt+↑` では相手の行を動かすだけ）ため、`S.selId` の再設定は不要。深さも変わらないため `S.openSet` の操作も不要。
- **凡例**: `legendEl` に `Alt+↑↓ 並べ替え` を追加する。対応する単体のボタン/UI要素が無い操作（`Tab`/`Shift+Tab`/`↑↓` と同様）のため、`attachTooltip` は個別要素へは付けず、凡例のみで案内する（既存コードの precedent と一致）。

## Risks / Trade-offs

- [`Alt+↑`/`Alt+↓` はブラウザ/OS のグローバルショートカット（例: ウィンドウ切り替え）と衝突しうる] → ツリー内の `keydown`（`onTreeKeydown`、`preventDefault` 済み）でのみハンドルするため、フォーカスがタスク一覧の行にあるときだけ有効。既存の `Alt+C` と同じスコープなので新しいリスクではない。
- [`siblingIds` はクライアントのローカル状態（直近の `reload()` 時点のスナップショット）のため、他クライアントの同時編集と競合する可能性] → 既存の `Tab`/`Shift+Tab` も同じ前提で動いており、単一ユーザー利用を想定したこのアプリの既存の許容範囲と同じ。

## Migration Plan

なし（クライアント側のみの追加。データモデル・API 変更なし）。

## Open Questions

なし。
