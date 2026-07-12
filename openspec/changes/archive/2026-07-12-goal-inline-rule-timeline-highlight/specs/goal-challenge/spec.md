## MODIFIED Requirements

### Requirement: 実践の採用は condition_key で行う

目標の実践は、開始日（翌日）の実効ルールセットに現存する条件から選択するか、または目標作成時にその場で作成して翌日ルールへ追記した新規条件（`goal-inline-condition`）から採用し、その `condition_key`（`total_work` / `group:<stableGroupId>` / `planning:<signalKey>` / `timeline:<ラベル>`）の文字列を保存 SHALL する。`MANUAL_CHECK` ターゲットの条件は同一性が並び順依存（`manual:<index>`）のため採用候補に含めてはならない（MUST NOT）が、`TIMELINE` ターゲットの条件は安定キー（`timeline:<ラベル>`）を持つため採用候補に含める SHALL。インライン作成した条件は、翌日ルールへ追記され採用可能になった時点で、既存条件と同じく `condition_key` 文字列で採用 SHALL する。採用時に表示用ラベル（グループ名・カテゴリ名等）のスナップショットを保存 SHALL する。

#### Scenario: 翌日の実効ルールから採用候補が出る

- **WHEN** 目標作成 UI を開く
- **THEN** 翌日の実効ルールセットの `TOTAL_WORK` / `GROUP` / `PLANNING` / `TIMELINE` 条件が候補として表示され、`MANUAL_CHECK` 条件は表示されない

#### Scenario: 採用実践はキー文字列で保存される

- **WHEN** 「総作業時間 4時間」条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='total_work'` が保存される

#### Scenario: TIMELINE 条件を実践として採用できる

- **WHEN** ラベル「運動」・30分の `TIMELINE` 条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='timeline:運動'`・`target='TIMELINE'`・ラベルスナップショット「運動」が保存される

#### Scenario: インライン作成した条件がそのまま採用される

- **WHEN** 目標作成で新規「掃除・15分」の TIMELINE 条件をその場で作成して目標を作成する
- **THEN** その条件は翌日ルールへ追記され、`goal_practice` に `condition_key='timeline:掃除'`・`target='TIMELINE'` が保存される
