## Why

振り返りタブの「一日の配分」バー（`reflection-day-overview`）で、今日タブでは支配的なはずのグループ（例: 振り返り(紫)）が大きなバーとして現れず、消えているように見えるバグ（issue #47）。原因は、配分バーが WORK スライスを **`stable_group_id`** で束ねているのに対し、今日タブの権威内訳（`today-group-breakdown` / `snapshotGroups`）は **名前+色スナップショット identity**（`today-group-breakdown` の design D1）で束ねている、という集計キーの不整合。Chrome はタブグループを閉じて開き直すと**同名同色でも新しい `stable_group_id`** を割り当てるため、配分バーだけが同一グループを多数の小片へ粉砕し、支配的グループが1本の大きなバーとして表示されず他グループの下に埋没する。ユーザーには「大きいはずのグループが表示されていない」と映る。

さらに、この機能はプロジェクトルール上「日数が関わる機能はデモモードで成果を明示する」対象だが、`demo-seed.ts` は集計元の `session` / `activity_log_entry` を1件も seed しておらず、デモでは配分バーが常に空でこのバグを再現・確認できない。

## What Changes

- 配分バー（`getDayAllocation`）の **WORK スライスの集計キーを `stable_group_id` から「名前+色スナップショット identity」へ変更**し、今日タブの内訳（`snapshotGroups` / `today-group-breakdown` design D1）と束ね方を一致させる。これにより、開き直しで `stable_group_id` が変わった同名同色グループが1本のバーへ合算される。
- スライスのラベル・色はこれまで通り記録時点スナップショット（最新時点）を採用。MANUAL スライスは既に `category_key`（安定キー）で束ねているため変更なし。
- デモモードに **タイムライン記録（`session`。必要なら `activity_log_entry`）の seed を追加**し、配分バーとこのバグ（同名同色の作り直しグループが支配的な日）をデモで再現・確認できるようにする。既存の達成日数の筋書き（達成 24/30・中盤の谷）を壊さない範囲で、集計が読むテーブルへ固定 `day_key` / 固定タイムスタンプで焼き込む。
- `demo.test.ts` の期待値を、追加した配分 seed に合わせて更新・追加する。

## Capabilities

### New Capabilities
<!-- なし（新規ケイパビリティは導入しない） -->

### Modified Capabilities
- `reflection-day-overview`: 「一日の配分集計」の WORK スライスの束ね方を、記録時点スナップショットの **名前+色 identity** に基づくものとして明確化する（今日タブの内訳と一致させ、`stable_group_id` の入れ替わりで同一グループが分裂しないことを要求に加える）。

## Impact

- コード: `server/src/services/day-allocation.ts`（WORK スライスの集計キー）、`server/src/services/demo-seed.ts`（タイムライン記録 seed 追加）、`server/src/services/demo.test.ts`（期待値更新）、必要なら `server/src/services/day-allocation.test.ts`（identity 束ねのケース追加）。
- API/挙動: `GET /api/timeline/:date/allocation` のレスポンス（WORK スライスの `key`・粒度）が変わる。本番の常設バー `reflection.js` の `renderAlloc` はスライスをそのまま描画するため描画ロジックは不変。
- デモ表示の配線（実装で判明・追加）: デモの振り返りタブ `showDemo` は配分バーを描画していなかったため、デモ DB を参照する読み取り専用ルート `GET /api/demo/timeline/:date/allocation` を追加し、`showDemo` が対象日の配分バーを描画するよう配線した（本番バーと共有の `buildAllocCard` へ切り出し）。これによりデモで配分バーが非空になり、issue #47 の解消を UI で確認できる。
- 依存: 新規依存なし。既存の `today-group-breakdown` の identity 規則（名前+色スナップショット）に整合させる。
- デモ: 配分バーがデモで初めて非空になる。既存の達成集計（`daily_totals_snapshot` / 評価）には影響を与えない（seed 追加は別テーブル中心で、達成日数の筋書きを維持）。
