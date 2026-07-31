## 1. 土台（DB・純関数）

- [x] 1.1 `migrations.ts` に `goal_freeze`（`goal_id` FK CASCADE・`start_day`・`end_day`・`reason`・`created_at`・`updated_at`）を追加する
- [x] 1.2 `migrations.ts` に `goal_freeze_change`（`goal_id`・`day_key`・`op`・`start_day`・`before_end_day`・`after_end_day`・`reason`・`created_at`。`goal_freeze` へ FK を張らない・design D4）を追加する
- [x] 1.3 `server/src/services/goal-freeze.ts` に純関数を置く: 凍結区間の導出（予約中／凍結中／解凍済み）・`frozenDaysUpTo`（未到来分を数えない）・`effectiveEndDay`・`frozenGoalIdsOn`
- [x] 1.4 月枠の導出（`start_day` の `YYYY-MM` で数える・生きている行のみ・design D4）を `freezeQuota` として実装する

## 2. 凍結の操作（サービス）

- [x] 2.1 `reserveFreeze`: `start_day` は翌日固定・`endDay` は `start_day` 以降・理由必須・同一目標の二重予約を拒否・月枠が埋まっていれば拒否。`goal_freeze` と `goal_freeze_change('reserve')` を1トランザクションで書く
- [x] 2.2 `updateFreeze`: 理由必須。発効後は後ろへのみ（短縮は拒否）、発効前は前後どちらへも可。`goal_freeze_change('extend')` を書く
- [x] 2.3 `cancelFreeze`: 発効前のみ。`goal_freeze` を削除し `goal_freeze_change('cancel')` を残す（枠は解放される・沿革には残る）
- [x] 2.4 `releaseFreeze`: 凍結中のみ。`end_day` を解除日の前日へ切り詰め、`goal_freeze_change('release')` を書く。発効当日の解除は凍結日数 0 日
- [x] 2.5 `getFreeze`: その目標の最新の凍結（予約中／凍結中／解凍済み）を状態つきで返す

## 3. ゲートへの反映

- [x] 3.1 `listActiveRules` から、紐づく目標が**すべて**凍結中のルールを除外する（`frozenGoalIdsOn` を共通利用・design D3）
- [x] 3.2 `listDueRules`（今日タブのトースト）に同じ除外を通す
- [x] 3.3 `evaluateDay` は変更しない（「有効ルール 0 なら達成不能」を維持することを回帰テストで確認する）

## 4. 目標の期限・レポート・沿革

- [x] 4.1 `goal.end_day` の直参照を洗い出し、実効 `end_day` へ通し替える（`deriveStatus`・`toGoalView` の `endDay`/`dayCount`/`dayNumber`・`getGoalReport` の `dayCount`/`elapsedDays`/`dayKeys`・`addRuleToGoal` の延長判定）
- [x] 4.2 `GoalView` に `freeze`（状態・期間・理由）を足す。`status` は凍結中も `active` のまま（新 status を作らない・design D1）
- [x] 4.3 `ReportDayCell` に `frozen` を足し、`wasActiveOn` に凍結条件を入れる。達成日数の集計ロジックは変えない（凍結日は `applicable.length === 0` で自動的に除外される）
- [x] 4.4 `Chronicle` に `freezes` を足し、`entries`／`freezes` の双方に `sortKey`（`dayKey` → `createdAt` → `id`）を持たせる。`activate` は生きている行から合成する（design D6）
- [x] 4.5 `packages/contract` に `FreezeView`・`FreezeEntry`・`FreezeQuota` の型を追加する

## 5. API

- [x] 5.1 `POST /api/goals/:id/freeze`（予約）・`PATCH /api/goals/:id/freeze`（期間変更・延長）
- [x] 5.2 `DELETE /api/goals/:id/freeze`（取消・発効後は 409）・`POST /api/goals/:id/freeze/release`（解除・発効前は 409）
- [x] 5.3 `GET /api/goals/freeze/quota`（今月の枠・使った目標名と期間・回復する月）
- [x] 5.4 入力エラーは 400、状態の食い違い（二重予約・月枠・発効前後の不一致）は 409 で返す

## 6. UI

- [x] 6.1 振り返りタブに「一時凍結モーダル」を構築する（理由・期限を入力 → 紐づくルール一覧が併記された目標をチェックボックスで複数選択 → 一括決定。予約中/凍結中目標のカードには期間・理由・解除/延長/取消導線を表示）
- [x] 6.2 凍結中はルール操作ブロックを畳む。カード自体と日記・画像は残す（`activeGoals` の絞り込みが凍結中の目標を落とさないことを確認する）
- [x] 6.3 月枠の状態を一時凍結モーダルおよび目標表示に反映する（使った目標名・期間・回復する月）。デモモードでは操作導線を出さない
- [x] 6.4 目標カード／レポートの期間表示を実効 `Day N/M` にし、凍結中は凍結中である旨を示す
- [x] 6.5 レポート①の凍結マスを、開始前・削除後の対象外と見分けがつく表現にする
- [x] 6.6 レポート⑤沿革で `entries` と `freezes` を `sortKey` で併合して描く
- [x] 6.7 `today.js` の「ルール未設定 (達成不能)」を、振り返りタブでルール／目標を作れば当日から解錠できる旨の案内に差し替える（作成 UI は置かない）

## 7. デモモード（プロジェクトルール・必須）

- [x] 7.1 `demo-seed.ts` に凍結サンプルを1件足す（固定 day_key・既存の「中盤の谷」に重ねる・`Date.now()` 非依存）
- [x] 7.2 `demo.test.ts` の期待値（実践数・達成日数）を実測に合わせて更新する
- [x] 7.3 `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動し、`POST /api/demo/reset` → `GET /api/demo/goals/:id/report?now=<完走後の day_key>` を通して、凍結マス・延長された `Day N/M`・沿革の凍結エントリを確認しユーザーに提示する

## 8. 新規 e2e（実装が終わってから最後に書く）

- [x] 8.1 「振り返りタブで凍結を予約する → 翌日そのルールが今日タブのゲートから消える → 解除するとその日のうちに戻る」を1本書く
- [x] 8.2 `git stash push -- server/ extension/ packages/` → `$env:CI="1"; npx playwright test e2e/<new-spec>.spec.ts` で**落ちること**を確認し、`git stash pop` 後に通ることを確認する

## 凍結ライン（このタスクリストの前提）

**propose がここまでに書いた vitest（apply は変更禁止）**

- `server/src/services/goal-freeze.test.ts`（新規・30 ケース）: 予約と翌日発効・理由必須・二重予約の拒否／月枠（アプリ全体で月1回・予約中も占有・取消で解放・発効後は解放しない・跨月は発効日の月）／発効前の変更と取消・発効後の取消拒否／延長（理由必須・短縮拒否・枠を消費しない）／解除（即日・発効当日は 0 日）／実効 `end_day`（`Day N/M`・凍結中に残り日数が減らない・未到来の予約は影響しない・凍結中に完走しない）／ゲート除外（`evaluateDay`・複数目標・単発ルールの繰り越し・有効ルール 0 なら LOCKED のまま）／レポート（凍結マス・達成日数から除外）／沿革（`freezes` の並びと `sortKey`・取消も残る・`untilDayKey` で未来を見せない）
- `server/src/api/goals-freeze.test.ts`（新規・6 ケース）: 予約 200 と翌日発効／理由空 400／同月2件目 409／発効前の解除 409／発効前の取消 200／`GET /api/goals/freeze/quota`

**既存 e2e への影響**: なし。`e2e/goal-rule-gate-loop.spec.ts` は目標カード内の `.pc-block`（ルールブロック）を操作するが、凍結していない目標では畳まれないため現状のまま通る。今日タブの `.sub` 文言（6.7 で変更）に依存している既存 spec は無い。

**apply が最後に書く新規 e2e**: 上記 8.1 のフロー（セレクタではなくフローとして）。
