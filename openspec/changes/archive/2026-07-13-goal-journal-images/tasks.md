> 凡例: [x]=実装済みかつ新要件でも不変 / [ ]=新規または要変更。旧「進行中のみ書込」前提のタスクは design D4b（いつでも可）に合わせて改訂した。

## 1. データモデル: 画像テーブル（migration v14）— 実装済み

- [x] 1.1 `goal_journal_image`（`goal`へ直接FK・CASCADE / `day_key` / `caption` / `mime` / `bytes` BLOB / `width` / `height` / `sort_order` / `created_at`）＋ `idx_gji`（design D1）。
- [x] 1.2 `db.test.ts` に goal 削除で画像が CASCADE 消去されるテスト。

## 2. サーバ: 画像サービス（`goals.ts`）— 書込ガードを撤廃（design D4b）

- [x] 2.1 `listJournalImages(db, goalId, dayKey)`（sort_order 昇順・バイト非含）。
- [x] 2.2 `addJournalImage`：**`active` ガードを外す**（status 不問）。`day_key ∈ [start,end]` は残し、**期間外は `JournalImageError`（400）**。mime 許可リスト・サイズ上限は据え置き。
- [x] 2.3 `getJournalImageBytes`（`goal_id` 所有検証）。
- [x] 2.4 `updateJournalImageCaption` / `deleteJournalImage`：**`active` ガードを外し所有検証のみ**。
- [x] 2.5 ユニットテスト改訂：(a) **開始前・進行中・完走後いずれでも**追加/更新/削除できる、(b) **期間外 `day_key` は 400**、(c) 他目標 `imageId` は不可、(d) 非画像 mime・上限超過は 400、(e) 本文が無い日でも画像だけ保存できる。旧「完走後拒否」テストは置換する。

## 3. サーバ: 画像 API（`api/goals.ts`）

- [x] 3.1 `GET …/journal/:date/images` → メタ一覧。
- [x] 3.2 `POST …/journal/:date/images`：**`JournalNotWritableError`→409 マッピングを除去**（もう投げない）。`JournalImageError`=400 / NotFound=404 は維持。
- [x] 3.3 `GET …/journal/images/:imageId` → バイナリ。
- [x] 3.4 `PATCH` / `DELETE …/:imageId`：**409 マッピング除去**（所有検証の 404 のみ）。
- [x] 3.5 API テスト改訂：**完走後の追加が 200**・**期間外 `day_key` が 400** を反映。

## 4. サーバ: レポート集計に画像を載せる（`buildReport`・design D5）

- [x] 4.1 `GoalReport` に **`reportImages: [{ imageId, caption, dayKey, dayNumber, sortOrder }]`**（`(caption, dayNumber, sortOrder)` 昇順）を追加。④用の `days[i].images` は維持。
- [x] 4.2 `goals.test.ts`：`reportImages` がキャプション→日番号→添付順で並ぶこと、`days[i].images` も維持されることを確認。

## 5. クライアント: API 配線と縮小 — 実装済み

- [x] 5.1 `api.js` の `listGoalJournalImages` / `addGoalJournalImage` / `updateGoalJournalImageCaption` / `deleteGoalJournalImage`。
- [x] 5.2 `images.js`（`File`→canvas 長辺≤1600→JPEG q0.85→data URL・小PNG素通し・EXIF最小対応）。

## 6. 目標作成フォームの Before 画像ステージング（`goals.js` `openCreateForm`・design D7）

- [x] 6.1 作成モーダルに画像ステージングゾーン（ファイル選択・貼り付け・D&D → 5.2 縮小 → `{dataUrl, caption}` を配列で保持・`data:` プレビュー・キャプション編集・削除）を追加。
- [x] 6.2 作成成功後、ステージ画像を **`start_day`（Day1）へ順に `addGoalJournalImage`**。0枚でも作成可、個別失敗はトースト。

## 7. 振り返り日記コーナーの画像（`reflection.js`）— 実装済み

- [x] 7.1 画像ゾーン（3方式・サムネイル・キャプション編集/削除・本文 dirty/flush と独立＝`reflection_done` 非汚染）。
- [x] 7.2 対象日切替で読み直し・進行中の目標×対象日で構築。

## 8. レポート ③ の2モード＋CTA（`goals.js`・design D6/D6b）

- [x] 8.1 `blockBeforeAfter` を作り替え：`reportImages` を trim キャプションでグループ化（空キャプションは各1枚を単独グループ）、各グループを `dayNumber→sortOrder` 昇順に整列。
- [x] 8.2 **デフォルト（Before/After）**：各グループの最古(Before)/最新(After) 2枚を左右並置（1枚なら単独）。Day番号＋キャプション。既存文面 `baCol` は残す。
- [x] 8.3 **全比較**：グループ＝行、古い→新しい順に全枚数を横スクロールで並置。
- [x] 8.4 モード切替トグル（2ボタン）を ③ 見出し脇に。既定＝デフォルト。
- [x] 8.5 **最終日写真の追加CTA**：③ の目立つ位置にアップロード枠（ファイル/貼付/D&D → 縮小 → `POST …/journal/:end_day/images` → ③④再描画）。デモは非表示。
- [x] 8.6 ④ 日記リーダーの選択日画像表示を維持（`days[i].images`・読み取り専用・他日は出さない）。

## 9. デモモードの画像（`demo-db.ts` / `api/demo.ts` / `api.js`・design D8）

- [x] 9.1 `demo-seed` の完走目標に **サンプル画像 BLOB**（キャプション別・初日/中間/最終日）を投入。
- [x] 9.2 デモ report に `reportImages` / `days[i].images` を載せる。
- [x] 9.3 `GET /api/demo/goals/:id/journal/images/:imageId` でバイナリを返す＋`api.js` の `demo` に配線。
- [x] 9.4 レポート描画のバイナリ URL をデモ時は `/api/demo/…` に切替（`imgFig` のベースパス切替）。

## 10. スタイル（`app.css`）

- [x] 10.1 日記コーナーの画像ゾーン（追加ボタン・drop・サムネイル・キャプション・削除）。
- [x] 10.2 ③ モード切替トグル・デフォルトのペアグリッド・全比較の横スクロール行・最終日CTA枠・作成フォームのステージングゾーン。ライト/レスポンシブ・CSP準拠（インライン style 属性なし）。

## 11. 検証

- [x] 11.1 `npm test` と `npm run typecheck` を通す。
- [ ] 11.2 **デモモード**で ③ の2モード切替・④ の画像表示を確認（[[verify-goal-features-via-demo-mode]]）。実機で作成フォーム/振り返りの追加・最終日CTAを確認。
- [ ] 11.3 完走後CTA追加・開始前の作成フォーム保存・期間外拒否・目標削除の CASCADE・画像なし目標の退行なしを確認。
