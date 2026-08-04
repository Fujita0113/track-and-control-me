## Context

`rule-form.js` の `buildRuleForm()` は「種類」（`kindSel`）と種類ごとの追加入力（`extra`）を1つの `.row`（flex横並び）に押し込んでいる。`syncKind()` は `target` に応じて `extra` の中身を作り直すが、写真ルール・質問ルールの分岐だけ、編集時専用の注記を

```js
extra.append(labelSpan('質問文'), questionInp, isEdit ? labelSpan('（作成後は変更不可）') : null);
```

という形で `append()` の第3引数に三項演算子の結果を直接渡していた。`Element.append()` は非 Node の引数を `String(value)` で文字列化してテキストノードとして追加するため、`isEdit=false`（新規作成）のとき `null` がそのまま `"null"` という可視テキストになる（issue #84）。

同じ issue で「種類」欄と「質問文」欄が横並びで読みにくいという指摘もあり、原因は上記 `.row` による横並びレイアウト。

## Goals / Non-Goals

**Goals:**
- 新規作成時に `null` などの不正な文字列がフォームに表示されないようにする。
- 「種類」セレクトと種類別の追加入力を縦に並べ、質問文のような長めの入力欄を読みやすくする。
- 既存 e2e（`goal-rule-gate-loop` / `rule-form-group-unify` / `rule-group-or-aggregate`）のDOM前提を壊さない。

**Non-Goals:**
- フォーム全体のビジュアルデザインの刷新（今回は最小限のレイアウト是正のみ）。
- 種類×スケジュールの2軸独立という既存の設計方針自体の変更（そのまま維持する）。
- 写真ルールのキャプション欄・グループ選択欄など、issue #84 で指摘されていない他の入力の見た目調整。

## Decisions

- **`append()` に `null` を渡さない**: `isEdit ? labelSpan(...) : null` という三項演算子を、`if (isEdit) extra.append(labelSpan(...))` という条件分岐に置き換える。代替案として「常に空文字のラベルを追加してCSSで隠す」も検討したが、不要なDOMノードを増やすだけで根本原因（`null` を `append` に渡す書き方）が残るため採用しない。
- **`extra` コンテナを `row`（横並び）から `pc-field`（縦積み）に変更**: 既存CSSに `.pc-field { display:flex; flex-direction:column; gap:4px; }` が「開始日」欄などで既に使われており、ラベル→入力の縦積みパターンとして確立済み。新しいクラスを増やさずこれを再利用する。
- **`種類`軸（`kindSel` + `extra`）も横並びの `row` から外し、`pc-axis`（縦積み）の直接の子として並べる**: `pc-axis` は既に `flex-direction: column` のため、`row` ラッパーを取り除くだけで種類セレクトと追加入力が別行になる。

## Risks / Trade-offs

- [Risk] `extra` を縦積みにすると、`GROUP`/`GROUP_OR`・`TIMELINE` など他ターゲットの「ラベル＋数値入力」も縦に並び、見た目の密度が変わる → Mitigation: いずれも短いラベル＋小さい入力欄なので縦積みでも可読性は損なわれない。既存 e2e で操作性（selectOption・fill）が壊れていないことを確認する。
- [Risk] 既存 e2e が `.pc-field` セレクタで「終了」欄を絞り込んでいる（`form2.locator('.pc-field', { hasText: '終了' })`）箇所があり、`extra` にも同クラスを付けるとセレクタ的に競合しないか → Mitigation: `hasText` フィルタで文言が異なるため衝突しない。実装時に対象 e2e を実行して確認する。

## Migration Plan

- フロントエンドの純粋なJS/DOM変更のみ。DBスキーマ・APIへの影響なし。ロールバックは当該コミットの revert のみで完結する。

## Open Questions

（なし）
