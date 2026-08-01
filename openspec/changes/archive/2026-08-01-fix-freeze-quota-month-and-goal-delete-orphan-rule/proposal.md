## Why

issue #75（e2e失敗の原因調査）から、実ユーザーに影響する2件の本物のバグが見つかった。どちらも「対象の月/日を判定する基準がずれている・削除後の後始末が漏れている」という日付境界・ライフサイクル境界の実装漏れで、症状はテストの失敗として顕在化したが原因はプロダクトコードにある。

1. **凍結枠の「今月」判定が予約チェックと表示で別の月を見ている**（月末限定で再現）。月末に凍結を予約すると、直後の表示や別目標からの再予約試行で「空いています」「使用済みです」が食い違う。
2. **目標を削除しても、その目標が追っていたルールが `status='active'` のまま残り続け、当日以降の解錠ゲートを永久にロックする**。`goal-challenge` spec は「削除は成功し、関連する実践・日記も消える」と既に定めているが、実装がこれを満たしていない（rule本体の行が残ること自体は既存の意図的な仕様であり問題ではない。問題は `status` が更新されず `listActiveRules()` に拾われ続けること）。

## What Changes

- `freezeQuota()`（`server/src/services/goal-freeze.ts`）が「今月」を判定する基準を、`reserveFreezeMulti()` と同じ「翌日（発効日）の月」に揃える。
- `deleteGoal()`（`server/src/services/goals.ts`）が、削除対象の目標にのみ紐づく rule（他のどの目標からも `goal_rule` で参照されなくなるもの）を、既存の `removeRule()`（`rule-registry.ts`）で `status='removed'` に遷移させ、`listActiveRules()`（解錠ゲート）の評価対象から外す。rule本体の行・変更履歴は既存どおり残す（物理削除はしない）。他の目標がまだ参照している rule には触れない。
- `goals-freeze.test.ts` の既存赤テスト（「枠の状態は使った目標が分かる形で返る」）を通す。
- `deleteGoal()` が孤児化した rule を `removed` にすること・共有 rule には触れないことの vitest 検証を追加する。
- 既存 e2e `goal-freeze-reserve-flow.spec.ts` は本セッション中に、テスト末尾で作成した2目標を `finally` で `DELETE /api/goals/:id` するクリーンアップを既に追加済み（バグ2修正前は効果が出ない状態だった）。バグ2修正後にこのクリーンアップが機能することを確認する。

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `goal-freeze`: 月枠（quota）の「今月」判定基準を、予約チェックと表示APIで一致させる（翌日＝発効日の月を単一の基準にする）。
- `goal-challenge`: 目標削除時に、その目標にのみ紐づいていたルールが解錠ゲートの評価対象から確実に外れる（孤児のまま残らない）ことを明文化する。

## Impact

- `server/src/services/goal-freeze.ts`（`freezeQuota`）
- `server/src/services/goals.ts`（`deleteGoal`。`rule-registry.ts` の `removeRule` を利用）
- `server/src/api/goals-freeze.test.ts`（既存赤テストが通るようになる）
- `server/src/services/goal-freeze.test.ts`（月末境界のquota一致を検証する決定論的テストを追加）
- `server/src/services/goals.test.ts`（孤児rule除去・共有rule非影響の検証を追加）
- `e2e/goal-freeze-reserve-flow.spec.ts`（今回のセッションで追加済みのクリーンアップが有効化される）
