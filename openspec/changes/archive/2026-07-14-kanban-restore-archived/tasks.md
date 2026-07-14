## 1. 復帰ハンドラの実装

- [x] 1.1 `kanban.js` に `restoreTask(t)` を追加：ローカル `S.tasks` の当該タスクを `status='TODO'` / `done_at=null` に更新し、TODO 列末尾へ並べ替え（`reindexColumn` 相当）してから `renderAll()`（楽観更新, design D2）
- [x] 1.2 `restoreTask` から `api.updateTask(t.id, { status: 'TODO' })` を呼び出して永続化する
- [x] 1.3 PATCH 失敗時のロールバック：当該タスクを復帰前（`DONE` / 元 `done_at`）へ戻して `renderAll()`、`toast(..., 'err')` で通知（または `reload()` でサーバ状態に一致）（design D3）

## 2. ログ行の導線

- [x] 2.1 `logEl` の各 `kb-log-row` に控えめな「戻す」ボタンを追加し、クリックで `restoreTask(t)` を呼ぶ（design D4）
- [x] 2.2 「戻す」ボタンのスタイルを既存のログ／かんばんのトーンに合わせて `kanban.css`（該当 CSS = `css/app.css`）へ追加

## 3. 派生表示の整合確認

- [x] 3.1 復帰後に完了件数チップ・アーカイブ件数・達成率・ドーナツ・列カードが即座に更新されることを確認（spec: 復帰後の派生表示の整合。楽観更新は `S.tasks` 更新＋`renderAll()` で全派生を再算出）

## 4. 動作確認

- [x] 4.1 ローカル起動（`PORT=<空きポート> DB_PATH=:memory: npm run server`）でタスクを完了→ログに出現→「戻す」で TODO 列末尾へ復帰し、ログから消えることを確認（API smoke＋Playwright E2E `e2e/kanban-restore.spec.ts` で確認）
- [x] 4.2 保存失敗系（サーバ停止等）でロールバックが働き状態が乖離しないことを確認（失敗時 `reload()` でサーバ状態へ収束する経路を実装。設計 D3）
