## MODIFIED Requirements

### Requirement: 実践の採用は condition_key で行う

目標の実践は、**開始日（今日開始なら当日・明日開始なら翌日）** の実効ルールセットに現存する条件から選択するか、または目標作成時にその場で作成して開始日のルールへ追記した新規条件（`goal-inline-condition`）から採用し、その `condition_key`（`total_work` / `group:<identityId>` / `planning:<signalKey>` / `timeline:<ラベル>` / `manual:<ラベル>`）の文字列を保存 SHALL する。安定キーを持つターゲット（`TOTAL_WORK` / `GROUP` / `PLANNING` / `TIMELINE` / `MANUAL_CHECK`）はいずれも採用候補に含める SHALL。かつては `MANUAL_CHECK` の同一性が並び順依存（`manual:<index>`）であったため採用候補から除外していたが、安定キー `manual:<ラベル>`（`manual-check-stable-key`）の導入により採用可能になった。`MANUAL_CHECK` は完了/未完了（チェック）型の非時間型実践として採用 SHALL され、閾値（`threshold_seconds`）を持たない。インライン作成した条件は、開始日のルールへ追記され採用可能になった時点で、既存条件と同じく `condition_key` 文字列で採用 SHALL する。採用時に表示用ラベル（グループ名・カテゴリ名・手動チェックのテキスト等）のスナップショットを保存 SHALL する。

`GROUP` 実践のキーはグループ identity の内部 ID（`group-identity-registry`）を参照 SHALL し、拡張機能が採番する `stable_group_id` を新規に参照してはならない（MUST NOT）。対象グループが改名された場合、`condition_key` は変化させず、保存済みの表示用ラベルスナップショットを新しい名前へ更新 SHALL する（`tab-group-rename-tracking`）。過去に保存された `group:<stableGroupId>` 形式の実践キーは引き続き有効 SHALL とし、書き換えてはならない（MUST NOT）。

#### Scenario: 開始日の実効ルールから採用候補が出る

- **WHEN** 目標作成 UI を開く
- **THEN** 選択した開始日（今日／明日）の実効ルールセットの `TOTAL_WORK` / `GROUP` / `PLANNING` / `TIMELINE` / `MANUAL_CHECK` 条件が候補として表示される
- **AND** `GROUP` 条件はグループ名（現在名）で表示され、UUID や内部 ID は表示されない

#### Scenario: 採用実践はキー文字列で保存される

- **WHEN** 「総作業時間 4時間」条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='total_work'` が保存される

#### Scenario: TIMELINE 条件を実践として採用できる

- **WHEN** ラベル「運動」・30分の `TIMELINE` 条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='timeline:運動'`・`target='TIMELINE'`・ラベルスナップショット「運動」が保存される

#### Scenario: MANUAL_CHECK 条件を実践として採用できる

- **WHEN** ラベル「筋トレ」の `MANUAL_CHECK` 条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='manual:筋トレ'`・`target='MANUAL_CHECK'`・ラベルスナップショット「筋トレ」が保存され、非時間型として扱われる

#### Scenario: インライン作成した条件がそのまま採用される

- **WHEN** 目標作成で新規「掃除・15分」の TIMELINE 条件をその場で作成して目標を作成する
- **THEN** その条件は翌日ルールへ追記され、`goal_practice` に `condition_key='timeline:掃除'`・`target='TIMELINE'` が保存される

#### Scenario: GROUP 実践は identity 参照で保存される

- **WHEN** `競技プログラミング` を対象とする GROUP 条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='group:<identityId>'` と、その時点の名前のラベルスナップショットが保存される

#### Scenario: 改名でキーは変わらずラベルだけ更新される

- **WHEN** 採用中の GROUP 実践の対象グループを `競技プログラミング` から `競プロ` へ改名する
- **THEN** `condition_key` は変化せず、目標画面の実践名が `競プロ` として表示される
