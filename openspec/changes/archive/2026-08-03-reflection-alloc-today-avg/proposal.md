## Why

振り返りタブの「一日の配分」ビューは各カテゴリの内訳（横棒リスト）を見せるが、その日の作業量が「多かったのか少なかったのか」を判断する基準がない。issue #81 は、今日の作業時間と直近の平均作業時間との差分を +N/-N で示し、その日を振り返る際に一目で調子がわかるようにしたいという要望。

## What Changes

- 「一日の配分」ビューのヘッダ（`.rf-alloc-head` 付近）に、対象日の総作業時間と「直近7日平均（対象日を除く）」との差分を `+Nh Nm` / `-Nh Nm` で表示する。
  - 総作業時間は今日タブと同じソース（`GET /api/summary?date=` の `totalWorkSeconds`）を対象日パラメータで取得する。`一日の配分`独自の `totalSeconds`（覚醒時間の端〜端）とは別物であり、これと混同しない。
  - 平均は対象日の前日から遡って7日間（対象日を含まない）の `totalWorkSeconds` をカレンダー日数7で単純平均する。記録が無い日（0秒）も分母に含める。
  - 差分がゼロの場合は `±0` 表示とする。
- 対象日が「振り返り」対象日ストリップで切り替わったとき、この比較表示も再取得・再描画する（既存の一日の配分ビューの同期動線に合わせる）。
- デモモードの「一日の配分」表示にも同じ比較を表示する（デモ用の合計・平均取得APIを利用）。

## Capabilities

### New Capabilities
(なし)

### Modified Capabilities
- `reflection-day-overview`: 「一日の配分」ビューの要件に、対象日の総作業時間と直近7日平均（対象日を除く）との差分表示を追加する。

## Impact

- `server/src/services/summary.ts`: 直近7日平均を計算するための集計処理（既存 `rangeSummary` を再利用 or 新規ヘルパー追加）。
- `server/src/api/*`（timeline または summary 関連ルート）: 「一日の配分」ビューが対象日の `totalWorkSeconds` と平均を取得できるレスポンスを追加・拡張。
- `server/static/js/reflection.js`: `buildAllocCard` のヘッダ部分に比較表示を追加。
- `server/static/js/api.js`: 新規/拡張エンドポイントの呼び出しを追加。
- デモ用データ生成（`server/src/services/demo-seed.ts` 等）・デモAPI（`api.demo.allocation` 周辺）にも同等の値を渡す。
