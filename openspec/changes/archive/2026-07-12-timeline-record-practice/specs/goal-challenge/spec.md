## MODIFIED Requirements

### Requirement: 実践の採用は condition_key で行う

目標の実践は、開始日（翌日）の実効ルールセットに現存する条件から選択し、その `condition_key`（`total_work` / `group:<stableGroupId>` / `planning:<signalKey>` / `timeline:<ラベル>`）の文字列を保存 SHALL する。`MANUAL_CHECK` ターゲットの条件は同一性が並び順依存（`manual:<index>`）のため採用候補に含めてはならない（MUST NOT）が、`TIMELINE` ターゲットの条件は安定キー（`timeline:<ラベル>`）を持つため採用候補に含める SHALL。採用時に表示用ラベル（グループ名・カテゴリ名等）のスナップショットを保存 SHALL する。

#### Scenario: 翌日の実効ルールから採用候補が出る

- **WHEN** 目標作成 UI を開く
- **THEN** 翌日の実効ルールセットの `TOTAL_WORK` / `GROUP` / `PLANNING` / `TIMELINE` 条件が候補として表示され、`MANUAL_CHECK` 条件は表示されない

#### Scenario: 採用実践はキー文字列で保存される

- **WHEN** 「総作業時間 4時間」条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='total_work'` が保存される

#### Scenario: TIMELINE 条件を実践として採用できる

- **WHEN** ラベル「運動」・30分の `TIMELINE` 条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='timeline:運動'`・`target='TIMELINE'`・ラベルスナップショット「運動」が保存される

### Requirement: 閾値変更には理由が必須で、記録される

採用中の実践に対応する時間型条件（`TOTAL_WORK` / `GROUP` / `TIMELINE`）の `threshold_seconds` を変更する編集（上げ下げ問わず）は、非空の理由テキストを伴わなければならない（MUST）。理由が無い場合は編集を拒否 SHALL する。変更は `condition_key`・適用日・変更前後の秒数・理由として永続化 SHALL し、同一条件を複数目標が採用していても記録は1本とする。採用されていない条件の閾値変更は従来どおり理由不要（MUST NOT 要求）。

#### Scenario: 理由なしの閾値変更は拒否される

- **WHEN** 採用中の「総作業時間 4時間」を 3時間 に変更する PUT を理由なしで送る
- **THEN** 400 エラーになりルールセットは変更されない

#### Scenario: 理由つきの閾値変更は記録される

- **WHEN** 同じ変更を理由「課題週間。ゼロにはしない」つきで送る
- **THEN** 編集は成功し、変更記録（14400→10800・適用日・理由）が保存される

#### Scenario: TIMELINE 閾値の緩和も理由が必須

- **WHEN** 採用中のラベル「運動」の `TIMELINE` 条件を 30分→15分 に変更する PUT を理由なしで送る
- **THEN** 400 エラーになり、理由つきで送ると変更記録（1800→900・適用日・理由）が保存される
