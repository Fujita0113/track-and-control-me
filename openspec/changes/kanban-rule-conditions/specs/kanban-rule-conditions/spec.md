## ADDED Requirements

### Requirement: PLANNING 条件は signal_key で評価シグナルを選択する

`PLANNING` ターゲットのルール条件は `signal_key` によって評価するブールシグナルを選択 SHALL する。サポートするシグナルは `reflection_done` / `tomorrow_tasks_registered` / `tomorrow_planned`。`signal_key` が未設定（null）の条件は後方互換のため `tomorrow_planned` として評価 SHALL する。未知の `signal_key` は未達成(false)と評価し警告をログ SHALL する。

#### Scenario: reflection_done の充足

- **WHEN** `PLANNING`/`signal_key=reflection_done` を評価し、当日の振り返り本文が非空で保存されている
- **THEN** その条件は met=true

#### Scenario: tomorrow_tasks_registered の充足

- **WHEN** `PLANNING`/`signal_key=tomorrow_tasks_registered` を評価し、翌日を対象とする未完了タスク数が `planning_min_tomorrow_tasks` 以上
- **THEN** その条件は met=true

#### Scenario: signal_key 未設定は tomorrow_planned として評価される（後方互換）

- **WHEN** `signal_key=null` の既存 `PLANNING` 条件を評価する
- **THEN** 従来の合成シグナル `planningDone`（振り返り済み AND 翌日タスク≥`planning_min_tomorrow_tasks`）と同一結果になる

#### Scenario: 未知の signal_key は安全側で未達成

- **WHEN** レジストリに無い `signal_key` を持つ条件を評価する
- **THEN** met=false となり警告がログされる（誤解錠しない）

### Requirement: 「今日の振り返りをした」条件

`reflection_done` シグナルは、評価対象日 `dayKey` の `reflection_entry` が存在し本文が空白のみでないとき true SHALL とする。未記録または空白のみは false。

#### Scenario: 本文ありで充足

- **WHEN** 当日の振り返りに非空の本文が保存されている
- **THEN** `reflection_done` は true

#### Scenario: 未記録で不充足

- **WHEN** 当日の `reflection_entry` が無い、または本文が空白のみ
- **THEN** `reflection_done` は false

### Requirement: 「明日のタスクを登録した」条件

`tomorrow_tasks_registered` シグナルは、評価対象日の翌日を `due` または `planned_for` に持つ未完了（`status<>'DONE'`）タスク数が `planning_min_tomorrow_tasks` 以上のとき true SHALL とする。列（HOLD/TODO/DOING）は限定せず DONE 以外を計上する。`due` 列が無い旧スキーマでは `planned_for` のみで判定する。

#### Scenario: 翌日タスクが閾値以上で充足

- **WHEN** `due=翌日` または `planned_for=翌日` の未完了タスクが `planning_min_tomorrow_tasks` 件以上
- **THEN** `tomorrow_tasks_registered` は true

#### Scenario: DONE タスクは計上しない

- **WHEN** 翌日を対象とするタスクが存在するが、すべて `status='DONE'`
- **THEN** `tomorrow_tasks_registered` は false

### Requirement: タスク期日は列とモードから自動決定される

ロックされていないタスクは、**新規作成時**および**列移動時**に、列と「明日トグル」の状態から期日を自動決定 SHALL する。決定規則:

- 非HOLD で作成、または HOLD から非HOLD へ移動: 明日トグル OFF なら当日、ON なら翌日。
- HOLD で作成、または非HOLD から HOLD へ移動: 作業日から7日後。
- 非HOLD から非HOLD への移動、および DONE への移動（完了）: 期日を変更しない。

#### Scenario: 明日トグル OFF で通常作成

- **WHEN** 明日トグル OFF で TODO 列に新規タスクを作成する
- **THEN** そのタスクの `due` は当日に設定される

#### Scenario: 明日トグル ON で作成

- **WHEN** 明日トグル ON で TODO 列に新規タスクを作成する
- **THEN** そのタスクの `due` は翌日に設定される

#### Scenario: 保留への追加は約1週間後

- **WHEN** HOLD 列にタスクを作成する、または既存タスクを HOLD へ移動する
- **THEN** そのタスクの `due` は作業日の7日後に設定される

#### Scenario: 保留から戻すと当日/翌日

- **WHEN** HOLD のタスクを TODO/DOING へ移動する
- **THEN** `due` は明日トグル OFF で当日、ON で翌日に更新される

#### Scenario: 完了移動は期日を触らない

- **WHEN** タスクを DONE 列へドラッグして完了する
- **THEN** `due` は変更されない

### Requirement: 手動指定した期日はロックされ、自動に戻せる

ユーザーが期限ピッカーで期日（当日/翌日/期限なし/任意日付）を手動指定した場合、そのタスクは `due_locked` を立てて自動決定の対象から除外 SHALL する。期限ピッカーは「自動に戻す」操作を提供 SHALL し、選択するとロックを解除して現在の列と明日トグルから期日を再計算する。`due_locked` は永続化される。

#### Scenario: 手動指定でロックされ自動上書きされない

- **WHEN** タスクの期日を手動で指定し、その後そのタスクを列移動する（DONE以外）
- **THEN** `due` は手動指定値のまま保持され、自動決定で上書きされない

#### Scenario: 「自動に戻す」でロック解除・再計算

- **WHEN** ロック済みタスクの期限ピッカーで「自動に戻す」を選ぶ
- **THEN** `due_locked` が解除され、現在の列と明日トグルに基づいて `due` が再計算される

### Requirement: 明日の計画モードへ移行できる

システムは「明日トグル（明日の計画モード）」を提供 SHALL する。振り返り画面の「振り返りを終えて明日の計画へ」ボタンは、振り返りを保存し、明日トグルを ON にし、カンバンへ遷移 SHALL する。カンバン上の手動トグルでもモードに出入りできる。モードはその日限りで、翌日は OFF にリセット SHALL する。計画モード中は翌日タスクの登録件数と閾値（`planning_min_tomorrow_tasks`）を進捗として表示する。

#### Scenario: 振り返り完了ボタンで計画モードへ

- **WHEN** 振り返り画面で非空の振り返りを書き「振り返りを終えて明日の計画へ」を押す
- **THEN** 振り返りが保存され（`reflection_done` 成立）、明日トグルが ON になり、カンバンへ遷移する

#### Scenario: 計画モード中の作成は翌日期日

- **WHEN** 明日トグル ON の状態で非HOLD 列にタスクを作成する
- **THEN** そのタスクは `due=翌日` になり、進捗表示の登録件数が増える

### Requirement: 明日タスク登録の閾値は設定可能

`planning_min_tomorrow_tasks` は `tomorrow_tasks_registered` の判定件数および計画モード進捗の目標として使用 SHALL し、設定画面から入力・編集 SHALL できる。

#### Scenario: 閾値変更が評価に反映される

- **WHEN** `planning_min_tomorrow_tasks` を 3 に設定し、翌日タスクが 2 件のとき評価する
- **THEN** `tomorrow_tasks_registered` は false（3件以上で true）

### Requirement: ルール作成 UI で既知シグナルを選択できる

ルール編集 UI は `PLANNING` ターゲット選択時に `signal_key` を既知シグナル（`reflection_done` / `tomorrow_tasks_registered` / `tomorrow_planned`）から選ぶ選択肢として日本語ラベル付きで提示 SHALL する。凍結済みルールが未知の `signal_key` を持つ場合はその値を選択肢に温存し破壊的に上書きしない。ゲート画面の条件テキストも同じ日本語ラベルを表示する。

#### Scenario: PLANNING 選択時にシグナルを選べる

- **WHEN** 未来ルール編集で条件ターゲットに `PLANNING` を選ぶ
- **THEN** 既知シグナルを日本語ラベル付きで選択できる

#### Scenario: 条件テキストにシグナルのラベルが出る

- **WHEN** `signal_key=tomorrow_tasks_registered` の条件を一覧・ゲート画面で表示する
- **THEN** 「明日のタスク登録」等の日本語ラベルが表示される（生キー文字列ではない）
