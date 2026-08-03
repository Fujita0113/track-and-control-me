## ADDED Requirements

### Requirement: 対象日を指定した再集計は raw_sample の読み込み範囲を絞り込む

`recompute(db, { onlyDays })` が対象日（`onlyDays`）を指定して呼ばれたとき、システムは `raw_sample` 全件ではなく、対象日のうち最も古い日から1日分前倒しした時刻（`prevDayKey(min(onlyDays))` の日境界開始時刻）以降のサンプルのみを読み込み SHALL する。対象日より過去の確定済み履歴を毎回全件読み直さない SHALL。

`onlyDays` が省略されたときは、従来どおり `raw_sample` の全件を読み込む SHALL（テスト・将来のバックフィル用途との後方互換）。

#### Scenario: 直近2日のみを対象にした再集計は raw_sample 全件を読み直さない

- **WHEN** `raw_sample` に3日以上前からのサンプルが大量に蓄積された状態で、`recompute(db, { onlyDays: [today, yesterday] })` を呼ぶ
- **THEN** 読み込まれるサンプルは `prevDayKey(yesterday)` の日境界開始時刻以降のものに限られ、それより前のサンプル件数が増えても読み込み件数・処理時間は増加しない

#### Scenario: onlyDays 省略時は全期間を対象にする

- **WHEN** `onlyDays` を指定せず `recompute(db)` を呼ぶ
- **THEN** `raw_sample` の全件が読み込まれ、全期間の非確定日が再計算される（絞り込み導入前と同じ挙動）

### Requirement: 読み込み範囲の絞り込みは集計結果を変えない

対象日レンジ開始直前のサンプルを含むバッファを読み込むことで、絞り込みの有無によらず対象日の `dailyTotals` / `sessions` / `daily_excluded_snapshot` の値が一致する SHALL。特に対象レンジ開始直後の最初の区間（バッファ日の最終サンプルと対象日の最初のサンプルの間のgap）が欠落しない SHALL。

#### Scenario: 対象日レンジ開始直後の区間が欠落しない

- **WHEN** バッファ日の終わり近くにサンプルがあり、対象日の始まり直後に次のサンプルがある状態で `recompute(db, { onlyDays: [対象日] })` を呼ぶ
- **THEN** その2サンプル間の区間が対象日の `dailyTotals`（またはgapとして `daily_excluded_snapshot`）に、絞り込み無し（全件読み込み）で計算した場合と同じ値で計上される

#### Scenario: 絞り込みありなしで対象日の集計結果が一致する

- **WHEN** 同じ `raw_sample` データに対して、`onlyDays` を絞り込んだ `recompute` と、絞り込まない（全件読み込みの）`recompute` をそれぞれ実行する
- **THEN** 対象日ぶんの `dailyTotals` / `sessions` / `daily_excluded_snapshot` の値は両者で一致する

### Requirement: バッファより前のサンプルが存在しない場合も安全に扱う

対象レンジの開始直前にサンプルが1件も存在しない（例: 記録開始直後、または長期間サンプルが送られていなかった）場合でも、システムはエラーを起こさず、直前サンプルが無い区間を単に「集計対象なし」として扱う SHALL。

#### Scenario: 対象日より前にサンプルが1件も無い

- **WHEN** 対象日より前に `raw_sample` が1件も存在しない状態で `recompute(db, { onlyDays: [対象日] })` を呼ぶ
- **THEN** エラーにならず、対象日の集計は対象日内のサンプルのみから計算される
