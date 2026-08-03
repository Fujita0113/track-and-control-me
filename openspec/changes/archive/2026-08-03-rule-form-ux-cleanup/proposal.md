## Why

ルール作成・編集フォームの条件ドロップダウンにおいて、単一グループ（`GROUP`）とグループOR集計（`GROUP_OR`）が別々の選択肢として提示されており、内部実装の都合がユーザーに露呈し混乱を招いている（issue #78）。
また、条件の選択肢が増加してフラットに並んでいるため視認性が低くなっている。
さらに、モーダル/フォーム操作における `Ctrl + Enter` キーボードショートカットの共通ルールが文書化されておらず、手動対応の漏れが発生しやすい状況にある。

## What Changes

- **グループ作業条件の UI 統合**: ルールフォームのドロップダウンで「グループ作業時間」を1つの選択肢に統合する。グループ選択のチェックボックスが1件の場合は `GROUP` ルール、2件以上の場合は `GROUP_OR` ルールとして透明に保存・更新する。
- **条件ドロップダウンの `<optgroup>` 分類**: `targets.js` および `rule-form.js` を改修し、ドロップダウン項目をカテゴリ（⏱ 作業時間・計測 / 📝 計画・振り返り / ✅ チェック・手動記録）ごとに `<optgroup>` で視覚的に整理する。
- **プロジェクトルールの同期追記**: `CLAUDE.md` / `GEMINI.md` / `.agents/AGENTS.md` の3ファイルに「フォーム・モーダルにおける `Ctrl + Enter` (Mac: `Cmd + Enter`) 送信の原則」を追記・同期する。

## Capabilities

### New Capabilities

- `rule-form-group-unify`: ルールフォーム上で単一グループと複数グループORの選択を「グループ作業時間」として統合し、選択件数から送信種別を自動判定する機能

### Modified Capabilities

- `kanban-rule-conditions`: 条件ドロップダウンを `<optgroup>` でカテゴリ構造化し、`GROUP` と `GROUP_OR` を単一の「グループ作業時間」項目へ集約する表示仕様の更新

## Impact

- **変更ファイル**:
  - `server/static/js/targets.js`
  - `server/static/js/rule-form.js`
  - `CLAUDE.md`
  - `GEMINI.md`
  - `.agents/AGENTS.md`
- **既存 API / DB 影響**: なし（バックエンドの `GROUP` / `GROUP_OR` レジストリ・評価ロジック・マイグレーションはそのまま利用する）
- **既存 e2e**: 既存 spec のセレクト操作に影響がないか検証し、必要に応じて維持・補正する
