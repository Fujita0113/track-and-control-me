# Design: goal-30day-challenge

## Context

日次ルール（`daily_rule_set` / `rule_condition`）は当日凍結・rollover・`unlock_evaluation` への評価結果永続化まで完成している。`unlock_evaluation.per_condition_results` には条件ごとの `conditionKey / met / actualSeconds / thresholdSeconds` が**日ごとに焼き込まれて永続化**されており（`evaluate.ts`）、`condition_key` は `total_work` / `group:<stableGroupId>` / `planning:<signalKey>` と決定的に導出されるため日をまたいで安定している（`MANUAL_CHECK` のみ `manual:<index>` で並び順依存）。ルールセットは持ち越し方式（その日の行が無ければ直近過去の行が実効）。

ダッシュボードは `server/static/` のバニラ JS（タブごとに 1 モジュール）。ライブ Markdown エディタは `md-editor.js` の `createMarkdownEditor()` として部品化済み。Chart.js 同梱済み。ミニマム UI 要件は `ref/goal-report/design-brief.md`（ヘッダ＋4ブロック・1カラム・静かに）。

## Goals / Non-Goals

**Goals:**

- 30日チャレンジの作成・並行運用・完走レポートを、**既存の計測・評価・凍結機構を無改造のまま**その上に乗せる
- 期間中の「ジャンル固定・強度可変（理由必須）」をルール編集レイヤで強制する
- 目標日記を `reflection_done` シグナルを汚染せずに振り返りタブへ同居させる

**Non-Goals:**

- 画像添付基盤・TIMELINE 条件タイプ・MANUAL_CHECK の採用・Day0 儀式拡張（手紙/予想/ベースライン）・期間中の演出（ペース予測/封印）・候補カード群（解錠時刻推移/相関/換算/ナラティブ/トロフィー棚）— すべて将来の change
- 目標の放棄・中断・期間変更（30日固定、脱出手段なし）

## Decisions

### D1. 採用（adopt）モデル — 注入ではなく参照。同一性は `condition_key` 文字列

目標は既存ルール条件を「実践」として**参照**する。`goal_practice` は採用時点の `condition_key` 文字列（`total_work` / `group:<id>` / `planning:<signal>`）をそのまま保存し、以後のバリデーション・レポート集計はこの文字列一致だけで行う。

- 採用候補 = **開始日（翌日）の実効ルールセットに現存する条件**のうち `TOTAL_WORK` / `GROUP` / `PLANNING` ターゲットのもの。`MANUAL_CHECK` は同一性が並び順依存のため採用不可（UI で非表示）。
- 代替案（目標が `goal:<id>` キーの条件を注入・所有する）は棄却: 主用途が「既に走っているルールに目的の傘をかぶせる」であり、注入だと同一条件が重複しゲート表示が濁る。
- 表示用に採用時点のラベルスナップショット（グループ名等）も保存する（グループ改名で表示が壊れないため）。

### D2. ジャンル固定・強度可変の強制点は `rules.ts`

`upsertFutureRuleSet` / `deleteRuleSet` のトランザクション内に検証を追加する（凍結チェック `FrozenRuleError` と同じ層）。

- **検証規則**: 編集適用後、アクティブな各目標について残期間の各日（`明日..end_day`、最大30日）の実効ルールセットを解決し、目標の全実践 `condition_key`（新条件リストから再導出したキー集合に対して）が存在することを確認。欠けていれば `GoalLockError` で ABORT。持ち越し・削除フォールバックも「適用後に解決して確認」で一括カバーする（日数×目標数のループで十分軽い）。
- **閾値変更**: 採用中条件の `threshold_seconds` が変更される場合（上げ下げ問わず）、リクエストに理由（非空文字列）を必須とし `practice_threshold_change`（`condition_key` / `effective_date` / `old_seconds` / `new_seconds` / `reason`）へ記録する。理由が無ければ 400。ログは条件キー単位（目標非依存）とし、同一条件を複数目標が採用していても記録は1本。
- 当日凍結は既存機構のまま — 変更が効くのは常に翌日以降（「泣きの一手」は構造的に不可能）。

### D3. 目標エンティティ — 状態は導出、削除猶予は作成当日のみ

`goal` テーブル: `id / name / purpose / start_day / end_day / created_at`。`end_day = start_day + 29`。

- **開始日は常に翌日**。当日ルールは凍結済みで採用対象の整合が取れないため。作成 UI は翌日の実効ルールセットから採用候補を出す。
- **status カラムは持たない**。`todayKey()` との比較で導出: `today < start_day` = 開始前 / `start_day <= today <= end_day` = 進行中 / `today > end_day` = 完走。
- **削除は `created_at` の day_key == 今日 のときだけ許可**（ブートストラップ例外 `canWriteTodayRule` と同思想の誤作成救済）。翌日以降は削除 API 自体が拒否。放棄機能は作らない。

### D4. 目標日記 — 別テーブル、保存は振り返りと同じ動線に相乗り

`goal_journal(goal_id, day_key, content, created_at, updated_at)` PK=(goal_id, day_key)。`reflection_entry` に触れないので `reflection_done`（本文非空判定）を汚染しない。

- 振り返りタブに、**進行中の目標ごと**の日記コーナー（見出し=目標名、`createMarkdownEditor()` 再利用）を本文エディタの下に置く。保存は既存の「保存する」ボタンと離脱時フラッシュに相乗り（振り返り本文と同時に PUT）。
- 完走後の日記は読み取り専用（レポートから読む）。進行中のみ書ける。

### D5. レポートのデータ源は `per_condition_results` 一本 + 日記

完走した目標（`today > end_day`）に対しヘッダ＋4ブロックを描く。集計はサーバー側 `GET /api/goals/:id/report` で行い、期間30日×実践の行列を返す。

- **① 達成カレンダー**: 各日の `unlock_evaluation.per_condition_results` から実践の `condition_key` 一致エントリの `met`。評価行が無い日・キーが見つからない日は**未達成扱い**（欠測を美化しない）。
- **② 時間推移**: 同じエントリの `actualSeconds` / `thresholdSeconds` をそのまま折れ線＋閾値表示に使う（過去ルールセットの再解決は不要 — 評価時点の値が焼き込み済み）。閾値変更マーカーは `practice_threshold_change` から理由つきで重ねる。時間型実践（TOTAL_WORK/GROUP）が無い目標ではブロック自体を出さない。
- **③ Before/After**: Day1 と Day30 の文面並置。**その日の `goal_journal` があればそれ、無ければ `reflection_entry`** にフォールバック（日単位）。
- **④ 日記リーダー**: 読むのは常に1件。①のカレンダーのマスまたは日付セレクタで日を選ぶ。ソースは③と同じフォールバック規則。
- 達成 N/30（ヘッダ）= 全実践が met の日数。合否・スコアの語は UI に出さない（「完走」のみ）。

### D6. API 面

- `POST /api/goals` `{name, purpose, practices: [conditionKey...]}` → 翌日開始で作成
- `GET /api/goals` → 一覧（導出 status 付き）/ `DELETE /api/goals/:id` → 作成当日のみ
- `GET /api/goals/:id/report` → レポート集計 JSON（完走前は 409）
- `PUT /api/goals/:id/journal/:date` / `GET /api/goals/:id/journal/:date`
- `PUT /api/rules/:date` に任意フィールド `threshold_change_reason` を追加（採用中条件の閾値変更時のみ必須）

### D7. UI 面

- 新「目標」タブ: 進行中（名前・Day X/30・目的）と完走済み（「レポートを開く」）の一覧＋新規作成フォーム。レポートは design-brief のとおり1カラム・4ブロック。②は同梱 Chart.js。
- ルール編集 UI: 採用中条件に「ジャンル固定」バッジ、削除ボタン無効化、閾値変更時は理由入力を促す。
- 振り返りタブ: D4 の日記コーナー。

## Risks / Trade-offs

- [評価行の欠測（サーバー完全停止日）が未達成として描かれる] → 仕様として明記（ゲートも同じ扱い）。レポートは欠測を区別しない代わりに嘘もつかない。
- [`per_condition_results` の形式が将来変わると過去レポートが読めなくなる] → 追記のみ（フィールド削除・改名をしない）を評価側の暗黙契約としてスペックに記載。読み手は未知フィールド無視・欠損キー=未達成で防御。
- [同一条件を複数目標が採用 → 閾値変更ログが共有される] → 意図どおり（事実は1つ）。レポートは自目標の実践キーでフィルタするだけ。
- [`exclude_ungrouped_from_total` 等の設定変更が期間途中で入ると ② の actualSeconds の意味が揺れる] → 評価時点の値＝ゲートが見た値をそのまま示す方針（再計算しない）。
- [ジャンル固定により、目標を作った後でルール構成の自由度が30日間下がる] → 仕様そのもの（コミットメントデバイス）。救済は作成当日削除と閾値変更のみ。

## Migration Plan

migration v11 で `goal` / `goal_practice` / `practice_threshold_change` / `goal_journal` を追加（既存テーブル無変更・後方互換）。ロールバック手段は設けない（既存マイグレーションと同様 forward-only、単独ユーザー・SQLite 単一ファイルバックアップで復元可能）。

## Open Questions

（なし — 実装中に生じた微細な判断は spec のシナリオに従い、逸脱が必要なら本ファイルに追記する）
