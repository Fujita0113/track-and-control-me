## 0. テスト方針（propose 時点の記録）

- **vitest（新規追加）: なし。** この変更はクライアント側の描画ロジック（`server/static/js/kanban.js` の `parentBreadcrumbEl`）のみを変える。依存しているサーバー側の契約（`listTasks()` が根タスク自身にも `goal_name` を返すこと）は `server/src/services/task-tree.test.ts`「根自身の root_task_id は自分」で使っている `createRootTask` 経路が既に通しており、サーバー側に変更が無いため新たに赤くできる契約が無い（design.md の「サーバー側の変更は不要」を参照）。
- **既存 e2e への影響: なし。** `.kb-breadcrumb` を検証する既存 e2e（`e2e/goal-blueprint-keyboard-tree.spec.ts`、`e2e/goal-blueprint-task-tree.spec.ts`）はいずれも子タスクのカードだけを対象にしており、根タスクに帯が無いことをアサートしている箇所は無い（`toHaveCount(0)` 等で根タスクの帯の不在を固定しているテストは無いことを確認済み）。
- **apply が最後に書く新規 e2e（フロー名。セレクタは実装後に決める）**:
  「目標のタスク一覧から分解せずに直接作った根タスクを盤面で見る → カードの帯に目標名だけが表示され、区切りの記号や親名は出ない」

## 1. spec 反映の確認

- [x] 1.1 `openspec/specs/task-tree/spec.md` の「カードは親のパンくずを表示する」要件が、今回のdelta（`openspec/changes/kanban-goal-root-crumb/specs/task-tree/spec.md`）と矛盾しないことを実装前に読み直す。

## 2. 実装（kanban.js）

- [x] 2.1 `server/static/js/kanban.js` の `parentBreadcrumbEl(t)` を、「親を持つ」または「`goal_name` を持つ根タスク（`parent_task_id == null` かつ `goal_name` あり）」のいずれかで帯を出すように分岐を広げる。
- [x] 2.2 親が存在しないケース（根タスク）では `parent` を参照せず、`crumb-goal` 相当（`kb-breadcrumb-goal`）のみを描画し、区切り記号（`kb-breadcrumb-sep`）と親名（`kb-breadcrumb-parent`）は出さない。`title` 属性（ホバーテキスト）も同様に目標名のみにする。
- [x] 2.3 帯の色クラスは既存どおり `CRUMB_COLORS[((t.root_task_id ?? 0) % 3 + 3) % 3]` をそのまま使う（根タスクは `root_task_id` が自分自身の id になるため変更不要。design.md の決定を参照）。
- [x] 2.4 目標に属さない根タスク（`goal_name` が無い、通常のカンバンタスク）には従来どおり帯を出さないことをコードレビューで確認する。

## 3. 確認

- [x] 3.1 `npm test`（vitest）を実行し、既存テストに回帰が無いことを確認する。
- [x] 3.2 デモモード、または手動データで「目標のタスク一覧から根タスクを直接作る → カンバンで目標名だけの帯が出る」ことをブラウザで目視確認する。
- [x] 3.3 上記§0の新規 e2e を、実際にできた DOM（クラス名等）に対して書き、CLAUDE.md の凍結ラインの手順（`git stash` で実装抜きに落ちることを確認 → `git stash pop` で通すことを確認）で検証する。
- [x] 3.4 既存 e2e（`e2e/goal-blueprint-keyboard-tree.spec.ts`、`e2e/goal-blueprint-task-tree.spec.ts`）を実行し、回帰が無いことを確認する。
