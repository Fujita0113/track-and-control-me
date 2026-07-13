## Why

新しい目標（30日チャレンジ）を作るとき、手動チェックのルール条件（例：「筋トレ」）を採用する実践として選べない（issue #46）。ユーザーはルール編集で手動チェックを追加したのに、目標作成の候補リストに現れず採用できない。原因は `MANUAL_CHECK` の `condition_key` が並び順依存（`manual:<index>`）の弱同一性しか持たず、ジャンル固定（30日間キー不変）の前提を満たせないため、採用候補から明示的に除外されているから。`TIMELINE` は既に安定キー（`timeline:<ラベル>`）を導入してこの問題を解消済みで、同じ設計を `MANUAL_CHECK` にも適用すれば自然に採用可能になる。

## What Changes

- `MANUAL_CHECK` 条件の `condition_key` を並び順依存の `manual:<index>` から、ラベル由来の安定キー `manual:<ラベル>` へ変更する（`TIMELINE` の `timeline:<ラベル>` と対称）。並べ替え・他条件の追加削除でキーが変化しなくなる。
- ルール編集で `MANUAL_CHECK` 条件はラベル必須とし、同一ルールセット内でラベル重複を禁止する（安定キーの一意性を担保）。
- 目標作成の採用候補から `MANUAL_CHECK` を除外していた制約を撤廃し、開始日の実効ルールの手動チェック条件を候補に含める。採用時は完了/未完了（チェック）型の実践として扱う（非時間型：完走レポート①カレンダーに乗り、②時間推移からは除外）。
- 既存データの移行：`rule_condition` の `MANUAL_CHECK` 行と、それに紐づく `daily_check`（当日チェック状態）の `condition_key` を `manual:<index>` から `manual:<ラベル>` へ振り替える。**BREAKING**（内部キーの移行を伴う。移行はマイグレーションで一度きり実施）。

## Capabilities

### New Capabilities
- `manual-check-stable-key`: `MANUAL_CHECK` 条件のラベル由来安定キー（`manual:<ラベル>`）の定義、ラベル必須・ルールセット内一意の制約、および既存 `manual:<index>` データ（`rule_condition`・`daily_check`）の移行。

### Modified Capabilities
- `goal-challenge`: 採用候補から `MANUAL_CHECK` を除外する制約（`manual:<index>` の並び順依存を理由とする MUST NOT）を撤廃し、安定キーを持つ手動チェック条件を採用可能にする。採用候補・保存キー・完走レポートでの `MANUAL_CHECK` の扱いを明文化。

## Impact

- サーバー: `server/src/rules/rules.ts`（`deriveConditionKey` の `MANUAL_CHECK` 分岐、ラベル一意バリデーション）、`server/src/services/goals.ts`（`adoptCandidates` の除外撤廃・`practiceLabel` の `MANUAL_CHECK` 表示）、`server/src/db/migrations.ts`（`manual:<index>` → `manual:<ラベル>` の移行）。
- フロント: `server/static/js/goals.js`（採用候補に手動チェックが表示・非時間型として `≥時間` サブラベルなしで描画）。
- データ: `rule_condition.condition_key`・`daily_check.condition_key` の `MANUAL_CHECK` 行を移行。`unlock_evaluation` の履歴 JSON は既存の完走目標が `MANUAL_CHECK` を採用していない（従来不可能だった）ため移行不要。
- 影響なし: 集計・パスワード解錠・rollover のロジック（`MANUAL_CHECK` の評価パイプラインは条件キー単位のまま／キー文字列のみが変わる）。
