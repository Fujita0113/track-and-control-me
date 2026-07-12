# goal-journal Specification

## Purpose
TBD - created by archiving change goal-30day-challenge. Update Purpose after archive.
## Requirements
### Requirement: 進行中の目標ごとの日記コーナー

振り返りタブは、**進行中**の目標ごとに日記コーナー（見出し=目標名＋本文エディタ）を振り返り本文エディタの下に表示 SHALL する。エディタは既存のライブ Markdown エディタ部品（`createMarkdownEditor`）を再利用 SHALL する。開始前・完走後の目標のコーナーは表示しない（MUST NOT）。

#### Scenario: 進行中の目標だけコーナーが出る

- **WHEN** 進行中の目標が2つ、完走済みが1つある状態で振り返りタブを開く
- **THEN** 日記コーナーは進行中の2つ分だけ表示される

### Requirement: 日記は振り返りと同じ保存動線で永続化される

日記本文は対象日の day_key と目標 ID をキーに保存 SHALL する。「保存する」ボタンでの手動保存、および日付切替・過去エントリ選択・タブ離脱時の自動フラッシュは、振り返り本文と同時に日記本文にも適用 SHALL する（未変更の日記は送信しなくてよい）。

#### Scenario: 保存ボタンで振り返りと日記が同時に保存される

- **WHEN** 振り返り本文と目標日記の両方を編集して「保存する」を押す
- **THEN** 両方が保存され、リロード後も内容が復元される

#### Scenario: 離脱時フラッシュ

- **WHEN** 日記に未保存の変更がある状態で別タブへ移動する
- **THEN** 移動前に日記が自動保存される

### Requirement: reflection_done シグナルを汚染しない

日記本文は `reflection_entry` とは独立に保存 SHALL し、日記のみを書いた状態で `reflection_done` シグナルが true になってはならない（MUST NOT）。

#### Scenario: 日記だけでは振り返り済みにならない

- **WHEN** 当日の振り返り本文が空のまま、目標日記にだけ本文を書いて保存する
- **THEN** `reflection_done` は false のままで、PLANNING 条件は充足しない

### Requirement: 書き込みは進行中のみ

日記の書き込み（作成・更新）は目標が進行中（`start_day <= today <= end_day`）の日に対してのみ許可 SHALL する。完走後は既存の日記を読み取り専用で参照できる（レポートの③④が読み手となる）。

#### Scenario: 完走後は書き込みが拒否される

- **WHEN** 完走した目標の日記に対して PUT を送る
- **THEN** リクエストは拒否され、既存の日記は変更されない

