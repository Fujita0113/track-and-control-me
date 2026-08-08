## 1. DB マイグレーション（凍結の種別）

- [x] 1.1 `server/src/db/migrations.ts` に version 27 を追加: `ALTER TABLE goal_freeze ADD COLUMN kind TEXT NOT NULL DEFAULT 'period'`（既存行は `period`・design D1）
- [x] 1.2 既存の migration テスト（`server/src/db/db.test.ts` 等）が通ることを確認する

## 2. 当日凍結（サーバ・`goal-freeze.ts`）

- [x] 2.1 `FreezeKind = 'period' | 'same_day'` を定義し、`FreezeView`・`FreezeInterval`・`GoalFreezeRow` に `kind` を足す。`toFreezeView` と `goalFreezeIntervals` が `kind` を返すようにする
- [x] 2.2 `sameDayFreeze(db, goalId, { reason }, nowMs)` と `sameDayFreezeMulti(db, goalIds, { reason }, nowMs)` を追加する。`start_day = end_day = today`・`kind='same_day'`・理由必須・二重凍結拒否・月枠チェック（`today` の月）・`goal_freeze_change` へ `op='reserve'` を追記（design D1）
- [x] 2.3 月枠の判定を「`start_day` の属する月」へ一般化する。`quotaMonthOf(today)` は期間凍結用に残しつつ、`sameDayFreezeQuota(db, nowMs)`（`today` の月を見る）を追加し、`quotaRowForMonth` を両者で共有する（design D4）
- [x] 2.4 `updateFreeze` で対象行が `kind='same_day'` なら `FreezeStateError` を投げる（design D3）
- [x] 2.5 `effectiveEndDay` / `frozenDaysUpTo` の役割を分ける: 実効 `end_day` の算定は `kind='period'` の区間のみを数え、ペースの分母（`goalPace` の `elapsedDays`）とゲート離脱（`frozenGoalIdsOn`）とレポートの `frozen` セルは**全区間**を数える（design D2）
- [x] 2.6 `server/src/services/goals.ts` の `effectiveEndDayOf` / `goalPace` が 2.5 の切り分けどおりになっていることを確認する（`goalPace` の `frozen` は全区間・`effectiveEndDayOf` は period のみ）
- [x] 2.7 `npm test -- goal-same-day-freeze` が緑になることを確認する（凍結ライン: このテストは変更してはならない）

## 3. 当日凍結（API）

- [x] 3.1 `server/src/api/goals.ts` に当日凍結のエンドポイントを追加する（`POST /api/goals/freeze/same-day` の multi と、必要なら単体）。理由必須・`endDay` を受け取らない
- [x] 3.2 `GET /api/goals/freeze/quota` のレスポンスを `{ ...期間凍結の枠（既存の形）, sameDay: 当日凍結の枠 }` に拡張する（design D4）
- [x] 3.3 `FreezeValidationError` → 400・`FreezeStateError` → 409 の既存マッピングが新経路にも効いていることを確認する
- [x] 3.4 デモモード（`server/src/api/demo.ts`）に当日凍結の操作経路を追加しない（閲覧専用のまま・spec: goal-freeze）

## 4. 終了の翌日発効（サーバ）

- [x] 4.1 `endGoal` から `removeRule` の呼び出しを外し、`ended_day_key` に `addDaysKey(today, 1)` を書くようにする。`end_reason`・`outcome_met`・`final_pace_json`・`lifecycle_*` は従来どおり要求時点で焼き込む（design D5・D8）
- [x] 4.2 `endedGoalIdsOn(db, dayKey)`（`ended_day_key IS NOT NULL AND ended_day_key <= dayKey`）を追加する
- [x] 4.3 `server/src/services/rule-registry.ts` の `isFullyFrozen` を `isFullyInactive` へ一般化し、`listActiveRules(db, dayKey)` が「紐づく全目標が凍結中または終了済み」のルールを落とすようにする（design D5）
- [x] 4.4 `GoalView` に `endingOn: string | null`（発効前の `ended_day_key`）を追加し、`endedDayKey` は発効後のみ非 null にする（design D9）
- [x] 4.5 `cancelEndGoal(db, goalId, nowMs)` を追加する。`today < ended_day_key` のときのみ許可し、`ended_day_key`・`end_reason`・`outcome_met`・`final_pace_json`・`lifecycle_choice`・`lifecycle_reason`・`lifecycle_decided_at` を NULL に戻す。発効後・未終了は `GoalLifecycleError`（design D7）
- [x] 4.6 取消で凍結予約を復元しないこと、終了時に保存した証拠写真を消さないことを確認する（design D7）
- [x] 4.7 `server/src/services/goal-history.ts` の「−終える」行を `ended_day_key` から導出し、`pending`（`today < ended_day_key`）を返すようにする。取消で行が消えることを確認する（spec: goal-history MODIFIED）
- [x] 4.8 `POST /api/goals/:id/end/cancel`（またはそれに相当する経路）を `server/src/api/goals.ts` に追加し、`GoalLifecycleError` を 409 にマッピングする
- [x] 4.9 `npm test` が全緑になることを確認する（凍結ライン: `goal-end-anytime.test.ts`・`goal-history.test.ts`・`goals.test.ts`・`goal-same-day-freeze.test.ts` は変更してはならない）

## 5. 終了済み目標のルールが他の一覧へ漏れていないことの確認

- [x] 5.1 `status='active'` を全件走査する経路が `rule-registry.ts:364`（`listActiveRules`）だけであることを再確認する（`grep -rn "FROM rule WHERE status" server/src`）
- [x] 5.2 目標ごとの一覧（`linkedRules` を使う画面: 振り返りタブの目標コーナー・目標カード・凍結モーダルのルール一覧）が終了済み目標を描画しないことを実機で確認する
- [x] 5.3 終了済み目標に紐づくルールが今日タブ（`listDueRules`）に現れないことを確認する

## 6. クライアント: 一時凍結モーダルの種別選択

- [x] 6.1 `server/static/js/` の一時凍結モーダルに種別セレクタを追加する。**既定は期間凍結（翌日発効）**（design D10）
- [x] 6.2 当日凍結を選んだときは期限入力欄を隠す（spec: goal-freeze MODIFIED「操作導線」）
- [x] 6.3 種別の選択肢にそれぞれの代金（当日＝今日から効くが期限は延びない／期間＝翌日から効き期限が延びる）と、どちらも同じ月枠を1回使うことを明示する
- [x] 6.4 サイドバーの月枠表示を、選択中の種別に対応する月で出す（月末に両者が食い違うため・design D4）
- [x] 6.5 当日凍結中のカードには延長の導線を出さない（解除のみ）

## 7. クライアント: 終了予約中の表示と取消

- [x] 7.1 終了成功トーストを `明日からこの目標を終えます` にする（design D11・既存 e2e が凍結している文言）
- [x] 7.2 目標カードのバッジを、発効前は `進行中` のまま `終了予約中` バッジ（発効日を併記）にする。`終了` バッジは発効後のみ（design D11）
- [x] 7.3 削除ボタンの表示条件を `ended_day_key == null` にする（終了予約中も隠す・サーバの削除ガードと一致させる・design D11）
- [x] 7.4 「終える」ボタンを終了予約中には出さず、代わりに「終了を取り消す」を出す。確認ダイアログに「取り消しても凍結予約は戻りません」を書く（design D7）
- [x] 7.5 取消ボタンに `attachTooltip` が必要なショートカットを足す場合は、ホバーヒントを併記する（CLAUDE.md 必須ルール）
- [x] 7.6 大きい沿革の「−終える」行に、発効前は `予約中` と発効日を出す（design D11）

## 8. 新規 e2e（DOM ができてから最後に書く）

- [x] 8.1 **当日凍結の筋**を新規 e2e で書く: 今日タブにルールが出ている → 振り返りタブのモーダルで種別「今日1日だけ」＋理由を入れて決定 → **その場で今日タブのゲートから外れる** → 月枠が使用済みになる（期間凍結の予約もできなくなる）
- [x] 8.2 **終了の翌日発効の筋**を新規 e2e で書く: 進行中の目標を終える → **今日タブのゲートは変わらない** → カードが「終了予約中」になり削除ボタンが出ない → 「終了を取り消す」で進行中に戻り、大きい沿革の行が消える
- [x] 8.3 各 spec について、実装を stash した状態で落ちることを確認する（`git stash push -- server/`／`$env:CI="1"; npx playwright test e2e/<new-spec>.spec.ts` で red →`git stash pop` → green）。`CI=1` を必ず付ける（CLAUDE.md 必須ルール）

## 9. デモモードでの成果の明示（CLAUDE.md 必須ルール）

- [x] 9.1 `server/src/services/demo-seed.ts` に、当日凍結の日（期限が延びていないこと）と期間凍結の日（期限が延びていること）が並んで読めるサンプルを足す。固定 day_key／固定タイムスタンプを守り、既存の筋書き（達成 24/30・中盤の谷）を壊さないよう既存の谷日に寄せる
- [x] 9.2 `server/src/services/demo.test.ts` の期待値（実践数・達成日数など）を併せて更新する
- [x] 9.3 `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動し、`POST /api/demo/reset` → `GET /api/demo/goals/:id/report?now=<完走後の day_key>` で本物の集計経路を通し、当日凍結の日が「対象外だが期限は延びていない」ことをユーザーに明示する

## 参考: このタスクリストが前提にしている凍結ライン

**propose で書いたので apply は変更してはならない:**

- delta spec（`openspec/changes/same-day-freeze-next-day-end/specs/**`）
- vitest:
  - **新規** `server/src/services/goal-same-day-freeze.test.ts`（当日凍結・21 ケース）
  - **更新** `server/src/services/goal-end-anytime.test.ts`（翌日発効・取消）
  - **更新** `server/src/services/goal-history.test.ts`（「−終える」行の日付・予約中・取消で消える）
  - **更新** `server/src/services/goals.test.ts`（完走フォークの「終える」で rule 行を書き換えない）
- **既存** e2e（この change が無効化したぶんを propose で更新済み）:
  - `e2e/goal-end-ctrl-enter.spec.ts` — トースト文言
  - `e2e/goal-delete-after-end-rejected.spec.ts` — トースト文言・`終了予約中` バッジ
  - `e2e/goal-target-hours.spec.ts` — トースト文言・`終了予約中` バッジ・沿革行の `予約中`
  - `e2e/goal-freeze-reserve-flow.spec.ts` — **無改変**（モーダルの既定が期間凍結なので従来の筋がそのまま通る・design D10）

**propose 時点の `npm test`**: 34 failed / 420 passed。落ちているのは上記4ファイルのみで、他テストへの波及は無い。

**apply が書く新規 e2e**: 8章。セレクタは実装後に決まるため propose では書かない。
