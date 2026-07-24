## MODIFIED Requirements

### Requirement: Check は解錠ゲートへ合成条件として合流する

システムは、対象日に**有効な写真ルール・質問ルール**（旧 Check。`editable-rule-registry` の `target=PHOTO`/`QUESTION`）を、その日の解錠評価へ **AND の未達成条件として合流** SHALL する。合流は他の時間型・非時間型ルールと同じく安定キー `conditionKey='rule:<id>'` を用い SHALL、専用の `check:<checkId>` 名前空間は廃止 SHALL する（写真・質問も第一級ルールに畳まれたため）。合流は当日のゲートを**厳しくする方向にのみ**働く SHALL。

写真・質問ルールの達成状態は**評価時に対象日から遅延導出** SHALL する（日次 cron に依存せず、オンデマンド起動でも正しく発火させるため）。`start_day`（開始日）より前の日には合流してはならない（MUST NOT）。

#### Scenario: 開始日前はゲートに影響しない

- **WHEN** 写真ルールを作成した直後（`start_day` 到達前）の日を評価する
- **THEN** その日の解錠評価に当該ルールは現れない

#### Scenario: 未達の写真ルールがあるとパスワードが出ない

- **WHEN** 開始日を迎えた未達の写真ルールがある日に、他の条件（総作業時間・翌日の計画）をすべて満たす
- **THEN** その日の解錠状態は LOCKED のままで、パスワードは表示されない

#### Scenario: 合流は rule:<id> 名前空間を使う

- **WHEN** 写真ルール（id=42）が当日ゲートに合流する
- **THEN** そのゲート条件の `conditionKey` は `rule:42` であり、`check:<checkId>` 形式は使われない
