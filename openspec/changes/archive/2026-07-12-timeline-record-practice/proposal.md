## Why

いまの30日チャレンジで目標にぶら下げられる「実践」は、作業時間まわり（`TOTAL_WORK` / `GROUP`）と翌日計画（`PLANNING`）だけで、**筋トレ・読書・瞑想のような「やった／やらない」系の習慣そのものは目標にできない**。アプリが時間を自動計測できないためで、名前だけ筋トレ・中身は作業時間、というちぐはぐが起きる（issue #21）。既存の「手動チェック（◯✕）」は同一性が並び順依存（`manual:<index>`）で採用不可のまま棚上げされている。タイムラインの手動記録（ラベル＋分数）は安定して識別できるので、これを判定材料にすれば習慣を自己申告で30日チャレンジに乗せられる。

## What Changes

- ルール条件に**新ターゲット `TIMELINE`** を追加する。「指定ラベル（手動カテゴリ）の手動記録が、その日◯分以上あれば達成」で評価する。評価は既存の時間型条件と同じ経路で `actualSeconds` / `thresholdSeconds` を焼き込む。
- ルール編集 UI のフラットな条件ドロップダウンに `TIMELINE`（カテゴリ選択＋分数閾値）を、他ターゲットと同列の日本語ラベルで追加する。
- 目標の実践採用候補に `TIMELINE` を含める。安定キーは `timeline:<ラベル>`。`MANUAL_CHECK` は従来どおり採用不可のまま（世代交代・#9 方針）。
- ジャンル固定・閾値変更の理由必須・完走レポート②（時間の推移）を `TIMELINE` にも効かせる（`TIMELINE` は分数=時間型として扱う）。
- 手動カテゴリの不変条件「ラベルは表示専用で評価・解錠に影響しない」を改め、`TIMELINE` 条件から参照されたカテゴリは目標達成判定・ゲート解錠に影響しうる旨を明記する。

## Capabilities

### New Capabilities
- `timeline-record-condition`: 手動記録（`activity_log_entry` の `MANUAL` エントリ）を「カテゴリラベル一致＋当日合計◯分以上」で評価する新ルール条件ターゲット `TIMELINE`。データモデル・条件キー（`timeline:<ラベル>`）・評価（`actualSeconds`/`thresholdSeconds` 焼き込み）を定義する。

### Modified Capabilities
- `kanban-rule-conditions`: 条件ドロップダウンに `TIMELINE`（カテゴリ＋分数）を他ターゲットと同列で追加。ゲート画面・条件テキストの表示ラベル。
- `goal-challenge`: 実践採用候補に `TIMELINE`（`timeline:<ラベル>`）を追加。`MANUAL_CHECK` 除外は維持。ジャンル固定と閾値変更理由必須を `TIMELINE` にも適用。
- `goal-report`: ②「時間の推移」の時間型実践に `TIMELINE` を含める。
- `manual-category-registry`: 「カテゴリは評価・解錠に影響しない」不変条件に例外（`TIMELINE` 条件から参照されたカテゴリ）を追記。

## Impact

- サーバー: `rules/rules.ts`（`RuleTarget` に `TIMELINE`・`deriveConditionKey`）, `rules/evaluate.ts`（`case 'TIMELINE'` の集計）, `services/goals.ts`（採用候補・`TIME_TARGETS`・`GoalPracticeTarget`・閾値変更対象）, ルール編集/採用のバリデーション。
- フロント: `static/js/rules.js`（条件ドロップダウン＋カテゴリ選択＋分数）, `static/js/goals.js`（採用候補表示・レポート②）。
- DB: `activity_log_entry`（既存・変更なし、`category_key` で一致）/ `rule_condition`（既存カラムで表現、`target` 列に CHECK 制約なし＝マイグレーション不要見込み・design で確認）。
- 自己申告ゆえ厳密さは下がる（本人が正直に記録する前提）。ゲート（パスワード解錠）の重みとのバランスは design の論点。
- 対象外（follow-up）: デモ #20 への習慣系サンプル投入、#22 画像、#25 レポート要素の吟味。
