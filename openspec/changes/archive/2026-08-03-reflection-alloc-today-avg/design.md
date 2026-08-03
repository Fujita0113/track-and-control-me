## Context

「一日の配分」ビュー（`reflection.js` の `renderAllocView` → `buildAllocCard`、データ源は `GET /api/timeline/:date/allocation` → `getDayAllocation()`）は、対象日の記録を「覚醒時間（記録の端〜端）に対する持ち分」として横棒で見せる。この `totalSeconds` は端〜端の時間幅であり、今日タブが KPI として出す「総作業時間」（`daySummary().totalWorkSeconds`、`totalWorkSecondsForDay()` 由来）とは別の値である。

issue #81 は、今日タブが使っている「総作業時間」を一日の配分ビューにも表示し、それが直近の平均からどれだけ増減したか（+N/-N）を添えてほしいというもの。デモモードの一日の配分（`/api/demo/timeline/:date/allocation`）も同じ `getDayAllocation()` を仮想 DB・仮想 now で呼んでいるだけなので、サービス層を1箇所直せば本番・デモ両方に伝播する。

## Goals / Non-Goals

**Goals:**
- 一日の配分ビューのヘッダに、対象日の総作業時間（今日タブと同一の値・同一の計算経路）を表示する。
- 直近7日平均（対象日を含まない、カレンダー日数7で単純平均、記録の無い日も0秒として算入）との差分を `+Nh Nm` / `-Nh Nm` / `±0` で表示する。
- 本番・デモの両方で同じ表示ロジック（`buildAllocCard`）を再利用する。

**Non-Goals:**
- 平均の期間をユーザーが選べるようにする（7日固定）。
- 「多い/少ない」を良し悪し（色分けの価値判断）として演出する。本アプリは強制ではなく計測用途であり、単なる増減の事実提示に留める。
- `today-group-breakdown` や `rf-alloc` の既存の「覚醒時間に対する持ち分」ロジック・棒グラフ自体の変更。

## Decisions

### 1. 集計は `getDayAllocation()` の戻り値に相乗りさせる（新規APIを作らない）
`DayAllocation` に `workSeconds`（対象日の総作業時間）と `avgWorkSeconds7d`（直近7日平均、対象日を除く）を追加する。
- 理由: `renderAllocView` は既に `api.getAllocation(date)` を1回呼ぶだけで完結している。別エンドポイントを新設すると、対象日切替のたびに2回フェッチする必要が生じ、日付切替の同期（`reflection-day-overview` の「対象日への追従」要件）でレースが増える。
- デモ側 (`/api/demo/timeline/:date/allocation`) は `getDayAllocation()` をそのまま呼んでいるだけなので、サービス層の変更だけで自動的に同じフィールドを返すようになる。デモ用の別実装は不要。
- 代替案（採らない）: `today.js` の `totalWorkSeconds` 用エンドポイント（`/api/summary`）を振り返り側から追加で叩く。→ フェッチが2回に増え、対象日切替時の非同期競合状態を増やすだけで得るものがない。

### 2. `workSeconds` は `totalWorkSecondsForDay()` をそのまま呼ぶ（`totalSeconds` の流用や再計算はしない）
`day-allocation.ts` から `totalWorkSecondsForDay()`（`services/categories.ts`、`daySummary().totalWorkSeconds` と同一関数）を直接呼ぶ。
- 理由: issue が明示的に「今日タブに渡しているものをそのまま持ってくる」と指定している。今日タブの総作業時間は `daySummary()` 経由でこの関数を呼んでいるため、同じ関数を呼べば定義が完全に一致する（未グループ非計上の扱い等も含めて）。
- `totalSeconds`（端〜端の時間幅）から差し引き計算で求める方法は採らない。定義が違う値同士の演算になり、`untrackedSeconds` や休憩（自己申告）の扱いでズレる。

### 3. 平均は「直近7日・対象日を除く・カレンダー日数で単純平均・0秒日も算入」で固定
対象日を `D` として `[D-7, D-1]` の7日分、それぞれ `totalWorkSecondsForDay()` を呼び、合計を7で割る（記録が無い日は0として扱う＝分母は常に7）。
- 理由: ユーザー確認により決定（直近7日／今日を除く／カレンダー日数で単純平均）。目標のペース計算 `goalPace()`（凍結日を除外して割る）とは意図的に異なる規則であり、混同しないよう `avgWorkSeconds7d` という名前で明示する。
- 対象日が記録開始から7日未満しか経っていない場合も、存在しない日は「その日を含めない」のではなく、日付範囲は常に `D-7〜D-1` の7日分を計算対象にし、レコードが無い日は0秒として扱う（＝分母は常に7で固定。日数を可変にしない）。

### 4. UI: 色による価値判断をしない
`+Nh Nm` / `-Nh Nm` の表示は `.rf-alloc-head` 内に中立トーンのテキストとして追加し、既存の `.gr-marker-delta`（`color:#46505f`、`font-variant-numeric: tabular-nums`）に準じたスタイルにする。緑/赤などの増減価値判断色は使わない。

## Risks / Trade-offs

- [Risk] `getDayAllocation()` は1日ごとに `getTimeline()` を呼ぶ重い集計だが、平均計算は `totalWorkSecondsForDay()`（`daily_totals` 権威集計ベース）を7回呼ぶだけで `getTimeline()` は呼ばない → 影響は軽微（`rangeSummary` が既に同じ関数を7日分ループしている実績があり、同等のコスト）。
- [Risk] 対象日の翌日以降のデータしかない新規ユーザーは平均が常に0に近い → 意図通り（「記録が薄い平均と比較される」ことは今回のスコープ外の課題として許容し、Non-Goals に明記）。

## Migration Plan

- 既存 `DayAllocation` 利用箇所（`reflection.js`, テスト）は新フィールドを無視しても壊れない（追加フィールドのみ、既存フィールドは変更しない）。破壊的変更なし。
