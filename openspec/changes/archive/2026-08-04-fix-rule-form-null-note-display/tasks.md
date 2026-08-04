## 1. 実装（`server/static/js/rule-form.js`）

- [x] 1.1 `buildRuleForm()` の `syncKind()` で、`PHOTO` / `QUESTION` 分岐の `extra.append(labelSpan(...), input, isEdit ? labelSpan('（作成後は変更不可）') : null)` を、`isEdit` が真のときだけ注記 `labelSpan` を `append` する条件分岐に書き換える（`null` を `append()` へ渡さない）。
- [x] 1.2 「種類」軸で `kindSel` と `extra` を包んでいた `.row`（横並び）ラッパーを外し、`pc-axis` の直接の子として縦に並べる。
- [x] 1.3 `extra` コンテナ自体のクラスを `row` から `pc-field`（縦積み・既存CSS流用）に変更し、種類別の追加入力（しきい値・カテゴリ・チェック名・撮るもの・質問文）がすべてラベル→入力の縦積みになるようにする。

## 2. 既存 e2e への影響確認

- [x] 2.1 `e2e/goal-rule-gate-loop.spec.ts` を実行し、写真×単発・質問×範囲のルール作成フローがレイアウト変更後も通ることを確認する（`.pc-field` セレクタで「終了」欄を絞り込む箇所が `extra` と衝突しないことを含む）。→ green（衝突なし）。
- [x] 2.2 `e2e/rule-form-group-unify.spec.ts` ・ `e2e/rule-group-or-aggregate.spec.ts` を実行し、GROUP/GROUP_OR 選択のフォーム操作（チェックボックス・数値入力）が縦積み後も同じセレクタで動作することを確認する。→ green。
- [x] 2.3 上記で問題があれば実装 (1.) を調整する。既存 e2e の assertion 自体は変更しない（フローズン）。→ 3本とも無調整で green のため対応不要。

## 3. 新規 e2e（DOM確定後に追加）

- [x] 3.1 フロー「ルールを追加モーダルで種類を💬質問／📷写真に切り替えたとき、新規作成時は `null` も編集専用注記も表示されず、編集時は編集専用注記が表示される」を検証する e2e を新規追加する（ファイル名・セレクタは実装のDOMを見てから決める）。→ `e2e/rule-form-edit-note-visibility.spec.ts`。
- [x] 3.2 変更前のコード（`git stash`）で追加した e2e が失敗し、変更後は成功することを `CI=1` 付きで確認する。→ stash 適用時は `not toContainText('null')` で red（実際に `"...質問文null..."` を検出）、`stash pop` 後は green を確認済み。
