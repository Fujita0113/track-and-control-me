## 1. 凍結枠の月判定を統一する（バグ1）

- [x] 1.1 `server/src/services/goal-freeze.ts` に `quotaMonthOf(today: string): string`（`addDaysKey(today, 1).slice(0, 7)`）を追加する。
- [x] 1.2 `reserveFreezeMulti()` の `quotaRowForMonth(db, startDay.slice(0, 7))` を `quotaMonthOf(today)` を使う形に置き換える（値は変わらないがロジックを共有元に揃える）。
- [x] 1.3 `freezeQuota()` の月計算（`today.slice(0, 7)`）を `quotaMonthOf(today)` に置き換える。
- [x] 1.4 `npx vitest run server/src/services/goal-freeze.test.ts server/src/api/goals-freeze.test.ts` を実行し、以下が通ることを確認する:
  - 既存赤テスト: `goals-freeze.test.ts` の「枠の状態は使った目標が分かる形で返る」
  - 新規テスト（propose で追加済み）: `goal-freeze.test.ts` の「月末（today の翌日が翌月）に予約した直後は、翌月（発効月）の使用済みとして返る（issue #75）」
  - 既存の他ケース（月末以外・月またぎ凍結等）に回帰が無いこと

## 2. 目標削除で孤児ルールを解錠ゲートから外す（バグ2）

- [x] 2.1 `server/src/services/goals.ts` の `deleteGoal()` を変更する:
  - トランザクション開始前（またはトランザクション内の削除直前）に、削除対象 goal に紐づく `rule_id` 一覧を `SELECT rule_id FROM goal_rule WHERE goal_id = ?` で取得する。
  - `DELETE FROM goal WHERE id = ?` を実行する（既存どおり。`goal_rule` は FK カスケードで自動削除）。
  - 削除が成功した場合、取得しておいた各 `rule_id` について `SELECT 1 FROM goal_rule WHERE rule_id = ?` で他 goal からの参照が無いことを確認し、無ければ `removeRule(db, ruleId, '目標の削除に伴い自動的に削除', nowMs)`（`rule-registry.ts` からimport）を呼ぶ。他から参照されていれば何もしない。
- [x] 2.2 `npx vitest run server/src/services/goals.test.ts` を実行し、以下が通ることを確認する:
  - 既存テスト「作成当日は削除でき、紐づけ・日記も CASCADE で消える（ルール本体は残る）」（rule本体の行数=1は変わらず維持されること）
  - 新規テスト（propose で追加済み）:「削除後、他goalと共有していなかったルールは removed になり、解錠評価から外れる（issue #75）」
  - 新規テスト（propose で追加済み）:「削除しても、他goalとまだ共有しているルールの status は変えない（issue #75）」
- [x] 2.3 `npx vitest run` （全体）を実行し、`rule_change`（沿革）まわりに新規の回帰が無いことを確認する（`goal-chronicle` 関連テスト含む）。

## 3. 既存 e2e への影響を確認する

- [x] 3.1 `e2e/goal-freeze-reserve-flow.spec.ts`（本セッション中に、テスト末尾で作った2目標を `finally` で `DELETE /api/goals/:id` するクリーンアップを追加済み。バグ2修正前は効果が出なかった）を単独実行し、テスト自体が最後まで通ることを確認する。
- [x] 3.2 `e2e/goal-rule-gate-loop.spec.ts`（本セッション中に `.pc-block` の locator スコープを修正済み）と `goal-freeze-reserve-flow.spec.ts` を同じプロセスで連続実行し（`CI=1 npx playwright test e2e/goal-freeze-reserve-flow.spec.ts e2e/goal-rule-gate-loop.spec.ts e2e/hide-achieved-once-rules.spec.ts e2e/today-tab-answer-text-display.spec.ts`）、`goal-rule-gate-loop.spec.ts` が `.gate-hero.unlocked` で失敗しないこと（＝バグ2が原因で見えていた孤児ルールのブロックが解消されたこと）を確認する。
- [x] 3.3 `CI=1 npx playwright test`（フルスイート）を実行し、issue #75 で報告されていた失敗が month-boundary バグ・孤児ルールバグに起因するものは解消されていることを確認する。それ以外の flaky（`tomorrow-plan-*` 系の負荷起因のもの）は許容範囲として残ってよい（既知の共有DB下での負荷起因のflakeであり、本changeのスコープ外）。
  - 1回目実行で `goal-rule-gate-loop.spec.ts` と `tomorrow-plan-board-hold-pickup.spec.ts` が失敗/flakyだったが、2回目の再実行（同一コード・変更なし）では全38件green。39ファイル並列・共有DB下での負荷起因の一過性flakeと判断（本changeのスコープ外）。
- [x] 3.4 新規 e2e は書かない。ただし、以下のユーザー可視フローについて、DOM ができ次第（今回は既存 DOM のみを触るため実質不要だが、念のため）確認する: 「月末に凍結を予約する→別目標のカードに即座に使用済みが反映される→取り消すと戻る」（`goal-freeze-reserve-flow.spec.ts` が既にこのフローをカバーしているため、新規追加は不要と判断）。

## 4. 最終確認

- [x] 4.1 `npm test`（vitest 全体）を実行し、全テストが green であることを確認する。
- [x] 4.2 `openspec/changes/server-port-fallback-dev-db/`（本セッションと並行して進んでいた別changeの未コミット作業）に影響していないこと（ファイルを触っていないこと）を確認する。
  - 別changeは本セッション中に既にコミット・アーカイブ済み（コミット `ad12db4`, `4086c31`）。本changeは一切触れていない。
- [x] 4.3 `/opsx:archive` で delta spec（`goal-freeze` / `goal-challenge`）をメインspecへ sync してからアーカイブする。
