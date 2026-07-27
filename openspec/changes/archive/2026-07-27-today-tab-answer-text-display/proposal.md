## Why

今日タブで質問ルールに回答して達成すると、行には「回答済み」としか表示されず、実際に何と答えたかが消えて見える。ユーザーは自分が何を入力したか確認できず、見づらい（issue #70）。回答テキストは `rule_answer.answer_text` に保存済みで、振り返りタブの目標沿革では表示されているため、今日タブでも同じデータを出せば直る。

## What Changes

- 質問ルールが達成された今日タブの行で、「回答済み」の代わりに実際に入力した回答テキストをタイトル下の2行目に表示する。
- ゲート評価（`ConditionResult`）に、質問ルールの当日の回答テキストを含める。写真ルールの `met` 行は今回スコープ外（表示は「提出済み」のまま据え置き）。
- 今日タブの行コンポーネントは、`met=true` になった質問ルール行でも回答テキストをレンダリングするよう変更する（現状は `met` なら早期リターンして何も出さない）。

## Capabilities

### Modified Capabilities
- `goal-check-gate`: 今日タブの質問ルール行の達成後表示に、回答テキストの表示要件を追加する。

## Impact

- `server/src/rules/evaluate.ts`: `ConditionResult` に `answerText` を追加し、`evaluateRule` の `QUESTION` 分岐で当日の `rule_answer.answer_text` を取得して詰める。
- `server/src/rules/evaluate.test.ts`: `ConditionResult.answerText` を検証する vitest を追加。
- `server/static/js/today.js`: `ruleAnswerRow` の `met` 早期リターンを見直し、質問ルールの回答テキストを行の2行目に描画する。
- `e2e/goal-rule-gate-loop.spec.ts`: 今日タブで回答後に回答テキストが表示されることを確認するアサーションを追加（新規 e2e は apply が最後に書く）。
