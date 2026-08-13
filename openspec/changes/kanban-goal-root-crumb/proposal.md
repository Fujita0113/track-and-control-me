## Why

長期目標のタスク一覧（`goal-blueprint`）で分解せずに直接作った根タスク（`goal_id` はあるが `parent_task_id` は無い）は、カンバンに出てもどの目標の一部なのかが見た目からわからない。`task-tree` spec の「カードは親のパンくずを表示する」要件は、既に子タスクに対して目標名入りの色付き帯（パンくず）を表示しているが、「根のタスクには帯を表示してはならない（MUST NOT）」と明記されており、根タスクだけがこの恩恵を受けられない状態になっている（issue #101）。

## What Changes

- `task-tree` spec の「根のタスクには帯を表示してはならない」制約を、「**目標に属する**根のタスクには帯を表示する」に変更する。目標に属さない根タスク（`goal_id` が無い、普段のカンバンタスク）には従来どおり帯を出さない。
- 根タスクの帯には**目標名のみ**を表示する（直近の親が存在しないため、区切り記号や親名は出さない）。
- 帯の色は既存ルールを踏襲し、`root_task_id`（根タスク自身の id）から決定的に3色ローテーションで決まる。同じ目標でも枝（根タスク）が違えば色は変わりうる。
- 実装は `server/static/js/kanban.js` の `parentBreadcrumbEl(t)` の早期return条件（`t.parent_task_id == null` で即 `null`）を、目標に属する根タスクを弾かない形に見直す。

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `task-tree`: 「カードは親のパンくずを表示する」要件のうち、根タスクを一律で帯なしとしていた制約を、「目標に属する根タスクには目標名だけの帯を出す」よう変更する。

## Impact

- `server/static/js/kanban.js`: `parentBreadcrumbEl(t)` のロジック変更。
- `server/static/css/app.css`: 既存の `.kb-breadcrumb` 系クラスを流用（新規クラス追加は想定しない）。
- `openspec/specs/task-tree/spec.md`: 「カードは親のパンくずを表示する」要件のデルタ更新。
- 対象は `server/src/services/tasks.ts` の `listTasks()` が既に返している `goal_id` / `goal_name` / `root_task_id` のみで、DBスキーマ・API契約の変更は不要。
