## 1. サーバー: TIMELINE 条件の型と条件キー

- [x] 1.1 `rules/rules.ts` の `RuleTarget` に `'TIMELINE'` を追加する
- [x] 1.2 `deriveConditionKey` に `case 'TIMELINE': return 'timeline:' + label` を追加する（label 未指定時のフォールバックも定義）
- [x] 1.3 `contentHash` の対象フィールドに `TIMELINE` の `label`/`thresholdSeconds` が含まれることを確認（既存で label/threshold は入っているため差分がハッシュに反映されるか検証）
- [x] 1.4 `rule_condition.target` に CHECK 制約／トリガの禁止が無いことを migrations.ts で最終確認。制約があれば relax マイグレーションを1本追加する

## 2. サーバー: 評価

- [x] 2.1 `rules/evaluate.ts` の `switch(c.target)` に `case 'TIMELINE'` を追加し、当日 `activity_log_entry`（`entry_type='MANUAL'` AND `category_key = c.label`）の `SUM(end_at-start_at)/1000` を `actualSeconds` に、`met = actualSeconds >= threshold_seconds` を算出する
- [x] 2.2 `per_condition_results` に `actualSeconds`/`thresholdSeconds` が焼き込まれることを確認（既存 push 経路で自動、追加分岐が無いこと）

## 3. サーバー: 目標採用・ジャンル固定・閾値理由

- [x] 3.1 `services/goals.ts` の `GoalPracticeTarget` に `'TIMELINE'` を、`TIME_TARGETS` に `'TIMELINE'` を追加する
- [x] 3.2 `adoptCandidates` の除外は `MANUAL_CHECK` のみに保ち、`TIMELINE` が候補に含まれることを確認する
- [x] 3.3 `practiceLabel` を拡張し、`TIMELINE` 候補・採用の表示ラベルを「<カテゴリ> ◯分以上」で返す
- [x] 3.4 `recordThresholdChanges` の対象 `target IN ('TOTAL_WORK','GROUP')` に `'TIMELINE'` を加え、閾値変更の理由必須・記録を効かせる
- [x] 3.5 `assertGoalsSatisfied` が `timeline:*` の `condition_key` も残期間で保護することを確認（文字列ベースのため実装追加不要・テストで担保）

## 4. サーバー: テスト

- [x] 4.1 evaluate: ラベル一致合計≥閾値で met、未満で not met、別ラベル/AUTO を算入しないケース
- [x] 4.2 rules: `TIMELINE` 条件の `condition_key='timeline:<label>'` が並べ替えで不変
- [x] 4.3 goals: `TIMELINE` 条件を採用できる／`manual:*` は依然採用不可
- [x] 4.4 goals: 採用中 `TIMELINE` の閾値変更が理由なしで拒否・理由つきで記録される
- [x] 4.5 goals: ジャンル固定で採用中 `timeline:運動` を外す編集が拒否される
- [x] 4.6 report: `TIMELINE` 実践が①カレンダー・②時間推移（isTimeType）に乗る

## 5. フロント: ルール編集 UI

- [x] 5.1 `static/js/rules.js` の条件ドロップダウンに「タイムライン記録」を追加する
- [x] 5.2 選択時にカテゴリ選択（`GET /api/categories` 直近使用順）＋分数入力を表示し、保存ペイロード `{target:'TIMELINE', label, thresholdSeconds}` を組む
- [x] 5.3 未登録カテゴリ名の入力はレジストリへ upsert される（記録経路と同じ扱い）ことを確認する
- [x] 5.4 一覧・ゲート画面の条件テキストを「<カテゴリ> ◯分以上」で表示（`timeline:` 生キーを出さない）

## 6. フロント: 目標作成・レポート

- [x] 6.1 `static/js/goals.js` の採用候補に `TIMELINE` が「<カテゴリ> ◯分以上」ラベルで並ぶことを確認する
- [x] 6.2 完走レポート②に `TIMELINE` 実践の折れ線＋閾値が描画されることを確認する

## 7. 検証

- [x] 7.1 `npm test` と typecheck をクリアする
- [x] 7.2 実機スモーク: 「運動」ラベルの `TIMELINE` 条件を作成→目標に採用→当日「運動」記録で met、閾値未満で not met、閾値変更に理由必須、完走レポート①②に反映（過去日シードで確認）
- [x] 7.3 既存目標・ルール（`TIMELINE` 無し）が完全 no-op で不変であることを確認する
