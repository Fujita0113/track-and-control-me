## Why

現在 `GROUP` ルールは「1グループ1条件」にしか対応していない。
「英語の勉強 OR 読書 → 合計30分以上」のように、複数のグループを OR で束ねた合計時間でルールを設定したいというユーザー要求（issue #78）に応えられない。

## What Changes

- `GROUP_OR` ターゲットを新規追加する（既存 `GROUP` ターゲットは後方互換を維持）
- `GROUP_OR` ルールは複数の `group_identity_id` を参照し、それらのセッション時間を **合算**して閾値と比較する
- ルールフォームの UI に「グループ OR 集計」種別を追加し、グループを複数選択できるようにする
- ゲート画面・条件テキストは「〈グループA〉または〈グループB〉 XX分以上」の形で表示する
- DB マイグレーション：ルールと複数グループを紐づける中間テーブル `rule_group_member` を追加する

## Capabilities

### New Capabilities

- `rule-group-or-aggregate`: グループ OR 集計ルール — 複数のグループをまとめて「合計時間」で評価する新ルール種別

### Modified Capabilities

- `kanban-rule-conditions`: ルール作成 UI の条件ドロップダウンに `GROUP_OR`（グループ OR 集計）を追加し、グループ複数選択 UI を提供する。既存 `GROUP` 条件の動作は変更しない。

## Impact

- **サーバー DB**: `rule_group_member` テーブル追加（マイグレーション）
- **サーバー評価ロジック**: `server/src/rules/evaluate.ts` に `GROUP_OR` case 追加
- **サーバー ルールレジストリ**: `server/src/services/rule-registry.ts` のバリデーション・CRUD 拡張
- **クライアント UI**: `server/static/js/rule-form.js`・`targets.js` の種別定義・フォーム更新
- **クライアント 表示**: `server/static/js/today.js`（ゲート画面）・`server/static/js/goals.js`（目標画面）の表示ラベル更新
- **既存 e2e**: ルール UI のテストは条件種別リストが変わるため更新が必要
