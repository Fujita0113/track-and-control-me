## Context

`task` は完全にフラットで、親子も目標との紐付けも持たない（`server/src/db/migrations.ts:306` ＋ 後続の `ALTER TABLE`: `priority` / `due` / `notes` / `due_locked` / `category_*`）。カンバンは `S.tasks` 全件を `status` で4列に振り分けるだけ（`kanban.js:203-213` の `normStatus` / `tasksFor`）。

分かっている足場:

- **完了はアーカイブであって削除ではない**。`DONE` に落ちると盤面から消えてアクティビティログへ移るだけで、`task` 行は残る（`kanban-restore-archived` の「復帰専用の DB スキーマ追加は行わない」）。つまり**カンバンで完了させてもツリーのノードは消えない**。この前提が崩れていたら設計ごと成立しない。
- タスクを読むのは `GET /api/tasks`（`planning.ts:107`）1本で、消費者は `kanban.js` と `tomorrow-plan.js` の2つだけ（`api.js:77`）。容れ物を隠す場所は2箇所で済む。
- `task.notes` は既に Markdown ノートで、カンバンのカード詳細が編集している。設計図の「テキストテキスト」はこれをそのまま使えるので**新カラム不要**。
- PLANNING シグナルは `task` を直接 SQL で数えている（`planning.ts:50`: `SELECT COUNT(*) ... WHERE (planned_for = ? OR due = ?) AND status <> 'DONE'`）。ここは解錠ゲートの条件なので、容れ物が混ざると水増しになる。
- 完走フォークは `goal.continued_goal_id` で新しい `goal` 行を連結する（`migrations.ts` v22）。

## Goals / Non-Goals

**Goals:**

- 深さ無制限のタスクツリーを `task` の3列追加だけで導入する（新テーブルを作らない）
- 葉だけを盤面に出し、容れ物の完了は導出する
- 目標ごとの設計図ビュー（プレビュー／取り込み）を、レポートに触れずに新設する
- テキスト取り込みを一方向に限定して、双方向同期の破壊を構造的に不可能にする

**Non-Goals:**

- 設計図の進捗をレポートに載せる（`goal-report` は無改造）
- ツリーのドラッグ&ドロップ再親付け **UI**（`setParent` の API と循環検査は作るが、UI は別 issue）
- 目標に紐づかないツリーを見るための「全体設計図」画面（データ上は作れるが、入口は目標ごとだけ）
- カンバンの列構成・アーカイブ・復帰の仕組みの変更

## Decisions

### D1. 新テーブルではなく `task` に3列足す

```sql
ALTER TABLE task ADD COLUMN parent_task_id INTEGER REFERENCES task(id);
ALTER TABLE task ADD COLUMN goal_id INTEGER REFERENCES goal(id);
ALTER TABLE task ADD COLUMN tree_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task ADD COLUMN drop_reason TEXT;   -- 非 NULL = 打ち切り（D7）
CREATE INDEX idx_task_parent ON task(parent_task_id, tree_order);
CREATE INDEX idx_task_goal ON task(goal_id);
```

既存行はすべて `parent_task_id IS NULL` / `goal_id IS NULL` になり、根かつ目標なし＝**現状とまったく同じ挙動**になる。マイグレーションにデータ移行は無い。

- **代替案（`goal_node` テーブル ＋ `task.node_id`）を採らない理由**: 中目標と小目標が別の器になると、「1.1 をさらに割りたくなった」ときに小目標を中目標へ**昇格**させる操作が要る。器が1つなら子を作るだけで済む。issue の「階層が何階で止まるか分からない」がそのまま器の形を決めている。
- `goal_id` は**根にだけ**入れる（子は親を辿れば分かる）。冗長に全ノードへ配ると、枝ごと別の目標へ移したときに更新漏れが起きる。

### D2. `goal_id` は継続チェインの根へ正規化してから書く

`resolveLineageRootGoalId(db, goalId)` を1本置き、`continued_goal_id` の逆リンクを遡って根を返す。設計図の読み書きは**必ずこれを通す**。

`continued_goal_id` は「親 → 子」向きなので、根を求めるには `SELECT id FROM goal WHERE continued_goal_id = ?` を繰り返す。チェインが壊れて循環していた場合に無限ループしないよう、訪問済み集合で打ち切る（防御。実際には作られないはず）。

- **代替案（新しい目標を作るときに設計図を複製する）を採らない理由**: 同じツリーが2本になり、どちらのカードがカンバンに出るのか決まらない。

### D3. 「葉か容れ物か」はサーバが `has_children` として返す

`listTasks` の返す行に `has_children: 0|1` を足す（`LEFT JOIN` の `EXISTS` で1クエリ）。クライアントは `t.has_children` を見るだけ。

- **代替案（クライアントが全件から `parent_task_id` の集合を作る）を採らない理由**: 消費者が `kanban.js` と `tomorrow-plan.js` の2つあり、両方に同じ導出を書くことになる。片方だけ直し忘れると盤面の集合が食い違う（`tomorrow-plan-board` の MUST NOT）。
- `listTasks` は**全件を返し続ける**（フィルタしない）。設計図は容れ物も要るし、アクティビティログは `DONE` も要る。盤面の絞り込みは表示側の責務。

### D4. 完了の導出は「子孫の葉がすべて決着済みか」

```
isSettled(leaf)      = status === 'DONE'        // 打ち切りも DONE なので含まれる（D7）
isSettled(container) = 子孫の葉が1つ以上あり、そのすべてが isSettled
```

木である以上、容れ物の子孫を辿れば必ず葉に行き着くので「葉を1つも持たない容れ物」は存在しない（子を持つ＝容れ物、持たない＝葉、という定義そのものから）。導出は下から素直に積み上がる。

再帰は SQL の再帰 CTE ではなく **TypeScript 側で1度だけツリーを組んで後順走査**する。タスク総数はたかだか数百で、`listTasks` が既に全件を返しているため追加クエリはゼロ。

### D5. 分解の規則は `createTask` ではなく専用の入口に置く

`createChildTask(db, parentId, input)` を新設する。ここで、

- 親が `DONE` なら `TaskTreeError('完了済みのタスクは分解できません')` を投げる（spec）
- 子の `status` は指定が無ければ**親の `status` を引き継ぐ**（spec）
- 親が葉だった場合、この瞬間に容れ物になる。親の `sort_order` は触らない（盤面から消えるだけで、葉に戻ったときに元の位置へ帰れる）

`POST /api/tasks` に `parent_task_id` を渡す経路も同じ関数を通す。規則を1箇所に閉じる。

### D6. 循環検査は「付け替え先の祖先に自分がいないか」

`setParent(db, taskId, parentId)`:

1. `parentId === taskId` なら拒否
2. `parentId` から `parent_task_id` を根まで遡り、途中に `taskId` が出たら拒否
3. 遡る途中で訪問済みに戻ったら（既存データが壊れている）拒否

深さ無制限なので、遡りにも訪問済み集合で上限をかける。

### D7. 打ち切りは `status='DONE'` ＋ `drop_reason` 非 NULL

新しい `status` 値を増やすと、`normStatus`・4列の振り分け・アーカイブ・復帰・`archivedCount`・PLANNING の `status <> 'DONE'` の全部に分岐が増える。`DONE` に寄せれば、

- 盤面から外れる … 既存の `DONE` の扱いでタダで手に入る
- 決着済みとして数える … `isSettled` は `status === 'DONE'` を見るだけ
- 完了と区別できる … `drop_reason` が非 NULL かどうか

`dropBranch(db, containerId, reason)` は**未完了の子孫の葉だけ**を対象にし、既に `DONE` の葉には `drop_reason` を書かない（spec の MUST NOT）。`done_at` は打ち切った時刻を入れる。

- [`completedTodayCount()` が打ち切りぶんだけ増えてしまう] → 表示側で `drop_reason` を持つものを除く。カンバンの進捗ドーナツで「やめた」が「やった」に数えられるのは事実に反する。

### D8. 削除は子を繰り上げる

`deleteTask` を、削除前に `UPDATE task SET parent_task_id = <消す行の parent_task_id> WHERE parent_task_id = <消す行>` してから消すように変える。`ON DELETE CASCADE` は**付けない**（子の実績が消える）。

根を消したときは子が根に繰り上がる。そのとき子の `goal_id` に、消える親の `goal_id` を配る（設計図から丸ごと抜け落ちないように）。

### D9. 取り込みパーサは純関数で切り出す

`parseBlueprintText(text: string): ParsedNode[]`（`ParsedNode = { title, notes, children }`）を DB に触れない純関数として `task-tree.ts` に置く。テストしやすく、文法の議論をここだけに閉じられる。

- インデント幅は「そのテキストで最初に現れたインデント量」を1段とする。タブ・スペース混在は、タブを1段ぶんとして扱う
- `-`（および `*`）で始まる行がタスク。行頭の連番 `^\d+(\.\d+)*\.?\s*` はタイトルから除去
- バレット無しの行は、**直前に確定したタスク**の `notes` へ改行連結。まだタスクが1つも無い状態でバレット無しの行が来たら**無視**する（先頭の見出し行などを黙って捨てる）
- インデントが1段より深く飛んだ場合（1段目の次が3段目）は、**1段だけ深いものとして扱う**（拒否しない。手書きテキストのブレを許容する）

`importBlueprint(db, goalId, text)` が `parseBlueprintText` の結果を `createChildTask` 経由で書き込む。葉は `status: 'HOLD'`。

### D10. 設計図ビューは新規ファイル、レポートには触らない

`server/static/js/blueprint.js` を新設し、`goals.js` からは「設計図を開く」導線だけを足す（`goalCard` にボタンを1つ、`renderReport` の戻り先と行き来）。`goals.js` の `renderReport` 本体には触らない。

展開規則（`goal-blueprint` の「現在地までのパス」）は**フロントに書かない**。`task-tree.ts` の純関数 `computeOpenPath(nodes): number[]` として持ち、`GET /api/goals/:id/blueprint` のレスポンスに `openPath` として同梱する。

- **理由**: vitest の対象は `server/src/**` なので（`vitest.config.ts`）、この規則をフロントに置くと**赤で凍結できるテストが1本も書けない**。「決定的であること」を要求している規則を、機械で確かめられない場所に置くのは筋が悪い。
- フロント（`blueprint.js`）は `openPath` に載っているノードを開いた状態で描くだけ。手で開閉した状態はフロントのメモリにだけ持ち、永続化しない（spec）。

### D11. API

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/api/goals/:id/blueprint` | ツリー（`has_children`・導出完了・`notes` 込み）を返す。`:id` はチェインのどの目標でもよい |
| `POST` | `/api/goals/:id/blueprint/import` | `{ text }` を取り込む |
| `POST` | `/api/tasks/:id/children` | 1件だけ分解して子を作る |
| `POST` | `/api/tasks/:id/branch-start` | 枝への着手（配下の `HOLD` の葉を `TODO` へ） |
| `POST` | `/api/tasks/:id/branch-drop` | 枝の打ち切り（`{ reason }` 必須） |
| `PATCH` | `/api/tasks/:id` | 既存。`parent_task_id` / `tree_order` を受け付けるよう拡張（循環検査を通す） |

`GET /api/tasks` はレスポンスに `parent_task_id` / `goal_id` / `tree_order` / `drop_reason` / `has_children` が増えるだけで、既存の消費者は無視すればよい（前方互換）。

## Risks / Trade-offs

- [容れ物を盤面から隠す変更が、既存 e2e の「作ったカードが盤面に出る」前提を壊す] → 既存 e2e（`kanban-*.spec.ts` / `tomorrow-plan-*.spec.ts`）は**どれも親子関係を作らない**。作られるタスクはすべて `has_children = 0` の葉になり、盤面の絞り込みは恒等写像になる。実装前に playwright を走らせても「まだ何も変わっていない状態」を測るだけで、この主張の裏は取れない。したがって**確認は apply の実装直後に置く**（`git diff -- e2e/` が空のまま既存 e2e が緑であること）。もし落ちたら、それは凍結ラインの投げ返し対象（1回だけ）になる。
- [設計図とカンバンの二重管理になり、設計図が腐る] → 設計図は**計画時に書いて、以後は読む**面と割り切る。日々の移動はカンバンのままで、設計図は同じ行を別の見え方で見せているだけなので、腐りようがない（写しを持たない・spec）。
- [分解でカードが盤面から消える体験が唐突] → 子が親の列を引き継ぐ（D5）ので、同じ列に子が現れる形になる。加えて分解の導線をカード詳細の中に置き、盤面のドラッグ中に暴発しないようにする。
- [深いツリーをインデントで描くと横幅が死ぬ] → 視覚的なインデントは3段で頭打ちにし、それ以上はパンくずで表現する。実値は `ref/` の静的モックで確認してから決める（[[reference-impl-in-ref-dir]]）。
- [`drop_reason` を `DONE` に相乗りさせたことで、完了系の集計に「やめた」が混ざる] → 混ざる箇所は `completedTodayCount()` と `archivedCount()` の2つだけ。前者は除外する（D7）。後者はアーカイブ件数なので混ざってよい。
- [PLANNING シグナルの変更が解錠ゲートの挙動を変える] → 変わるのは「容れ物が翌日の期限を持っていた場合」だけで、この change 以前には容れ物が存在しないため、**既存データでは挙動が1ミリも変わらない**。それでも vitest で固定する。
- [日数の絡む機能なのでデモモードでの提示が要る] → `demo-seed.ts` に2〜3階層・一部完了の設計図サンプルを足し、`demo.test.ts` の期待値を更新する。既存の筋書き（達成 24/30・中盤の谷）を壊さないよう、タスクは `task` テーブルへ直接焼き込むだけで日々の集計には触れない。

## Migration Plan

1. マイグレーション（4列＋2インデックス）を足す。既存行は全部根＝挙動不変
2. サーバ側（`task-tree.ts` ＋ `tasks.ts` ＋ `planning.ts` ＋ ルート）
3. カンバン側の絞り込みとパンくず（ここで初めてユーザーに見える変化が出る）
4. 設計図ビュー
5. デモサンプル

巻き戻しは、3列＋`drop_reason` を無視すれば旧挙動に戻る（列を落とす必要はない）。

## Open Questions

- 設計図から葉に**カテゴリ**（`kanban-task-category`）を付けられるようにするか。付けられないと、設計図由来のカードだけカテゴリ無しで盤面に並ぶ。実装しながら見て判断する（付けるなら既存のカテゴリ選択 UI の再利用）。
- 「この枝に着手する」を**枝を開いたときに自動でやる**か、明示のボタンにするか。自動だと展開しただけで盤面が動くので、まずは明示のボタンで作る。
- 視覚インデントの頭打ちを3段にするかどうかは `ref/` のモック待ち。
