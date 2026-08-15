## 1. サービス層の回帰テスト（既存 `setTreePosition` の再利用を保証）— 完了

- [x] 1.1 `server/src/services/task-tree.test.ts` に、隣接する2件のうち前を後ろの直後へ移す形で `setTreePosition` を呼んだ場合、2件が入れ替わり `parent_task_id`/`goal_id` が変わらないことを確認するテストを追加した（子を持つ兄弟3件 A・B・C を用意し、A を B の直後へ挿入 → 並び順が B・A・C になることを確認）
- [x] 1.2 根どうし（`parentId: null`）での隣接入れ替えでも `goal_id` が変わらないことを確認するテストを追加した
- [x] 1.3 子を持つノード（容れ物）を入れ替えても、その子の `parent_task_id` が変わらない（一緒に付いてくる）ことを確認するテストを追加した
- [x] 1.4 **落とし穴の回帰テスト**: `afterTaskId: null` は「先頭」ではなく「末尾」になることを確認するテストを追加した（design の「素朴な実装は先頭境界で壊れる」という判断を裏付ける証拠）
- [x] 1.5 `npm test -- --run task-tree` を実行し、74件全て green であることを確認済み（サービス層に新規コードが無いため意図どおり green。今回の契約を固定する回帰テストとして機能する）

## 2. クライアント実装（`server/static/js/blueprint.js`）

- [x] 2.1 `onTreeKeydown` に `Alt+ArrowUp` / `Alt+ArrowDown` の分岐を追加する（`node` が無ければ何もしない）
- [x] 2.2 `handleMoveSibling(nodeId, dir)` を実装する（design の Decisions のとおり）:
  - `dir === 'down'`: `idx = siblingIds.indexOf(nodeId)`。`idx === -1 || idx === siblingIds.length - 1` なら何もしない。そうでなければ `api.setTaskTreePosition(nodeId, { parentId: info.parentId, afterTaskId: siblingIds[idx + 1] })`
  - `dir === 'up'`: `idx = siblingIds.indexOf(nodeId)`。`idx <= 0` なら何もしない。そうでなければ `api.setTaskTreePosition(siblingIds[idx - 1], { parentId: info.parentId, afterTaskId: nodeId })`（**動かすのは前の兄弟の方**であり、対象自身ではない点に注意）
  - **`Alt+↑` を「対象の2つ前の兄弟を参照（無ければ null）」の形で実装しないこと**（design の落とし穴・task 1.4 のテストが検出する誤り）
- [x] 2.3 呼び出し成功後、`reload()` する（対象ノードの id は変わらないため `S.selId` の再設定は不要）。失敗時は既存の `handleTab` と同様に `toast` でエラーを表示する
- [x] 2.4 `legendEl` に `Alt+↑↓ 並べ替え` の凡例エントリを追加する

## 3. テスト（e2e）

- [x] 3.1 既存 e2e（`e2e/goal-blueprint-editor-fix.spec.ts`、`e2e/goal-blueprint-keyboard-tree.spec.ts`、`e2e/goal-blueprint-task-tree.spec.ts`）を確認 — 凡例へのスパン追加や新規キー分岐は既存のセレクタ・テキスト完全一致の想定と衝突しないため、**既存 E2E への影響なし**（`bp-legend` の存在チェックのみで文言の完全一致は見ていない）。実装後に念のため実行して確認する
- [x] 3.2 新規 e2e（実装後、DOM ができてから最後に書く）: 「タスク一覧で兄弟を Alt+↑/Alt+↓ で並べ替える」フロー — 同じ深さの兄弟2件を作り、後ろの1件で `Alt+↑` を押すと表示順が入れ替わり、リロード後も維持されることを確認する
- [x] 3.3 新規 e2e の red-proof: `git stash push -- server/` → `CI=1 npx playwright test <新規spec>` で実装なしでは失敗することを確認 → `git stash pop` → 実装ありで通ることを確認する
