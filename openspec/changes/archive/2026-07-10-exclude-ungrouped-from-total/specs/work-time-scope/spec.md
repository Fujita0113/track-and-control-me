## ADDED Requirements

### Requirement: 未グループ時間の総作業時間への算入は設定で制御する

システムは設定 `exclude_ungrouped_from_total`（真偽・既定 OFF）を提供 SHALL する。この設定は、日の「総作業時間」の集計に未グループバケット（`ungrouped`、= `UNGROUPED_KEY`）の計上ミリ秒を含めるか否かを制御する。既定（OFF）では現行どおり未グループを含めて合算 SHALL し、後方互換を保つ。実グループ（タブグループ）の計上ミリ秒は本設定の影響を受けず、常に総作業時間へ算入 SHALL する。

本設定は総作業時間の**算入スコープのみ**を変更し、区間化・divide-by-N 分配・日境界分割・`daily_totals_snapshot` の per-group 生データには影響しない SHALL。すなわち未グループの計上ミリ秒自体は従来どおり記録・保持され、失われない。

#### Scenario: 既定（OFF）では未グループを総作業時間に含める

- **WHEN** `exclude_ungrouped_from_total` が OFF で、ある日の `daily_totals_snapshot` に実グループ 40 分・`ungrouped` 20 分が記録されている
- **THEN** その日の総作業時間は 60 分（全グループ合算）となる

#### Scenario: ON では未グループを総作業時間から除外する

- **WHEN** `exclude_ungrouped_from_total` が ON で、ある日の `daily_totals_snapshot` に実グループ 40 分・`ungrouped` 20 分が記録されている
- **THEN** その日の総作業時間は 40 分（`ungrouped` を除外）となる

#### Scenario: 未グループのみの日は ON で総作業時間ゼロ

- **WHEN** `exclude_ungrouped_from_total` が ON で、ある日の記録が `ungrouped` 30 分のみ（実グループなし）
- **THEN** その日の総作業時間は 0 分となる

#### Scenario: per-group 生データは設定に依存しない

- **WHEN** `exclude_ungrouped_from_total` の値に関わらず同じサンプル列を集計する
- **THEN** `daily_totals_snapshot` の `ungrouped` 行の ms は同一で、設定によって書き換わらない

### Requirement: 設定はパスワードゲートの総作業時間条件へ一貫して波及する

「総作業時間」を評価するパスワードゲート条件は、`exclude_ungrouped_from_total` を反映した総作業時間を用いて評価 SHALL する。すなわち ON のときは未グループ時間だけでは総作業時間条件を満たせない。設定は表示用の総作業時間とゲート評価用の総作業時間で同一の値を用い、両者が乖離しない SHALL。

#### Scenario: ON では未グループのみでは総作業時間条件を満たさない

- **WHEN** `exclude_ungrouped_from_total` が ON、総作業時間条件が「120 分以上」、当日の記録が `ungrouped` 150 分のみ
- **THEN** 総作業時間条件は未達成（unmet）となり、その条件はパスワード表示を許可しない

#### Scenario: ON でも実グループ時間が閾値を満たせば充足

- **WHEN** `exclude_ungrouped_from_total` が ON、総作業時間条件が「120 分以上」、当日の記録が実グループ 130 分・`ungrouped` 60 分
- **THEN** 総作業時間（130 分）は閾値を満たし、総作業時間条件は達成となる

### Requirement: ダッシュボードは未グループを表示しつつ非計上を明示する

ダッシュボードのグループ内訳は、`exclude_ungrouped_from_total` の値に関わらず未グループ行（その計上時間）を表示 SHALL する（行を消さない）。設定が ON のときは、未グループ行が総作業時間に**計上されていない**ことをユーザーが識別できる表示ヒント（ラベル/注記等）を付与 SHALL する。表示される総作業時間の数値は、同日のゲート評価に用いる総作業時間と一致 SHALL する。

#### Scenario: ON で未グループ行は表示され非計上と分かる

- **WHEN** `exclude_ungrouped_from_total` が ON で、当日の内訳に実グループと `ungrouped` の両方がある
- **THEN** 未グループ行は時間つきで表示され、かつ総作業時間に非計上である旨のヒントが付く
- **AND** 表示される総作業時間は未グループを除いた合計と一致する

#### Scenario: OFF では従来どおり未グループも総作業時間に含めて表示

- **WHEN** `exclude_ungrouped_from_total` が OFF
- **THEN** 未グループ行は表示され、総作業時間は未グループを含む全グループ合算と一致する

### Requirement: 設定はトグルとして参照・更新できる

`exclude_ungrouped_from_total` は `GET /api/config` のレスポンスに含まれ SHALL、`PATCH /api/config` の許可フィールドとして真偽（0/1）で更新可能 SHALL である。設定 UI はこのトグルを提供し、変更は永続化 SHALL される。

#### Scenario: PATCH でトグルを ON にできる

- **WHEN** `PATCH /api/config` に `exclude_ungrouped_from_total: 1` を送る
- **THEN** 設定が永続化され、以降 `GET /api/config` は `exclude_ungrouped_from_total: 1` を返す
- **AND** 以降の総作業時間集計は未グループを除外する

#### Scenario: 未指定フィールドは変更されない

- **WHEN** `PATCH /api/config` が `exclude_ungrouped_from_total` を含まない
- **THEN** `exclude_ungrouped_from_total` の現在値は保持される
