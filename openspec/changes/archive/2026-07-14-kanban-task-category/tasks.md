## 1. DB / スキーマ

- [x] 1.1 新マイグレーションを追加し `task` に `category_group_id TEXT NULL` / `category_name TEXT NULL` / `category_color TEXT NULL` を追加（`server/src/db/migrations.ts`、既存 ALTER 群の並びに合わせる。color は制約なし TEXT）
- [x] 1.2 マイグレーションが既存DBに冪等適用され、既存タスクがカテゴリ無し（従来挙動）になることを確認

## 2. サーバ（サービス／API）

- [x] 2.1 `TaskRow` にカテゴリ3列を追加（`server/src/services/tasks.ts`）
- [x] 2.2 `TaskInput` にカテゴリ入力（`categoryGroupId?`, `categoryName?`, `categoryColor?`）を追加し、`createTask` で保存
- [x] 2.3 `PATCHABLE` にカテゴリ3列を追加し、カテゴリの付与・変更・除去（NULL化）を許可
- [x] 2.4 `POST /api/tasks` / `PATCH /api/tasks/:id` でカテゴリを受け入れ・バリデート（`server/src/api/planning.ts`。`category_group_id` があれば name/color も伴う想定、無ければ自由入力として name のみ許容）
- [x] 2.5 カテゴリ保存が集計・評価・rollover・解錠・目標追跡に波及しないことを確認（既存ロジック不変更）

## 3. クライアント（かんばん）

- [x] 3.1 ヘッダー（`headerEl()`）に「カテゴリ付けモード」トグルを明日モードの隣へ追加（`server/static/js/kanban.js`）
- [x] 3.2 localStorage キー（例 `tcm_kanban_categorize`）に `{date, on}` で状態保持・日次リセットするヘルパを追加（明日モードの `tomorrowMode`/`setTomorrowMode` に倣う）
- [x] 3.3 `commitComposer` を拡張：モードON時、作成直後に作成タスク向けカテゴリピッカーを次入力位置に表示
- [x] 3.4 カテゴリピッカーUIを実装（候補＝`GET /api/groups` 最近順の色付きチップ＋自由入力＋「その他」、`timeline.js` の `openDraft` チップUIを参考、候補数に上限）
- [x] 3.5 選択でタスクをPATCH更新（UUID＋name＋colorを焼き込み）、スキップ（Esc/空Enter）で未分類のまま次入力へ。IMEガード（`isComposing`/`keyCode 229`）を適用
- [x] 3.6 `api.js` にタスク作成/更新のカテゴリ引数を追加（`server/static/js/api.js`。汎用 body 透過で category3列をそのまま送出）
- [x] 3.7 カードにカテゴリの色付きバッジを1つ描画（色ありはカテゴリ色、色なしは中立色、未分類は非表示。未知色はフォールバック）

## 4. テスト／検証

- [x] 4.1 サービス層のユニットテスト：カテゴリ付き作成・PATCH更新・NULL化、集計非波及（`tasks` 系テストに追加）
- [x] 4.2 APIの受け入れ／バリデーションのテスト（グループ由来・自由入力・その他・スキップ）
- [x] 4.3 グループ削除後もスナップショット表示が残ること、改色しても照合(UUID)が維持されスナップショットは当時値のままであることを確認
- [x] 4.4 Playwright でモードON→タスク作成→カテゴリ選択→カードにバッジ表示、およびスキップ経路の E2E（既存Playwright構成に追加）
- [x] 4.5 モードOFF時に従来の連続作成フローが不変であることを確認
