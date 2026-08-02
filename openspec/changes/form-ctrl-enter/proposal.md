## Why

「目標を終える」モーダルの保存ボタン（「この目標を終える」）が Ctrl+Enter で押せない（issue #78）。
他のフォーム（ルール作成・設定・目標作成）にはすでに `ctrlEnterToSave` が実装されており、
このモーダルだけが取り残されている。ユーザーの期待する一貫した UX を提供するために修正する。

## What Changes

- `goals.js` の `endGoalModal` 関数に `ctrlEnterToSave(body, save)` の1行を追加する
- 既存の `ctrlEnterToSave` ユーティリティ関数（`util.js`）はそのまま利用する（変更なし）
- 他に Ctrl+Enter が欠けているフォームが見つかった場合は合わせて対応する

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `enter-submit-ime-guard`: 「目標を終える」モーダルを Ctrl+Enter 対応フォームの一覧に追加する

## Impact

- **変更ファイル**: `server/static/js/goals.js`（1行追加）
- **変更なし**: `util.js`（`ctrlEnterToSave` は既存をそのまま使う）
- **既存 e2e**: 影響なし（Ctrl+Enter が動くことの確認は apply 時に e2e で書く）
