## 0. 凍結ラインの申し送り

**propose が凍結したもの（apply は触るの禁止）**:

- delta spec 2本（`goal-blueprint` / `task-tree`）
- **`server/src/services/task-tree.test.ts` の末尾に追記した2つの describe**
  （`まとめて追加は取り込み先のノードを選べる` / `getBlueprint は枝への着手の対象件数を返す`）。
  同ファイルの**それ以前の describe は `goal-blueprint-task-tree` が凍結したもの**で、これも触るの禁止。

**`npm test` の現状**: `task-tree.test.ts` が `9 failed | 34 passed (43)`。落ちている9件は
すべて今回追記したもので、内訳は:

| 落ちている理由 | 件数 |
|---|---|
| `importBlueprint` が第4引数（取り込み先の親）を見ていない | 5 |
| `BlueprintNode` に `holdLeafCount` が無い（`undefined`） | 4 |

**この9件が緑になり、既存34件が緑のままであることが実装完了の最低条件**。

このテストが固定している契約:

| 関数 | 何を固定したか |
|---|---|
| `importBlueprint(db, goalId, text, parentTaskId?)` | 第4引数の子孫として足す／省略時は従来どおり根／完了済みの親は `TaskTreeError`／別目標のツリーの親は `TaskTreeError`／ぶら下げた葉は `HOLD` |
| `getBlueprint(db, goalId)` の `nodes[].holdLeafCount` | 自分を含む部分木の中の `HOLD` の葉の数。葉自身は `HOLD` なら 1、そうでなければ 0 |

**変更した既存 e2e**: `e2e/goal-blueprint-task-tree.spec.ts` の1本目
（`設計図でテキストを取り込む → …` → `ツリーを投入する → …`）。

- **理由**: この change はモード切替（`取り込み` ボタン）を撤去するので、その UI を踏む手順は必ず落ちる。
  一方、差し替え後の入力 UI（ノードから開くパネル）の DOM は apply が発明するので、ここで
  セレクタを書くと当てずっぽうになる。そこで**投入を API（`POST /api/goals/:id/blueprint/import`）へ移し**、
  この spec は「ツリーが盤面へどう出るか」だけを見張る形にした。他の3本は API 投入なので無変更。
- 変更後も4本とも緑であることを確認済み（`CI=1 npx playwright test e2e/goal-blueprint-task-tree.spec.ts`）。
- 以降 apply は `e2e/` を触るの禁止。`git diff -- e2e/` が（新規ファイルの追加を除いて）空であること。

**apply が最後に書く新規 e2e が覆うべきフロー**（セレクタではなくフローで指定する）:

1. 「タスク一覧でノードの `＋` から子を1件足す → その場に子が現れ、カンバンの同じ列にカードが出る」
2. 「葉に子を足す → その葉が盤面から消え、子が親のいた列に現れる」（分解の入口がタスク一覧側にもある）
3. 「既存のノードを取り込み先に指定してまとめて追加する → その子孫になり、根に新しい枝が増えない」
4. 「保留の葉を持たない枝には着手の導線が出ない」

## 1. 前提（順序の制約）

- [x] 1.1 `goal-blueprint-task-tree` をアーカイブし、`openspec/specs/goal-blueprint/` と
      `openspec/specs/task-tree/` が存在する状態にする。**これより前にこの change を apply しない**
      （MODIFIED / REMOVED の当て先が無い）

## 2. サーバ（凍結テストを緑にする）

- [x] 2.1 `task-tree.ts` `importBlueprint(db, goalId, text, parentTaskId = null)`: `parentTaskId` が
      あればパース結果の根を `createChildTask(db, parentTaskId, …)` でぶら下げる。完了済みの親の
      拒否は `createChildTask` が既に持っているので**新しい検査を書かない**（design D4）
- [x] 2.2 `importBlueprint`: `parentTaskId` の属するツリーの根の `goal_id` が、この目標の
      lineage root と一致しない場合は `TaskTreeError`（他の目標の枝に紛れ込ませない）
- [x] 2.3 `task-tree.ts` `BlueprintNode` に `holdLeafCount: number` を足し、`build()` の後順走査の
      ついでに積み上げる（葉は `status === 'HOLD' ? 1 : 0`、容れ物は子の合計・design D3）
- [x] 2.4 `POST /api/goals/:id/blueprint/import` が `parentTaskId` を受け取り、`importBlueprint` へ渡す
- [x] 2.5 `api.js` `importGoalBlueprint(goalId, text, parentTaskId)` に引数を足す
- [x] 2.6 `npx vitest run server/src/services/task-tree.test.ts` が 43 件すべて緑になる。
      **テストは1行も変えない**
- [x] 2.7 `npm test` 全体が緑になる

## 3. 画面名の置き換え（design D6）

- [x] 3.1 `goals.js:264` 目標カードのボタン `設計図` → `タスク一覧`
- [x] 3.2 `goals.js:756` レポートからの導線 `設計図を開く` → `タスク一覧を開く`
- [x] 3.3 `blueprint.js:87` 見出し `設計図 — <目標名>` → `タスク一覧 — <目標名>`
- [x] 3.4 `blueprint.js` の空状態の文言を、追加の導線を案内する内容へ変える
      （「取り込み」というモード名を指さない）
- [x] 3.5 `blueprint.js` 冒頭のブロックコメントを更新する
- [x] 3.6 **capability id `goal-blueprint` / ファイル名 `blueprint.js` / CSS 接頭辞 `bp-` は変えない**。
      `grep -rn "設計図" server/static/` が空になることだけ確認する（コメントは除く）

## 4. モード切替の撤去とツリーの編集（design D1・D2・D5）

- [x] 4.1 `blueprint.js` から `S.mode` と `modeToggleEl()` を消し、常に `previewEl()` を出す
- [x] 4.2 `nodeEl()`: タイトルを `<span>` からダブルクリックで編集に入る形へ変える。
      `kanban.js` `cardTitleEl()` の流儀（Enter/blur で確定、Escape で戻す）をそのまま使う
- [x] 4.3 `nodeEl()`: 行に `＋`（子を足す）を**常時表示**で置く。クリックでその行の直下に
      インライン入力を1つ開き、Enter で確定して続けて次の入力を開く。空文字の Enter は
      入力を閉じるだけで何も作らない。Esc で閉じる（design Risks）
- [x] 4.4 子を足したら、その親の id を `S.openSet` に入れてから再描画する
      （追加した子が畳まれて見えなくならないこと・spec「子を足した親は開いたままになる」）
- [x] 4.5 `nodeEl()`: 行ホバーで `⋯` を出し、その中に「まとめて追加」「枝への着手」「枝の打ち切り」
      「削除」を畳む。`branchActionsEl()` の常時2ボタンを撤去する（spec: task-tree）
- [x] 4.6 枝への着手のラベルを `保留の{holdLeafCount}件を未着手へ` にし、`holdLeafCount === 0` なら
      項目自体を出さない
- [x] 4.7 削除を `⋯` に置く。**完了済みまたは子を持つノードの削除には確認を出す**
      （`kanban.js` の `deleteTaskWithConfirm` の流儀・design Risks）
- [x] 4.8 根（目標直下）にも `＋` と「まとめて追加」の導線を置く
- [x] 4.9 「まとめて追加」は、開いた元のノードを取り込み先として渡す（根から開いたら `parentTaskId` 無し）。
      入力欄は共有 Markdown エディタ（`createMarkdownEditor`）のまま使う
- [x] 4.10 デモモードでは追加・改名・削除・`⋯` のいずれも出さない（既存の `S.demo` ガードに揃える）
- [x] 4.11 追加・改名・削除のショートカットやボタンには `attachTooltip` を併記する（プロジェクトルール）

## 5. 見た目

- [x] 5.1 `ref/` にノード行のモックを1枚置き、`＋` と `⋯` の位置・ホバーの出方・
      深い階層での可読性をスクショで確認してから CSS を確定する
- [x] 5.2 `app.css` の `.bp-*` を更新する。フォーマッタをファイル全体にかけない。
      編集後に `git diff --stat -- server/static/css/app.css` の桁を確認する

## 6. 既存 e2e の回帰確認（実装直後・ここで止める）

- [x] 6.1 `$env:CI="1"; npx playwright test e2e/goal-blueprint-task-tree.spec.ts e2e/kanban-*.spec.ts` が
      緑で、かつ `git diff -- e2e/` が空であることを確認する。**落ちた場合は e2e を書き換えず停止**し、
      凍結ラインの投げ返し（1回だけ）としてユーザーへ確認する
      → `openBlueprint()` の `設計図` セレクタが D6 の改名（3.1）と矛盾していたためユーザーへ確認し、
      承認を得て `タスク一覧` へ修正。修正後 29/29 緑、`git diff -- e2e/` は当該1行のみ。

## 7. デモモードで確認（プロジェクトルール）

- [x] 7.1 `PORT=<空きポート> DB_PATH=:memory: npm run server` → `POST /api/demo/reset` で起動し、
      デモの目標からタスク一覧を開いて、編集の導線が1つも出ていないことを確認する
      → Playwright で確認。追加・改名・削除・⋯・root-actions のいずれも出ない。
- [x] 7.2 本番モードで、`＋` から子を足す・改名する・まとめて追加をノード指定で使う、を実際に通す
      → Playwright で確認。ここで根の「＋」が `importGoalBlueprint` 経由だと `parseBlueprintText` の
      連番読み捨てにより先頭が数字のタイトルが壊れるバグを発見（例:「2つ目のタスク」→「つ目のタスク」）。
      設計にない新規エンドポイント `POST /api/goals/:id/blueprint/root` と `createRootTask()` を追加して
      修正（テキストパーサを経由しない単発追加）。凍結された spec/vitest とは無矛盾（frozen set 対象外の
      新規関数）。vitest 3件追加、526件全緑で再検証済み。

## 8. 新規 e2e（DOM ができた後に書く）

- [x] 8.1 §0 に挙げた4フローの e2e を書く。セレクタは実装した DOM から採る
      → `e2e/task-list-inline-edit.spec.ts` に4本追加
- [x] 8.2 `git stash push -- server/` → `$env:CI="1"; npx playwright test e2e/<new-spec>.spec.ts` で
      **落ちること**を確認 → `git stash pop` → 通ることを確認する。`CI=1` は必須
      → 4本とも落ちることを確認 → stash pop → 4本とも通ることを確認（2回実施。1回目で
      「まとめて追加」テストの入力に `-` バレットを付け忘れていたテスト側の誤りを見つけ修正し、
      再度 red→green を確認）
- [x] 8.3 `git diff -- e2e/` に新規ファイルの追加以外の差分が無いことを確認する
      → `e2e/goal-blueprint-task-tree.spec.ts` の承認済み1行のみ。新規ファイルは untracked。
