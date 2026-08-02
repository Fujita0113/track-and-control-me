## Context

`goals.js` の `openEndDialog` 関数は「この目標を終える」ボタンを持つモーダルを表示する。
同じファイルの目標作成モーダル（`openCreateGoalModal`）は `ctrlEnterToSave` + `attachTooltip` で
Ctrl+Enter 対応およびホバーヒント表示済みだが、`openEndDialog` には追加されていなかった。

他の実装済み箇所:
- `settings.js`: `ctrlEnterToSave(editCard, save)` + `attachTooltip` ✓
- `rule-form.js`: `ctrlEnterToSave(body, save)` + `attachTooltip` ✓
- `goals.js`（目標作成）: `ctrlEnterToSave(body, save)` + `attachTooltip` ✓
- `goals.js`（目標を終える）: **未実装** ← 今回対応

## Goals / Non-Goals

**Goals:**

- `openEndDialog` に `ctrlEnterToSave(body, save, '終える')` を追加して Ctrl/Cmd+Enter で「この目標を終える」ボタンをトリガーする
- `ctrlEnterToSave` 内で `attachTooltip` を自動設定できるように拡張し、ショートカット付与時のツールチップ漏れを構造的に防止する

**Non-Goals:**

- 他画面の Ctrl+Enter 対応（今後の課題）

## Decisions

### D1: `ctrlEnterToSave` の第3引数でツールチップを自動付与する

`ctrlEnterToSave(root, saveBtn, label)` のように第3引数へラベル（例: `'終える'`）を渡すと、内部で `attachTooltip(saveBtn, { label, keys: ['Ctrl', 'Enter'] })` も自動呼び出しする。ラベル省略時は既存のキー操作ハンドラのみ登録されるため、既存コードの後方互換性を壊さない。

## Risks / Trade-offs

- リスクなし。`ctrlEnterToSave` の拡張は既存の挙動を破壊せず、ツールチップ共通化を促進する。
