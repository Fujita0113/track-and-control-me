## 0. 凍結ライン（apply は触らない／apply が書く）

propose の時点で決まっているものは凍結済み。**apply は以下を変更してはならない。**

**凍結（触るの禁止）**

- delta spec 9本のシナリオ（`goal-burnup` / `task-estimate` / `goal-report` / `goal-report-day-detail` / `goal-chronicle` / `goal-lifecycle-fork` / `goal-history` / `goal-challenge` / `goal-check-gate`）
- 新規 vitest 3本
  - `server/src/services/goal-burnup.test.ts` — 累積線・2本のペース・凍結日を含む分母・空状態・段差
  - `server/src/services/task-estimate.test.ts` — 根直下限定・小数の進捗・走行中の枝・単価と上書き・変更記録
  - `server/src/api/goal-burnup.test.ts` — `GET /burnup`・`PUT /estimate`・`PUT /progress`・**レポート API が 404 であること**
- **既存 e2e**（`git diff -- e2e/` で検出できる）。propose で処理済み:
  - 削除: `e2e/goal-report-day-detail.spec.ts` / `e2e/goal-report-journal-strip.spec.ts`（レポート画面しか検証していない）
  - 縮小: `e2e/goal-rule-gate-loop.spec.ts`（§4 のレポート経由の⑤沿革・①検証を落とし、ゲートが開くまでで終える）
  - 縮小: `e2e/goal-target-hours.spec.ts`（大きい沿革の行 → レポート遷移の4行を落とす）

**propose 時点の赤（`npm test` 実測）**: 新規3ファイルが失敗。サービス2本は `./task-estimate.js` 未実装で import に失敗（0 test）、API は 10/10 が失敗。既存テストは全緑。

**apply が最後に書く新規 e2e**（DOM ができてから。セレクタではなく筋で指定する）

1. 目標カード「見通し」→ バーンアップが出る → 「直近3日ペース」へ切り替える → 完了予想日が手前の日付に変わる
2. `PUT /api/tasks/:id/estimate` を叩く → 見通しを開き直す → スコープ線に段差が出て、理由と実行者が読める
3. 計測対象を持たない目標の見通し → 空状態が出て、数値の欠損は出ない
4. 大きい沿革の行を選ぶ → 見通しが開く（レポートは存在しない）
5. 完走した目標のカードに「続ける」と「終える」が並ぶ → 「終える」で永続ルールがゲートから外れる

`CI=1 npx playwright test <spec>` で `git stash push -- server/ extension/ packages/` 状態でも落ちることを示すまで、
その spec は何も主張していない（`CI=1` を外すと `reuseExistingServer` で偽の緑になる）。

## 1. スキーマ（先に土台を置く）

- [ ] 1.1 `server/src/db/migrations.ts` に**新しいバージョン**を足して `task.estimated_seconds`（INTEGER・NULL 可）と `task.progress_ratio`（REAL・NULL 可）を追加する。既存 migration の SQL を書き換えない
- [ ] 1.2 同じバージョンで `task_estimate_change`（`task_id` / `field` / `from_value` / `to_value` / `reason` / `actor` / `day_key` / `created_at`）を作る
- [ ] 1.3 `server/src/db/db.test.ts` を通し、`:memory:` と既存 DB の両方でバージョンが上がることを確かめる

## 2. task-estimate サービス

- [ ] 2.1 `server/src/services/task-estimate.ts` を作り、`TaskEstimateError` を定義する
- [ ] 2.2 `setTaskEstimate(db, taskId, { estimatedSeconds, reason, actor }, nowMs)` — 根直下以外・負値・空の理由を拒否し、`task_estimate_change` へ1行追記する
- [ ] 2.3 `setTaskProgress(db, taskId, { ratio, reason, actor }, nowMs)` — 葉以外・範囲外（0未満／1超）・空の理由を拒否し、記録を追記する
- [ ] 2.4 `runningBranch(db, goalId, nowMs)` — 根直下を `tree_order` 順に見て未決着の葉を持つ最初のノードを返す。開始日は直前の枝が決着した日の翌日（無ければ `start_day`）
- [ ] 2.5 `branchRemaining(db, goalId, nowMs, opts?)` — 消化量（完了=1.0／小数の進捗／打ち切りは除外）、単価、残り、`source`（`measured` / `placeholder` / `none`）を返す。`opts.all` で全枝を返す
- [ ] 2.6 `remainingScopeSeconds(db, goalId, nowMs)` — 根直下の残りの単純和。想定が1件も無ければ `null`
- [ ] 2.7 `setSubtreeDone` の一括完了で `progress_ratio` を 1.0 と読み替える規則をサービス層に閉じ込め、呼び出し側で分岐させない
- [ ] 2.8 `npx vitest run server/src/services/task-estimate.test.ts` を緑にする

## 3. goal-burnup サービス

- [ ] 3.1 `server/src/services/goal-burnup.ts` を作り、計測対象を解決する（目標時間の対象 → 時間型ルールの対象 → `null`）。全作業時間へフォールバックしない
- [ ] 3.2 `accumulatedSecondsFor()` を再利用して累積点列を作る。**凍結日を除外せず**、`start_day` 〜 今日を欠けなく並べる
- [ ] 3.3 全体平均（凍結日を含む経過日数で割る）と直近3日のペースを算定する
- [ ] 3.4 完了予想日＝`今日 + ceil(残り想定 ÷ ペース)`。ペース 0・想定なし・**完走後**は `null` を返す（`NaN` / `Infinity` を返さない）
- [ ] 3.5 `task_estimate_change` からスコープの段差（日・前後の値・理由・実行者）を組み立てる
- [ ] 3.6 `goalBurnup()` は開始前に `null` を返す。`goalPace()` は**変更しない**
- [ ] 3.7 `npx vitest run server/src/services/goal-burnup.test.ts` を緑にする

## 4. レポートの削除（サーバ）

- [ ] 4.1 `server/src/api/goals.ts` から `GET /api/goals/:id/report` を削除する
- [ ] 4.2 `server/src/services/goals.ts` から `getGoalReport()` とレポート専用の組み立て・`GoalReportNotReadyError` の用途を整理する（開始前の 409 は `burnup` が引き継ぐ）
- [ ] 4.3 `server/src/services/goal-chronicle.ts` を削除する
- [ ] 4.4 `server/src/api/demo.ts` のデモ用レポート経路を見通しへ差し替える
- [ ] 4.5 `getGoalReport` を呼んでいた既存ユニット（`goals.test.ts` / `goal-end-anytime.test.ts` / `goal-freeze.test.ts` / `goal-open-period.test.ts` / `goal-resume.test.ts` / `demo.test.ts`）からレポート依存を外す。**アサーションの意図を落とさず**、burnup か既存の別 API へ移す。落とすしかないものはコミットメッセージに理由を残す

## 5. API と契約

- [ ] 5.1 `packages/contract/src/index.ts` に `PUT /estimate` `/progress` の zod スキーマを足す（`reason` 必須・`actor` は `human` / `agent`・`ratio` は 0〜1）
- [ ] 5.2 `server/src/api/goals.ts` に `GET /api/goals/:id/burnup` を足す。開始前は 409。**算定済みの値**を返す
- [ ] 5.3 `server/src/api/planning.ts` に `PUT /api/tasks/:id/estimate` と `PUT /api/tasks/:id/progress` を足し、`TaskEstimateError` を 400 に写す
- [ ] 5.4 `npx vitest run server/src/api/goal-burnup.test.ts` を緑にする

## 6. レポートの削除（画面）

- [ ] 6.1 `server/static/js/goals.js` から `renderReport()` と①〜⑤のブロック関数（`blockCalendar` / `blockTimeSeries` / `blockPhotoCompare` / `blockJournalStrip` / `blockChronicle` / `openDayDetailModal` / `blockLifecycleFork` / `finalPhotoCta` ほか）を削除する
- [ ] 6.2 `server/static/css/app.css` から使われなくなった `.gr-cal` / `.gr-strip` / `.gr-chr` / `.gr-daytip` 等を削除する。**1ルール1行**の既存書式を守り、フォーマッタをファイル全体にかけない
- [ ] 6.3 `goalHistorySection()` の行の遷移先をレポートから見通しへ変える
- [ ] 6.4 完走カードに「続ける」を出し、既存の「終える」と2択にする（`goal-lifecycle-fork`）。「レポートを開く」は消す。導線の数を増やさない

## 7. 画面（見通し）

- [ ] 7.1 `goalCard()` — 進行中のボタン文言を「見通し」に変え、行き先を見通しにする
- [ ] 7.2 見通しのビューを作る。ヘッダ（目標名・Day・期限）＋バーンアップ＋枝の現在地＋スコープが動いた記録
- [ ] 7.3 バーンアップを**インライン SVG** で描く（累積線・スコープ線の段差・予測直線2本・交点マーカー）。Chart.js は使わない
- [ ] 7.4 「全体平均ペース／直近3日ペース」の切り替え。選ばれていない側の到達日も薄く残す
- [ ] 7.5 完走後・終了後は予測直線と完了予想日を出さない
- [ ] 7.6 枝の現在地 — 走行中の枝は実測由来、先の枝は仮置きと分かる見た目にする
- [ ] 7.7 スコープが動いた記録 — 日・前後の値・理由・実行者を並べる
- [ ] 7.8 「タスク一覧」への導線を置く（レポートへの導線は作らない）
- [ ] 7.9 空状態 — 計測対象が無いとき「何で測るかを決める」導線を出す。数値の欠損を出さない
- [ ] 7.10 `paceBlock()` の隣に完了予想日を1行足す。グラフとバーンアップの平均値はカードへ出さない
- [ ] 7.11 `blueprint.js` に想定時間と小数の進捗を表示する（編集導線を置くかは実装時に決めてよい）
- [ ] 7.12 切り替え・空状態のボタンに `attachTooltip` でホバーヒントを付ける（ショートカットを足す場合は必ず併記）

## 8. デモモード（必須・成果の明示）

- [ ] 8.1 `server/src/services/demo-seed.ts` に固定 day_key のサンプルを足す。段差が2つ以上あり、2本のペースで交点が明確に動くこと。既存の筋書き（達成 24/30・中盤の谷）を壊さず、谷日に寄せる
- [ ] 8.2 `server/src/services/demo.test.ts` の期待値を併せて更新する
- [ ] 8.3 `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動し、`POST /api/demo/reset` → `GET /api/demo/goals/:id/burnup` を通す
- [ ] 8.4 デモモードで見通しを開き、完了予想日が「全体平均」と「直近3日」で動くことをユーザーへ明示する

## 9. 参照実装と新規 e2e（最後）

- [ ] 9.1 Claude Design の 2a を `ref/goal-burnup/` へ写し、スクリーンショットを添える
- [ ] 9.2 実装した画面と `ref/` を見比べ、食い違いがあれば実装を寄せる
- [ ] 9.3 §0 に挙げた5つの筋で新規 e2e を書く
- [ ] 9.4 `git stash push -- server/ extension/ packages/` → `$env:CI="1"; npx playwright test <new-spec>` で**落ちる**ことを示す → `git stash pop` → 緑になることを確かめる
- [ ] 9.5 `npm test` と `npx playwright test` を通し、縮小した既存 e2e 2本も緑であることを確かめる
- [ ] 9.6 `git diff --stat` を見て、想定より桁が大きければ整形の混入を疑う
