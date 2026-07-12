## 1. 内訳集計をスナップショット identity へ切り替え

- [x] 1.1 `server/src/services/summary.ts` の `daySummary` で、`groups` を `daily_totals_snapshot × tab_group` の JOIN ではなく、当日 `session` を `(tab_group_name_snapshot, group_color_snapshot)` でグルーピングし `SUM(credited_ms)` して生成する（`ms` 降順）。
- [x] 1.2 各内訳行の `stableGroupId` に合成キー（例: `${snapName}\x1f${snapColor ?? ''}`、未グループは `UNGROUPED_KEY`）を、`name`/`color` にスナップショット値を格納する。未グループ行（sid=`UNGROUPED_KEY`）は単一行へ集約し、`countsTowardTotal(UNGROUPED_KEY, cfg)` で `countsTowardTotal` フラグを付与する。
- [x] 1.3 `rangeSummary` にも同一のスナップショット集計を適用し、各日の `groups` を同方式で生成する（棒グラフ系列 key＝合成キー）。
- [x] 1.4 `daySummary.totalWorkSeconds` は従来どおり `totalWorkSecondsForDay`（`daily_totals_snapshot` 源泉）を維持し、変更しない。

## 2. テスト

- [x] 2.1 単体テスト: 同一 sid が `webエンジニアリング`(pink)→`振り返り`(purple) と改名した日について、`daySummary.groups` が両者を別スライスで返し、pink が現在名へ吸収されないことを検証する。
- [x] 2.2 単体テスト: 集計方式切り替え後も `totalWorkSecondsForDay` と解錠ルール（`TOTAL_WORK`/`GROUP`）の達成判定が不変であることを検証する。
- [x] 2.3 単体テスト: 未グループ行が単一行として表示され、`exclude_ungrouped_from_total` ON で `countsTowardTotal=false` になることを検証する。
- [x] 2.4 単体テスト: 異なる sid が同一（name,color）identity のとき1スライスへ合算されることを検証する。
- [x] 2.5 既存の集計・ルール・work-time-scope 系テストが緑のままであることを確認する（`npm test`）。

## 3. 検証

- [ ] 3.1 サーバを起動し、2026-07-11 の今日タブでグループ別ドーナツに `webエンジニアリング`(pink) が2番目のスライスとして現れ、タイムラインと一致することを目視確認する。
- [ ] 3.2 直近7日棒グラフで改名前系列（pink）が該当日に保持されることを確認する。
- [x] 3.3 `npm run typecheck` が通ること。
