## 1. 追加入力の Tab / Shift+Tab（子モード切り替え）

- [x] 1.1 `renderSiblingList` を、`S.addAfter.asChild` のときは対象ノードの直後に追加入力を差し込まないよう変更する
- [x] 1.2 `nodeEl` に、対象ノードが `S.addAfter.afterTaskId` かつ `asChild` のとき子コンテナを強制的に開き、末尾に追加入力を差し込む分岐を追加する
- [x] 1.3 追加入力の `keydown` ハンドラに `Tab` / `Shift+Tab` の分岐を追加し、`S.addAfter` の `asChild` を切り替える（直前のタスクが無いときは何もしない）
- [x] 1.4 `submitAdd` を、`asChild` のとき `api.createChildTask` を呼ぶよう分岐する

## 2. 打ちかけ文字列の保持

- [x] 2.1 `Tab` / `Shift+Tab` を押した瞬間の `input.value` を `draft` として次の `S.addAfter` に持たせる
- [x] 2.2 `addInlineRowEl` が新しい `<input>` の初期値を `S.addAfter.draft` から復元するようにする
- [x] 2.3 `restoreFocus` で、追加入力へのフォーカス時にカーソルを末尾（`value.length`）へ戻す

## 3. テスト

- [x] 3.1 既存 e2e（`e2e/goal-blueprint-editor-fix.spec.ts`、`e2e/goal-blueprint-keyboard-tree.spec.ts`）が壊れていないことを確認する（影響なし）
- [x] 3.2 新規 e2e: 追加入力で `Tab` を押すと子モードへ切り替わり `Shift+Tab` で戻せ、確定すると子として作られる（`e2e/goal-blueprint-editor-fix.spec.ts`）
- [x] 3.3 新規 e2e: 追加入力に文字を打ちかけた状態で `Tab` を押しても文字列が消えない（`e2e/goal-blueprint-editor-fix.spec.ts`）
- [x] 3.4 実装なしでは新規 e2e 2本が失敗することを `git stash` + `CI=1` で確認済み（red-proof 済み）
