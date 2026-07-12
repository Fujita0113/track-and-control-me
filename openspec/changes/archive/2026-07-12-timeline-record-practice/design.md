## Context

30日チャレンジ（実装済み・archive 済み）は、実践を既存ルール条件の `condition_key` で「採用」するモデル。採用可能なのは `total_work` / `group:<id>` / `planning:<signal>` の3系統だけで、`MANUAL_CHECK` は `condition_key=manual:<index>`（並び順依存＝同一性が弱い）ゆえ採用不可として除外されている（`services/goals.ts` `adoptCandidates`）。このため筋トレ・読書のような習慣は目標に据えられない。

一方タイムラインタブには手動記録機能があり、`activity_log_entry`（`entry_type='MANUAL'`）に `category_key`（手動カテゴリの trim 名、既定に「運動」あり）と時間帯（`start_at`/`end_at`）が保存される。カテゴリはレジストリ（`manual_category`、名前が主キー）で永続管理される。

評価は `rules/evaluate.ts` の `switch(c.target)` が条件ごとに `met`/`actualSeconds`/`thresholdSeconds` を算出し、`unlock_evaluation.per_condition_results` に JSON で焼き込む。完走レポート（`services/goals.ts`）はこの焼き込み値だけを読むので、時間型実践は `TIME_TARGETS` に入っていれば①カレンダー・②時間推移に自動で乗る。

## Goals / Non-Goals

**Goals:**
- 手動記録（ラベル＋分数）を判定材料にする新ルール条件ターゲット `TIMELINE` を追加し、習慣を自己申告で30日チャレンジに乗せる。
- 既存の時間型評価パイプライン（`actualSeconds`/`thresholdSeconds` 焼き込み → レポート①②）を再利用し、レポート側の分岐追加を最小化する。
- 安定キー `timeline:<ラベル>` により、`MANUAL_CHECK` の弱同一性問題を回避して採用可能にする。

**Non-Goals:**
- `MANUAL_CHECK`（◯✕）を採用可能にすること（従来どおり除外・世代交代）。
- カテゴリの改名／統合 UI。カテゴリ名は `TIMELINE` の安定キーを兼ねるため、本変更では改名手段を増やさない。
- 手動記録の重なり考慮・二重計上防止の厳密化（同一ラベルの重複記録は想定しない前提で単純合算）。
- デモ #20 の習慣サンプル投入、#22 画像、#25 レポート要素の吟味（別 issue）。

## Decisions

### D1: `TIMELINE` は新ルール条件ターゲット（既存カラムで表現、マイグレーション不要）
`RuleTarget` に `'TIMELINE'` を追加。条件は既存 `rule_condition` テーブルのカラムで表現する:
- `target='TIMELINE'`
- `label=<カテゴリ名>`（一致キー兼表示ラベル。`GROUP` が `stable_group_id` で一致するのに対し、`TIMELINE` は `label` で一致）
- `threshold_seconds=<分×60>`

`rule_condition.target` に CHECK 制約は無い（コメントのみ）ことを migrations.ts で確認済みのため、**スキーマ変更なし**で追加できる。`deriveConditionKey` に `case 'TIMELINE': return 'timeline:' + (label);` を足す。

**代替案**: 専用テーブルや `category_key` 列の新設 → オーバーエンジニアリング。`label` を一致キーに使う方が既存モデルに素直（`GROUP` と対称）。

### D2: 一致は `category_key` の完全一致
評価は当日の MANUAL エントリを `WHERE day_key=? AND entry_type='MANUAL' AND category_key=?`（`?=label`）で引き、`SUM(end_at - start_at)/1000` を `actualSeconds` に。`addManualEntry` は category を trim して `category_key` に格納する（空なら `'uncategorized'`）ので、`label` 側も同じ trim 名で保存すれば完全一致で引ける。

**代替案**: `title` 一致 → タイトルは自由文で不安定。`category_key` はレジストリ管理で安定。

### D3: 安定キー `timeline:<ラベル>` と採用可否
`condition_key='timeline:'+label`。カテゴリ名が主キーの永続レジストリなので、並び順・他条件の増減で変化しない（`manual:<index>` の弱同一性を解消）。`adoptCandidates` の除外条件は `MANUAL_CHECK` のみに保ち、`TIMELINE` は候補に含める。`GoalPracticeTarget` に `'TIMELINE'` を追加、`TIME_TARGETS` に `'TIMELINE'` を追加（→ レポート②が自動で乗る）。

### D4: ジャンル固定・閾値理由必須の拡張
- `assertGoalsSatisfied`（残期間の実効ルールに採用 `condition_key` が存在するか検証）は `condition_key` 文字列ベースなので `timeline:*` も自動で保護される（追加実装ほぼ不要、テストで確認）。
- `recordThresholdChanges` は現在 `target IN ('TOTAL_WORK','GROUP')` に限定。ここに `'TIMELINE'` を加え、閾値変更の理由必須・記録を効かせる。

### D5: UI（`rules.js`）
条件ドロップダウンに「タイムライン記録」を追加。選択時にカテゴリ選択（`GET /api/categories` の直近使用順）＋分数入力を出す。保存ペイロードは `{target:'TIMELINE', label, thresholdSeconds}`。ゲート画面・条件テキストは「<カテゴリ> ◯分以上」で表示（`timeline:` 接頭辞は出さない）。目標作成 UI（`goals.js`）は採用候補に `TIMELINE` が並ぶだけで、ラベル表示は既存 `practiceLabel` を拡張。

## Risks / Trade-offs

- **[自己申告ゆえズルの余地] → 緩和**: 本人が正直に記録する前提。ゲート（パスワード解禁）の重みとしては「無心で続ける」用途に十分だが厳密性は下がる。仕様として「事実の記録」に留め、罰やスコアを付けない設計方針（#9）と整合。閾値の緩和は理由必須で記録されるため、後から自分の交渉ログとして残る。
- **[カテゴリ名がキー＝改名でキーが割れる] → 緩和**: 改名 UI を出さない（Non-Goal）。既存レジストリは upsert のみで改名・削除手段が無いため現状は安全。将来カテゴリ改名を入れる場合は `timeline:*` 条件のキー移行が必要 → Open Question。
- **[「運動」ラベルが評価に影響するようになる] → 明記**: manual-category-registry の不変条件（表示専用）を delta で改訂。`TIMELINE` 条件から参照されたカテゴリのみ評価に効く、と限定。
- **[同一ラベルの重複記録で二重計上] → 許容**: 手動記録は同一ラベルを重ねない前提で単純合算。重なり除去は Non-Goal。

## Migration Plan

- スキーマ変更なし（既存カラムで表現）。マイグレーション追加は不要の見込み（実装時に `rule_condition.target` の CHECK/トリガを最終確認し、制約があれば relax マイグレーションを1本追加）。
- 後方互換: 既存ルール・目標は `TIMELINE` を含まないため完全 no-op。`evaluate.ts` の switch に case を足すだけで既存 target の挙動は不変。
- ロールバック: `TIMELINE` 条件を作らなければ機能は休眠。作成済み条件が残った状態で戻す場合のみ、未知 target として評価不能になるため、ロールバック時は該当条件の削除を案内。

## Open Questions

- ゲート重みのバランス（自己申告条件を必須 AND に混ぜるか、任意 OR 寄りにするか）は運用で調整。仕様では強制しない。
- 将来のカテゴリ改名対応時の `timeline:*` キー移行方針（今回は改名を出さないので先送り）。
