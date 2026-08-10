## Why

`task-list-inline-edit` でタスク一覧は「常に編集できる面」になったが、**編集の入口がすべてマウス**に寄っている。行にホバーして `＋` を押し、インライン入力へ1件打ち、Esc で閉じ、また次の行へホバーする。骨組みを一気に組む作業には手数が多すぎる。階層を後から変える手段に至っては**画面に無い**（`setParent` は循環検査つきで実装済みなのに UI が付いていない）。

見た目の側も、行が背景色のホバーだけで区切られているため、**どこを触っているのか・全体がどこまで進んだのか**が読めない。進捗の総量を示すものが1つも無い。

Claude Design プロジェクト「プロジェクト進捗管理UI改修」（`Task Tree.dc.html`）で、この2点に答えるモックを作った。実際に動く試作で、**アウトライナーのキーボード操作**（Enter で兄弟・Tab で1段深く・Shift+Tab で1段浅く・Alt+C で完了・↑↓ で移動・Ctrl+Enter で詳細）と、**カード型の行・選択枠・進捗バー**を持つ。カンバン側も同じモックで、カード上端の色付き帯に「目標 / 親タスク」を出して、盤面のカードがどの枝のものか一目で分かる形にした。

これを現物の仕様として取り込む。

## What Changes

- **BREAKING（操作）**: タスク一覧を**キーボードで組める面**にする。`Enter` 兄弟追加 / `Tab` 1段深く / `Shift+Tab` 1段浅く / `Alt+C` 完了 / `↑↓` 選択移動 / `Ctrl+Enter` 詳細を開く。画面下部に凡例の帯を置き、対応する UI 要素には `attachTooltip` を併記する。
- **BREAKING（操作）**: ノードのタイトルを**常時編集できる `<input>`** にする。ダブルクリックで編集に入る流儀（`task-list-inline-edit` で入れたばかり）をやめる。
- **BREAKING（画面構成）**: 行ホバーの **`＋` を撤去し、`⋯` は削除専用にする**。これに伴い、行から開いていた「まとめて追加（取り込み先の指定）」「枝への着手」「枝の打ち切り」の導線が画面から無くなる。
  - まとめて追加はヘッダ右上へ移し、**根に足す**形に戻す。既存の枝へ入れたいときは、足してから `Tab` で潜らせる（`task-list-inline-edit` が解こうとした「既存の枝を伸ばせない」問題は、取り込み先の指定ではなく階層操作で解く）。
  - **枝への着手・枝の打ち切りは、タスク一覧から操作できなくなる**。サービスと API は残すが導線は無い。
  - **削除だけは `⋯` に残す**。容れ物はカンバンに出ないため、ツリーから消せないとアプリのどこからも消せなくなる。ほかの操作と違い代わりの入口が無い。
- **BREAKING（挙動）**: **容れ物のチェックボックスを押せるようにする**。チェックすると配下の葉がまとめて完了になり、外すと未着手へ戻る。`task-tree` の「容れ物は手で完了にできない」を改める。ただし**打ち切り済みの葉は動かさない**（決着済みのため）。
- タスク一覧に**進捗バーと「N / M 完了」**を出す。分母は葉の数。容れ物の行には右端に `完了数/葉数` を出す。
- ノードの**詳細をモーダルで開く**（`Ctrl+Enter`）。パンくずとタイトルのヘッダ、全面の Markdown 本文（`task.notes`）、`Esc` で閉じる。入力の流儀は既存の `md-editor.js` に揃える。
- カンバンのカードのパンくずを、**カード上端いっぱいの色付き帯**にする。`目標名 / 直近の親名` の2階層とフォルダ型アイコンを持ち、**根の枝ごとに色が変わる**。
- **スコープ外**: ドラッグによる並べ替え（モックの凡例にはあるが今回は入れない・別 change）。

## Capabilities

### New Capabilities

（なし。`goal-blueprint` / `task-tree` の要件変更のみ）

### Modified Capabilities

- `goal-blueprint`: カード型ツリーの視覚要件、キーボード操作一式、常時編集のタイトル、進捗の提示、詳細モーダル、まとめて追加の取り込み先指定の撤去、`⋯` を削除専用にすること
- `task-tree`: 容れ物の完了（部分木の一括完了）、階層のその場での付け替え、カードのパンくず帯（目標名・色）、枝の操作の UI 要件の撤去

## Impact

- **順序の制約**: この change は `task-list-inline-edit` の delta を土台にしている。**先に `task-list-inline-edit` をアーカイブして** `openspec/specs/goal-blueprint` / `openspec/specs/task-tree` へ sync してからでないと、ここの MODIFIED / REMOVED は当てる先が無い（`openspec/specs/goal-blueprint/spec.md` は今なお「プレビュー / 取り込みの切替」時代の内容）。前回 `goal-blueprint-task-tree` で踏んだのと同じ罠。
- **サーバ（新規）**:
  - `task-tree.ts` `setTreePosition(db, taskId, { parentId, afterTaskId })` … `Tab` / `Shift+Tab` の当たり先。`setParent` の循環検査を通し、根へ戻る場合は祖先チェインから `goal_id` を継ぐ。部分木ごと動く。
  - `task-tree.ts` `createSiblingTask(db, taskId, title)` … `Enter` の当たり先。対象の**部分木の直後**に同じ深さで1件。
  - `task-tree.ts` `setSubtreeDone(db, taskId, done)` … 容れ物のチェックと `Alt+C` の当たり先。打ち切り済みの葉は動かさない。
  - `tasks.ts` `listTasks` に `root_task_id` と `goal_name` を足す（再帰 CTE）。カンバンの帯が使う。**現状カンバンには目標の情報が1つも渡っていない**（`kanban.js` に `goal` の語が1つも無い）。
  - `planning.ts` に `POST /api/tasks/:id/siblings` と `PATCH /api/tasks/:id/tree-position` と `POST /api/tasks/:id/subtree-done`
- **フロント**: `server/static/js/blueprint.js`（ほぼ全面。カード行・キーボード・進捗・詳細モーダル）、`server/static/js/kanban.js` `parentBreadcrumbEl()`（帯化）、`server/static/js/api.js`、`server/static/css/app.css` の `.bp-*` と `.kb-breadcrumb`（**1ルール1行の書式を厳守**）
- **既存 e2e**: `e2e/goal-blueprint-task-tree.spec.ts` と `e2e/task-list-inline-edit.spec.ts` が、撤去される `＋`、中身が入れ替わる `⋯` のメニュー項目、`.bp-node-title`（span → input）、`.bp-checkbox`（checkbox → button）を踏んでいる。この change で直す。
- **参照実装**: `ref/goal-blueprint/task-tree-mock.html`（t1）と `ref/goal-blueprint/kanban-crumb-mock.html`（t2）に design doc を写し、spec の視覚要件をそこへ紐づける。
