## Context

現在の `GROUP` ルールは 1 行 1 グループに対応する。評価は `rule.group_identity_id`（または後方互換の `stable_group_id`）が指すグループの 1 日のセッション時間合計と閾値を比較するだけで、複数グループの合算は不可能。

ユーザーは「英語の勉強 *または* 読書 → 合計30分以上」のように、複数グループを **OR（合算）** で束ねた時間を条件にしたいと要求している（issue #78）。

既存 `GROUP` ターゲットは評価・表示・沿革すべてで使われており、既存ルールへの破壊的変更は避ける。

## Goals / Non-Goals

**Goals:**

- 新ターゲット `GROUP_OR` を追加し、複数グループのセッション時間を合算して閾値と比較する評価を実現する
- ルール作成 UI でグループを複数選択できるようにする（既存 `GROUP` フォームは変更しない）
- ゲート画面・条件テキストで「〈A〉または〈B〉 XX分以上」と分かりやすく表示する
- 既存 `GROUP` ルールには一切影響を与えない（後方互換を保つ）

**Non-Goals:**

- 既存 `GROUP` ルールを `GROUP_OR` に移行・変換する機能
- AND 結合（すべて達成）の複数グループ集計
- 3 グループ以上の上限解除（UI は上限なしだが実用的に 2〜3 グループ想定）

## Decisions

### D1: `rule` テーブルの新 target + 中間テーブル `rule_group_member`

`GROUP_OR` は `rule.target='GROUP_OR'` として区別し、グループの複数参照は `rule_group_member(rule_id, group_identity_id, sort_order)` 中間テーブルで持つ。

**採用理由:**

- 既存 `GROUP` ルールの行（`rule.group_identity_id`）を一切変更しない。後方互換がゼロコスト。
- `rule_group_member` は `rule` 行に対してのみ参照外部キーを持つ。シンプルな JOIN で参照でき、削除時に CASCADE でクリーンアップされる。
- 将来 `GROUP_AND`（AND 結合）や「3グループ以上」などへの拡張も同一テーブルで受けられる。

**却下した案 — 既存 `GROUP` を拡張（`group_identity_ids` JSON列）:**

- 既存 `GROUP` の評価ロジックに `GROUP_OR` の合算ロジックが混入し、評価ロジックが複雑になる。
- 移行時に既存ルールへの影響範囲が不透明。

### D2: GROUP_OR ルールの condition_key は `rule:<id>` のまま

既存 `GROUP` と同様、`rule:` プレフィックス＋数値 ID で condition_key を生成する。`group_or:` のようなプレフィックスは不要（target 列で区別できる）。

### D3: 評価は GROUP_OR 専用の case を evaluate.ts に追加

`GROUP_OR` case は `rule_group_member` から全グループの alias を取得し、全グループのセッション時間を合算して閾値と比較する。`GROUP` case は変更しない。

### D4: UI はグループ複数選択をチェックボックスで実現

`rule-form.js` に `GROUP_OR` のフォームを追加する。グループ一覧をチェックボックスで表示し、2件以上選択を必須とする。既存 `GROUP` の単一 `<select>` は変更しない。

## Risks / Trade-offs

- **中間テーブルと rule_change の整合**: `rule_change` の `before`/`after` JSON は現在 `rule` 行の列値をスナップショットするが、`rule_group_member` は別テーブル。スナップショットに `groupIdentityIds` 配列を含める形に拡張し、沿革の再現性を維持する。
  - → `contentSnapshot` 関数に `groupIdentityIds` フィールドを追加し、`rule_group_member` を JOIN して読む。
- **旧評価結果 `per_condition_results` との整合**: `GROUP_OR` 評価後の JSON 構造が `GROUP` と同一（`actualSeconds`, `thresholdSeconds`, `met`）になるようにし、既存の集計・レポートロジックへの影響を最小化する。
- **ルール API の `createRule`/`updateRule`**: `GROUP_OR` は複数 `groupIdentityIds` を受け取り、DB への書き込みは `rule` 挿入後に `rule_group_member` を挿入するトランザクション。`updateRule` では `rule_group_member` を一度全削除し再挿入する（シンプルさ優先）。

## Migration Plan

1. 新マイグレーションで `rule_group_member` テーブルを追加する（既存 `rule` テーブルは変更しない）。
2. 新 target `'GROUP_OR'` をサーバーサイドの型・バリデーション・評価に追加する。
3. クライアント側の `targets.js`・`rule-form.js` を更新して UI に `GROUP_OR` を追加する。
4. 既存 `GROUP` データは何も変更しない（ロールバックはマイグレーション削除だけ）。
