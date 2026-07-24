## ADDED Requirements

### Requirement: 記録時点スナップショットはサーバー側の identity へ解決される

サーバーは、記録時点スナップショット `(tab_group_name_snapshot, group_color_snapshot)` を安定した内部 identity へ解決するレジストリを保持 SHALL する。レジストリは identity 本体（内部 ID・現在名・現在色・作成時刻・最終観測時刻）と、`(名前, 色)` から identity への別名表からなる。

未知の `(名前, 色)` を観測した場合、identity を新規作成し、その組を別名として登録 SHALL する。名前が空文字の組、および未グループ（`stable_group_id = UNGROUPED_KEY`）は identity を作成してはならない（MUST NOT）。未グループは従来どおり単一の `UNGROUPED_KEY` として扱う。

identity の解決は、拡張機能が採番する `stable_group_id` に依存してはならない（MUST NOT）。`stable_group_id` は `session` の生データとしては保持するが、表示・ルール判定の同一性の根拠にはしない。

#### Scenario: 新しい名前と色の組で identity が作られる

- **WHEN** これまでに観測されていない `(競技プログラミング, yellow)` のセッションが記録される
- **THEN** 現在名 `競技プログラミング`・現在色 `yellow` の identity が新規作成され、その `(名前, 色)` が別名として登録される

#### Scenario: 同じ名前と色は同一 identity へ解決される

- **WHEN** 別々の `stable_group_id` を持つ2つのセッションが、いずれも記録時点で `(振り返り, purple)` である
- **THEN** 両者は同一の identity へ解決される

#### Scenario: 壊れた stable_group_id は identity を混ぜない

- **WHEN** 同一の `stable_group_id` を共有する `(面接, grey)` と `(競技プログラミング, yellow)` のセッションが存在する
- **THEN** 2つは別々の identity へ解決され、同じ identity にまとめられない

#### Scenario: 未グループと空名は identity を作らない

- **WHEN** `stable_group_id = UNGROUPED_KEY` のセッション、および名前が空文字のセッションが記録される
- **THEN** identity は作成されず、未グループは従来どおり単一の `UNGROUPED_KEY` として集計される

### Requirement: 既存データから identity を初期構築する

マイグレーションは、既存 `session` の distinct な `(tab_group_name_snapshot, group_color_snapshot)`（空名・未グループを除く）から identity を初期構築 SHALL する。既存 `session` 行・`daily_totals_snapshot`・`unlock_evaluation` を書き換えてはならない（MUST NOT）。改名履歴は推測できないため、初期構築時の別名は identity ごとに1組とする。

#### Scenario: 過去データが名前ごとに分離される

- **WHEN** 過去の `session` に `(面接, grey)` と `(競技プログラミング, yellow)` が同一 `stable_group_id` で存在する状態でマイグレーションを適用する
- **THEN** 2つの identity が作られ、過去の内訳・タイムラインはそれぞれの名前で分離して読み出せる
- **AND** `session` / `daily_totals_snapshot` の行は変更されない

### Requirement: 直近に実測されたグループを一覧できる

システムは、直近 N 日（既定 30 日）に実際に計測された identity を、期間合計時間の降順で返す一覧を提供 SHALL する。各要素は identity ID・現在名・現在色・期間合計秒・最終観測日を含む。合計が 60 秒未満の identity は一覧から除外 SHALL する（グループ名入力途中の断片を候補から排除するため）。

#### Scenario: 実測順に候補が並ぶ

- **WHEN** 直近30日で `開発`(blue) に 12h、`英語`(blue) に 5h、`面接`(grey) に 2h が計上されている状態で一覧を取得する
- **THEN** `開発` → `英語` → `面接` の順で、それぞれの現在名・色つきで返る

#### Scenario: 入力途中の断片は候補に出ない

- **WHEN** グループ名入力の途中で 3 秒だけ観測された `(せっけ, pink)` が identity として存在する
- **THEN** その identity は一覧に含まれない
