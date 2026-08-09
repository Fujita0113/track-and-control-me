## 0. 凍結ラインの申し送り

**propose が凍結したもの（apply は触るの禁止）**:

- delta spec 4本（`task-tree` / `goal-blueprint` / `kanban-task-category` / `tomorrow-plan-board`）
- **`server/src/services/task-tree.test.ts`**（新規・赤で置いた）

**`npm test` の現状**: `Test Files 1 failed | 40 passed (41)` / `Tests 478 passed`。
落ちているのは新規の `task-tree.test.ts` 1本だけで、理由は
`Cannot find module './task-tree.js'`（実装がまだ存在しない）。`tsc -p server/tsconfig.json` も
同じ理由に加えて `TaskRow` に `has_children` / `parent_task_id` / `goal_id` / `drop_reason` が
無い旨を出す。**この2つが消えることが実装完了の最低条件**。

このテストが固定している契約（design の関数名と一致させること）:

| 関数 | 置き場所 | 何を固定したか |
|---|---|---|
| `parseBlueprintText(text)` | `task-tree.ts`（純関数・DB非依存） | インデント＝階層／`-`＝タスク／バレット無し＝直前タスクの `notes`／連番読み捨て／段飛ばしは1段扱い |
| `importBlueprint(db, goalId, text)` | `task-tree.ts` | 葉は `HOLD`・追加のみ・空テキストは `TaskTreeError` |
| `getBlueprint(db, goalId)` | `task-tree.ts` | `{ nodes }` を返す。`nodes[].done` は導出／`children` を持つ |
| `computeOpenPath(nodes)` | `task-tree.ts`（純関数） | `number[]` を返す。DOING優先→未完了の最初→全決着なら `[]` |
| `createChildTask(db, parentId, input)` | `task-tree.ts` | 親の列を引き継ぐ／`DONE` の分解は `TaskTreeError` |
| `setParent(db, taskId, parentId)` | `task-tree.ts` | 自己・子孫への付け替えは `TaskTreeError` |
| `startBranch(db, containerId)` | `task-tree.ts` | 配下の `HOLD` の葉だけ `TODO` へ |
| `dropBranch(db, containerId, reason)` | `task-tree.ts` | 理由必須／未完了の葉だけ／完了済みの `drop_reason` は上書きしない |
| `resolveLineageRootGoalId(db, goalId)` | `task-tree.ts` | `continued_goal_id` を遡って根を返す |
| `TaskTreeError` | `task-tree.ts` | 上記の拒否に使う例外型 |
| `listTasks(db)` | `tasks.ts`（既存を拡張） | 行に `has_children: 0|1` / `parent_task_id` / `goal_id` / `drop_reason` が載る |
| `deleteTask(db, id)` | `tasks.ts`（既存を拡張） | 子を消さず親の親へ繰り上げ、根に上がるときは `goal_id` を引き継ぐ |
| `getPlanningSignal(db, day)` | `planning.ts`（既存を修正） | `tomorrowTaskCount` が容れ物を数えない |

**変更した既存 e2e**: なし。**既存 E2E への影響なし** — `kanban-*.spec.ts` /
`tomorrow-plan-*.spec.ts` はどれも親子関係を持つタスクを作らないため、全タスクが
`has_children = 0` の葉になり、盤面の絞り込みは恒等写像になる。`git diff -- e2e/` が
（新規ファイルの追加を除いて）空のまま既存 e2e が緑であることを 6.1 で確認する。

**apply が最後に書く新規 e2e が覆うべきフロー**（セレクタではなくフローで指定する）:

1. 「設計図でテキストを取り込む → カンバンの保留列に葉が並び、容れ物は盤面に出ない」
2. 「カンバンで葉を完了へ → 設計図に戻るとチェックが付いている」
3. 「盤面のカードを分解する → そのカードが消えて子が同じ列に現れる」
4. 「設計図を開くと、進行中の葉に至る枝だけが開いている」

## 1. スキーマ

- [x] 1.1 マイグレーションを追加する: `task` に `parent_task_id INTEGER REFERENCES task(id)` /
      `goal_id INTEGER REFERENCES goal(id)` / `tree_order INTEGER NOT NULL DEFAULT 0` /
      `drop_reason TEXT` の4列と、`idx_task_parent(parent_task_id, tree_order)` /
      `idx_task_goal(goal_id)` の2インデックス（design D1）
- [x] 1.2 `ON DELETE CASCADE` を**付けない**ことを確認する（子の実績が消えるため・design D8）
- [x] 1.3 既存 DB を開いて、既存タスクが全部 `parent_task_id IS NULL` / `goal_id IS NULL` になり
      挙動が変わらないことを確認する

## 2. サービス層（`task-tree.ts` 新規）

- [x] 2.1 `TaskTreeError` と `parseBlueprintText(text)` を書く（純関数・DB非依存・design D9）
- [x] 2.2 `resolveLineageRootGoalId(db, goalId)` を書く。`continued_goal_id` の逆リンクを遡り、
      訪問済み集合で循環を打ち切る（design D2）
- [x] 2.3 `createChildTask(db, parentId, input)` を書く。親が `DONE` なら拒否、`status` 未指定なら
      親の列を引き継ぐ（design D5）
- [x] 2.4 `setParent(db, taskId, parentId)` を書く。自己・子孫・壊れたチェインを拒否（design D6）
- [x] 2.5 `importBlueprint(db, goalId, text)` を書く。`resolveLineageRootGoalId` を通してから
      根に `goal_id` を入れ、葉は `HOLD`。空テキストは拒否
- [x] 2.6 `getBlueprint(db, goalId)` を書く。`listTasks` の全件から1度だけツリーを組み、
      後順走査で `done` を積み上げる（追加クエリなし・design D4）
- [x] 2.7 `computeOpenPath(nodes)` を書く（純関数・design D10）
- [x] 2.8 `startBranch` / `dropBranch` を書く（design D7）
- [x] 2.9 `npx vitest run server/src/services/task-tree.test.ts` が緑になるまで実装する。
      **テストは1行も変えない**

## 3. 既存サービスの修正

- [x] 3.1 `tasks.ts` `TaskRow` に `parent_task_id` / `goal_id` / `tree_order` / `drop_reason` /
      `has_children` を足し、`listTasks` が `EXISTS` で `has_children` を返すようにする（design D3）
- [x] 3.2 `tasks.ts` `deleteTask`: 削除前に子を「削除される行の親」へ繰り上げ、根へ上がる場合は
      `goal_id` を引き継ぐ（design D8）
- [x] 3.3 `tasks.ts` `TaskInput` / `updateTask` が `parent_task_id` / `tree_order` を受け付ける。
      `parent_task_id` の変更は必ず `setParent` の循環検査を通す
- [x] 3.4 `planning.ts`: `tomorrowTaskCount` の SQL から容れ物を除外する
      （`AND NOT EXISTS (SELECT 1 FROM task c WHERE c.parent_task_id = task.id)`）。
      `columnExists` のガードは既存の書き方に合わせる
- [x] 3.5 `npm test` 全体が緑（`Test Files 41 passed`）になることを確認する

## 4. API

- [x] 4.1 `POST /api/tasks` が `parent_task_id` を受け付け、`createChildTask` 経由で作る
- [x] 4.2 `PATCH /api/tasks/:id` が `parent_task_id` / `tree_order` を受け付ける（循環検査つき）
- [x] 4.3 `GET /api/goals/:id/blueprint` を足す。`{ nodes, openPath }` を返す
- [x] 4.4 `POST /api/goals/:id/blueprint/import`（`{ text }`）を足す
- [x] 4.5 `POST /api/tasks/:id/children` / `POST /api/tasks/:id/branch-start` /
      `POST /api/tasks/:id/branch-drop`（`{ reason }`）を足す
- [x] 4.6 `api.js` に上記のクライアント関数を足す

## 5. カンバン側

- [x] 5.1 `kanban.js` `tasksFor(colKey)` と `activeTasks()` が `t.has_children` の立った行を除外する
      （容れ物は盤面に出ない）。アクティビティログ・進捗ドーナツの母数も同じ絞り込みに揃える
- [x] 5.2 `kanban.js` `completedTodayCount()` から `drop_reason` を持つ行を除く
      （「やめた」を「やった」に数えない・design D7）
- [x] 5.3 `cardEl(t)`: 親を持つカードに**直近の親1つだけ**のパンくずチップを出す。
      カテゴリバッジとは別要素で、両方あるとき視覚的に区別できること（spec: kanban-task-category）
- [x] 5.4 カード詳細に「このタスクを分解する」導線を置く（盤面のドラッグ中に暴発しない位置）。
      分解後は親が盤面から消えて子が同じ列に現れることを実機で確認する
- [x] 5.5 `tomorrow-plan.js` も同じ絞り込みを通す。埋め込み盤面とカンバンタブで出るカードの集合が
      食い違わないこと（spec: tomorrow-plan-board の MUST NOT）
- [x] 5.6 分解・完了・復帰のショートカットや新規ボタンを足した場合は `attachTooltip` を併記する
      （プロジェクトルール）

## 6. 既存 e2e の回帰確認（実装直後・ここで止める）

- [x] 6.1 `$env:CI="1"; npx playwright test e2e/kanban-*.spec.ts e2e/tomorrow-plan-*.spec.ts` が緑で、
      かつ `git diff -- e2e/` が空であることを確認する。**落ちた場合は e2e を書き換えず停止**し、
      凍結ラインの投げ返し（1回だけ）としてユーザーへ確認する

## 7. 設計図ビュー

- [x] 7.1 `ref/` に設計図の静的モックを1枚置き、視覚インデントの頭打ち（3段案）とカードの見た目を
      スクショで確認してから CSS を確定する（design Risks / [[reference-impl-in-ref-dir]]）
- [x] 7.2 `blueprint.js` を新設する。プレビュー（階層カード・折りたたみ）と取り込み（テキスト入力）の
      2モード。モード切替でツリーが変化しないこと
- [x] 7.3 プレビューの初期展開は、サーバが返した `openPath` に載っているノードだけを開く。
      手で開閉した状態はメモリにだけ持ち、永続化しない
- [x] 7.4 葉のチェックで完了/未着手をトグルする（`PATCH /api/tasks/:id`）。容れ物のチェックは
      読み取り専用にする
- [x] 7.5 容れ物に「この枝に着手する」「この枝を打ち切る（理由必須）」を置く
- [x] 7.6 `goals.js` `goalCard` に設計図への導線を足す。**開始前の目標でも出す**
      （レポートの導線は出さない）。`renderReport` 本体には触らない
- [x] 7.7 設計図とレポートを行き来できるようにする

## 8. デモモードで成果を出す（プロジェクトルール）

- [x] 8.1 `demo-seed.ts` に設計図のサンプルを足す（2〜3階層・一部完了・進行中の葉を1つ）。
      固定 day_key／固定タイムスタンプを守り、`task` へ直接焼き込む（日々の集計には触れない）
- [x] 8.2 `demo.test.ts` の期待値を更新する。既存の筋書き（達成 24/30・中盤の谷）を壊さないこと
- [x] 8.3 `PORT=<空きポート> DB_PATH=:memory: npm run server` → `POST /api/demo/reset` で起動し、
      デモの目標から設計図を開いて「進行中の葉に至る枝だけが開いている」ことを目視で確認する
- [x] 8.4 デモのカンバンで容れ物が盤面に出ず、葉にパンくずが出ていることを確認する

## 9. 新規 e2e（DOM ができた後に書く）

- [x] 9.1 §0 に挙げた4フローの e2e を書く。セレクタは実装した DOM から採る
- [x] 9.2 `git stash push -- server/` → `$env:CI="1"; npx playwright test e2e/<new-spec>.spec.ts` で
      **落ちること**を確認 → `git stash pop` → 通ることを確認する。`CI=1` は必須
      （無いと `reuseExistingServer` が起動済みサーバを使い回して偽の緑になる）
- [x] 9.3 `git diff -- e2e/` に新規ファイルの追加以外の差分が無いことを確認する
