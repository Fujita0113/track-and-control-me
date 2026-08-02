## ADDED Requirements

### Requirement: GROUP_OR ルールは複数グループの合計時間で評価される

`GROUP_OR` ターゲットのルールは、関連付けられた複数の `group_identity_id` に対応するすべてのグループ別名（aliases）のセッション時間を合算し、合計秒数が `threshold_seconds` 以上のとき `met=true` と評価 SHALL する。グループは `rule_group_member` テーブルで管理 SHALL する。

#### Scenario: 2グループの合計が閾値以上で充足

- **WHEN** `GROUP_OR` ルールに「英語の勉強」(600秒)・「読書」(900秒) の2グループを設定し、「英語の勉強」に 400秒・「読書」に 200秒 のセッションがある（合計600秒 = 閾値と等しい）
- **THEN** `met=true`・`actualSeconds=600`

#### Scenario: 一方のグループのみでも閾値超過なら充足

- **WHEN** `GROUP_OR` ルールに2グループを設定し、一方のグループだけで閾値秒数を超えている
- **THEN** `met=true`（合計が閾値を超えるため）

#### Scenario: 合計が閾値未満なら未充足

- **WHEN** `GROUP_OR` ルールの全グループの合計セッション時間が閾値秒数未満
- **THEN** `met=false`

#### Scenario: グループに紐づくセッションが0件でも評価できる

- **WHEN** `GROUP_OR` ルールのいずれのグループにもその日のセッションが無い
- **THEN** `actualSeconds=0`・`met=false`（エラーにならない）

### Requirement: GROUP_OR ルールは作成・更新・削除できる

`GROUP_OR` ルールは `createRule` で作成 SHALL し、その際 `groupIdentityIds` 配列（2件以上）と `thresholdSeconds`（1分以上）が必須 SHALL する。`updateRule` では `groupIdentityIds` を丸ごと差し替え SHALL する。理由は `GROUP` ルールと同様に必須 SHALL する。

#### Scenario: 2グループ指定で GROUP_OR ルールを作成する

- **WHEN** `target='GROUP_OR'`・`groupIdentityIds=[id1, id2]`・`thresholdSeconds=1800` で `createRule` を呼ぶ
- **THEN** `rule` 行が挿入され、`rule_group_member` に `(rule_id, id1)`・`(rule_id, id2)` の2行が追加される

#### Scenario: groupIdentityIds が1件以下なら作成エラー

- **WHEN** `target='GROUP_OR'`・`groupIdentityIds=[id1]`（1件のみ）で `createRule` を呼ぶ
- **THEN** `RuleValidationError`（グループは2件以上選択してください）がスローされ、ルールは作成されない

#### Scenario: GROUP_OR ルールのグループ一覧を更新する

- **WHEN** 既存 `GROUP_OR` ルールを `groupIdentityIds=[id1, id3]`（id2 → id3 に変更）で `updateRule` する
- **THEN** `rule_group_member` の旧行が削除され、新しい `(rule_id, id1)`・`(rule_id, id3)` の2行に差し替わる

### Requirement: GROUP_OR ルールの表示は「グループA または グループB XX分以上」

ゲート画面・条件テキスト・ルール一覧では `GROUP_OR` 条件を「〈グループ1〉または〈グループ2〉 XX分以上」の形式で表示 SHALL する。グループが2件の場合は上記形式、3件以上の場合は「〈グループ1〉など XX分以上」と要約する。

#### Scenario: 2グループの GROUP_OR 条件を表示する

- **WHEN** `GROUP_OR` ルールに「英語の勉強」「読書」の2グループ・閾値30分が設定されている
- **THEN** 条件テキストは「英語の勉強 または 読書 30分以上」と表示される

#### Scenario: 3グループ以上の GROUP_OR 条件を要約表示する

- **WHEN** `GROUP_OR` ルールに3件以上のグループが設定されている
- **THEN** 条件テキストは「〈最初のグループ名〉など XX分以上」のように先頭グループ名＋「など」で要約表示される
