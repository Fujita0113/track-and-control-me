## Why

振り返りタブの「ルールを追加」モーダルで質問ルール（💬 QUESTION）・写真ルール（📷 PHOTO）を新規作成すると、質問文・撮るもの欄の右に文字列 `null` が表示される（issue #84）。`rule-form.js` の `syncKind()` が編集時専用の注記を `isEdit ? labelSpan(...) : null` という式で組み立て、新規作成時（`isEdit=false`）に確定する `null` をそのまま `Element.append()` に渡しているため、`null` が文字列 `"null"` に変換されテキストノードとして描画されてしまうのが原因。ユーザーからも「nullは何なんだろうかって思っている」と、意味不明な表示として指摘されている。

## What Changes

- `rule-form.js` の `syncKind()` で、写真ルール・質問ルールの編集専用注記（「（作成後は変更不可）」）を、新規作成時は一切 DOM に追加しない形に修正する（`isEdit` が偽のときに `null` を `append()` へ渡さない）。
- 併せて、同じフォームの「種類」セレクトと種類別の追加入力（質問文・撮るもの等）を横並び（同一行）から縦積みに変更し、質問文のような長めの入力欄が窮屈にならないようにする（issue #84 のもう一つの指摘。振る舞いの変更はなく見た目のみ）。

## Capabilities

### New Capabilities
（なし）

### Modified Capabilities
- `editable-rule-registry`: 「写真ルール・質問ルールと種類×スケジュールの独立2軸」要件に、新規作成時は編集専用の注記文言が表示されず、`null` などの不正な文字列がフォームに混入しないことを追加する。

## Impact

- `server/static/js/rule-form.js`: `buildRuleForm()` 内の `syncKind()`（種類別の追加入力を組み立てる箇所）と、`種類`軸のDOM構造（`kindSel` と `extra` の配置）。
- 既存 e2e `e2e/goal-rule-gate-loop.spec.ts` / `e2e/rule-form-group-unify.spec.ts` / `e2e/rule-group-or-aggregate.spec.ts`: いずれもこのフォームのDOM構造に触れるため、レイアウト変更（縦積み化）で選択子・操作手順が壊れていないか確認が必要（実装側で確認済み・全て green）。
