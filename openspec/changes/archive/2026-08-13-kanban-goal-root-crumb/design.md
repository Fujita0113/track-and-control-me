## Context

`task-tree` spec の「カードは親のパンくずを表示する」要件により、`server/static/js/kanban.js` の `parentBreadcrumbEl(t)` は子タスク（`parent_task_id` を持つタスク）のカードに、目標名と直近の親名を表示する色付き帯を出している。しかし関数の先頭で `if (t.parent_task_id == null) return null;` としているため、根タスク（分解せず `goal-blueprint` のタスク一覧から直接作ったタスク）は目標に属していても帯が一切出ない。

`server/src/services/tasks.ts` の `listTasks()` は既に `goal_name` を根タスク自身にも正しく付与している（`goal_root` を `root_task.goal_id` で JOIN するクエリのため、根タスクは自分自身が `root_task`）。よって今回はサーバー側の変更は不要で、`kanban.js` の分岐条件を直すだけで実現できる。

## Goals / Non-Goals

**Goals:**
- 目標に属する根タスク（`goal_id` あり・`parent_task_id` なし）のカードに、目標名だけの帯を表示する。
- 既存の子タスクの帯（目標名＋直近の親）の挙動・色決定ロジックは変えない。

**Non-Goals:**
- goal 自体への色設定機能の追加（既存どおり `root_task_id` 由来の3色ローテーションを使う）。
- 目標に属さない根タスク（普段のカンバンタスク）への帯表示。これは spec 上も対象外のまま。

## Decisions

- **`parentBreadcrumbEl(t)` の分岐を「親あり」から「目標に属する（`goal_name` がある）か、親がある」のいずれかに広げる。** 親が無い場合は `parent` 変数・区切り記号・`crumb-parent` 相当の要素を出さず、`crumb-goal` 相当のみ描画する。
  - 代替案: 根タスク専用の別関数を新設する案も検討したが、色決定（`CRUMB_COLORS[(root_task_id % 3)]`）とマークアップ（`.kb-breadcrumb` / `.kb-breadcrumb-icon` / `.kb-breadcrumb-text`）が子タスクと完全に共通のため、1つの関数内で分岐する方が重複が無い。
- **根タスクの帯の色は `root_task_id ?? t.id` ではなく、根タスク自身なので `t.id` を使う根拠が要る。** `listTasks()` は根タスクにも `root_task_id` を自分自身の id として返しているため、既存の `t.root_task_id ?? 0` 参照をそのまま使えば根タスクでも正しい色が出る（変更不要）。
- **`title` 属性（ホバーテキスト）も分岐する。** 親が無い場合は `t.goal_name` のみを表示し、`/ 親名` を付けない。

## Risks / Trade-offs

- [目標に属さない根タスクと、目標に属する根タスクが同じ列に混在すると、帯の有無で見た目の高さが揃わない] → 既存の子タスクでも帯のある/なしは混在しており（目標に属さない枝の子は帯なし文言は出ないが帯自体は出る一方、根タスクは元々全部帯なしだった）、これは仕様上許容されている前提を踏襲する。追加の対処はしない。
- [`goal_name` が `listTasks()` 以外の経路（例: 楽観的更新やローカルキャッシュ）で欠落するとき、根タスクの帯だけ現れたり消えたりする] → 既存の子タスクの帯も同じ `goal_name` フィールドに依存しており、今回新たに生じるリスクではない。

## Migration Plan

不要（フロントエンドの表示ロジックのみの変更、データ移行なし）。
