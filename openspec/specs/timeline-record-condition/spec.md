# timeline-record-condition Specification

## Purpose

手動記録（`activity_log_entry` の MANUAL エントリ）を「カテゴリラベル一致＋当日合計◯分以上」で評価する新ルール条件ターゲット `TIMELINE` を定義する。時間を自動計測できない習慣（筋トレ・読書・掃除など）を自己申告で判定材料にし、安定キー `timeline:<ラベル>` により30日チャレンジの実践として採用可能にする。評価は既存の時間型パイプライン（`actualSeconds`/`thresholdSeconds` の焼き込み）を再利用し、完走レポートの①カレンダー・②時間推移へ自然に乗せる。

## Requirements

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

### Requirement: TIMELINE 条件の安定キーと表示ラベル

`TIMELINE` 条件の `condition_key` は `timeline:<ラベル>`（ラベル＝一致対象のカテゴリ名）SHALL とする。これはカテゴリ名を安定識別子として用いるもので、並び順に依存する `manual:<index>` と異なり、条件の並べ替えや他条件の追加削除で変化してはならない（MUST NOT）。条件は一致対象のカテゴリ名を `label` に保持し、これを表示ラベル兼一致キーとして用いる SHALL。

#### Scenario: 条件キーがラベル由来で安定

- **WHEN** ラベル「運動」の `TIMELINE` 条件を含むルールセットを保存する
- **THEN** その条件の `condition_key` は `timeline:運動` になる

#### Scenario: 並べ替えでキーが変わらない

- **WHEN** 同じルールセット内で条件の並び順を変更して再保存する
- **THEN** `TIMELINE` 条件の `condition_key` は `timeline:運動` のまま変化しない

### Requirement: TIMELINE 条件の評価結果は per_condition_results に焼き込まれる

`TIMELINE` 条件の評価は、`unlock_evaluation.per_condition_results` の当該エントリに `actualSeconds`（当日の一致合計秒）と `thresholdSeconds`（その日の閾値秒）を焼き込む SHALL。これにより完走レポートの①達成カレンダー・②時間の推移が、過去ルールの再解決なしに `TIMELINE` 実践を時間型として描画できる。

#### Scenario: 実測と閾値が焼き込まれる

- **WHEN** ラベル「運動」・閾値30分の `TIMELINE` 条件がある日に、当日「運動」記録35分で評価が走る
- **THEN** その日の `per_condition_results` の該当エントリに `actualSeconds=2100`・`thresholdSeconds=1800`・`met=true` が記録される
