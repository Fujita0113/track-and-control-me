## Why

単発（`schedule=single`）の写真/質問ルールは「達成するまで日をまたいでロックを繰り越す」仕様上、一度提出すると `met=true` のまま**永久に**アクティブ扱いになる（`isRuleActiveOn`・`carryoverPolicy==='carry'`）。この設計自体は正しい（ゲート判定を変えてはならない）が、副作用として、提出した当日を過ぎても今日タブの「条件の進捗」欄と振り返りタブの一時凍結モーダルのルール一覧に、何年経っても達成済みの単発ルールが表示され続ける（issue #73）。ユーザーはその日達成しないといけないものだけを見たいのに、済んだ一発ネタが埋もれさせる。

## What Changes

- ゲート評価（`ConditionResult`）に、単発(carry)の写真/質問ルールが「達成済みだが当日の提出ではない」かを示す `carryStale` フラグを追加する。`met` 自体は変えない（ゲートの AND 判定・latch は無関係・不変）。
- 今日タブが読む `GET /api/unlock/:date`（および `PUT /api/checks/:date/:conditionKey` の返り値・デモの `GET /api/demo/today`）で、`carryStale=true` の条件を表示用リストから除外する。提出した当日はそれまでどおり ✓ 行として表示され続ける。
- 振り返りタブの一時凍結モーダルが読む目標ルール一覧（`GoalRuleView`）にも同じ `carryStale` を追加し、モーダルの箇条書きから `carryStale=true` のルールを除外する。
- ルール管理（振り返りタブの目標コーナー・`editable-rule-registry`）や目標カードのルールチップ、完走レポートの①カレンダーなど、他の `GoalRuleView`/`per_condition_results` 消費箇所は変更しない（達成済み単発ルールを消す・編集不能にするわけではなく、あくまで「今日やること」表示からの除外に限定する）。

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `goal-check-gate`: 今日タブの条件表示に、達成済みの単発ルールを除外する表示専用フィルタの要件を追加する（ゲートの合流・latch・AND 判定は不変）。
- `goal-freeze`: 一時凍結モーダルのルール一覧表示に、同じ除外を適用する要件を追加する。

## Impact

- `server/src/services/rule-registry.ts`: `carryoverPolicy`/`isRuleMetOn` と対になる `isCarryStale` 純関数を追加。`answerDayKeysFor` 相当の共有クエリ `ruleAnswerDayKeys` を追加。
- `server/src/rules/evaluate.ts`: `ConditionResult` に `carryStale?: boolean` を追加し、`evaluateRule` の `PHOTO`/`QUESTION` 分岐で設定。表示専用フィルタ関数 `filterForDisplay` を追加。
- `server/src/api/index.ts`: `GET /api/unlock/:date`・`PUT /api/checks/:date/:conditionKey` の返り値に `filterForDisplay` を適用。
- `server/src/api/demo.ts`: `GET /api/demo/today` の `unlock.perCondition` にも同じフィルタを適用。
- `server/src/services/goals.ts`: `GoalRuleView` に `carryStale` を追加し、`toRuleView` で単発の写真/質問ルールについて算出する。
- `server/static/js/goal-freeze.js`: 凍結モーダルのルール箇条書きから `carryStale` なルールを除外する。
- `server/src/services/demo-seed.ts`: 既存の単発サンプル（`RULE_PHOTO_MORNING_ID`・`RULE_QUESTION_FOCUS_ID`）の焼き込み `per_condition_results` に、提出日翌日以降 `carryStale: true` を付与する（デモモードで再現するため）。
- 影響を受けるテスト: `server/src/services/rule-registry.test.ts`・`server/src/rules/evaluate.test.ts`・`server/src/services/goals.test.ts`（新規 vitest）。既存 e2e（`e2e/today-tab-answer-text-display.spec.ts`・`e2e/goal-rule-gate-loop.spec.ts`）は当日提出時の挙動（`carryStale=false` のまま表示継続）を検証しているため、今回の変更で壊れないことを確認するのみで変更は不要。
