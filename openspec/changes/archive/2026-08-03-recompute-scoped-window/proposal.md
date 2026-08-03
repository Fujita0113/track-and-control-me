## Why

issue #82: 振り返りタブを開くとき `/api/goals` の fetch に2.4秒かかり「死ぬほど重い」。調査の結果、原因は `/api/goals` 自体ではなく、`server/src/services/recompute.ts` の `loadRawSamples()` が `onlyDays` 指定を無視して `raw_sample` テーブルを毎回全件ロードし、`aggregateSamples()` も全履歴をJSで再集計していることだった。書き込み（persist）は当日・前日など `onlyDays` に絞られているのに、読み込み・集計コストだけ全履歴に比例して増え続ける。

ingest（拡張機能からのサンプル受信）のたびに3秒デバウンスで `runPipeline → recompute` が自動実行され（起動時にも1回）、better-sqlite3は同期API・Node/Fastifyはシングルスレッドのため、この再集計中は `/api/goals` を含む他の全リクエストがイベントループ上でブロックされる。実測（本番相当DB、`raw_sample` 49,111件）では `recompute()` に約4.9秒、`runPipeline()` に約5.5秒かかっており、この構造は使うほど（`raw_sample` が増えるほど）悪化する。

## What Changes

- `recompute()` の対象範囲が `onlyDays` で指定されているとき、`loadRawSamples()` を全履歴ではなく、その日付範囲＋境界のギャップ算出に必要な前後バッファ分のみに絞り込む。
- `onlyDays` 未指定（全件再計算）の呼び出し経路が実在する場合はその用途を洗い出し、通常の ingest デバウンス経路（`main.ts` の3秒タイマー）が絞り込み版のパスを使うようにする。
- 集計コストを日単位（おおむね定数）に近づけ、`raw_sample` の総件数に比例してブロック時間が伸びる構造を解消する。

## Capabilities

### New Capabilities
- `activity-recompute-scope`: ingest 後の再集計（raw_sample → セッション/日次集計）が、対象日と集計上必要な前後バッファのみを読み込み・処理し、無関係な通常APIリクエストを秒単位でブロックしないことを規定する。

### Modified Capabilities
（既存の集計結果・ユーザー可視の値には変更なし。挙動としての再集計対象範囲の絞り込みは上記の新規capabilityで規定する）

## Impact

- `server/src/services/recompute.ts`（`loadRawSamples`, `recompute`, `persist`）
- `server/src/services/pipeline.ts`（`runPipeline` からの呼び出し方）
- `server/src/main.ts`（ingestデバウンス・起動時呼び出し）
- `server/src/services/rollover.ts`（日次ロールオーバーからの呼び出し。`onlyDays` を渡さない全件再計算経路が無いか要確認）
- `server/src/aggregation/aggregate.ts` の `aggregateSamples` は純関数のまま変更なし（入力サンプル列の絞り込みのみで対応する想定）
- ユーザー可視の集計結果（総作業時間・セッション・ゲート評価等）は変更しない。変わるのは再計算のレイテンシのみ。
