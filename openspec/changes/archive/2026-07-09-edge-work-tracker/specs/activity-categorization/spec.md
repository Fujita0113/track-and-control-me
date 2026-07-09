## ADDED Requirements

### Requirement: タブグループから活動カテゴリへのマッピング

システムは、各タブグループ（グループ名を主キーとする）を**活動カテゴリ**へ対応付ける設定を保持 SHALL する。
未対応のグループは既定カテゴリ（例: `uncategorized`）に落ちる SHALL。

#### Scenario: 既存マッピングによる分類
- **WHEN** グループ "AtCoder" が カテゴリ `competitive-programming` にマップされている状態で "AtCoder" の秒数が計上された
- **THEN** その秒数は カテゴリ `competitive-programming` に集計される

#### Scenario: 未マップのグループ
- **WHEN** マッピングに存在しないグループ "random" の秒数が計上された
- **THEN** その秒数は既定カテゴリ `uncategorized` に集計され、後からマッピングを追加できる

### Requirement: 作業カテゴリの指定と総作業時間の算出

システムは、各カテゴリに「**作業とみなすか**」のフラグを設定でき、**総作業時間**を「作業とみなすカテゴリのアクティブ秒数の合計」として算出 SHALL する。

#### Scenario: 総作業時間の集計
- **WHEN** `competitive-programming`（作業=真）が 15 分、`documentation`（作業=真）が 3 時間45分、`entertainment`（作業=偽）が 30 分計上されている
- **THEN** 当日の総作業時間は 4 時間（240 分）と算出され、`entertainment` は総作業時間に含まれない

#### Scenario: カテゴリ別内訳の提供
- **WHEN** ダッシュボードやルール評価がカテゴリ別の当日集計を要求した
- **THEN** システムはカテゴリごとのアクティブ秒数と、総作業時間を返す

### Requirement: マッピング変更の当日集計への反映方針

カテゴリマッピング／作業フラグの変更は、当日のカテゴリ別ロールアップに反映 SHALL される
（グループ別の生の秒数は保持され、カテゴリ集計は再計算可能である）。

#### Scenario: 当日にマッピングを追加
- **WHEN** 当日に未マップだったグループ "codeforces" を `competitive-programming` にマップした
- **THEN** そのグループの当日の秒数が `competitive-programming` の総計に加算される
