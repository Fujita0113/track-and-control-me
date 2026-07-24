## ADDED Requirements

### Requirement: GROUP 条件は identity を参照する

解錠ルールの `GROUP` 条件は、グループ identity の内部 ID を参照 SHALL し、`condition_key = 'group:<identityId>'` を持つ。新規作成・編集経路は必ず identity 参照を書き込む SHALL。拡張機能が採番する `stable_group_id` を新規条件の参照先にしてはならない（MUST NOT）。

#### Scenario: 新規 GROUP 条件は identity 参照で保存される

- **WHEN** ルール編集で `競技プログラミング`(yellow) を選び 15 分の GROUP 条件を保存する
- **THEN** その条件は当該 identity の ID を参照し、`condition_key='group:<identityId>'` として保存される

### Requirement: GROUP 条件の達成判定は identity の別名すべての合算で行う

`GROUP` 条件の実績値は、対象日の `session` のうち、記録時点 `(名前, 色)` が当該 identity の**いずれかの別名**に一致する行の `credited_ms` 合計 SHALL とする。これによりグループ別内訳の数字とゲートの進捗は定義上一致 SHALL する。`daily_totals_snapshot` の per-group 生データ・総作業時間・divide-by-N 配分は変更しない（MUST NOT）。

#### Scenario: 内訳とゲートの数字が一致する

- **WHEN** ある日の内訳が `開発`(blue) 2h27m を示している状態で、`開発` を対象とする 15 分の GROUP 条件を評価する
- **THEN** 条件の実績値は 2h27m であり、内訳の数字と一致する

#### Scenario: 別グループの時間で解錠されない

- **WHEN** `競技プログラミング`(yellow) を対象とする GROUP 条件があり、当日は `面接`(grey) にのみ 2 時間が計上されている
- **THEN** その条件の実績値は 0 秒であり、未達成となる

#### Scenario: 別名（改名前の名前）も合算される

- **GIVEN** identity `競プロ`(yellow) が別名として `競技プログラミング`(yellow) を持つ
- **WHEN** 当日 `競技プログラミング` として 90 分、`競プロ` として 30 分が計上されている
- **THEN** その identity を対象とする GROUP 条件の実績値は 120 分になる

### Requirement: GROUP 条件はグループ名で表示される

ゲート画面（今日タブ）の条件進捗・ルール一覧・目標画面は、`GROUP` 条件を identity の**現在名**（および色チップ）で表示 SHALL する。内部 ID や `stable_group_id`（UUID）を利用者に表示してはならない（MUST NOT）。

#### Scenario: ゲート画面にグループ名が出る

- **WHEN** `開発`(blue) を対象とする 15 分の GROUP 条件をゲート画面で表示する
- **THEN** 「グループ: 開発」と現在名で表示され、`70d5118e-e7c2-467d-8097-73a500a5e9bf` のような UUID は表示されない

### Requirement: GROUP 条件の選択肢は直近使用グループから出す

ルール編集および目標のインライン条件作成におけるグループ選択は、直近に実測された identity の一覧（`group-identity-registry`）から選ぶ SHALL。`tab_group` テーブルの行を選択肢の源泉にしてはならない（MUST NOT）。一覧は現在名と色で表示し、合計時間の降順とする。

#### Scenario: 実際に使っているグループだけが候補に出る

- **WHEN** ルール編集で GROUP 条件のグループ選択を開く
- **THEN** 直近30日に計測された identity が現在名・色つきで合計時間降順に並び、UUID 文字列や未計測の古い行は現れない

### Requirement: 旧 `group:<stableGroupId>` 条件は従来経路で評価し表示だけ補正する

identity 参照を持たない既存の `GROUP` 条件（`condition_key='group:<stableGroupId>'`）は、従来どおり `daily_totals_snapshot` の `stable_group_id` 単位で評価 SHALL し、過去の判定結果を変えてはならない（MUST NOT）。表示は `tab_group` の名前で解決し、「（要再設定）」を添えて示す SHALL。名前が解決できない場合は「不明なグループ（要再設定）」とし、UUID を表示してはならない（MUST NOT）。

#### Scenario: 旧条件は名前と要再設定ヒントで表示される

- **WHEN** `condition_key='group:<uuid>'` の凍結済み条件をゲート画面・ルール一覧で表示する
- **THEN** 解決できた名前＋「（要再設定）」が表示され、UUID は表示されない

#### Scenario: 旧条件の過去判定は変わらない

- **WHEN** 移行前後で、旧 `GROUP` 条件を持つ過去日の解錠判定を比較する
- **THEN** 達成/未達成および実績秒は同一である

### Requirement: ゲート画面の TIMELINE 条件はカテゴリ名と分数を表示する

ゲート画面の条件進捗は、`TIMELINE` 条件を「＜カテゴリ名＞ ◯分以上」のラベルと「実績 / 閾値」の副文で表示 SHALL する。ターゲット名のみ（「タイムライン記録」）の表示にとどめてはならない（MUST NOT）。

#### Scenario: TIMELINE 条件の達成状況が読める

- **WHEN** ラベル「運動」・閾値 30 分の TIMELINE 条件があり、当日 12 分が記録されている
- **THEN** ゲート画面に「運動 30分以上」と「0:12 / 0:30」が表示される
