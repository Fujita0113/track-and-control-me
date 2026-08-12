## MODIFIED Requirements

### Requirement: PLANNING 条件は signal_key で評価シグナルを選択する

`PLANNING` ターゲットのルール条件は `signal_key` によって評価するブールシグナルを選択 SHALL する。サポートするシグナルは `reflection_done` / `tomorrow_tasks_registered` / `tomorrow_planned` / `kakeibo_recorded`。`signal_key` が未設定（null）の条件は後方互換のため `tomorrow_planned` として評価 SHALL する。未知の `signal_key` は未達成(false)と評価し警告をログ SHALL する。

#### Scenario: reflection_done の充足

- **WHEN** `PLANNING`/`signal_key=reflection_done` を評価し、当日の振り返り本文が非空で保存されている
- **THEN** その条件は met=true

#### Scenario: tomorrow_tasks_registered の充足

- **WHEN** `PLANNING`/`signal_key=tomorrow_tasks_registered` を評価し、翌日を対象とする未完了タスク数が `planning_min_tomorrow_tasks` 以上
- **THEN** その条件は met=true

#### Scenario: kakeibo_recorded の充足

- **WHEN** `PLANNING`/`signal_key=kakeibo_recorded` を評価し、その作業日に家計簿の支出レコードが1件以上ある、または「0円だった」が宣言されている
- **THEN** その条件は met=true

#### Scenario: signal_key 未設定は tomorrow_planned として評価される（後方互換）

- **WHEN** `signal_key=null` の既存 `PLANNING` 条件を評価する
- **THEN** 従来の合成シグナル `planningDone`（振り返り済み AND 翌日タスク≥`planning_min_tomorrow_tasks`）と同一結果になる

#### Scenario: 未知の signal_key は安全側で未達成

- **WHEN** レジストリに無い `signal_key` を持つ条件を評価する
- **THEN** met=false となり警告がログされる（誤解錠しない）

## ADDED Requirements

### Requirement: 「家計簿に今日の記録がある」条件

`kakeibo_recorded` シグナルは、評価対象日 `dayKey` について家計簿の支出レコードが1件以上存在する、または `dayKey` の「0円だった」宣言が存在するとき true SHALL とする。どちらも無ければ false。家計簿のテーブルが未導入の環境では false を返し、例外を投げてはならない（MUST NOT）。

#### Scenario: 支出レコードがあれば充足

- **WHEN** 当日の家計簿に支出レコードが1件以上ある
- **THEN** `kakeibo_recorded` は true

#### Scenario: 0円の宣言があれば充足

- **WHEN** 当日の支出レコードは無いが「0円だった」が宣言されている
- **THEN** `kakeibo_recorded` は true

#### Scenario: どちらも無ければ不充足

- **WHEN** 当日の支出レコードも0円の宣言も無い
- **THEN** `kakeibo_recorded` は false

### Requirement: 家計簿の条件をルール編集から選べる

ルール編集の条件ドロップダウンは、「📝 計画・振り返り」グループ内に `家計簿に今日の記録がある`（`PLANNING`/`kakeibo_recorded`）の項目を提供 SHALL する。一覧・ゲート画面での表示は、生の `signal_key` ではなく日本語ラベルを接頭辞なしで SHALL 表示する。

#### Scenario: 条件ドロップダウンから選べる

- **WHEN** ルール編集で条件のドロップダウンを開く
- **THEN** 「計画・振り返り」グループ内に「家計簿に今日の記録がある」が現れ、選んで保存できる

#### Scenario: ゲート画面で日本語ラベルが出る

- **WHEN** `signal_key=kakeibo_recorded` の条件を今日タブで表示する
- **THEN** 「家計簿に今日の記録がある」と接頭辞なしで表示される（生キー文字列ではない）
