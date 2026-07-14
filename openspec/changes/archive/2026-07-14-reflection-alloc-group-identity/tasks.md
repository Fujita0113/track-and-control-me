## 1. 集計キーの共有ヘルパー化

- [x] 1.1 `summary.ts` の snapshot identity ロジック（`stableGroupId === UNGROUPED_KEY ? UNGROUPED_KEY : name + SNAP_KEY_SEP + (color ?? '')`）と未グループ表示名を、小さなヘルパー（例 `snapshotIdentityKey` / `snapshotDisplayName`）として切り出し export する。`SNAP_KEY_SEP` も共有可能にする。
- [x] 1.2 `snapshotGroups`（SQL 側）が新ヘルパーと同一規則であることを確認し、規則の二重定義が残らないようにする（必要なら SQL のコメントで identity 一致を明記）。

## 2. 配分バーの WORK 束ねを identity へ変更

- [x] 2.1 `day-allocation.ts` の `workMap` のキーを `b.stableGroupId` から新 identity ヘルパー（`snapshotIdentityKey(b.stableGroupId, b.title, b.color)`）へ変更する。
- [x] 2.2 WORK スライスの `label`/`color` を identity 内の最新スナップショット（現行の `last` 選択）で決定。未グループ identity は表示名「その他（未グループ）」・色 null に揃える。スライス `key` を `work:${identity}` にする。
- [x] 2.3 MANUAL スライス（`categoryKey` 束ね）・母数（端〜端）・未記録・÷n 持ち分は変更しないことを確認する。

## 3. テスト（集計）

- [x] 3.1 `day-allocation.test.ts` に「同名同色・別 `stable_group_id` の作業が1つの WORK スライスへ合算される」ケースを追加（例: 30 分×6 回＝3 時間が1スライス）。
- [x] 3.2 同じ日について「配分バーの WORK 各スライス合計＝`daySummary`/`today-group-breakdown` の同グループ合計」を突き合わせるアサーションを追加し、将来のドリフトを防ぐ。
- [x] 3.3 未グループ（`UNGROUPED_KEY`）が単一スライスへ集約されるケースを追加する。

## 4. デモ seed（配分バーの再現）

- [x] 4.1 `demo-seed.ts` に、固定 `day_key`／固定タイムスタンプで `session` 行を焼き込む。issue #47 再現のため、同名同色（例: 振り返り・紫）を**異なる `stable_group_id`** で複数回入れる（休憩を見せたい場合は `activity_log_entry`(MANUAL) も追加）。`Date.now()` 非依存。
- [x] 4.2 追加 seed が既存の達成集計（`daily_totals_snapshot` / 評価 / 達成日数 24/30・中盤の谷）を壊さないことを確認する（配分 seed は `session` 中心で、達成用データには手を入れない）。

## 5. テスト（デモ）と手動確認

- [x] 5.1 `demo.test.ts` の期待値を追加 seed に合わせて更新（配分エンドポイントのスライス構成、または既存の達成系期待値が不変であることの確認）。
- [x] 5.2 `PORT=<空きポート> DB_PATH=:memory: npm run server` → `POST /api/demo/reset` → `GET /api/demo/timeline/<seed日>/allocation` を叩き、振り返り(紫)が1本の大きなスライスに合算され、今日タブ内訳と一致することを確認する。（デモ DB は本番 db と分離しているため、本番ルート `/api/timeline/:date/allocation` ではなくデモ用ルートで確認。実測: Day15=2026-06-25 で 振り返り3.00h/勉強2.00h/制作0.75h＋休憩0.75h、`/api/demo/today` の内訳と一致。）

## 6. 仕上げ

- [x] 6.1 `npm run typecheck`（server）とテスト一式を通す。
- [x] 6.2 デモモードで振り返りタブの配分バーを開き、issue #47 の症状（振り返りの分裂・埋没）が解消していることをユーザーに明示する。（実装追加: デモの振り返りタブ `showDemo` は従来 配分バーを描画していなかったため、デモ用配分ルート `GET /api/demo/timeline/:date/allocation` を追加し、`showDemo` が対象日の配分バーを読み取り専用で描画するよう配線。本番バーと同一の `buildAllocCard` で描画。仮想日付 Day15=2026-06-25 で 振り返り(紫) が1本の 3.00h スライスとして最上段に出る。）
