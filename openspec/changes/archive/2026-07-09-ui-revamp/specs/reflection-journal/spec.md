## ADDED Requirements

### Requirement: 満足度 5 段階と Markdown ライブプレビュー

システムは振り返りタブで、上部に当日の満足度 5 段階評価（1〜5）を、下部に Markdown のライブプレビュー付きエディタを表示 SHALL。カンバンとはタブを分離 SHALL。

#### Scenario: 満足度と本文を入力

- **WHEN** ユーザーが振り返りタブで満足度を選び、Markdown 本文を入力する
- **THEN** 入力に応じてプレビューが即時に更新される
- **AND** 保存すると満足度と本文が当該日に紐づいて永続化される

### Requirement: 過去の振り返りを参照できる

システムは保存済みの振り返りを日付一覧から選択し、その日の満足度と本文を参照できる SHALL。

#### Scenario: 過去日の振り返りを開く

- **WHEN** ユーザーが振り返りの日付一覧から過去の日付を選ぶ
- **THEN** その日の満足度と本文が表示される

### Requirement: 振り返り完了は PLANNING 評価と整合する

システムは振り返りの保存状態を、ゲートの PLANNING 判定（reflectionDone）と整合させ SHALL。満足度・本文の追加によって既存の reflectionDone 判定を壊さ SHALL NOT。

#### Scenario: 振り返り保存が PLANNING に反映

- **WHEN** ユーザーが当日の振り返りを保存する
- **THEN** ゲートの PLANNING における reflectionDone が従来どおり真になる
