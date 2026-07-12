## ADDED Requirements

### Requirement: グループ別内訳は記録時点のスナップショット identity で分類する

今日タブおよび range サマリの「グループ別」内訳は、各時間が計上された**記録時点のスナップショット名（`tab_group_name_snapshot`）と色（`group_color_snapshot`）の組**を分類キーとして集計 SHALL する。現在の `tab_group` 行の名前／色でラベルを解決してはならず（MUST NOT）、Edge 側での改名・色変更をまたいだ時間を現在名の1スライスへ吸収してはならない（MUST NOT）。同一の記録時点 identity（名前・色が一致）を持つ時間は1スライスへ合算 SHALL し、異なる identity は別スライスとして分離 SHALL する。

これにより、同一ビュー内でグループ別内訳がタイムライン（同じスナップショットを読む）と一致 SHALL する。本要件は表示内訳の分類・ラベル・彩色のみを規定し、`daily_totals_snapshot` の生データ、総作業時間、解錠ルール評価には影響しない SHALL。

#### Scenario: 改名をまたいだグループは記録時点の名前で別スライスになる

- **WHEN** ある日に、同一の `stable_group_id` で `webエンジニアリング`(pink) として 1.6h、その後 `振り返り`(purple) へ改名して 0.3h が計上され、現在の `tab_group` 行はその sid を `振り返り`(purple) としている
- **THEN** グループ別内訳には `webエンジニアリング`(pink) 1.6h と `振り返り`(purple) 0.3h が**別々のスライス**として現れる
- **AND** `webエンジニアリング`(pink) は消えず、`振り返り`(purple) に全時間が吸収されない

#### Scenario: 内訳の分類がタイムラインと一致する

- **WHEN** 同じ日について、今日タブのグループ別内訳とタイムラインの AUTO ブロックを比較する
- **THEN** 両者は同一の（名前・色）identity 単位で同じ持ち分を示し、食い違わない

#### Scenario: 同一の記録時点 identity は合算される

- **WHEN** ある日に、異なる複数の `stable_group_id` がいずれも記録時点で `振り返り`(purple) として計上されている
- **THEN** グループ別内訳ではそれらが1つの `振り返り`(purple) スライスへ合算される

### Requirement: 生データ・総作業時間・ルール評価は不変を保つ

本内訳の集計方式変更は、`daily_totals_snapshot` の per-group 生データ、日の総作業時間、パスワードゲートの解錠ルール評価（`TOTAL_WORK` / `GROUP`）を書き換えても算出値を変えてもならない（MUST NOT）。内訳は表示専用の再集計であり、権威データとゲート判定は従来の `stable_group_id` 単位のまま維持 SHALL する。

#### Scenario: 集計方式変更後も総作業時間とゲート判定は同一

- **WHEN** 同一のサンプル列・同一設定で、内訳をスナップショット identity 集計へ切り替える前後を比較する
- **THEN** 日の総作業時間の秒数は同一である
- **AND** 各解錠条件（`TOTAL_WORK` / `GROUP`）の達成判定は同一である

### Requirement: 未グループ行は表示され非計上ヒントを保持する

グループ別内訳をスナップショット identity で再集計しても、未グループ（`ungrouped` = `UNGROUPED_KEY`）の時間は1つの未グループ行として表示 SHALL し、`exclude_ungrouped_from_total` が ON のときは「総作業時間に非計上」である表示ヒントを従来どおり付与 SHALL する。

#### Scenario: 未グループは単一行として表示され非計上が分かる

- **WHEN** ある日に未グループの計上時間があり、`exclude_ungrouped_from_total` が ON である
- **THEN** グループ別内訳に未グループ行が時間つきで表示される
- **AND** その行には総作業時間に非計上である旨のヒントが付く

### Requirement: 直近7日の内訳にも同一の分類を適用する

range サマリ（直近7日の積み上げ棒グラフ用データ）の各日の `groups` も、記録時点のスナップショット identity 単位で集計・ラベル・彩色 SHALL する。日をまたいで同一 identity（名前・色一致）の系列は同一の凡例・色で連続表示 SHALL する。

#### Scenario: 7日棒グラフでも改名前の系列が保持される

- **WHEN** 直近7日のうち一部の日に `webエンジニアリング`(pink) の計上があり、後日その sid が `振り返り`(purple) へ改名されている
- **THEN** 棒グラフには `webエンジニアリング`(pink) 系列が該当日の値つきで現れ、現在名 `振り返り` に吸収されない
