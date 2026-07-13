## 1. 安定キーとバリデーション（rules）

- [x] 1.1 `server/src/rules/rules.ts` の `deriveConditionKey` の `MANUAL_CHECK` 分岐を `manual:<index>` から `manual:<ラベル(trim)>` へ変更
- [x] 1.2 `upsertFutureRuleSet` に `MANUAL_CHECK` のラベル必須（trim 後非空）バリデーションを追加し、違反を既存エラー様式で拒否
- [x] 1.3 `upsertFutureRuleSet` に同一ルールセット内の `manual:<ラベル>` 重複禁止バリデーションを追加
- [x] 1.4 単体テスト（`rules.test.ts`）: 手動チェックのキーが `manual:<ラベル>` になる／並べ替え・他条件追加でキー不変／空ラベル拒否／重複ラベル拒否

## 2. 採用候補とレポート（goals サービス）

- [x] 2.1 `server/src/services/goals.ts` の `adoptCandidates` から `MANUAL_CHECK` 除外（`if (c.target === 'MANUAL_CHECK') continue;`）を撤廃
- [x] 2.2 `practiceLabel` に `MANUAL_CHECK` 分岐を追加し、ラベルを接頭辞なしで表示
- [x] 2.3 `MANUAL_CHECK` が非時間型として扱われること（`TIME_TARGETS` に含めない＝`isTimeType=false`）を確認・保証
- [x] 2.4 単体テスト（`goals.test.ts`）: 手動チェックが採用候補に出る／採用で `goal_practice` に `condition_key='manual:<ラベル>'`・`target='MANUAL_CHECK'`・ラベルスナップショットが保存される／完走レポート①カレンダーに乗り②時間推移から除外される

## 3. データ移行（migrations）

- [x] 3.1 `server/src/db/migrations.ts` に一括移行を追加: 各 `daily_rule_set` の `rule_condition` を `sort_order, id` 順に読み、グローバル index を再現して `MANUAL_CHECK` 行の `manual:<index>` → `manual:<ラベル>` 対応表を作成
- [x] 3.2 `rule_condition.condition_key` を新キーへ UPDATE
- [x] 3.3 各日の実効ルールセットを解決し、`daily_check` 行の `condition_key`（旧 `manual:<index>`）を新キーへ振り替え、当日チェック状態を保持
- [x] 3.4 衝突（空ラベル／重複ラベル／対応ラベル無し）の行はスキップ＋ログし、旧キーを据え置く
- [x] 3.5 移行テスト（`migrations.test.ts` 相当）: 移行前後で `daily_check` のチェック状態が保持される／`manual:<index>` が残らない／孤児キーは据え置き

## 4. フロント（採用候補 UI）

- [x] 4.1 `server/static/js/goals.js` の候補描画で `MANUAL_CHECK` を表示（`≥ 時間` サブラベルは付けない＝時間型のみ対象）
- [x] 4.2 採用チェックボックスの `value` に `condition_key`（`manual:<ラベル>`）が入り、作成 POST に含まれることを確認

## 5. 検証

- [x] 5.1 デモモードで手動チェックのルールを作成し、目標作成の採用候補に出る→採用→完走レポート①に乗ることを実機確認（`verify-goal-features-via-demo-mode`）
- [x] 5.2 既存 DB（`ref`/バックアップ）に空ラベル/重複ラベルの `MANUAL_CHECK` が無いか確認し、Open Question を解消
- [x] 5.3 全テスト（`vitest`）green を確認
