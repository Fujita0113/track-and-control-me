## RENAMED Requirements

- FROM: `### Requirement: 目標作成時に新規 TIMELINE 条件を作成して採用できる`
- TO: `### Requirement: 目標作成時に新規条件を作成して採用できる`

## MODIFIED Requirements

### Requirement: 目標作成時に新規条件を作成して採用できる

目標作成は、既存条件の採用に加えて、その場で新規ルール条件を作成し同時に採用 SHALL できる。対応ターゲットは今日タブの条件エディタと同等の**全5ターゲット（`TOTAL_WORK` / `GROUP` / `TIMELINE` / `MANUAL_CHECK` / `PLANNING`）**とする。各ターゲットの新規条件は次を持つ: `TOTAL_WORK` は `thresholdSeconds`（> 0）、`GROUP` は既存グループの `stableGroupId` と `thresholdSeconds`（> 0）、`TIMELINE` はカテゴリ名 `label`（非空）と `thresholdSeconds`（> 0）、`MANUAL_CHECK` はチェック名 `label`（非空・閾値なし）、`PLANNING` は `signalKey`。新規条件は**目標の開始日（今日開始なら当日ルール・明日開始なら翌日ルール）の実効ルールセットへ追記**したうえで、そのターゲットに応じた `condition_key`（`total_work` / `group:<stableGroupId>` / `timeline:<ラベル>` / `manual:<ラベル>` / `planning:<signalKey>`）を採用 SHALL する。今日開始で当日ルールへ追記する場合は、`same-day-rule-additions` の当日追加経路（`DRAFT_TODAY`・baseline 保存）で追記 SHALL する。作成と採用は一体の操作として扱い、途中で失敗（凍結・ジャンル固定・採用不整合・バリデーション）した場合は目標も条件も作成してはならない（MUST NOT）。追加しようとした条件の `condition_key` が開始日の実効ルールに既存の場合（`TOTAL_WORK` / `PLANNING` の singleton や同名の `GROUP` / `TIMELINE` / `MANUAL_CHECK`）は、重複追記せず既存条件の採用へ寄せる SHALL。

#### Scenario: 明日開始でカテゴリ＋分数の TIMELINE 条件を作成して採用できる

- **WHEN** 開始日「明日から」で新規に「掃除・15分」の TIMELINE 条件を追加して目標を作成する
- **THEN** 翌日の未来ルールへ `target='TIMELINE'`・`label='掃除'`・`threshold_seconds=900`・`condition_key='timeline:掃除'` が追記され、その `condition_key` が当該目標に採用される

#### Scenario: 今日開始では当日ルールへ追記して採用する

- **WHEN** 開始日「今日から」で新規「掃除・15分」の TIMELINE 条件を追加して目標を作成する
- **THEN** 当日ルール（`DRAFT_TODAY`）へ `timeline:掃除` が追記され当日の実効ゲートに算入され、その `condition_key` が当該目標に当日から採用される

#### Scenario: 総作業時間（TOTAL_WORK）をその場で作成して採用できる

- **WHEN** 開始日の実効ルールに `total_work` が無い状態で、新規「総作業時間・4時間」条件を追加して目標を作成する
- **THEN** 開始日ルールへ `target='TOTAL_WORK'`・`threshold_seconds=14400`・`condition_key='total_work'` が追記され、その `condition_key` が採用される

#### Scenario: グループ作業（GROUP）をその場で作成して採用できる

- **WHEN** 既存グループを選び、新規「そのグループ・2時間」の GROUP 条件を追加して目標を作成する
- **THEN** 開始日ルールへ `target='GROUP'`・当該 `stable_group_id`・`threshold_seconds=7200`・`condition_key='group:<stableGroupId>'` が追記され、その `condition_key` が採用される

#### Scenario: 手動チェック（MANUAL_CHECK）をその場で作成して採用できる

- **WHEN** 新規「筋トレ」の MANUAL_CHECK 条件を追加して目標を作成する
- **THEN** 開始日ルールへ `target='MANUAL_CHECK'`・`label='筋トレ'`・`condition_key='manual:筋トレ'`（閾値なし）が追記され、その `condition_key` が非時間型として採用される

#### Scenario: 翌日計画（PLANNING）をその場で作成して採用できる

- **WHEN** 新規に signal を選んだ PLANNING 条件を追加して目標を作成する
- **THEN** 開始日ルールへ `target='PLANNING'`・当該 `signal_key`・`condition_key='planning:<signalKey>'` が追記され、その `condition_key` が採用される

#### Scenario: 既存キーと重複する新規作成は既存採用へ寄せる

- **WHEN** 開始日の実効ルールに既に `total_work` がある状態で、新規「総作業時間」条件を追加して目標を作成する
- **THEN** `total_work` は重複追記されず（閾値・キーは変わらず）、その `condition_key` が採用される

#### Scenario: 作成が失敗すると目標も条件も作られない

- **WHEN** 新規条件の追記処理が失敗する（例: バリデーション不正で拒否される）
- **THEN** 目標は作成されず、新規条件も未来ルールへ追記されない（部分状態を残さない）

#### Scenario: label 空・分数0は拒否される

- **WHEN** インライン作成で `TIMELINE`/`MANUAL_CHECK` のラベルが空、または時間型（`TOTAL_WORK`/`GROUP`/`TIMELINE`）の分数が 0 以下で目標を作成する
- **THEN** 400 エラーで拒否される

#### Scenario: 未知・未対応ターゲットのインライン作成は拒否される

- **WHEN** 目標作成のインライン作成で全5ターゲット以外の未知ターゲットを指定する
- **THEN** 400 エラーで拒否され、目標もルールも変更されない
