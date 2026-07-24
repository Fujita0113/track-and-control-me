# goal-challenge Specification

## Purpose
TBD - created by archiving change goal-30day-challenge. Update Purpose after archive.
## Requirements
### Requirement: 30日チャレンジの作成

システムは、名前・目的の一文・採用する実践（1つ以上）・**開始日の選択（今日から／明日から。既定＝今日から）** を指定して30日チャレンジ（以下「目標」）を作成できなければならない（MUST）。期間は選択した開始日から **30日固定**（`start_day ∈ {今日, 翌日}`・`end_day = start_day + 29`）であり、開始日は今日か明日の二択のみ・それ以外の開始日や期間は指定できない（MUST NOT）。今日開始を選んだ目標は当日を Day 1 として作成直後に「進行中（Day 1/30）」となり、明日開始を選んだ目標は「開始前」で現れる。複数の目標を並行して作成・運用できる（MUST）。

#### Scenario: 今日開始を選ぶと当日から進行中になる

- **WHEN** 開始日「今日から」（既定）で名前・目的・実践を指定して目標を作成する
- **THEN** `start_day` は当日、`end_day` は当日から30日目となり、一覧に「進行中（Day 1/30）」として現れる

#### Scenario: 明日開始を選ぶと翌日から開始前になる

- **WHEN** 開始日「明日から」を選んで目標を作成する
- **THEN** `start_day` は翌日、`end_day` は開始から30日目となり、一覧に「開始前」として現れる

#### Scenario: 並行して2つ目を作成できる

- **WHEN** 進行中の目標がある状態で別の目標を作成する
- **THEN** 両方が独立に運用される（採用実践の重複も許容される）

### Requirement: 実践の採用は condition_key で行う

目標の実践は、**開始日（今日開始なら当日・明日開始なら翌日）** の実効ルールセットに現存する条件から選択するか、または目標作成時にその場で作成して開始日のルールへ追記した新規条件（`goal-inline-condition`）から採用し、その `condition_key`（`total_work` / `group:<identityId>` / `planning:<signalKey>` / `timeline:<ラベル>` / `manual:<ラベル>`）の文字列を保存 SHALL する。安定キーを持つターゲット（`TOTAL_WORK` / `GROUP` / `PLANNING` / `TIMELINE` / `MANUAL_CHECK`）はいずれも採用候補に含める SHALL。かつては `MANUAL_CHECK` の同一性が並び順依存（`manual:<index>`）であったため採用候補から除外していたが、安定キー `manual:<ラベル>`（`manual-check-stable-key`）の導入により採用可能になった。`MANUAL_CHECK` は完了/未完了（チェック）型の非時間型実践として採用 SHALL され、閾値（`threshold_seconds`）を持たない。インライン作成した条件は、開始日のルールへ追記され採用可能になった時点で、既存条件と同じく `condition_key` 文字列で採用 SHALL する。採用時に表示用ラベル（グループ名・カテゴリ名・手動チェックのテキスト等）のスナップショットを保存 SHALL する。

`GROUP` 実践のキーはグループ identity の内部 ID（`group-identity-registry`）を参照 SHALL し、拡張機能が採番する `stable_group_id` を新規に参照してはならない（MUST NOT）。対象グループが改名された場合、`condition_key` は変化させず、保存済みの表示用ラベルスナップショットを新しい名前へ更新 SHALL する（`tab-group-rename-tracking`）。過去に保存された `group:<stableGroupId>` 形式の実践キーは引き続き有効 SHALL とし、書き換えてはならない（MUST NOT）。

#### Scenario: 開始日の実効ルールから採用候補が出る

- **WHEN** 目標作成 UI を開く
- **THEN** 選択した開始日（今日／明日）の実効ルールセットの `TOTAL_WORK` / `GROUP` / `PLANNING` / `TIMELINE` / `MANUAL_CHECK` 条件が候補として表示される
- **AND** `GROUP` 条件はグループ名（現在名）で表示され、UUID や内部 ID は表示されない

#### Scenario: 採用実践はキー文字列で保存される

- **WHEN** 「総作業時間 4時間」条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='total_work'` が保存される

#### Scenario: TIMELINE 条件を実践として採用できる

- **WHEN** ラベル「運動」・30分の `TIMELINE` 条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='timeline:運動'`・`target='TIMELINE'`・ラベルスナップショット「運動」が保存される

#### Scenario: MANUAL_CHECK 条件を実践として採用できる

- **WHEN** ラベル「筋トレ」の `MANUAL_CHECK` 条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='manual:筋トレ'`・`target='MANUAL_CHECK'`・ラベルスナップショット「筋トレ」が保存され、非時間型として扱われる

#### Scenario: インライン作成した条件がそのまま採用される

- **WHEN** 目標作成で新規「掃除・15分」の TIMELINE 条件をその場で作成して目標を作成する
- **THEN** その条件は翌日ルールへ追記され、`goal_practice` に `condition_key='timeline:掃除'`・`target='TIMELINE'` が保存される

#### Scenario: GROUP 実践は identity 参照で保存される

- **WHEN** `競技プログラミング` を対象とする GROUP 条件を実践として採用する
- **THEN** `goal_practice` に `condition_key='group:<identityId>'` と、その時点の名前のラベルスナップショットが保存される

#### Scenario: 改名でキーは変わらずラベルだけ更新される

- **WHEN** 採用中の GROUP 実践の対象グループを `競技プログラミング` から `競プロ` へ改名する
- **THEN** `condition_key` は変化せず、目標画面の実践名が `競プロ` として表示される

### Requirement: 期間中のジャンル固定

進行中または開始前の目標が採用している実践について、ルールセットの編集・削除（`upsertFutureRuleSet` / `deleteRuleSet`）の結果、目標の残期間（**`max(今日, start_day)` 〜 `end_day`**）のいずれかの日の実効ルールセットからその実践の `condition_key` が欠ける場合、システムはその編集をエラーで拒否 SHALL する（トランザクション内で適用後検証・ABORT）。今日開始の目標が当日追加して採用した条件も、当日から残期間の対象に含まれ、同日でも骨抜きにできない。既存の凍結条件の緩和は従来どおり翌日以降でのみ可能とし、当日は追加のみを許す（`same-day-rule-additions`）。

#### Scenario: 採用中条件の削除は拒否される

- **WHEN** 進行中の目標が採用する「総作業時間」条件を未来ルールから外した内容で PUT する
- **THEN** リクエストはエラーになり、ルールセットは変更されない

#### Scenario: 今日開始で当日採用した条件は当日削除できない

- **WHEN** 今日開始の目標が当日追加・採用した条件を、同じ日にルールから削除しようとする
- **THEN** リクエストは拒否され、当日の実効ルールから採用中 `condition_key` は欠けない

#### Scenario: 削除フォールバックでも実践が残るなら許可される

- **WHEN** ある未来日のルールセットを DELETE し、持ち越しで実効になる過去ルールセットにも採用中の実践がすべて含まれている
- **THEN** 削除は成功する

#### Scenario: 目標期間外の日の編集は制約されない

- **WHEN** すべての目標の `end_day` より後の日だけに影響する編集を行う
- **THEN** 実践の有無にかかわらず従来どおり成功する

### Requirement: 閾値変更には理由が必須で、記録される

採用中の実践に対応する時間型条件（`TOTAL_WORK` / `GROUP` / `TIMELINE`）の `threshold_seconds` を変更する編集（上げ下げ問わず）は、非空の理由テキストを伴わなければならない（MUST）。理由が無い場合は編集を拒否 SHALL する。変更は `condition_key`・適用日・変更前後の秒数・理由として永続化 SHALL し、同一条件を複数目標が採用していても記録は1本とする。採用されていない条件の閾値変更は従来どおり理由不要（MUST NOT 要求）。

#### Scenario: 理由なしの閾値変更は拒否される

- **WHEN** 採用中の「総作業時間 4時間」を 3時間 に変更する PUT を理由なしで送る
- **THEN** 400 エラーになりルールセットは変更されない

#### Scenario: 理由つきの閾値変更は記録される

- **WHEN** 同じ変更を理由「課題週間。ゼロにはしない」つきで送る
- **THEN** 編集は成功し、変更記録（14400→10800・適用日・理由）が保存される

#### Scenario: TIMELINE 閾値の緩和も理由が必須

- **WHEN** 採用中のラベル「運動」の `TIMELINE` 条件を 30分→15分 に変更する PUT を理由なしで送る
- **THEN** 400 エラーになり、理由つきで送ると変更記録（1800→900・適用日・理由）が保存される

### Requirement: 削除は作成当日のみ

目標の削除は、作成時刻の day_key が現在の day_key と一致する間だけ許可 SHALL する（誤作成の救済）。翌日以降の削除・放棄・期間変更の手段を提供してはならない（MUST NOT）。

#### Scenario: 作成当日は削除できる

- **WHEN** 今日作成した目標を今日中に削除する
- **THEN** 削除は成功し、関連する実践・日記も消える

#### Scenario: 翌日以降は削除できない

- **WHEN** 昨日作成した（進行中の）目標を削除しようとする
- **THEN** リクエストは拒否される

### Requirement: 状態は導出され、成否ラベルは存在しない

目標の状態は保存せず、現在の day_key から導出 SHALL する: `today < start_day` は「開始前」、`start_day <= today <= end_day` は「進行中（Day N/30）」、`today > end_day` は「完走」。達成日数によらず、合格・不合格・スコアに相当する状態や表示を持ってはならない（MUST NOT）。

#### Scenario: 30日経過で完走になる

- **WHEN** `end_day` の翌日以降に目標一覧を見る
- **THEN** その目標は達成日数が何日であっても「完走」と表示され、レポートを開けるようになる

