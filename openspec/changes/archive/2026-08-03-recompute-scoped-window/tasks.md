## 1. テスト（propose 時点で赤置き・凍結）

- [x] 1.1 `server/src/services/recompute.test.ts` を新規作成し、以下を赤で置いた（`npx vitest run server/src/services/recompute.test.ts` で3件とも失敗を確認済み）:
  - `recomputeWindowStartMs(onlyDays, tz, boundaryMinutes)`: 対象日のうち最古日から1日前倒しした日境界開始時刻を返す（未指定/空配列は `undefined`）
  - `loadRawSamples(db, { sinceMs })`: `sinceMs` より前のサンプルを除外する（`sinceMs` 省略時は全件・後方互換）
  - 対象範囲より前の大量の無関係な履歴があっても、絞り込み後の読み込み件数は「バッファ日の直前サンプル＋対象日サンプル」のみになる

## 2. 実装: raw_sample の読み込み絞り込み（design D1）

- [x] 2.1 `server/src/services/recompute.ts` に `recomputeWindowStartMs(onlyDays: string[] | undefined, tz: string, boundaryMinutes: number): number | undefined` を追加する。`onlyDays` が空/未指定なら `undefined`。指定時は `min(onlyDays)` を `prevDayKey()` で1日前倒しし、`boundaryStartOfDay()` で epoch ms に変換して返す。
- [x] 2.2 `loadRawSamples(db, opts?: { sinceMs?: number })` に絞り込みを追加する。`opts.sinceMs` が指定されたときのみ `WHERE client_ts >= @sinceMs` をSQLに追加し、未指定時は現行どおり全件（`server/src/services/recompute.test.ts` の該当テストを通す）。
- [x] 2.3 `recompute(db, opts)` 内で、`opts.onlyDays` が指定されているときは `getConfig(db)` の `tz` / `day_boundary_minutes` を使って `recomputeWindowStartMs(opts.onlyDays, cfg.tz, cfg.day_boundary_minutes)` を計算し、`loadRawSamples(db, { sinceMs })` に渡す。`onlyDays` 未指定時は `sinceMs` を渡さない（全期間を維持）。
- [x] 2.4 `persist()` の書き込みフィルタ（`target()` / `finalDays` / `finalEval` チェック）は変更しない。

## 3. 検証

- [x] 3.1 `npx vitest run server/src/services/recompute.test.ts` を実行し、1章で赤置きした3件が通ることを確認する。
- [x] 3.2 既存の `server/src/services/rollover.test.ts`（`recompute(db)` の全期間呼び出しを含む）が引き続き通ることを確認する（後方互換の回帰チェック）。
- [x] 3.3 `npm test`（vitest 全体）を実行し、他のテストに影響が無いことを確認する。
- [x] 3.4 実機検証: issue #82 の調査で使ったプロファイリング手法（`server/data/track.sqlite` のコピーに対し `loadRawSamples` / `recompute` / `runPipeline` の実行時間を計測）を再実行し、修正前の実測値（`recompute()` 約4.9秒・`runPipeline()` 約5.5秒、raw_sample 49,111件）と比較して大幅に短縮されていることを確認する。プロファイリング用の一時スクリプトはリポジトリに残さず、確認後に削除する。
- [x] 3.5 開発サーバー（`npm run server`、DBは `server/data/track.dev.sqlite` 等の作業用コピーを使う。本番相当DBを直接壊さないこと）を起動し、拡張機能からのingestが継続している状態で `/api/goals` 等の他エンドポイントのレスポンスタイムが、再集計デバウンス（3秒後）のタイミングと重なっても大きく劣化しないことをブラウザのネットワークタブで目視確認する。

## 4. 既存/新規 e2e への影響

- [x] 4.1 既存 e2e への影響: なし（今回の変更はサーバー内部の再計算パフォーマンスのみで、DOM・API レスポンス形状に変更はない）。念のため `git diff -- e2e/` が空であることを確認する。
- [x] 4.2 新規 e2e: 不要（ユーザー可視のUIフロー変更が無いため）。挙動の検証は 3.1〜3.2 の vitest と、3.4〜3.5 の実測で行う。
