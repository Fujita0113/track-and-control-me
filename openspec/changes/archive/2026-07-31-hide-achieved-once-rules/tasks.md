## 1. rule-registry: 共有ロジック

- [x] 1.1 `server/src/services/rule-registry.ts` に `ruleAnswerDayKeys(db, ruleId): string[]` を追加する（`evaluate.ts` の `answerDayKeysFor` と同じ SQL を引き上げ）。
- [x] 1.2 同ファイルに `isCarryStale(target, schedule, answerDayKeys, dayKey): boolean` を追加する（`carryoverPolicy(target, schedule) === 'carry' && isRuleMetOn(...) && !answerDayKeys.includes(dayKey)`）。
- [x] 1.3 `server/src/services/rule-registry.test.ts` の赤テスト（propose で追加済み・凍結）を通す。

## 2. evaluate.ts: ConditionResult とフィルタ

- [x] 2.1 `ConditionResult` に `carryStale?: boolean` を追加する。
- [x] 2.2 `evaluateRule` の `PHOTO`/`QUESTION` 分岐で、引き上げた `ruleAnswerDayKeys`/`isCarryStale` を使って `carryStale` を設定する。`answerDayKeysFor` のローカル定義は削除し `rule-registry.ts` のものに置き換える。
- [x] 2.3 `filterForDisplay(perCondition: readonly ConditionResult[]): ConditionResult[]` を追加する（`carryStale` な条件を除いた配列を返す純関数）。
- [x] 2.4 `server/src/rules/evaluate.test.ts` の赤テスト（propose で追加済み・凍結）を通す。

## 3. API: 表示フィルタの適用

- [x] 3.1 `server/src/api/index.ts` の `GET /api/unlock/:date` で、`evaluateDay` の返り値の `perCondition` を `filterForDisplay` の結果に差し替えて返す（`conditionsMet`/`status`/`firstMetAt`/`hasRuleSet` はそのまま）。
- [x] 3.2 同ファイルの `PUT /api/checks/:date/:conditionKey` の返り値にも同様に適用する。
- [x] 3.3 `server/src/api/demo.ts` の `GET /api/demo/today` で、`daySummary` が返す `unlock.perCondition`（存在する場合のみ）にも同様に適用する。

## 4. goals.ts: GoalRuleView とフリーズモーダル用フィルタ

- [x] 4.1 `GoalRuleView` に `carryStale: boolean` を追加する。
- [x] 4.2 `toRuleView` に `today: string` 引数を追加し、`PHOTO`/`QUESTION` かつ単発のときだけ `ruleAnswerDayKeys`/`isCarryStale` で算出する（他の種別は常に `false`）。`toGoalView` からの呼び出しを更新する。
- [x] 4.3 `server/src/services/goals.test.ts` の赤テスト（propose で追加済み・凍結）を通す。

## 5. フロントエンド: 凍結モーダルの一覧を絞る

- [x] 5.1 `server/static/js/goal-freeze.js` の `openFreezeModal` で、各目標のルール箇条書きを組み立てる前に `rules.filter((r) => !r.carryStale)` する。
- [x] 5.2 絞り込んだ結果が0件になった場合の文言を、既存の「ルール: （登録ルールなし）」と区別できるものに変える（spec: `goal-freeze` ADDED 文言要件）。

## 6. デモモード: 既存サンプルへのフラグ焼き込み

- [x] 6.1 `server/src/services/demo-seed.ts` の `RULE_PHOTO_MORNING_ID`（D14提出）行を、`dayNum > 14` のとき `carryStale: true` を含めるよう更新する（D14当日は `carryStale` を付けない/false）。
- [x] 6.2 同様に `RULE_QUESTION_FOCUS_ID`（D15提出）行を、`dayNum > 15` のとき `carryStale: true` にする。
- [x] 6.3 `server/src/services/demo.test.ts` に影響があれば期待値を更新する（CLAUDE.md のデモルール）。

## 7. 動作確認

- [x] 7.1 `npm test` を実行し、propose が置いた赤テストを含め全て通ることを確認する。
- [x] 7.2 `PORT=<空きポート> DB_PATH=:memory: npm run server` を起動し、`POST /api/demo/reset` → `GET /api/demo/today?now=<D14/D15より後の day_key>` で、`RULE_PHOTO_MORNING_ID`/`RULE_QUESTION_FOCUS_ID` に対応する条件が `perCondition` に含まれず、`unlock.status` は変わらず `UNLOCKED` のままであることを確認する。D14当日・D15当日の `now` では引き続き含まれることも確認する。
- [x] 7.3 既存 e2e（`e2e/today-tab-answer-text-display.spec.ts`・`e2e/goal-rule-gate-loop.spec.ts`・`e2e/goal-freeze-reserve-flow.spec.ts`）が無改変のまま通ることを確認する（凍結・触ってはいけない）。
- [x] 7.4 新規 e2e を1本追加する:「単発ルールを今日タブから達成→翌日に日付を進めると条件一覧から消えるが解錠状態は保たれる」フロー（セレクタ・DOM は実装後に確定させる）。`git stash` で実装抜きに落ちることを確認してから通す（CLAUDE.md の凍結ライン運用）。
