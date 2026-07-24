# today-group-breakdown Specification

## Purpose
TBD - created by syncing change today-group-snapshot-labels. Update Purpose after archive.

## Requirements

### Requirement: グループ別内訳は記録時点のスナップショット identity で分類する

今日タブおよび range サマリの「グループ別」内訳は、各時間が計上された**記録時点のスナップショット名（`tab_group_name_snapshot`）と色（`group_color_snapshot`）の組**を、`group-identity-registry` の identity へ解決したうえで、その identity を分類キーとして集計 SHALL する。ラベル・色は identity の**現在名・現在色**とする SHALL。

現在の `tab_group` 行の名前／色でラベルを解決してはならない（MUST NOT）。`tab_group` の行は拡張機能が採番する `stable_group_id` に紐づいており、その採番が壊れた場合に無関係なグループの名前を持つため、表示の根拠にしない。identity の現在名は改名イベント（`tab-group-rename-tracking`）でのみ変化し、`stable_group_id` の採番には依存しない。

同一 identity へ解決される時間は1スライスへ合算 SHALL し、異なる identity は別スライスとして分離 SHALL する。改名をまたいだ区間（旧名が identity の別名として保持されている場合）は、現在名の1スライスへ合算 SHALL する。改名として記録されていない別々の `(名前, 色)` の組は、別 identity として分離 SHALL する。

これにより、同一ビュー内でグループ別内訳がタイムライン（同じ identity 解決を通す）と一致 SHALL する。本要件は表示内訳の分類・ラベル・彩色を規定し、`daily_totals_snapshot` の生データ・総作業時間には影響しない SHALL。

#### Scenario: 改名していない別名のグループは別スライスになる

- **WHEN** ある日に、同一の `stable_group_id` で `webエンジニアリング`(pink) として 1.6h、`振り返り`(purple) として 0.3h が計上され、両者の間に改名イベントが記録されていない
- **THEN** グループ別内訳には `webエンジニアリング`(pink) 1.6h と `振り返り`(purple) 0.3h が**別々のスライス**として現れる
- **AND** `stable_group_id` が同一であることを理由に1スライスへ吸収されない

#### Scenario: 改名した区間は現在名の1スライスに合算される

- **WHEN** ある日に `競技プログラミング`(yellow) として 90 分を計上した後、そのグループを `競プロ` へ改名し、さらに 30 分を計上する
- **THEN** グループ別内訳には `競プロ` 120 分の単一スライスが現れ、旧名のスライスは残らない

#### Scenario: 内訳の分類がタイムラインと一致する

- **WHEN** 同じ日について、今日タブのグループ別内訳とタイムラインの AUTO ブロックを比較する
- **THEN** 両者は同一の identity 単位で同じ持ち分を示し、食い違わない

#### Scenario: 同一の記録時点 identity は合算される

- **WHEN** ある日に、異なる複数の `stable_group_id` がいずれも記録時点で `振り返り`(purple) として計上されている
- **THEN** グループ別内訳ではそれらが1つの `振り返り`(purple) スライスへ合算される

### Requirement: 生データ・総作業時間・ルール評価は不変を保つ

本内訳の集計方式変更は、`daily_totals_snapshot` の per-group 生データ、日の総作業時間を書き換えても算出値を変えてもならない（MUST NOT）。内訳は表示専用の再集計であり、権威データは従来の `stable_group_id` 単位のまま保持 SHALL する。

解錠ルール評価のうち `TOTAL_WORK` の算出値は不変 SHALL とする。`GROUP` 条件の判定単位は本改訂で内訳と同じ identity 単位へ揃える（`group-rule-identity`）ため、識別が壊れていた `stable_group_id` 単位の旧判定と一致することは要求しない。identity 参照を持たない旧 `GROUP` 条件（`group:<stableGroupId>`）の算出値は従来どおり不変 SHALL とする。

#### Scenario: 集計方式変更後も総作業時間は同一

- **WHEN** 同一のサンプル列・同一設定で、内訳を identity 集計へ切り替える前後を比較する
- **THEN** 日の総作業時間の秒数は同一である
- **AND** `TOTAL_WORK` 条件および旧 `group:<stableGroupId>` 条件の達成判定は同一である

#### Scenario: 内訳と GROUP 条件の実績が一致する

- **WHEN** identity 参照を持つ `GROUP` 条件の実績秒と、同じ identity の内訳スライスの秒数を比較する
- **THEN** 両者は一致する

### Requirement: 未グループ行は表示され非計上ヒントを保持する

グループ別内訳をスナップショット identity で再集計しても、未グループ（`ungrouped` = `UNGROUPED_KEY`）の時間は1つの未グループ行として表示 SHALL し、`exclude_ungrouped_from_total` が ON のときは「総作業時間に非計上」である表示ヒントを従来どおり付与 SHALL する。

#### Scenario: 未グループは単一行として表示され非計上が分かる

- **WHEN** ある日に未グループの計上時間があり、`exclude_ungrouped_from_total` が ON である
- **THEN** グループ別内訳に未グループ行が時間つきで表示される
- **AND** その行には総作業時間に非計上である旨のヒントが付く

### Requirement: 直近7日の内訳にも同一の分類を適用する

range サマリ（直近7日の積み上げ棒グラフ用データ）の各日の `groups` も、identity 単位で集計・ラベル・彩色 SHALL する。日をまたいで同一 identity の系列は同一の凡例・色で連続表示 SHALL し、系列名は identity の現在名 SHALL とする。

#### Scenario: 7日棒グラフでも別グループの系列が保持される

- **WHEN** 直近7日のうち一部の日に `webエンジニアリング`(pink) の計上があり、同じ `stable_group_id` が別の日に `振り返り`(purple) として計上されている（改名イベントなし）
- **THEN** 棒グラフには `webエンジニアリング`(pink) 系列が該当日の値つきで現れ、`振り返り` に吸収されない

#### Scenario: 改名した系列は現在名で連続する

- **WHEN** 期間の途中で `競技プログラミング` を `競プロ` へ改名している
- **THEN** 棒グラフの系列は `競プロ` 1本として、改名前の日の値も含めて連続表示される
