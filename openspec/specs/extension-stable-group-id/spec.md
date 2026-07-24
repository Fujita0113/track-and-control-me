# extension-stable-group-id Specification

## Purpose
TBD - created by syncing change group-rule-snapshot-identity. Update Purpose after archive.

## Requirements

### Requirement: 空タイトルのグループは identity フォールバックを使わない

拡張機能の `stableGroupId` 解決は、グループのタイトルが空文字のとき、`(タイトル, 色)` による既存 ID の引き当てを行ってはならず（MUST NOT）、その組を identity マップへ書き込んでもならない（MUST NOT）。タイトルが空のグループには常に新しい ID を採番 SHALL する。

#### Scenario: 新規グループは既存 ID を継承しない

- **WHEN** 既に `(ブログ投稿, pink)` の ID が存在する状態で、新しいタブグループを作成する（作成直後のタイトルは空文字）
- **THEN** その新規グループには新しい ID が採番され、`ブログ投稿` の ID を継承しない

#### Scenario: 色だけが同じ新規グループも継承しない

- **WHEN** 連続して 2 つの無題グループを同じ色で作成する
- **THEN** 2 つはそれぞれ別の ID を持つ

### Requirement: 同一時点で 2 つのグループが同じ ID を持たない

拡張機能は、状態収集の各回において、開いているグループ集合に同一の `stableGroupId` が 2 つ以上現れてはならない（MUST NOT）ことを不変条件として保証 SHALL する。重複を検出した場合は、先に観測されたグループ（`groupId` が小さい方）が既存 ID を保持し、他方には新しい ID を再採番して写像を更新 SHALL する。

#### Scenario: 重複は再採番で解消される

- **WHEN** 写像の汚染により、同時に開いている 2 つのグループが同じ `stableGroupId` へ解決される
- **THEN** 一方に新しい ID が再採番され、送信されるサンプルの `openGroupKeys` に同じ ID は 2 つ現れない

### Requirement: 汚染された写像は強制的に再構築される

拡張機能は写像のスキーマ版数を保持 SHALL し、版数が現行未満のときは `groupId` 写像と identity 写像の両方を消去してから採番をやり直す SHALL。今回の修正では版数を 3 へ引き上げ、過去の誤った写像を一掃する。

#### Scenario: 更新後の初回起動で写像が作り直される

- **WHEN** 版数 2 の写像が残っている拡張を新しいビルドで読み込む
- **THEN** `groupId` 写像・identity 写像は消去され、以後のグループには新しい ID が採番される

### Requirement: 古い拡張ビルドを検出して警告する

サーバーは受信サンプルの拡張バージョンを参照し、既知の最小要求版未満である場合、ダッシュボードに「拡張機能が古いビルドです。再読み込みしてください」旨の警告を表示 SHALL する。修正済みコードがブラウザへ反映されていない状態を無警告で見逃してはならない（MUST NOT）。

#### Scenario: 古いビルドが動いていると警告が出る

- **WHEN** 最小要求版より古いバージョンの拡張からサンプルを受信する
- **THEN** ダッシュボードに再読み込みを促す警告が表示される

#### Scenario: 最新ビルドでは警告が出ない

- **WHEN** 最小要求版以上の拡張からサンプルを受信する
- **THEN** 警告は表示されない
