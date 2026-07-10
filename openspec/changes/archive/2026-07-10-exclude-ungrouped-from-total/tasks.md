## 1. データモデル / マイグレーション

- [x] 1.1 `server/src/db/migrations.ts` に新 `version` を追加し `ALTER TABLE app_config ADD COLUMN exclude_ungrouped_from_total INTEGER NOT NULL DEFAULT 0;` を流す
- [x] 1.2 `server/src/db/index.ts` の `AppConfigRow` に `exclude_ungrouped_from_total: number` を追加
- [x] 1.3 マイグレーション適用後に既定値 0 で読めることを確認（既存 DB に安全に付与される）

## 2. 集計 source の設定対応

- [x] 2.1 `server/src/services/categories.ts` の `totalWorkMsForDay` を設定対応にする：`exclude_ungrouped_from_total` が ON のとき `daily_totals_snapshot` の合算から `stable_group_id = UNGROUPED_KEY` 行を除外（`@track/contract` の `UNGROUPED_KEY` を import）
- [x] 2.2 `totalWorkSecondsForDay` が 2.1 を経由して同じ規則で算出されることを確認（追加改修不要のはず）
- [x] 2.3 `server/src/services/summary.ts` の range 集計（inline 合算）へ同一の除外規則を適用し、当日サマリ（`totalWorkSecondsForDay` 経由）と挙動を揃える
- [x] 2.4 除外条件を単一箇所に集約（共通ヘルパ or 共有 SQL 断片）し、categories/summary 間のドリフトを防ぐ

## 3. API

- [x] 3.1 `server/src/api/index.ts` の `PATCH /api/config` 許可フィールドへ `exclude_ungrouped_from_total` を追加
- [x] 3.2 `publicConfig` / `GET /api/config` のレスポンスに `exclude_ungrouped_from_total` が含まれることを確認

## 4. UI

- [x] 4.1 `server/static/js/settings.js` の `toggles` に `{ key: 'exclude_ungrouped_from_total', label: '未グループ時間を総作業時間に含めない（娯楽の除外）' }` を追加
- [x] 4.2 `server/static/js/today.js` の内訳描画で、設定 ON かつ行が `ungrouped` のとき「総作業時間に非計上」の注記/ラベルを表示（行は消さない）
- [x] 4.3 表示される総作業時間が summary API の値（未グループ除外済み）と一致することを確認

## 5. テスト / 検証

- [x] 5.1 集計テスト: OFF で未グループを含む合計 / ON で未グループを除外した合計 / 未グループのみの日は ON で 0 を検証
- [x] 5.2 `daily_totals_snapshot` の `ungrouped` 行の ms が設定値に依存せず不変であることを検証
- [x] 5.3 ルール評価テスト: ON かつ未グループのみでは総作業時間条件が unmet、実グループが閾値を満たせば met を検証
- [x] 5.4 range サマリと当日サマリの総作業時間が同一規則で一致することを検証
- [x] 5.5 手動 E2E: 設定でトグルを ON にし、未グループ時間が総作業時間表示・ゲート評価から外れることを確認（`UNGROUPED_KEY` 文字列がマイグレーションのコメントと一致することも固定）
