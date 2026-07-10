## 1. DB マイグレーション（manual_category）

- [x] 1.1 `server/src/db/migrations.ts` に version 8 `manual-category-registry` を追加し、`manual_category(name TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL DEFAULT 0, use_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)` を作成する
- [x] 1.2 同マイグレーション内で既定7語（昼食・休憩・移動・仮眠・運動・雑務・その他）を挿入順が並び順になるよう `INSERT OR IGNORE` で冪等にシードする（`last_used_at=0`）
- [x] 1.3 既存 DB での自動適用を確認（`npm run server` 起動でエラーなく v8 まで上がること）

## 2. サーバー: カテゴリレジストリ サービス

- [x] 2.1 手動カテゴリ用サービス（`server/src/services/categories.ts` に追記、または `manual-categories.ts` を新設）に `listManualCategories(db): {name,lastUsedAt,useCount}[]` を実装（`ORDER BY last_used_at DESC, rowid ASC`）
- [x] 2.2 `recordCategoryUse(db, name, nowMs)` を実装：`name` を trim、空なら no-op、非空なら `ON CONFLICT(name) DO UPDATE SET last_used_at=excluded.last_used_at, use_count=use_count+1` で upsert（新規は `use_count=1`）
- [x] 2.3 使用登録が集計・ルール・rollover の純関数へ波及しないこと（依存を持ち込まない）を確認

## 3. サーバー: API 配線

- [x] 3.1 `server/src/services/timeline.ts` の `ManualInput` に任意 `category?: string | null` を追加し、`addManualEntry` 内で trim 後 `recordCategoryUse` を呼び、非空なら `category_key` に trim 名を格納（未指定時は従来どおり `'uncategorized'`）
- [x] 3.2 `server/src/api/timeline.ts` の `POST /api/timeline/:date/manual` で body の `category` を受け取り `addManualEntry` へ渡す
- [x] 3.3 `GET /api/categories` ルートを追加（`listManualCategories` を返す）。登録先は timeline ルート群または新規 `registerCategoryRoutes` のどちらでもよいが `api/index.ts` に配線する

## 4. フロント: 記録ポップオーバーのチップをレジストリ由来へ

- [x] 4.1 `server/static/js/api.js` に `getCategories: () => req('GET','/api/categories')` を追加
- [x] 4.2 `server/static/js/timeline.js` の `CATEGORIES` 定数を `DEFAULT_CATEGORIES`（フォールバック）へリネームし、カテゴリのメモリキャッシュ（例: `let categoryCache = null`）を用意。`show()` 時に `api.getCategories()` を試行し名前配列をキャッシュ（失敗・空時は `DEFAULT_CATEGORIES`）
- [x] 4.3 `openDraft` のチップ生成をキャッシュ配列から行い、表示上限（定数 `MAX_CHIPS = 12`）で切る。新規カテゴリ名を入力できる入力欄を用意（既存メモ欄とは別に「カテゴリ」入力、または現行メモ欄をカテゴリ入力として明確化）
- [x] 4.4 記録確定（`addBtn`）で `api.addManual(date, { startAt, endAt, title, color:'grey', category })` を送る（`category` = 入力値 or 選択チップ、`title` = `memo.trim() || category`）。成功後に `api.getCategories()` を再取得してキャッシュ更新

## 5. テスト

- [x] 5.1 `server/src/services/timeline.test.ts`（または新規 categories テスト）に、記録で新規カテゴリが登録され `listManualCategories` の先頭に来ること、再使用で `last_used_at` が更新されること、空白カテゴリが登録されないことのテストを追加
- [x] 5.2 既定シードが初期状態で `listManualCategories` にシード順で並ぶことのテストを追加
- [x] 5.3 `npm test` と `npm run typecheck` がグリーン

## 6. 動作確認

- [x] 6.1 `npm run server` → ダッシュボードのタイムラインでゴーストをクリックし、新規カテゴリ「買い物」で記録 → 別のゴーストを開いてチップ先頭付近に「買い物」が出ることを目視確認
- [x] 6.2 翌日（対象日を変更）でも「買い物」がチップに残ること、集計・円グラフに影響がないことを確認
