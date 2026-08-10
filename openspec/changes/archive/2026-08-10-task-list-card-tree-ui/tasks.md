## 0. 凍結ラインの申し送り

**propose が凍結したもの（apply は触るの禁止）**:

- delta spec 2本（`goal-blueprint` / `task-tree`）
- **`server/src/services/task-tree.test.ts` の末尾に追記した4つの describe**
  （`createSiblingTask: …` / `setTreePosition: …` / `setSubtreeDone: …` / `listTasks は根の枝と目標名を返す`）。
  同ファイルの**それ以前の describe は過去の change が凍結したもの**で、これも触るの禁止。
- **`ref/goal-blueprint/task-tree-mock.html` と `ref/goal-blueprint/kanban-crumb-mock.html`**（見た目の正典）

**`npx vitest run server/src/services/task-tree.test.ts` の現状**: `24 failed | 46 passed (70)`。
落ちている24件はすべて今回追記したもので、内訳は:

| 落ちている理由 | 件数 |
|---|---|
| `createSiblingTask` が存在しない | 5 |
| `setTreePosition` が存在しない | 7 |
| `setSubtreeDone` が存在しない | 7 |
| `listTasks` の行に `root_task_id` / `goal_name` が無い | 5 |

**この24件が緑になり、既存46件が緑のままであることが実装完了の最低条件**。

このテストが固定している契約:

| 関数 | 何を固定したか |
|---|---|
| `createSiblingTask(db, taskId, title)` | 同じ親の**直後**に入る／対象の `status` を継ぐ／根の兄弟は根になり継続チェインの根の目標を継ぐ／存在しない対象は `TaskTreeError` |
| `setTreePosition(db, taskId, { parentId, afterTaskId })` | `parentId` 指定で新しい親の**末尾**の子／子孫は一緒に動く／`afterTaskId` 指定でその**直後**に並ぶ／`parentId: null` で根になり祖先の目標を継ぐ／自分自身・自分の子孫は `TaskTreeError`／存在しない対象は `TaskTreeError` |
| `setSubtreeDone(db, taskId, done)` | 部分木の葉を一括で `DONE` / `TODO`／**打ち切り済みの葉は両方向で不動**／葉なら自分だけ／容れ物の完了は導出のまま／存在しない対象は `TaskTreeError` |
| `listTasks(db)` の行 | `root_task_id`（根自身は自分・同じ枝の葉は同じ値）と `goal_name`（継続チェインの根の目標名・目標に属さなければ `null`） |

**API の口は凍結していない**（前回 change の `POST /api/goals/:id/blueprint/import` と同じ扱い）。
design.md D4 / D5 / D6 が名前と形を決めているので、そこへ揃える。

### 変更した既存 e2e

**`e2e/goal-blueprint-task-tree.spec.ts`**: 4本 → 2本にした。

- **残した2本**（カンバン側なので推測要素が少ない）
  - `ツリーを投入する → カンバンの保留列に葉が並び、容れ物は盤面に出ない`
    … タスク一覧側の `.bp-node-title` の assertion を「見出しに目標名が出る」へ替えた。
      タイトルが `<span>` から常時編集の `<input>` に変わり、`hasText` が成立しなくなるため。
  - `盤面のカードを分解する → そのカードが消えて子が同じ列に現れる`
    … `.kb-breadcrumb-text` を `.kb-breadcrumb` + `toContainText` へ緩めた。帯になって
      目標名の要素が増えるため、内側の分割には踏み込まない。
- **外した2本**（タスク一覧の DOM しか踏んでいない）
  - `カンバンで葉を完了へ → 設計図に戻るとチェックが付いている`
    … `.bp-checkbox` が `<input type=checkbox>` から `<button>` になり `toBeChecked` が成立しない。
      挙動は vitest `has_children と完了の導出` が押さえている。
  - `設計図を開くと、進行中の葉に至る枝だけが開いている`
    … 全 assertion が `.bp-node-title` の `hasText`。挙動は vitest
      `computeOpenPath: 現在地までの祖先だけを開く` が押さえている。

**`e2e/task-list-inline-edit.spec.ts`**: **削除した**（未コミットの新規ファイルだった）。
4本すべてが今回撤去・作り替えする DOM（`.bp-node-add-btn` / `.bp-menu-item` / `＋ 新しい枝を足す`）を
踏んでおり、うち2本は**踏んでいる振る舞い自体が無くなる**（「ノード指定のまとめて追加」は REMOVED、
「`⋯` の着手の導線が出ない」は `⋯` が削除専用になるので `.bp-menu-item` の中身ごと変わる）。
残る2本のフローは下の新規 e2e のリストへ引き継いだ。

**apply は `e2e/` を触るの禁止**（§8 で新規 spec を書くときを除く）。`git diff -- e2e/` に
上記2ファイル以外の差分が出ていないこと。

### apply が最後に書く新規 e2e が覆うべきフロー（セレクタではなくフローで指定する）

1. 「空のツリーで `Enter` を続けて押し、マウスを使わずに3件を同じ深さで打ち込む」
2. 「2件目で `Tab` を押す → 1件目の子になり、1件目が容れ物になって盤面から消え、
   2件目が1件目のいた列にカードとして現れる」（＝タスク一覧側からの分解の入口）
3. 「子で `Shift+Tab` を押す → 親と同じ深さになり、**親の直後**に並ぶ」
4. 「容れ物のチェックを付ける → 配下の葉が全部完了になり、盤面から消える。外すと未着手列へ戻る」
5. 「`Ctrl+Enter` で詳細モーダルが開き、本文を書いて閉じる → カンバンの同じカードの
   ノートに同じ本文が出ている」
6. 「カンバンのカードの帯に目標名と直近の親が出る。同じ枝の2枚は同じ色、別の枝は別の色」
7. 「行にホバーして `⋯` を開くと**削除だけ**があり、枝への着手・打ち切り・まとめて追加は入っていない。
   子を持つノードを削除すると確認が出て、消しても子は繰り上がって残る」
8. 「デモモードでは追加・改名・階層の変更・完了の切り替え・`⋯` のいずれも出ない」

## 1. 前提（順序の制約）

- [x] 1.1 `task-list-inline-edit` をアーカイブし、`openspec/specs/goal-blueprint/spec.md` に
      「タスク一覧のツリーはその場で編集できる」「まとめて追加は取り込み先のノードを選べる」が、
      `openspec/specs/task-tree/spec.md` に更新後の「枝への着手と、枝の打ち切り」が
      存在する状態にする。**これより前にこの change を apply しない**（MODIFIED / REMOVED の当て先が無い）

## 2. サーバ（凍結テストを緑にする）

- [x] 2.1 `task-tree.ts` `createSiblingTask(db, taskId, title)`（design D5）。対象が根なら
      `createRootTask` 相当（祖先の `goal_id` を継ぐ）、そうでなければ同じ親の子。
      **`tree_order` は対象の直後**に割り込ませる。`status` は対象から継ぐ
- [x] 2.2 `task-tree.ts` `setTreePosition(db, taskId, { parentId, afterTaskId })`（design D4）。
      `parentId` が非 `null` のときは**必ず `setParent` の循環検査を通す**（新しい循環検査を書かない）。
      `afterTaskId` は `tree_order` の採番だけに使う
- [x] 2.3 `setTreePosition` で `parentId: null`（根へ戻す）のとき、移動前の祖先チェインを辿って
      根の `goal_id` を継ぐ。**目標を持たない根を作らない**（作るとタスク一覧から消える・design Risks）
- [x] 2.4 `task-tree.ts` `setSubtreeDone(db, taskId, done)`（design D6）。部分木の**葉**だけを
      1つの `UPDATE` で切り替える。`drop_reason` が非 NULL の葉は **`WHERE` 句で除外**する
- [x] 2.5 `tasks.ts` `listTasks` に再帰 CTE で `root_task_id` を足し、根の `goal_id` から
      `goal_name` を LEFT JOIN する（design D3）。`TaskRow` に両方の型を足す
- [x] 2.6 `task(parent_task_id)` の索引の有無を確認し、無ければマイグレーションで足す（design Risks）
- [x] 2.7 `npx vitest run server/src/services/task-tree.test.ts` が 70 件すべて緑になる。
      **テストは1行も変えない**
- [x] 2.8 `npm test` 全体が緑になる

## 3. API（design D4・D5・D6）

- [x] 3.1 `planning.ts` `POST /api/tasks/:id/siblings` … `{ title }` を受け、`createSiblingTask` を呼ぶ
- [x] 3.2 `planning.ts` `PATCH /api/tasks/:id/tree-position` … `{ parentId, afterTaskId }` を受け、
      `setTreePosition` を呼ぶ。`TaskTreeError` は既存の流儀どおり 4xx で返す
- [x] 3.3 `planning.ts` `POST /api/tasks/:id/subtree-done` … `{ done }` を受け、`setSubtreeDone` を呼ぶ
- [x] 3.4 `api.js` に `createSiblingTask` / `setTaskTreePosition` / `setSubtreeDone` を足す

## 4. タスク一覧の作り替え（design D7・D9・D10）

- [x] 4.1 `blueprint.js` から `S.addTarget` / `S.bulkTarget` / `S.menuOpenId` / `S.renamingId` を捨て、
      `S.selId`（選択中のノード id）と `S.caret`（キャレット位置）を持つ形へ置き換える
- [x] 4.2 `nodeEl()`: 行を**カード**にする。キャレット → チェック（`<button>`）→ タイトル（常時 `<input>`）
      → 容れ物なら `完了数/葉数` の順。選択行に選択のクラスを付ける（spec: カード型のツリー）
- [x] 4.3 タイトルの確定: `blur` と `Enter` で保存。**無変更なら投げない・空文字は元の値へ戻す・
      IME 変換中の `Enter`（`e.isComposing` / `keyCode === 229`）は握り潰す**（design D7）
- [x] 4.4 チェック: 葉・容れ物とも `POST /api/tasks/:id/subtree-done` を叩く。デモモードでは出さない
- [x] 4.5 キーボード: `Enter` / `Tab` / `Shift+Tab` / `Alt+C` / `↑↓` / `Ctrl+Enter`（spec: キーボードだけで組める）。
      `Tab` は**直前の兄弟が無ければ何もしない**、`Shift+Tab` は**根なら何もしない**（どちらもエラーにしない）
- [x] 4.6 再描画のたびに、選択中のノードへフォーカスとキャレットを戻す（design D9・
      spec「編集の直後はいま触っているノードにフォーカスとキャレットが戻る」）
- [x] 4.7 階層を動かしたら、移動先の祖先を `S.openSet` に入れてから再描画する
      （spec「1段深くしたノードは見えたままになる」）
- [x] 4.8 ヘッダを「小見出し＋目標名の h1」＋右上「まとめて追加 / レポートを開く」にする。
      **まとめて追加は根に足す**（`parentTaskId` を渡さない・spec: REMOVED の Migration）
- [x] 4.9 進捗バーと `N / M 完了`。分母は**葉の数**。葉0件でも `NaN` を出さない（spec: 葉の数で進捗を示す）
- [x] 4.10 ツリー末尾の**破線の追加ボタン**と、最下部の**ショートカット凡例の帯**
- [x] 4.11 `＋`（`bp-node-add-btn`）と `＋ 新しい枝を足す`（`bp-root-actions`）を削除する。
      `grep -n "bp-node-add-btn\|bp-root-actions"` が空になること
- [x] 4.12 `⋯`（`bp-node-menu-btn` / `bp-menu`）は**削除だけを持つ1項目のメニュー**として残す（design D10）。
      「まとめて追加」「保留の N 件を未着手へ」「この枝を打ち切る」の3項目を消す。
      行ホバーで現れる既定の出方（`opacity: 0` → `.bp-node-row:hover` で 1）はそのまま
- [x] 4.13 削除は現行どおり、**完了済みまたは子を持つノードのときだけ確認を挟む**
      （`kanban.js` の `deleteTaskWithConfirm` の流儀）。削除後は `S.openSet` から id を落とす
- [x] 4.14 空状態の文言を「Enter で足して Tab で潜らせる」と読める内容にする（design Risks）
- [x] 4.15 チェック・キャレット・追加ボタン・`⋯` に `attachTooltip(el, { label, keys })` を併記する（プロジェクトルール）
- [x] 4.16 デモモードでは追加・改名・階層の変更・完了の切り替え・`⋯` のいずれも出さない（既存の `S.demo` ガードに揃える）

## 5. 詳細モーダル（design D8）

- [x] 5.1 `Ctrl/⌘+Enter` で開くモーダル。ヘッダに `目標名 › 祖先 › …` のパスとタイトル、右に閉じるボタン
- [x] 5.2 本文は `createMarkdownEditor`（`md-editor.js`）を埋める。**モックの `editorKey()` を移植しない**
      （同じ挙動が既にある）
- [x] 5.3 `Escape` で閉じる。閉じるとき本文を `PATCH /api/tasks/:id` で保存する
- [x] 5.4 モーダルを開いたまま `↑↓` で対象を移動する挙動は**入れない**（design D8）
- [x] 5.5 開閉のショートカットに `attachTooltip` を併記する

## 6. カンバンのパンくず帯（design D1・D2・D3）

- [x] 6.1 `kanban.js` `parentBreadcrumbEl(t)` を帯にする。`t.goal_name` があれば
      `目標名` + 区切り + `直近の親名`、無ければ**親だけ**（区切りも出さない）
- [x] 6.2 帯を `cardEl()` の**最上段**（`.kb-card-top` より前）へ移す（spec: 帯はカードの最上段）
- [x] 6.3 色は `t.root_task_id % 3` で3色のパレットから決定的に引く（design D2）。
      並べ替えや完了で変わらないこと
- [x] 6.4 フォルダ型アイコン（`clip-path`）を帯の左に置く。`ref/goal-blueprint/kanban-crumb-mock.html` の値に合わせる
- [x] 6.5 `.kb-breadcrumb` のクラス名は**残す**（既存 e2e が踏んでいる）。内側の分割は自由

## 7. 見た目（app.css）

- [x] 7.1 `ref/goal-blueprint/task-tree-mock.html` と `ref/goal-blueprint/kanban-crumb-mock.html` を
      ブラウザで開いてスクショを撮り、実装後の画面と並べて確認する（プロジェクトルール）
- [x] 7.2 `app.css` の `.bp-*` を作り替え、`.kb-breadcrumb` 系を帯用に書き替える。
      **1ルール1行のコンパクト書式を維持**し、フォーマッタをファイル全体にかけない
- [x] 7.3 `git diff --stat -- server/static/css/app.css` の桁を確認する。想定より大きければ整形が混入している

## 8. 既存 e2e の回帰確認（実装直後・ここで止める）

- [x] 8.1 `$env:CI="1"; npx playwright test e2e/goal-blueprint-task-tree.spec.ts e2e/kanban-*.spec.ts`
      が緑で、かつ `git diff -- e2e/` に新規ファイル以外の差分が無いことを確認する。
      **落ちた場合は e2e を書き換えず停止**し、凍結ラインの投げ返し（1回だけ）としてユーザーへ確認する

## 9. デモモードで確認（プロジェクトルール）

- [x] 9.1 `PORT=<空きポート> DB_PATH=:memory: npm run server` → `POST /api/demo/reset` で起動し、
      デモの目標からタスク一覧を開いて、編集の導線が1つも出ていないこと・進捗バーが正しいことを確認する
- [x] 9.2 本番モードで `Enter` → `Tab` → `Shift+Tab` → `Alt+C` → `Ctrl+Enter` を実際に通し、
      カンバンで帯の色と目標名を確認する

## 10. 新規 e2e（DOM ができた後に書く）

- [x] 10.1 §0 に挙げた8フローの e2e を書く。セレクタは実装した DOM から採る
- [x] 10.2 `git stash push -- server/` → `$env:CI="1"; npx playwright test e2e/<new-spec>.spec.ts` で
      **落ちること**を確認 → `git stash pop` → 通ることを確認する。**`CI=1` は必須**
      （無いと `reuseExistingServer` が起動済みサーバを使い回して偽の緑になる）
- [x] 10.3 `git diff -- e2e/` に新規ファイルの追加以外の差分が無いことを確認する
