## MODIFIED Requirements

### Requirement: TIMELINE 条件は手動記録のラベル一致＋当日合計分数で評価する

ルール条件は新ターゲット `TIMELINE` を持つ SHALL。`TIMELINE` 条件は、評価対象日 `dayKey` の `activity_log_entry` のうち `entry_type='MANUAL'` かつ `category_key` が条件のラベルに一致するエントリの持ち分秒の合計が、条件の `threshold_seconds` 以上のとき達成（met=true）とする SHALL。一致は `category_key` 文字列の完全一致で行い、`AUTO_SESSION` エントリは対象にしない（MUST NOT）。各エントリの持ち分秒は、単独記録では継続時間（`end_at − start_at`）そのもの、同時記録グループに属するエントリでは継続時間をそのグループの構成数で等分した `(end_at − start_at) ÷ N` とする SHALL（同時記録の持ち分は timeline-coactive-record に準拠）。合計は重なりの有無を問わず持ち分の単純加算とする（同一ラベルの単独記録を重複させない前提）。

#### Scenario: 指定ラベルの手動記録が閾値以上で達成

- **WHEN** ラベル「運動」・閾値30分の `TIMELINE` 条件を評価し、当日「運動」カテゴリの単独 MANUAL 記録が合計35分ある
- **THEN** その条件は met=true

#### Scenario: 閾値未満は未達成

- **WHEN** 同じ条件で当日「運動」の単独 MANUAL 記録が合計20分しかない
- **THEN** その条件は met=false

#### Scenario: 別ラベル・AUTO は集計しない

- **WHEN** 当日に「読書」ラベルの MANUAL 記録40分と、作業セッション（AUTO_SESSION）が多数あるが「運動」ラベルの MANUAL 記録は無い
- **THEN** ラベル「運動」の `TIMELINE` 条件は met=false（他ラベルや AUTO の時間は算入されない）

#### Scenario: 同時記録は持ち分で算入される

- **WHEN** 2時間の区間を「掃除」「洗濯」の2カテゴリで同時記録した当日に、ラベル「掃除」・閾値30分の `TIMELINE` 条件を評価する
- **THEN** 「掃除」の持ち分は1時間（2時間 ÷ 2）として算入され、`actualSeconds=3600` で met=true になる（区間長そのままの2時間では算入しない）
