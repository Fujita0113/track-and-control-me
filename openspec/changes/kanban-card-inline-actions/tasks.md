## 1. 削除フローの共通化

- [ ] 1.1 `server/static/js/kanban.js` の `.kb-del-btn` onclick（1104-1118行）にインラインで書かれている削除処理を `deleteTaskWithConfirm(t)` 関数へ切り出す（confirm→`api.deleteTask`→`S.tasks`から除去→`S.detailId`/`S.dueCalOpen`のクリア→toast→`renderAll()`）
- [ ] 1.2 詳細パネルの `.kb-del-btn` を新関数呼び出しに置き換え、既存挙動が変わらないことを確認する

## 2. カードからの削除（ゴミ箱アイコン・右クリック）

- [ ] 2.1 `cardEl(t)`（507-540行）に `.kb-card-del` ゴミ箱アイコンボタンを追加し、`click` で `e.stopPropagation()` した上で `deleteTaskWithConfirm(t)` を呼ぶ
- [ ] 2.2 `cardEl(t)` に `contextmenu` イベントリスナーを追加し、`e.preventDefault(); e.stopPropagation();` の上で `deleteTaskWithConfirm(t)` を呼ぶ（ブラウザ既定メニューを抑止）
- [ ] 2.3 `server/static/css/app.css` に `.kb-card-del` の見た目（配置・ホバー状態）を追加する。既存の `.kb-card` レイアウト（`.kb-card-top` 等）を崩さない位置に置く
- [ ] 2.4 ドラッグ開始（`dragstart`）とゴミ箱アイコン・右クリックが誤って競合しないことを手動確認する（design のRisks参照）

## 3. カード上インラインリネーム

- [ ] 3.1 `S`（84-104行）に `renamingId: null` を追加する
- [ ] 3.2 `cardEl(t)` の `.kb-card-title` に `dblclick` ハンドラを追加し、`e.stopPropagation()` の上で `S.renamingId = t.id; renderAll()`
- [ ] 3.3 `cardEl(t)` は `S.renamingId === t.id` のとき `.kb-card-title` の代わりに `<input class="kb-card-title-edit">`（value=`t.title`）を描画し、マウント時にフォーカス＋全選択する
- [ ] 3.4 入力欄に `keydown` ハンドラを追加: IME確定Enter（`e.isComposing`／`e.keyCode===229`）は無視、素のEnterは確定（`blur()`させて3.5へ）、Escapeは元のタイトルに戻して `S.renamingId = null; renderAll()`
- [ ] 3.5 入力欄に `blur` ハンドラを追加: 値が空文字なら破棄（`S.renamingId = null; renderAll()`のみ）、そうでなければ `t.title` を更新して `api.updateTask(t.id, { title })` を呼び、失敗時は toast、成功可否に関わらず `S.renamingId = null; renderAll()`
- [ ] 3.6 `server/static/css/app.css` に `.kb-card-title-edit` の見た目（既存 `.kb-card-title` と揃うフォント・余白）を追加する

## 4. 既存挙動・回帰の確認

- [ ] 4.1 `npm test` を実行し既存 vitest が壊れていないことを確認する（本変更はサーバー側 `server/src/**` を変更しないため新規 vitest は追加しない — 変更は `server/static/js` のクライアント側のみで、vitest の対象範囲外）
- [ ] 4.2 既存 e2e（`e2e/kanban-restore.spec.ts`, `e2e/kanban-category.spec.ts`, `e2e/kanban-note-editor.spec.ts`, `e2e/kanban-vertical-autoscroll.spec.ts`）はいずれも `.kb-card` へのシングルクリックのみを使用しダブルクリック・右クリックを使っていないため、既存 e2e への影響なし。`npx playwright test e2e/kanban-*.spec.ts` を実行して確認する
- [ ] 4.3 新規 e2e はDOM確定後に最後に書く。カバーすべきユーザーフロー:
  - 「ゴミ箱アイコンから削除する→確認して消える」
  - 「カードを右クリックして削除する→確認して消える」
  - 「カードをダブルクリックしてタイトルを直し、Enterで確定するとボード上のタイトルが変わる」
  - 「カードをダブルクリックして編集中にEscapeで元のタイトルに戻る」
