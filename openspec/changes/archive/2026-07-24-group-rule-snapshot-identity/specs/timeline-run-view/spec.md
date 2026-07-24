## MODIFIED Requirements

### Requirement: AUTO ブロックは記録時点のスナップショット identity 単位で生成する
タイムラインの AUTO ブロック生成（サーバ側の近接セッション結合）は、束ねる単位を各セッションの `stable_group_id` ではなく、**記録時点のスナップショット `(tab_group_name_snapshot, group_color_snapshot)` を `group-identity-registry` の identity へ解決した結果**とする SHALL。同一 identity へ解決されるセッションのみを近接結合の候補とし、identity が異なるセッションは別ブロックへ分離する SHALL。生成した AUTO ブロックのタイトル・色は、その identity の**現在名・現在色**とする SHALL。

同一タブグループを改名して使い回した場合、旧名は identity の別名として保持されるため、改名をまたいだ区間は**同一 identity の連続した区間**として扱い、現在名でラベル付けする SHALL。改名イベントとして記録されていない別々の `(名前, 色)` の組は、別 identity として分離する SHALL。この結合単位の変更は、`session` の生データ、`creditedMs`、`gaps` 計算、`daily_totals_snapshot`、および `TOTAL_WORK` の解錠ルール評価を変更してはならない（MUST NOT）。

これにより、タイムラインの AUTO ブロックは `today-group-breakdown` のグループ別内訳・振り返りリボン・`GROUP` 条件の実績値と同一の identity 単位で一致 SHALL する。

#### Scenario: 改名していない別名は名前ごとに別ブロックになる
- **WHEN** 同一 `stable_group_id` が、当日 14:15–14:23 は「ブログ投稿」(magenta)、14:23–15:03 は「開発」(blue)、15:08–16:04 は「アルゴリズム」(magenta) として計上され、改名イベントが記録されていない
- **THEN** タイムラインには「ブログ投稿 14:15–14:23」「開発 14:23–15:03」「アルゴリズム 15:08–16:04」が別々の AUTO ブロックとして描画される

#### Scenario: 改名した区間は現在名で1つの identity として扱われる
- **WHEN** 「競技プログラミング」(yellow) で 13:00–14:30 を計上した後に「競プロ」へ改名し、14:30–15:00 を計上する
- **THEN** 両区間とも「競プロ」としてラベル付けされ、近接結合の候補になる（名前が変わったことを理由に分断されない）

#### Scenario: 異なる stable_group_id でも同一 identity なら結合候補になる
- **WHEN** 異なる複数の `stable_group_id` がいずれも記録時点で「振り返り」(purple) として近接して計上されている
- **THEN** それらは1つの「振り返り」(purple) AUTO ブロックへ近接結合される

#### Scenario: 権威データと総作業時間は不変
- **WHEN** 同一のセッション列・同一設定で、AUTO ブロック生成を identity 単位へ切り替える前後を比較する
- **THEN** `daily_totals_snapshot` の per-group 生データ、日の総作業時間、`TOTAL_WORK` 条件の算出値は変わらない

### Requirement: 同一グループ断片のラン結合表示
タイムラインは、**同一 identity へ解決される**隣接 AUTO ブロック a, b を、次の両条件を満たす場合に限り1つのラン（単一ブロック）として描画する SHALL:
1. `b.startAt - a.endAt` が閾値 `away_min_seconds` 未満
2. 区間 `(a.endAt, b.startAt)` に他の描画ブロック（**別 identity の** AUTO、または MANUAL エントリ）が重ならない

グルーピング・列レイアウトのキー、および結合対象の同一性判定はすべて identity を用いる SHALL。同時オープングループ名（`coactiveGroupKeys` の表示名解決）も identity 単位で解決し、現在名で表示する SHALL。結合は描画時のみ行い、サーバーの `session` データ・`creditedMs`・`gaps` 計算には影響しない SHALL。

#### Scenario: 微小離席を挟む同一 identity 断片は1ランになる
- **WHEN** 「面接」(pink) の AUTO ブロックが 10:47–10:55 と 11:01–11:22 に存在し、間隔6分が閾値（10分）未満で、間に別 identity のブロックがない
- **THEN** 10:47–11:22 の単一ブロックとして描画され、タイトル「面接」と時間帯ラベルは1回だけ表示される

#### Scenario: 別 identity の作業を挟む場合は結合しない
- **WHEN** 「面接」ブロックの間（5分）に「ブログ投稿」の AUTO ブロックが存在する
- **THEN** 「面接」は2つの独立したブロックとして描画され、「ブログ投稿」の時間がハッチとして描かれることはない

#### Scenario: 改名していない別名の隣接ブロックは結合されない
- **WHEN** 同一 `stable_group_id` の隣接ブロックが、間隔は閾値未満だが「ブログ投稿」→「開発」と名前が変わっており、改名イベントが記録されていない
- **THEN** 2つは別 identity として扱われ、1つのランへ結合されず、それぞれの名前で別ブロックとして描画される

#### Scenario: 改名した隣接ブロックは結合される
- **WHEN** 「競技プログラミング」→「競プロ」の改名イベントが記録されており、その前後の隣接ブロックの間隔が閾値未満で、間に別 identity のブロックがない
- **THEN** 2つは同一 identity として1ランへ結合され、「競プロ」として1回だけラベル表示される
