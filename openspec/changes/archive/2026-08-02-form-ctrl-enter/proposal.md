## Why

「目標を終える」モーダルの保存ボタン（「この目標を終える」）が Ctrl+Enter で押せない（issue #78）。
他のフォーム（ルール作成・設定・目標作成）にはすでに `ctrlEnterToSave` が実装されており、
このモーダルだけが取り残されている。ユーザーの期待する一貫した UX を提供するために修正する。
また、ショートカット追加時にホバーヒント（ツールチップ）の付与を漏れなく自動化・標準化する。

## What Changes

- `goals.js` の `openEndDialog` 関数に `ctrlEnterToSave(body, save, '終える')` を追加する
- `util.js` の `ctrlEnterToSave(root, saveBtn, tooltipLabel)` を拡張し、第3引数 `tooltipLabel` が渡された場合は自動で `attachTooltip(saveBtn, { label: tooltipLabel, keys: ['Ctrl', 'Enter'] })` も設定されるようにする

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `enter-submit-ime-guard`: 「目標を終える」モーダルを Ctrl+Enter 対応フォームの一覧に追加する

## Impact

- **変更ファイル**: `server/static/js/goals.js`, `server/static/js/util.js`
- **既存 e2e**: 影響なし（Ctrl+Enter での送信確認 e2e を追加）
