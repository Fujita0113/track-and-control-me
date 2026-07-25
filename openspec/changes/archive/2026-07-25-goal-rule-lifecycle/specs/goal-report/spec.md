## MODIFIED Requirements

### Requirement: ① 達成カレンダーは per_condition_results から描く

達成カレンダーは **M日×ルールごとの行**（M=`end_day − start_day + 1`。延長された目標では30を越える・`goal-lifecycle-fork`）で、各日の達成/未達成の2値を表示 SHALL する。値は当該日の `unlock_evaluation.per_condition_results` から、ルールの安定キー `rule:<id>` に一致するエントリの `met` を用いる SHALL。**`rule:<id>` に一致するエントリが無い日は、そのルールの `legacy_condition_key`（`group:<uuid>` 等）に一致するエントリで解決** SHALL する（`editable-rule-registry` の橋渡し）。両方で引けない過去日、または評価行が無い日は**未達成として表示** SHALL する（欠測を美化しない）。未知のフィールドは無視する（前方互換の読み手防御）。

これにより、ルールの中身を差し替え・変更しても安定キーは不変なので、達成カレンダーの当該行は Day 1 から途切れず1行で描かれる SHALL。

ただし、**まだ到来していない日（`day_key > today`）は「未到来」として空白で表示** SHALL し、**未達成として表示してはならない**（MUST NOT）。「欠測（過去日に評価行が無い）＝未達成」と「未到来（まだその日が来ていない）＝空白」は**区別** SHALL する。

#### Scenario: 差し替え後も過去日が途切れない

- **WHEN** 壊れた `group:<uuid>` を参照していたルールを正しい identity へ差し替えた後、レポート①を開く
- **THEN** 差し替え前の過去日は `legacy_condition_key` で解決され、当該ルールの行は Day 1〜今日で途切れない

#### Scenario: 欠測日は未達成として描かれる

- **WHEN** 期間中のある日に `unlock_evaluation` の行が存在しない（サーバー停止日）
- **THEN** その日は全ルールとも未達成マスとして表示される

#### Scenario: 未到来の日は空白で描かれる

- **WHEN** Day 12/30 でレポートプレビューを開く
- **THEN** Day 1〜12 は事実どおり達成／未達成で描かれ、Day 13〜M は未到来として空白で描かれる（未達成マスにならない）

## ADDED Requirements

### Requirement: 完走レポートは続ける／終えるフォークを提示する

完走した目標（`today > end_day`）のレポートは、先頭に **「続ける／終える」フォーク**を提示 SHALL する（`goal-lifecycle-fork`）。進行中（走行中プレビュー）のレポートにはフォークを出してはならない（MUST NOT）。フォークに答えるまでの間、当該目標の永続ルールはゲートに残る（`goal-lifecycle-fork`）。

#### Scenario: 完走レポートにフォークが出る

- **WHEN** 完走した目標のレポートを開く
- **THEN** レポート先頭に「続ける／終える」フォークが表示される

#### Scenario: 進行中プレビューにはフォークが出ない

- **WHEN** Day 12/30 の進行中の目標でレポートプレビューを開く
- **THEN** 「続ける／終える」フォークは表示されない
