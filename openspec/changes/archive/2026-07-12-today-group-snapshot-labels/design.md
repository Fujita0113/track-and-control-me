## Context

システムには2つの時間データ経路がある。

1. **権威集計**: `raw_sample` → `aggregateSamples`（divide-by-N 分配）→ `daily_totals_snapshot`（`(day_key, stable_group_id)` → `ms`）。総作業時間・解錠ルール（`TOTAL_WORK` / `GROUP`）が読む。
2. **タイムライン**: 同集計が生成する `session` 行（各行に **記録時点の** `tab_group_name_snapshot` / `group_color_snapshot` / `credited_ms` を保持）。

`stable_group_id` は拡張側で「タイトル＋色」identity により再起動・改名をまたいで同一性を引き継ぐ（`extension/src/groups.ts`）。したがって Edge 側で1つのタブグループを改名／色変更すると、**同一 sid に複数の（名前・色）identity の時間が蓄積**される。

今日タブの「グループ別」内訳（`daySummary.groups`）と7日棒（`rangeSummary`）は `daily_totals_snapshot` を**現在の `tab_group` 行**へ JOIN して名前／色を得る（`server/src/services/summary.ts:47,89`）。このため過去 identity の時間が現在名の1スライスへ吸収され、タイムラインと食い違う（issue #19: pink `webエンジニアリング` が現在名 purple `振り返り` に吸収されグラフから消失）。

実データ（2026-07-11, sid `70d5118e…`）: session スナップショットは `webエンジニアリング`(pink) 1.63h ＋ `振り返り`(purple) 0.28h。現在 `tab_group` は同 sid を `振り返り`(purple)。結果、内訳では 1.91h 全量が purple `振り返り` になり pink が消える。

## Goals / Non-Goals

**Goals:**
- 今日タブのグループ別内訳・7日棒を、タイムラインと同じ**記録時点スナップショット（名前＋色）identity 単位**で集計・彩色し、両ビューを一致させる。
- 改名／色変更をまたぐグループを、記録時点の identity ごとに分離表示する。
- 総作業時間 KPI・解錠ルール評価・`daily_totals_snapshot` 生データを不変に保つ（非破壊・表示専用の修正）。

**Non-Goals:**
- `stable_group_id` の払い出しロジック（`extension/src/groups.ts`）や identity 統合の再設計はしない。改名を「同一グループの継続」とみなす現行モデルは維持する。
- 手動記録（`activity_log_entry` MANUAL）を今日タブの「グループ別」ドーナツへ取り込むことはしない（別スコープ。今回は AUTO 内訳の分類バグ修正に限定）。
- 総作業時間の算入スコープ（`exclude_ungrouped_from_total`）の意味は変えない。

## Decisions

### D1: 内訳を `session` スナップショット由来へ切り替える（read-side のみ）

`daySummary` / `rangeSummary` の `groups` を、`daily_totals_snapshot × 現在 tab_group` の JOIN ではなく、当日 `session` を **`(tab_group_name_snapshot, group_color_snapshot)` でグルーピングし `SUM(credited_ms)`** して生成する。分類キー＝記録時点 identity なのでタイムライン（同スナップショット）と構造的に一致する。

- **なぜ session 集計か**: タイムラインの AUTO ブロックと同一ソースのため、定義上一致が保証される。`daily_totals_snapshot` にスナップショット列を追加する案（D 代替）よりスキーマ変更・マイグレーション・集計パイプライン改修が不要で、リスクが小さい。
- **代替案（不採用）**: `daily_totals_snapshot` のキーを `(day, sid, name, color)` に拡張し `aggregateSamples` が identity 別 ms を出す。権威テーブルから内訳も引ける利点はあるが、スキーマ変更＋`GROUP` ルール（sid 単位合算）クエリの `GROUP BY sid` 化＋マイグレーションが必要で、非破壊要件に対し過剰。単一ユーザー規模では session 由来で十分。

### D2: `stableGroupId` フィールドの意味

現行 `GroupTotal.stableGroupId` は分類キーとして使われている（フロントの棒グラフ系列 key・凡例）。スナップショット集計後は分類キーが `(name,color)` になるため、`stableGroupId` には**安定な合成キー**（例: `snapName + '' + (snapColor ?? '')`、未グループは `UNGROUPED_KEY`）を格納する。フロント（`today.js`）は `stableGroupId` を series 識別・`ungrouped` 判定・`countsTowardTotal` 表示にのみ使うため、合成キーで機能は保たれる。`name`/`color` はスナップショット値をそのまま入れる。

- **未グループ判定**: `group_color_snapshot IS NULL` かつ sid が `UNGROUPED_KEY` の行を未グループ扱いとし、合成キーは `UNGROUPED_KEY` 固定。`countsTowardTotal(UNGROUPED_KEY, cfg)` で非計上ヒントを従来どおり付ける。

### D3: 総作業時間 KPI は現行のまま

KPI（`totalWorkSecondsForDay`）は `daily_totals_snapshot` を読む従来経路を維持。内訳スライスの合計（session credited 合算）と KPI は、従来同様に未グループ非計上や sub-second 丸めで完全一致しないことがあるが、これは既存挙動（未グループ行は表示するが KPI へ非計上）と同性質で許容。ゲート評価との数値乖離は生じない（KPI・ゲートとも同一 `daily_totals` 源泉のまま）。

### D4: データソース前提

内訳が `session` 依存になるため、`session` 行の無い日は内訳が空になる。本アプリはタイムラインが既に `session` に依存しており、`daily_totals` を持つ日は同集計で `session` も持つ（`recompute` が同時生成、finalize 時も両者を凍結保持）ため実害はない。

## Risks / Trade-offs

- **[内訳合計 ≠ KPI に見える]** 改名分割で見た目のスライス数が増える → 既存の「未グループは表示するが非計上」と同じ説明可能な差。KPI はゲートと一致し続けるため機能影響なし。
- **[同名・同色の別グループが合算される]** `(name,color)` 集計は、たまたま同名同色の別 sid を1スライスに統合する → 拡張の identity モデル自体が「タイトル＋色」を同一性キーにしているため、むしろ一貫。ユーザー知覚（同名同色＝同じグループ）とも合致。
- **[session と daily_totals の丸め差]** `distribute()`（totals）と `round(dur/n)`（session）で ms レベルの差が出る → 分単位表示では無視可能。KPI は `daily_totals` を使い続けるため権威値に影響なし。
- **[回帰]** `summary.ts` の2関数のみ変更。既存テスト（`aggregate.test.ts` 等）は集計パイプライン不変を担保。新規に「改名またぎで別スライス／KPI 不変」の単体テストを追加する。

## Migration Plan

- スキーマ変更・データ移行なし。`server/src/services/summary.ts` の read クエリ差し替えのみ。デプロイはサーバ再起動で反映。
- ロールバック: 当該コミットの revert で従来 JOIN 挙動へ即時復帰（データ不変のため副作用なし）。

## Open Questions

- なし（フロント返却形状不変・非破壊のため実装判断のみで完結）。レビューで分類軸（`(name,color)` 合算 vs sid 分離）に異論があれば D1/D2 を調整する。
