## 1. フロントエンド: pending判定とdirty管理

- [x] 1.1 `server/static/js/kanban.js` に `hasPendingCard(colKey)` を追加する（`S.tasks.some(x => normStatus(x.status) === colKey && x.id <= 0)`、design D1）。
- [x] 1.2 `S.dirtyReorderCols`（Set）を state 初期化箇所に追加する（design D2）。

## 2. フロントエンド: 送信の保留と安全弁

- [x] 2.1 `saveReorder(groups)` を変更し、各グループを `hasPendingCard(status)` で振り分ける：true なら送信せず `S.dirtyReorderCols.add(status)` するだけ、false なら送信対象に残す（design D2/D5）。
- [x] 2.2 実際に送信するグループの `ids` は `ids.filter((id) => id > 0)` を通してから `api.reorder` へ渡す（design D3、安全弁）。
- [x] 2.3 送信対象グループが空になった場合は `api.reorder` 自体を呼ばない（既存の `filtered.length` ガードを流用・拡張）。

## 3. フロントエンド: 確定時のflush

- [x] 3.1 `flushDirtyReorders()` を追加する：`S.dirtyReorderCols` を走査し、`hasPendingCard(col)` が false になった列について `S.tasks` から `ids = S.tasks.filter(x => normStatus(x.status) === col).map(x => x.id)` を再計算し、`col` を Set から削除した上で `ids.length > 0` なら `saveReorder([{ status: col, ids }])` を呼ぶ（design D4）。
- [x] 3.2 `commitComposer` の成功パス（`placeholder.id = t.id` の直後）で `flushDirtyReorders()` を呼ぶ。
- [x] 3.3 `commitComposer` の失敗パス（placeholder を `S.tasks` から除去した直後）で `flushDirtyReorders()` を呼ぶ。

## 4. 既存e2eへの影響確認

- [x] 4.1 `e2e/kanban-task-create-optimistic.spec.ts` を実行し、今回の変更（1〜3）が既存アサーション（即時反映・focus・ロールバック・Ctrl+Enter詳細）を壊していないことを確認する。dirty集合が空のまま推移する通常経路のため、挙動・アサーションとも変更不要（既存 E2E への影響なし）。実行結果: 4 passed。

## 5. 新規e2e（apply側でDOM確定後に作成）

- [x] 5.1 以下のユーザーフローを新規e2eとしてapply側で書く（セレクタは実装後のDOMに合わせて決める。propose時点では書かない）：
  「未着手列でカードを新規作成した直後（サーバー応答待ちの間）に同列の別カードをドラッグして並べ替えても、エラーtoastが出ず並び順が保持される。作成が確定した後にリロードしても、その並び順が維持されている」
  → `e2e/kanban-reorder-pending-create.spec.ts` に実装（`git stash` + `CI=1` でred-proof済み。未実装だと400由来の並べ替え失敗toastで赤くなることを確認）。
- [x] 5.2 上記に加え、作成が失敗するケース（作成中に並べ替え→作成失敗）でも、並べ替え自体はエラーにならず、失敗したカードを除いた順序がリロード後も保持されることを確認するフローも書く。
  → 同ファイルの2つ目のテストケースとして実装（red-proof済み）。

## 6. 動作確認

- [x] 6.1 `npm test` を実行し既存テストがグリーンのままであることを確認する（本変更はサーバー/サービス層の契約を変えないため新規vitestは追加しない — 理由: design Non-Goalsのとおり `reorderBody` 等API契約は不変、かつ変更対象の `kanban.js` は `server/static/js/` にありvitest対象glob(`server/src/**`, `extension/src/**`, `packages/*/src/**`)の外で、ブラウザDOM依存のためユニットテスト化は本修正のスコープ外）。実行結果: 37 test files / 424 tests すべてpassed。
- [x] 6.2 手動またはe2eで、`POST /api/tasks` に遅延を挟んだ状態で「作成直後に同列を並べ替える」操作を行い、400エラー・`reload()`による巻き戻りが発生しないことを確認する。→ 5.1/5.2のe2eで検証済み（POST /api/tasksに400ms/300msの遅延を挟み、エラーtoast・reloadの巻き戻りが発生しないことを確認）。
