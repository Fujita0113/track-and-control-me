## Context

30日チャレンジ（`goal-challenge`）の実践採用は `condition_key` を安定識別子として使い、期間中その条件が実効ルールから欠けないことを検証する（ジャンル固定 `GoalLockError`）。この前提を満たすには、キーが並び順や他条件の増減で変化しないことが必須。

現状の `MANUAL_CHECK` は `deriveConditionKey(c, index)`（`server/src/rules/rules.ts:137`）で `manual:<index>` を返す。ここでの `index` は条件配列の**グローバル位置**（`input.conditions.map((c, i) => ...)`）なので、手動チェックより前に別条件が挿入されるだけでキーがずれる。この弱同一性ゆえに `adoptCandidates`（`server/src/services/goals.ts:159`）は `MANUAL_CHECK` を明示的に除外しており、これが issue #46（手動チェックが採用候補に出ない）の直接原因。

同種の問題は `TIMELINE` で先に解決済み。`timeline:<ラベル>`（`server/src/rules/rules.ts:148-151`）を安定キーに採用し、`goal-challenge` 実践として採用可能にした（`timeline-record-condition`）。本変更は同じ設計を `MANUAL_CHECK` に横展開する。

`MANUAL_CHECK` の当日チェック状態は `daily_check (day_key, condition_key, checked)`（`server/src/rules/checks.ts`）に `condition_key` で保存され、達成判定は評価パイプラインを通って `unlock_evaluation.per_condition_results` に条件キー単位で焼き込まれる。完走レポート（`getGoalReport`）はこの `per_condition_results` を `condition_key` で引く。したがってキー文字列が安定していれば、レポート①カレンダーには自然に乗る。

## Goals / Non-Goals

**Goals:**
- `MANUAL_CHECK` を `manual:<ラベル>` の安定キーに変更し、目標作成の採用候補に含める。
- 採用時は非時間型（チェック型）実践として扱う（②時間推移からは除外、①カレンダーには乗る）。
- 既存の `manual:<index>` データ（`rule_condition`・`daily_check`）をマイグレーションで安定キーへ振り替え、当日チェック状態を失わない。
- 安定キーの一意性を担保するため、`MANUAL_CHECK` のラベルを必須かつルールセット内一意にする。

**Non-Goals:**
- `TIMELINE` / `GROUP` / `PLANNING` / `TOTAL_WORK` のキー体系は変更しない。
- `MANUAL_CHECK` の評価ロジック（チェックの有無で met を決める）自体は変更しない。キー文字列のみが変わる。
- `unlock_evaluation` の履歴 JSON の遡及移行は行わない（下記 Decisions 参照）。
- 手動チェックに閾値・時間概念を導入しない。

## Decisions

### D1: キーは `manual:<ラベル>`（ラベル＝チェックのテキスト）
`TIMELINE` の `timeline:<ラベル>` と対称。ラベルは手動チェックの表示テキストそのもので、ユーザーにとっての同一性と一致する。`deriveConditionKey` の `MANUAL_CHECK` 分岐を `return 'manual:' + (c.label ?? '').trim()` に変更する。
- 代替案: `MANUAL_CHECK` に別途 stable id（UUID）列を持たせる。→ スキーマ拡張と UI 変更が重く、`TIMELINE` 先例と非対称。ラベルで十分安定するため不採用。

### D2: ラベル必須＋ルールセット内一意
ラベルをキーに使う以上、空ラベルはキー衝突（`manual:`）を生み、重複ラベルは2条件が同一キーに畳まれる。`upsertFutureRuleSet` の検証で、`MANUAL_CHECK` 条件について (a) trim 後非空、(b) 同一ルールセット内で `manual:<ラベル>` が重複しないこと、を確認し、違反は既存のバリデーションエラー様式で拒否する。`TIMELINE` も同じラベル一意性を暗黙に要求しており（`goals.ts:315` で既存ラベル集合を扱う）、整合的。

### D3: 採用候補の除外撤廃と非時間型表示
`adoptCandidates`（`goals.ts:158-168`）の `if (c.target === 'MANUAL_CHECK') continue;` を削除。`practiceLabel` に `MANUAL_CHECK` 分岐を追加し、ラベルをそのまま表示（接頭辞なし）。フロント `goals.js` の候補描画は、`MANUAL_CHECK` を時間型（`TOTAL_WORK`/`GROUP`）の `≥ 時間` サブラベル対象から除外する（`c.target === 'MANUAL_CHECK'` はサブラベルなし）。`TIME_TARGETS`（`goals.ts`）には `MANUAL_CHECK` を含めない＝レポートで `isTimeType=false`。

### D4: マイグレーションは rule_condition＋daily_check のみ、履歴 JSON は据え置き
移行手順（1回きり、`migrations.ts`）:
1. 各 `daily_rule_set` について `rule_condition` を `sort_order, id` 順に読み、グローバル index を再現。`MANUAL_CHECK` 行の旧キー `manual:<index>` → 新キー `manual:<label>` の対応表を作る。
2. `rule_condition.condition_key` を新キーへ UPDATE。
3. 同じ対応を使い、その rule_set の実効日レンジに属する `daily_check` 行の `condition_key` を新キーへ振り替え。
   - 注意: `daily_check` は `day_key` 単位で、どの rule_set が実効かは持ち越しで決まる。実装上は「旧キー `manual:<index>` を、その日に実効なルールセットの同 index のラベルへ写す」形で日ごとに解決する。
- `unlock_evaluation.per_condition_results` は移行しない: 従来 `MANUAL_CHECK` を採用できる目標が存在し得なかったため、どの完走レポートもこの履歴キーを参照しない。移行コスト（JSON 全走査・書換）に見合う効果がない。

### D5: index の再現方法
旧キーの `index` は挿入時の**配列グローバル位置**であり、`upsertFutureRuleSet` は `sort_order = i` で書き込む（`rules.ts` の INSERT）。よって「`sort_order` 昇順・同値は `id` 昇順」で並べたときの 0 始まり順位が旧 index に一致する。マイグレーションはこの順位で index→label を解決する。

## Risks / Trade-offs

- [ラベル変更でキーが変わる（同一性がラベルに依存）] → `TIMELINE` と同じ既知のトレードオフ。手動チェックのテキストを改名すると別条件扱いになる。採用中目標があればジャンル固定検証（`GoalLockError`）が旧キーの欠落を検知して改名編集を拒否するため、期間中に採用実践が静かに壊れることはない。仕様として「ラベル＝同一性」を明記する。
- [マイグレーションの index→label 解決ミス] → `daily_check` は day 単位で実効ルールセットが持ち越しにより変わるため、日ごとの実効ルールセットを正しく解決する必要がある。移行前後の `daily_check` 件数・チェック状態を検証するテストを用意。万一マッピング不能な孤児キー（対応ラベル無し）は据え置き（削除しない）。
- [既存の空ラベル/重複ラベル `MANUAL_CHECK` データ] → 移行時に空ラベルは `manual:`、重複は同一キーへ畳まれる。移行スクリプトで衝突検出時はログを残し、当該行はスキップ（旧キー据え置き）して手当ての余地を残す。単独開発・データ規模小のため実害は限定的。
- [フロントの非時間型描画漏れ] → `MANUAL_CHECK` に誤って `≥ 時間` が出ないよう、候補描画とレポート `isTimeType` の両方でターゲット判定を確認する。

## Migration Plan

1. `deriveConditionKey` の `MANUAL_CHECK` を `manual:<label>` へ変更。
2. `upsertFutureRuleSet` にラベル必須・一意バリデーションを追加。
3. `adoptCandidates` の除外撤廃＋`practiceLabel` に `MANUAL_CHECK` 分岐。
4. `goals.js` 候補描画を非時間型対応に。
5. `migrations.ts` に `manual:<index>` → `manual:<label>` の一括移行（`rule_condition`・`daily_check`）を追加。
6. 単体テスト（キー派生・候補・移行）＋デモモードでの実機確認（`verify-goal-features-via-demo-mode` に沿う）。
- ロールバック: 本番デプロイ前提が単独開発のため、問題時は移行前 DB バックアップ（`backups/`）から復元。

## Open Questions

- 移行後、既存の空ラベル `MANUAL_CHECK` 条件が実データに存在するか（`ref`/実 DB を確認）。存在する場合は移行前にラベル付与を促すか、`manual:` を許容するかを最終決定する（暫定: スキップ＋ログ）。
