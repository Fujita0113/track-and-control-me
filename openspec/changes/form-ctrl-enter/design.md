## Context

`goals.js` の `endGoalModal` 関数は「この目標を終える」ボタンを持つモーダルを表示する。
同じファイルの目標作成モーダル（`openCreateGoalModal`）は `ctrlEnterToSave(body, save)` で
Ctrl+Enter 対応済みだが、`endGoalModal` には追加されていない。

他の実装済み箇所:
- `settings.js`: `ctrlEnterToSave(editCard, save)` ✓
- `rule-form.js`: `ctrlEnterToSave(body, save)` ✓
- `goals.js`（目標作成）: `ctrlEnterToSave(body, save)` ✓
- `goals.js`（目標を終える）: **未実装** ← 今回対応

`ctrlEnterToSave(root, saveBtn)` は `util.js` に実装済みで、IME ガード・disabled 中の二重送信防止も含む。

## Goals / Non-Goals

**Goals:**

- `endGoalModal` に `ctrlEnterToSave(body, save)` を追加して Ctrl/Cmd+Enter で「この目標を終える」ボタンをトリガーする

**Non-Goals:**

- `ctrlEnterToSave` 自体の変更
- 他画面の Ctrl+Enter 対応（今後の課題）
- ツールチップ（`attachTooltip`）の追加 ← `endGoalModal` のボタンにはツールチップ未設定だが今回は対象外

## Decisions

### D1: 最小変更で対応する

`endGoalModal` 内の `openModal(body, '目標を終える');` の直前に `ctrlEnterToSave(body, save);` を1行追加するだけで要件を満たす。パターンは他のモーダルと完全に同一。

## Risks / Trade-offs

- リスクなし。`ctrlEnterToSave` は本番で安定稼働中のユーティリティ。変更は1行。
