## Why

タイムラインが、1つのタブグループを改名して使い回した日に、別々の活動を1つの巨大ブロックへ誤って束ねてしまう（issue #52）。実データ 2026-07-14 では `stable_group_id` `70d5118e…` が「開発／ブログ投稿／アルゴリズム」の3名で共有され、タイムラインが「ブログ投稿 14:15–16:53」の連続ブロックとして描画してアルゴリズム・Python・開発の時間を飲み込んだ。一方、振り返り内部のリボンは名前で束ねるため正しい内訳（14:15–15:03 ブログ投稿／15:08–16:04 アルゴリズム＋Python／16:08–16:55 開発＋Python）を示す。

根因はタイムラインの集計が `stable_group_id` 単位で束ねて先頭フラグメントの名前でラベル付けする点にある。既存スペック `today-group-breakdown` は既に「今日タブのグループ別内訳とタイムラインの AUTO ブロックは、記録時点の（名前・色）identity 単位で同じ持ち分を示し**食い違わない**」ことを要求しており、タイムラインだけがこの identity モデルに未追従だった。改名は仕様上正しい記録（各セッションは当時の `tab_group_name_snapshot`／`group_color_snapshot` を保持）であり、集計側を identity へ揃えれば直る。

## What Changes

- タイムラインの AUTO ブロック生成（サーバ `coalesceSessions`）を、`stable_group_id` 単位ではなく**記録時点のスナップショット identity（`tab_group_name_snapshot` ＋ `group_color_snapshot`）単位**で束ねる。異なる identity は別ブロックへ分離し、同一 identity のみ近接結合する。
- クライアントのラン結合（`buildRuns`）および列レイアウトのキーを、`stableGroupId` から同じ（名前＋色）identity へ揃える。同時オープングループ名の解決（`coactiveGroupKeys` → 表示名）も identity で行う。
- 結果として、タイムライン・今日タブのグループ別内訳・振り返りリボンの3者が同一 identity で一致する。
- スコープは**集計／表示層のみ**。`session` の生データ・`creditedMs`・`gaps` 計算・`daily_totals_snapshot`・解錠ルール評価（`stable_group_id` 単位のまま）は変更しない。スナップショットに正しい名前が残るため**DB マイグレーションは不要**で、履歴日も再描画で自動的に直る。拡張機能（`extension/src/groups.ts` の stableGroupId 採番）は変更しない。

## Capabilities

### New Capabilities
（なし）

### Modified Capabilities
- `timeline-run-view`: 「同一グループ断片のラン結合表示」要件のグルーピング基準を `stableGroupId` から記録時点のスナップショット identity（名前＋色）へ変更する。同一タブグループを改名して使い回した場合に、名前が変わった区間を別ブロックへ分離し、正しい名前でラベル付けする。

## Impact

- `server/src/services/timeline.ts`: `coalesceSessions`（バケツキーを identity へ）、`AutoBlock` の同一性の扱い。
- `server/static/js/timeline.js`: `buildRuns` / `groupNames` 解決 / `layout` の `keyOf` を identity ベースへ。
- テスト: `server/src/services/timeline.test.ts` に改名使い回しケースを追加。振り返りリボン（`reflection.js`）は既に label ベースで正のため変更なし。
- クロス整合: `today-group-breakdown` が要求する「タイムライン＝今日タブ内訳の identity 一致」を満たす方向の修正であり、既存スペックとの矛盾を解消する。
