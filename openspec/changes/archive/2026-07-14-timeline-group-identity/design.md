## Context

タイムラインの AUTO ブロックは、サーバ `coalesceSessions`（`server/src/services/timeline.ts`）が `stable_group_id` 単位でセッションを束ね近接結合し、クライアント `buildRuns`（`server/static/js/timeline.js`）が同じ `stableGroupId` 単位でさらにラン結合して描画する。

しかし `stable_group_id` は「同一 Edge タブグループを改名しても安定」なIDであり、**1つのグループを改名して別活動に使い回すと、異なる名前のセッション群が同一IDを共有**する。実データ（2026-07-14）では `70d5118e…` が「開発／ブログ投稿／アルゴリズム」、`874cd9a3…` が「英語／Python」で共有され、タイムラインは先頭フラグメント名でラベル付けするため「ブログ投稿 14:15–16:53」の巨大ブロックに化けて他活動を飲み込む。

既存スペック `today-group-breakdown` は既に「今日タブのグループ別内訳とタイムラインの AUTO ブロックは記録時点の（名前・色）identity 単位で一致し**食い違わない**」ことを要求しており、内訳・振り返りリボンは identity/label ベースで正しく分離する。**タイムラインの集計だけがこの identity モデルに未追従**であることが根因。各セッションは記録時点の `tab_group_name_snapshot`／`group_color_snapshot` を正しく保持しているため、集計側を identity へ揃えるだけで直る。

## Goals / Non-Goals

**Goals:**
- タイムラインの AUTO ブロック生成（サーバ）とラン結合（クライアント）を、記録時点の（名前＋色）identity 単位へ揃える。
- 改名して使い回したグループの各区間を、当時の名前で別ブロックとして正しく分離する。
- タイムライン・今日タブのグループ別内訳・振り返りリボンの3者を同一 identity で一致させる。
- 同時オープングループの表示名解決を identity 化後も維持する。

**Non-Goals:**
- `session` 生データ・`creditedMs`・`gaps`・`daily_totals_snapshot`・解錠ルール評価の変更（従来どおり `stable_group_id` 単位を維持）。
- DB マイグレーション（スナップショットに正しい名前が残るため不要。履歴日は再描画で自動修正）。
- 拡張機能 `extension/src/groups.ts` の stableGroupId 採番ロジックの変更（改名で同一IDを維持するのは意図的で、誤字修正等では望ましい挙動）。
- 振り返りリボン `buildRibbon` の変更（既に label ベースで正しい）。

## Decisions

### D1. identity キー = （記録時点の名前 ＋ 色）
束ねる単位を `stable_group_id` から `identityKey(tab_group_name_snapshot, group_color_snapshot)` に変更する。`today-group-breakdown` と同じ定義を用い、名前・色が両方一致するもののみ同一 identity とする。未グループ（`ungrouped` / `UNGROUPED_KEY`）は従来どおり単一の未グループ identity として扱う。
- **代替案**: 「stable_group_id 維持＋名前変化で run 分割」。今回のバグは直るが、#47（同名同色が別IDで分裂）を解消できず二重基準が残る。ユーザ確認により identity 統一を採用。

### D2. サーバ `coalesceSessions`：バケツキーを identity へ
セッションを `identityKey` でバケツ化し、各バケツ内で近接結合（閾値 `session_coalesce_seconds`）する。AutoBlock の `title`/`color` はその identity の名前・色とする。`creditedMs` 合算・`n`・`categoryKey` の扱いは従来どおり。identity が異なるセッションは決して同一ブロックへ入れない。

### D3. クライアント `buildRuns` / `layout` / `keyOf`：identity へ
- `buildRuns` のグルーピング（`byGroup`）と「他ブロック重なり」判定の自己除外を identity キーへ。
- `layout` の `keyOf`（カラム安定化の prevCol キー）を、RUN は `g:${identityKey}`、MANUAL は従来どおり `m:${id}` に。
- ラン結合の同一性判定（`canMerge` の対象選別）も identity ベースに。

### D4. 同時オープングループの表示名解決
`coactiveGroupKeys` はセッション単位の**他グループの stable_group_id 集合**であり、identity 化後もこれ自体は sid のまま残る。表示名（「同時に開いていたグループ名」）を解決するため、**当該区間で各 coactive sid が保持していたスナップショット名へ解決**する。実装は、同時刻に記録された並行セッション行の `tab_group_name_snapshot` を引く（デモ／実データとも同時記録は同一 `started_at`/`ended_at` を持つ）。自己除外は「自分の identity に属する sid」を除く形へ変更する。
- **代替案A**: サーバが coactive を解決済みの identity ラベル配列で返す（クライアントの sid 依存を排除）。よりクリーンだが payload 形状変更。
- **代替案B**: 日次の `sid → 直近スナップショット名` マップで近似。改名を跨ぐ sid では時刻不一致の残余曖昧性あり（D4 リスク参照）。
- 本設計は「区間内の並行セッション名で解決」を第一とし、解決不能時は sid 文字列にフォールバックする。

### D5. 権威データ不変を保証
本変更は表示・集計の再グルーピングのみ。`daily_totals_snapshot` の per-group 生データ、総作業時間、パスワードゲート（`TOTAL_WORK`/`GROUP`）評価は `stable_group_id` 単位のまま維持し、算出値を変えない。回帰テストで identity 切替の前後不変を確認する。

## Risks / Trade-offs

- **[同名同色の別グループが合算される]** → #47 で採用済みの identity モデルの意図通り。タイムライン・内訳・リボンで一貫するため許容。
- **[名前は同じで色が違う区間が別ブロックに分かれる]** → identity は色も含むため分離するのが正。色は Edge 側の意図的な区別なので望ましい。
- **[改名を跨ぐ sid の coactive 表示名の曖昧性]** → 並行セッション名で区間ごとに解決するため実害は小。解決不能時は sid フォールバックで名前が生IDになるだけ（結合・分類の正しさには影響しない）。
- **[列レイアウト安定化キーの変更]** → prevCol キーが identity になることで、同名同色ブロックが連続クラスタで同カラムに留まる挙動は維持される（むしろ改名跨ぎで安定）。

## Migration Plan

- DB マイグレーション不要。デプロイは静的 JS ＋ サーバ再起動のみ。ロールバックは旧ファイルへ戻すだけ（データ非破壊）。
- 検証はデモモードで再現（プロジェクトルール）。`demo-seed.ts` に「同一 sid を改名して使い回す」日（例: 開発→ブログ投稿→開発）を1本足し、`demo.test.ts` の期待値を更新。`GET /api/timeline` の AUTO ブロックが名前ごとに分離し、同日の今日タブ内訳・振り返りリボンと一致することを確認する。

## Open Questions

- D4 の coactive 表示名解決を「区間内の並行セッション名」で行うか、サーバ側で解決済みラベルを返す（代替案A）へ踏み込むか。まずは非破壊な前者で実装し、必要なら後続で API 整理する想定。
