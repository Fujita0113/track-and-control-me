# manual-check-stable-key Specification

## Purpose
`MANUAL_CHECK`（完了/未完了のチェック型）条件の `condition_key` を、並び順依存の `manual:<index>` からラベル由来の安定キー `manual:<ラベル>` に定める。これにより `MANUAL_CHECK` は30日チャレンジの実践として採用可能になる（`goal-challenge`）。ラベルの必須・ルールセット内一意の制約と、既存 `manual:<index>` データの移行を規定する。

## Requirements
### Requirement: MANUAL_CHECK はラベル由来の安定キーを持つ

`MANUAL_CHECK` 条件の `condition_key` は `manual:<ラベル>`（ラベル＝手動チェックの表示テキスト）SHALL とする。これはラベルを安定識別子として用いるもので、並び順に依存する `manual:<index>` と異なり、条件の並べ替えや他条件の追加削除でキーが変化してはならない（MUST NOT）。`TIMELINE` の `timeline:<ラベル>` と対称であり、これにより `MANUAL_CHECK` は30日チャレンジの実践として採用可能になる（`goal-challenge`）。

`MANUAL_CHECK` 条件はラベル（`label`）が非空であること SHALL とし、空ラベルの `MANUAL_CHECK` 条件は保存してはならない（MUST NOT）。同一ルールセット内で `MANUAL_CHECK` のラベルは一意 SHALL とし、既存の `MANUAL_CHECK` 条件と重複するラベルの追加・変更は拒否 SHALL する（安定キーの衝突を防ぐため）。

#### Scenario: 手動チェック条件のキーはラベル由来

- **WHEN** ラベル「筋トレ」の `MANUAL_CHECK` 条件を作成する
- **THEN** その条件の `condition_key` は `manual:筋トレ` になる

#### Scenario: 並べ替え・他条件追加でキーが変わらない

- **WHEN** 「筋トレ」の手動チェックの前に別の条件（グループ作業など）を追加する
- **THEN** 「筋トレ」の `condition_key` は `manual:筋トレ` のまま変化しない

#### Scenario: 空ラベルの手動チェックは保存できない

- **WHEN** ラベルが空（trim 後に空）の `MANUAL_CHECK` 条件を保存しようとする
- **THEN** リクエストは拒否され、その条件は保存されない

#### Scenario: 同一ルールセット内のラベル重複を拒否する

- **WHEN** 既に「筋トレ」の `MANUAL_CHECK` 条件があるルールセットへ、もう1つ「筋トレ」の `MANUAL_CHECK` 条件を追加しようとする
- **THEN** リクエストは拒否される

### Requirement: 既存 manual:index データを安定キーへ移行する

システムは既存の `MANUAL_CHECK` データを一度きりのマイグレーションで安定キーへ移行 SHALL する。移行対象は `rule_condition` の `MANUAL_CHECK` 行の `condition_key`（`manual:<index>` → `manual:<ラベル>`）と、それに紐づく `daily_check` 行の `condition_key`（当日チェック状態）である。各ルールセット内で `manual:<index>` の index からその位置の `MANUAL_CHECK` 条件のラベルを解決し、対応する `daily_check` 行の `condition_key` を同じ規則で振り替える SHALL。

`unlock_evaluation` の履歴 JSON（`per_condition_results`）は、従来 `MANUAL_CHECK` を採用できる目標が存在しなかったため、いずれの完走レポートも参照しない。したがって履歴 JSON は移行不要 SHALL とする。

#### Scenario: rule_condition のキーが移行される

- **WHEN** マイグレーションを実行する
- **THEN** すべての `MANUAL_CHECK` 行の `condition_key` が `manual:<ラベル>` 形式になり、`manual:<index>` 形式は残らない

#### Scenario: daily_check の当日チェック状態が保持される

- **WHEN** ある日に `manual:0`（ラベル「筋トレ」）としてチェック済みの `daily_check` があり、マイグレーションを実行する
- **THEN** その `daily_check` 行の `condition_key` は `manual:筋トレ` へ振り替えられ、チェック状態は保持される
