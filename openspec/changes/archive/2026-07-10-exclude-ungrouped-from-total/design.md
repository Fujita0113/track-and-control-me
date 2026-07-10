## Context

総作業時間は `daily_totals_snapshot`（日×`stable_group_id` の分配後ミリ秒）を全グループ合算して求める。`ungrouped`（= `UNGROUPED_KEY`）はタブグループに属さないアクティブ時間のバケットで、実グループが同時オープンのときは分配で実グループへ吸収され、**どの実グループも開いていない“素のブラウジング”時間だけ**が `ungrouped` 行として残る（`resolveOpenKeys`：既定 `includeUngroupedInSplit=false`）。ユーザーは娯楽をこの状態（グループ無し）で行うため、`ungrouped` ≒ 娯楽時間となる。

現状 `totalWorkMsForDay`（`server/src/services/categories.ts`）は `ungrouped` を含めて `SUM(ms)` する。これが (1) パスワードゲートの総作業時間条件（`server/src/rules/evaluate.ts` → `totalWorkSecondsForDay`）、(2) ダッシュボード総作業時間（`server/src/services/summary.ts`）の両方の source となる。範囲サマリ（`summaryRange`）は categories.ts を経由せず inline で全グループを合算している点に注意。

設定は `app_config` シングルトン（`id=1`）で管理し、`GET/PATCH /api/config` と `server/static/js/settings.js` のトグル群で編集する既存パターンがある。

## Goals / Non-Goals

**Goals:**
- 未グループ時間を総作業時間から外す設定を提供し、娯楽が“作業”として計上されないようにする。
- 集計 source を 1 か所（`totalWorkMsForDay`）に集約し、ゲート評価・当日サマリへ一貫して波及させる。範囲サマリも同じ規則で揃える。
- per-group 生データ（`daily_totals_snapshot`）は不変に保ち、設定 ON/OFF の切替を再集計なしで即時反映する（設定は集計時ではなく“読み出し時”に適用）。

**Non-Goals:**
- シークレット/InPrivateタブの計測（拡張が既定で計測せず、そもそも記録されない）。
- カテゴリ層の復活（`eliminate-categories` で撤廃済み。単純な `ungrouped` バケット除外のみで実現し、カテゴリや `counts_toward_total` を再導入しない）。
- 未グループ時間の非表示化（内訳では引き続き表示し、非計上であることを示すに留める）。
- グループ単位での「作業/娯楽」タグ付け（本 issue の範囲外。将来別チェンジで検討）。

## Decisions

### D1: 集計時ではなく「読み出し時」に除外する
`totalWorkMsForDay` の SQL で `exclude_ungrouped_from_total` が ON のとき `WHERE stable_group_id <> 'ungrouped'` を付す。`daily_totals_snapshot` は書き換えない。
- **理由**: トグルを切り替えるたびに再集計/再計算が不要。過去日も含め即時に一貫反映される。生データを保持するため後から OFF に戻しても情報損失がない。
- **代替案**: 集計パイプライン（`aggregate.ts`）で未グループを落とす → 生データが失われ、トグル切替で再集計が必要。却下。

### D2: 除外の単位は `UNGROUPED_KEY` 行のみ
実グループは常に計上。除外対象は `stable_group_id = UNGROUPED_KEY`（`'ungrouped'`）の行だけ。
- **理由**: issue の要望（グループ無し＝娯楽）に正確に対応。`@track/contract` の `UNGROUPED_KEY` を単一の真実源として参照し、文字列リテラルの散在を避ける。

### D3: source を 1 本化し、range 集計も合わせる
`totalWorkMsForDay` を設定対応させ、`summaryRange`（`summary.ts`）の inline 合算も同じ除外規則へ揃える。共通のフィルタ判定（例: `countsTowardTotal(stableGroupId, cfg)` ないし SQL 条件の共有）で二重定義を避ける。
- **理由**: 「表示総作業時間」と「ゲート評価総作業時間」の乖離を仕様上禁止（spec の要件）。range だけ挙動が違うと内訳と合計が食い違う。

### D4: 既定 OFF（後方互換）
新カラムは `DEFAULT 0`。既存ユーザーの総作業時間・ゲート挙動を変えない。ユーザーが設定でONにして初めて娯楽を除外する。
- **理由**: 破壊的変更を避け、意図した人だけがオプトインする。issue も「設定がほしい」という表現。

### D5: マイグレーションは新バージョンで列追加
`server/src/db/migrations.ts` に新 `version` を追加し `ALTER TABLE app_config ADD COLUMN exclude_ungrouped_from_total INTEGER NOT NULL DEFAULT 0;`。`AppConfigRow`／`publicConfig`／`PATCH` 許可リストへ反映。
- **理由**: 既存の `user_version` ベースのマイグレーション運用に従う。`DEFAULT 0` で既存行に安全に適用される。

### D6: UI は既存トグル配列へ 1 行追加＋非計上ヒント
`settings.js` の `toggles` に `{ key: 'exclude_ungrouped_from_total', label: '未グループ時間を総作業時間に含めない（娯楽の除外）' }` を追加。`today.js` の内訳描画で、設定 ON かつ行が `ungrouped` のとき「総作業時間に非計上」注記を付す。
- **理由**: 既存パターンに最小差分で乗る。総作業時間の数値は summary API 側で既に除外済みのため、UI は表示ヒントのみ担当する。

## Risks / Trade-offs

- **内訳合計と総作業時間の不一致（ON 時）** → 未グループ行に「非計上」ヒントを明示し（D6）、ユーザーが差分を理解できるようにする。仕様シナリオでも表示ヒントを必須化。
- **除外規則の二重定義ドリフト（categories.ts と summary.ts）** → D3 で除外条件を共有し、片方だけ変わらないようにする。テストで両経路の一致を確認。
- **`UNGROUPED_KEY` の文字列ズレ** → contract の定数を import して参照（マイグレーションのコメントの `'ungrouped'` と一致することをテストで固定）。
- **手動タイムライン入力等が将来 `ungrouped` 以外の“非作業”を作る可能性** → 現状は `ungrouped` のみが対象で十分。将来の一般化（グループ単位の作業/娯楽タグ）は Non-Goal として別チェンジに委ねる。

## Migration Plan

1. マイグレーション追加（列 `exclude_ungrouped_from_total` 既定 0）。起動時に自動適用、既存挙動は不変。
2. サーバ集計・API・UI を更新。
3. ロールバック: 設定を OFF にすれば挙動は現行に戻る（データ損失なし）。列自体は無害なため残置可。

## Open Questions

- なし（既定 OFF・生データ保持・単一 source 化で確定）。実装時に range 集計とゲート評価の一致をテストで担保する。
