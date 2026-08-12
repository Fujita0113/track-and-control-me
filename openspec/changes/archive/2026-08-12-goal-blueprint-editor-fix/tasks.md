## 1. フォーカス奪い返しの修正（design D1）

- [x] 1.1 `blueprint.js` の `renderAll()` 冒頭（`clear(root)` の前）で `hadFocusInside = S.root && document.activeElement && S.root.contains(document.activeElement)` を評価して保持する（実装では、この判定をタイトル編集の blur から来た再描画だけに絞る `skipFocusRestoreIfOutside` オプションとして実装。初期表示・キー操作等の既存フローを壊さないため。design.md にも追記）
- [x] 1.2 `renderAll()` 末尾の `restoreFocus()` 呼び出しを `hadFocusInside` でガードし、再描画直前にフォーカスがツリーの外にあった場合は呼ばない
- [x] 1.3 確認: 新規 e2e（`e2e/goal-blueprint-editor-fix.spec.ts`）で、タイトルを書き換えてツリー外（`.bp-title`）をクリックすると入力枠のフォーカスが外れ `.bp-node-row.sel` が0件になることを確認済み（red-proof: 未実装コードでは失敗、実装後は成功）
- [x] 1.4 確認: 同 e2e で、別のノードのタイトルへクリックで乗り換えたあと↑↓で移動できる（乗り換え先から前のノードへ戻れる）ことを確認済み
- [x] 1.5 確認: 既存の凍結 e2e（`e2e/goal-blueprint-keyboard-tree.spec.ts` 全8本・`e2e/goal-blueprint-task-tree.spec.ts` 1本）を実行し全て pass。Enter 追加・Tab・Shift+Tab・Alt+C・Ctrl+Enter のキーボード駆動フローに回帰が無いことを確認済み

## 2. 本文プレビューの削除（design D2）

- [x] 2.1 `blueprint.js` の `nodeEl()` から `.bp-node-notes` を追加している if ブロックを削除する
- [x] 2.2 `server/static/css/app.css` の `.bp-node-notes` ルール（未使用になる1行）を削除する
- [x] 2.3 確認: 新規 e2e で、Ctrl+Enter で詳細モーダルを開いて本文を書いて閉じたあと `.bp-node-notes` が0件であることを確認済み（red-proof: 未実装コードでは失敗、実装後は成功）

## 3. テスト

- [x] 3.1 新規 vitest なし（このバグはフロントエンド（`server/static/js`）のみで完結し、`server/src/**/*.test.ts` の対象であるサービス・API層に変更が無いため。`vitest.config.ts` は `server/static/js` を対象に含めていない）
- [x] 3.2 既存 e2e への影響なし: `e2e/goal-blueprint-keyboard-tree.spec.ts`（8本）・`e2e/goal-blueprint-task-tree.spec.ts`（1本）を実行し全て pass（ファイル自体は無変更）
- [x] 3.3 新規 e2e `e2e/goal-blueprint-editor-fix.spec.ts` を実装後の DOM に対して追加:
      - フロー: 「タイトルを編集してツリーの外へクリックすると、入力枠のフォーカスと選択枠が外れる。別のノードをクリックすればそこから↑↓でタスク移動を再開できる」
      - フロー: 「Detail モーダルに本文を書いて閉じても、一覧の行の下にプレビューが出ない」
      - red-proof 済み: `git stash` で実装を退避した状態では両方とも失敗（フォーカス奪い返し／`.bp-node-notes` 検出）し、実装を戻すと両方 pass することを確認
- [x] 3.4 `npm test` を実行し、既存555件のテストが全て通ることを確認した（今回はサービス・API層の変更が無いため新規の赤テストは無い）

## 4. 空のエフェメラルな追加入力を Escape (Esc) / Delete キーと自動クローズで消せるようにする（design D3・issue #99 の追加コメント）

- [x] 4.1 `blueprint.js` の `addInlineRowEl()` の `<input>` の `keydown` ハンドラに `Escape` (Esc) および `Delete` キーの分岐を追加・整備する。`Escape` または値が空（trim後）での `Delete` のとき `e.preventDefault(); S.addAfter = null; renderAll();`（値が入っているときの `Delete` は通常のテキスト編集として素通しする）（`Escape` は既存実装済みだったので `Delete` 分岐のみ追加）
- [x] 4.2 同じ `<input>` に `blur` ハンドラを追加する。当初 `queueMicrotask` で実装したが、実測で「クリックによる mousedown→mouseup→click は複数タスクに分かれて処理される」ため早すぎ、クリック先の別ノードの `<input>` を先に破壊してフォーカスがどこにも乗らなくなる不具合が e2e で発覚。`setTimeout(fn, 0)`（マクロタスク）に変更して解消（design D3 に追記）。`S.root.querySelector('.bp-add-input')` で現在の追加入力を取り直し、(a) まだ存在し (b) 値が空 (c) もうフォーカスが無い、の3条件が揃っていれば `S.addAfter = null; renderAll({ skipFocusRestoreIfOutside: true });` を呼ぶ
- [x] 4.3 確認: 新規 e2e で、空の追加入力を開いたまま別のノードのタイトルをクリックすると、追加入力が閉じてそのノードが選択され、そこから ↑↓ で移動できることを確認済み（red-proof: 未実装コードでは失敗、実装後は成功）
- [x] 4.4 確認: 新規 e2e で、空の追加入力を開いたままツリーの外をクリックすると、追加入力が閉じ、フォーカスはツリーの中へ戻らないことを確認済み（red-proof 済み）
- [x] 4.5 確認: 新規 e2e で、空の追加入力で `Escape` (Esc) と `Delete` それぞれで閉じて、直前に触っていたノードへ選択とフォーカスが戻ることを確認済み（red-proof 済み）
- [x] 4.6 デグレ確認: 既存の凍結 e2e（`e2e/goal-blueprint-keyboard-tree.spec.ts` 全8本・`e2e/goal-blueprint-task-tree.spec.ts` 1本）を実行し全て pass。「追加入力にタイトルを打ってから別のノードをクリックしても閉じない」は、この変更の前後で挙動が変わらない（元々ブラーで何もしなかった）ため red-proof できる新規 e2e にはせず、コードレビュー（`blur` ハンドラが非空値では早期 return すること）で確認した
- [x] 4.7 新規 vitest なし（引き続きフロントエンドのみの変更）。既存 e2e（`e2e/goal-blueprint-keyboard-tree.spec.ts` 全8本・`e2e/goal-blueprint-task-tree.spec.ts` 1本）を実行し pass を確認した
- [x] 4.8 新規 e2e を `e2e/goal-blueprint-editor-fix.spec.ts` に追記した（実装後、DOM ができてから）:
      - フロー: 「空の追加入力を開いたまま別のノードをクリックすると、追加入力が閉じてそのノードを選べ、↑↓で移動できる」
      - フロー: 「空の追加入力を開いたままツリーの外をクリックすると閉じる」
      - フロー: 「空の追加入力は Escape でも Delete でも閉じ、直前に触っていたノードへ戻る」
      - 「文字が入った追加入力は他のノードをクリックしても閉じず、内容も消えない」は当初 e2e として書いたが、この change の前後で挙動が変わらず red-proof できなかった（stash した未実装コードでもテストが green のまま）ため、e2e からは削除し 4.6 のコードレビュー確認に置き換えた
      - red-proof（`git stash` + `CI=1`）で、実装した3本の新規シナリオが未実装コードでは失敗し、実装を戻すと成功することを確認した
- [x] 4.9 `npm test` を実行し、既存555件のテストが全て通ることを確認した
