## Why

かんばん（計画）で作ったタスクは今カテゴリを持たず、実行（タブグループ）や振り返り・長期目標とつながらない。タスクを「何のグループでやるか」で分類できれば、後から終わったタスクをグループ別に見返して「前回どこまでやったか」を思い出したり、いずれ30日レポートに載せたりできる ── このアプリの核である「計画→実行→振り返り」のループを締める一手になる（issue #27）。

## What Changes

- かんばんに**カテゴリ付けモード**のトグルを追加する（明日モードの隣、ヘッダー上）。既存の明日モードと同じく **localStorage のクライアント専用・日次リセット**方式。
- モードON時、タスクをEnterで作成すると、本来「次のタスク入力」へ移る位置が**そのタスクのカテゴリ選択**に置き換わる。選ぶと次のタスク入力へ進む。**選択はスキップ可**（未分類のまま次へ）。
- カテゴリの候補は **`GET /api/groups` の既知タブグループ（最近使った順）＋自由入力＋「その他」**。
- タスクにカテゴリを**焼き込む**：照合キー＝タブグループの `stable_group_id`（UUID）、表示用に**当時の名前・色をスナップショット**として保存（`session` テーブルの `tab_group_name_snapshot` / `group_color_snapshot` と同じ両持ち方式）。**1タスク1カテゴリ**。
- かんばんカード上にカテゴリを**色付きバッジ**で1つ表示する。
- **色は制約なしの TEXT スナップショット**として持つ（enum/CHECKで縛らない）。将来アプリ独自色を導入する余地を残すが、色機能自体は今回のスコープ外。

スコープ外（別issueへ）：目標30日レポートへのカテゴリ別タスク表示、追跡中目標のタスクのノスタルジック表示、タイムラインエントリとタスクの明示的紐付け。

## Capabilities

### New Capabilities
- `kanban-task-category`: かんばんのカテゴリ付けモード、タブグループ由来のカテゴリ選択ピッカー、タスクへのカテゴリ（UUID照合＋名前色スナップショット）の保存・表示。

### Modified Capabilities
<!-- 既存specの要求変更なし（新規capabilityとして追加） -->

## Impact

- **DB**: `task` テーブルに3列追加（`category_group_id TEXT NULL` / `category_name TEXT NULL` / `category_color TEXT NULL`）。新マイグレーション。
- **サーバ**: `server/src/services/tasks.ts`（`TaskInput` / `PATCHABLE` / `createTask` / `TaskRow`）、`server/src/api/planning.ts`（`POST /api/tasks`・`PATCH /api/tasks/:id` のカテゴリ受け入れ）。カテゴリ候補は既存 `GET /api/groups`（`listGroups`）を流用。
- **クライアント**: `server/static/js/kanban.js`（ヘッダーのモードトグル、`commitComposer` 後のカテゴリ選択フロー、カードの色付きバッジ）、`server/static/js/api.js`（タスク作成/更新のカテゴリ引数）。カテゴリピッカーUIは `server/static/js/timeline.js` の `openDraft` チップUIを参考にする（ソースは `/api/groups`）。
- **非影響**: 集計・ルール評価・rollover・解錠・目標追跡には波及させない（表示・保存のみ）。既存の配分バー(#47)・today-group-breakdown のロジックは変更しない。
