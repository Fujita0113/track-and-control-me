## 1. 列移動時に due を永続化する

- [x] 1.1 `server/static/js/kanban.js` の `onDrop` 列間移動分岐（`if (!t.due_locked)` ブロック）で、`computeDue` が `change: true` を返し `due` を更新した場合に、その変更を保存対象としてマークする。
- [x] 1.2 `saveReorder(...)` に加えて、`due` が変わった場合のみ `await api.updateTask(t.id, { due: t.due })` を呼ぶ。`dec.change === false` やロック済み(`due_locked`)では呼ばない。
- [x] 1.3 `updateTask` 失敗時は `pickDue`/`resetDueAuto` と同様に `toast('保存に失敗: ...', 'err')` で通知する（`saveReorder` の既存エラー処理は維持）。

## 2. 検証

- [x] 2.1 手動確認: TODO で作成したタスクを HOLD へドラッグ → 期日が +7 日表示。別タブへ切替→カンバンへ戻る → 期日が +7 日のまま（今日に戻らない）。
- [x] 2.2 手動確認: HOLD のタスクを TODO/DOING へ移動 → 当日/翌日（明日トグル準拠）が再読込後も保持される。
- [x] 2.3 手動確認: 非HOLD→非HOLD 移動・ロック済みタスクの移動で `due` が変わらない（余計な PATCH が飛ばない）ことを確認する。
- [x] 2.4 `computeDue` に関する既存ユニットテストがあれば実行し、緑を確認する（`npx vitest run`）。
