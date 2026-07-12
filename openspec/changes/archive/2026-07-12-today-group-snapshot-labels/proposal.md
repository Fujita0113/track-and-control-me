## Why

今日タブの「グループ別」ドーナツ（および直近7日の積み上げ棒グラフ）が、タイムラインとも実際の作業内容とも食い違う（issue #19）。原因は集計値ではなく**ラベル付けの引き元**にある。内訳は `daily_totals_snapshot`（`stable_group_id` 単位の計上ミリ秒）を**現在の `tab_group` 行**に JOIN して名前／色を解決している。ところが同一 `stable_group_id` は「タイトル＋色」identity で同一性を引き継ぐため、Edge 側でグループを改名／色変更（例: `webエンジニアリング`(pink) → `振り返り`(purple)）すると、過去に別名で計上した時間まで**現在名の1スライスへ吸収**される。結果、過去の名前（pink `webエンジニアリング`）はグラフから消え、現在名（purple `振り返り`）が水増しされる。タイムラインは `session` の記録時点スナップショット（`tab_group_name_snapshot` / `group_color_snapshot`）を読むため正しく分離できており、両ビューが一致しない。

## What Changes

- 今日タブの「グループ別」内訳（`daySummary` の `groups`）を、`daily_totals_snapshot` × 現在 `tab_group` の JOIN ではなく、**当日 `session` の記録時点スナップショット（`tab_group_name_snapshot`, `group_color_snapshot`）単位**で集計・分類する。改名／色変更をまたいだ時間は、記録時点の identity ごとに別スライスとして表示される（タイムラインと構造的に一致）。
- 直近7日の積み上げ棒グラフ（`rangeSummary` の各日 `groups`）にも同一の集計方式を適用する（同じバグを共有しているため）。
- 未グループ（`ungrouped`）行の表示と「総作業時間に非計上」ヒントは現行どおり維持する（`exclude_ungrouped_from_total` の扱いは不変）。
- **総作業時間 KPI・解錠ルール評価（`TOTAL_WORK` / `GROUP`）・`daily_totals_snapshot` の生データ・集計パイプラインは一切変更しない**。本変更は表示内訳の分類軸／ラベル解決のみに閉じる（非破壊）。

## Capabilities

### New Capabilities
- `today-group-breakdown`: 今日タブおよび range サマリの「グループ別」内訳を、記録時点のスナップショット（名前＋色）identity 単位で集計・分類・彩色する振る舞いを規定する。改名／色変更をまたぐグループの時間が現在名へ吸収されず、タイムラインと一致することを保証する。

### Modified Capabilities
<!-- 既存要件の変更なし。work-time-scope の未グループ表示／非計上・生データ不変・ゲート波及の各要件は本変更の影響を受けず両立する。 -->

## Impact

- コード: `server/src/services/summary.ts`（`daySummary` / `rangeSummary` の `groups` 生成をスナップショット集計へ差し替え）。フロント（`server/static/js/today.js`）は返却形状が同一なら変更不要。
- 影響しない: `server/src/services/categories.ts`（総作業時間）、`server/src/rules/*`（解錠ルール）、`server/src/aggregation/*`・`recompute.ts`（集計・生データ）、`daily_totals_snapshot` スキーマ。
- データソースの前提: 表示内訳は `session` 由来へ移行するため、`session` 行が存在する日にのみ内訳が出る（本アプリではタイムラインが既に `session` に依存しており実質同等）。
- API: `GET /api/summary` / range 系レスポンスの `groups` 要素の意味が「現在の tab_group 名/色」から「記録時点スナップショット名/色」に変わる（形状・フィールドは不変）。
