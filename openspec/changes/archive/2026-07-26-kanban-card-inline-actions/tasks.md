## 1. 削除フローの共通化

- [x] 1.1 `server/static/js/kanban.js` の `.kb-del-btn` onclick（1104-1118行）にインラインで書かれている削除処理を `deleteTaskWithConfirm(t)` 関数へ切り出す（confirm→`api.deleteTask`→`S.tasks`から除去→`S.detailId`/`S.dueCalOpen`のクリア→toast→`renderAll()`）
- [x] 1.2 詳細パネルの `.kb-del-btn` を新関数呼び出しに置き換え、既存挙動が変わらないことを確認する

## 2. カードからの削除（ゴミ箱アイコン・右クリック）

- [x] 2.1 `cardEl(t)`（507-540行）に `.kb-card-del` ゴミ箱アイコンボタンを追加し、`click` で `e.stopPropagation()` した上で `deleteTaskWithConfirm(t)` を呼ぶ
- [x] 2.2 `cardEl(t)` に `contextmenu` イベントリスナーを追加し、`e.preventDefault(); e.stopPropagation();` の上で `deleteTaskWithConfirm(t)` を呼ぶ（ブラウザ既定メニューを抑止）
- [x] 2.3 `server/static/css/app.css` に `.kb-card-del` の見た目（配置・ホバー状態）を追加する。既存の `.kb-card` レイアウト（`.kb-card-top` 等）を崩さない位置に置く
- [x] 2.4 ドラッグ開始（`dragstart`）とゴミ箱アイコン・右クリックが誤って競合しないことを手動確認する（design のRisks参照）

## 3. カード上インラインリネーム

- [x] 3.1 `S`（84-104行）に `renamingId: null` を追加する
- [x] 3.2 `cardEl(t)` の `.kb-card-title` に `dblclick` ハンドラを追加し、`e.stopPropagation()` の上で `S.renamingId = t.id; renderAll()`
- [x] 3.3 `cardEl(t)` は `S.renamingId === t.id` のとき `.kb-card-title` の代わりに `<input class="kb-card-title-edit">`（value=`t.title`）を描画し、マウント時にフォーカス＋全選択する
- [x] 3.4 入力欄に `keydown` ハンドラを追加: IME確定Enter（`e.isComposing`／`e.keyCode===229`）は無視、素のEnterは確定（`blur()`させて3.5へ）、Escapeは元のタイトルに戻して `S.renamingId = null; renderAll()`
- [x] 3.5 入力欄に `blur` ハンドラを追加: 値が空文字なら破棄（`S.renamingId = null; renderAll()`のみ）、そうでなければ `t.title` を更新して `api.updateTask(t.id, { title })` を呼び、失敗時は toast、成功可否に関わらず `S.renamingId = null; renderAll()`
- [x] 3.6 `server/static/css/app.css` に `.kb-card-title-edit` の見た目（既存 `.kb-card-title` と揃うフォント・余白）を追加する

## 4. 既存挙動・回帰の確認

- [x] 4.1 `npm test` を実行し既存 vitest が壊れていないことを確認する（本変更はサーバー側 `server/src/**` を変更しないため新規 vitest は追加しない — 変更は `server/static/js` のクライアント側のみで、vitest の対象範囲外）→ 28ファイル279件すべて成功
- [x] 4.2 既存 e2e（`e2e/kanban-restore.spec.ts`, `e2e/kanban-category.spec.ts`, `e2e/kanban-note-editor.spec.ts`, `e2e/kanban-vertical-autoscroll.spec.ts`）はいずれも `.kb-card` へのシングルクリックのみを使用しダブルクリック・右クリックを使っていないため、既存 e2e への影響なし。`npx playwright test e2e/kanban-*.spec.ts` を実行して確認する→ 11件すべて成功（既存e2eファイルへの変更なし）
- [x] 4.3 新規 e2e `e2e/kanban-card-quick-actions.spec.ts` を作成。カバーしたユーザーフロー:
  - 「ゴミ箱アイコンから削除する→確認して消える」
  - 「カードを右クリックして削除する→確認して消える」
  - 「確認をキャンセルすると削除されない」
  - 「カードをダブルクリックしてタイトルを直し、Enterで確定するとボード上のタイトルが変わる」（リロード後も保存を確認）
  - 「カードをダブルクリックして編集中にEscapeで元のタイトルに戻る」
  - `git stash push -- server/` → `CI=1 npx playwright test` で5件とも失敗（赤）を確認 → `git stash pop` で5件とも成功（緑）を確認。red-proof 済み

**実装中に発覚した design.md からの差分**: シングルクリックを即座に `openDetail` するとダブルクリックの1・2回目の `click` イベントで先に詳細パネルが開いてしまい（`renderAll()` が割り込み dblclick の判定自体は成立するがカードは既に別状態になる）、ダブルクリックによるリネームが機能しなかった。一度はシングルクリックを220ms遅延させる案（`OPEN_DETAIL_DELAY_MS`）で対処したが、これが「カードを開く操作全般が遅くなった」というユーザー指摘を招いたため撤回し、最終的にはシングルクリックは常に即時 `openDetail` のまま、`dblclick` 側で「一瞬開いた詳細を閉じてリネームへ切り替える」方式に落ち着いた（design.md の Decisions/Risks に詳細記載）。既存 e2e・新規 e2e とも全て通ることを確認済みで、仕様（`specs/*.md`）が定めるシナリオの内容自体は変えていない。

## 5. 追加修正: タスク作成の Optimistic UI（体感速度の指摘を受けた issue #29 の延長）

削除・リネームを直したあとも「タスク追加→Enterのあと次に移れない」と指摘され、原因調査の結果
`commitComposer` が `api.createTask`（カテゴリ付けモードでは `api.getGroups` も）の応答を
待ってからコンポーザを空にしていたことが判明。以下を追加実装した。

- [x] 5.1 `commitComposer` を Optimistic UI 化: 負の連番の仮IDでプレースホルダーを `S.tasks` に積み、
  応答を待たず次の状態（コンポーザ再オープン／カテゴリピッカー／詳細パネル）へ進める
- [x] 5.2 `api.createTask` 解決後、同一オブジェクト参照を保ったまま `id` のみ本物へ差し替える
  （`reconcileTaskId` で `S.detailId`/`S.renamingId`/`S.categorizePick.id` も追従させる）
- [x] 5.3 失敗時はプレースホルダーを除去してロールバックし、既存挙動どおり `S.composingCol` も閉じる
- [x] 5.4 実装中に見つけたバグを修正: id 差し替え後に無条件で `renderAll()` すると、
  誰も参照していない「次のコンポーザ・インスタンス」が再構築で作り直され、その `blur` で
  空文字コミットが誤発火し連続作成状態が壊れる回帰が発生（既存 e2e `kanban-category.spec.ts`
  の「モードOFF時は従来どおり連続作成」が赤くなり検出）。画面上の何かがこの仮IDをまだ
  参照しているときだけ再描画するよう修正して解消
- [x] 5.5 新規 e2e `e2e/kanban-task-create-optimistic.spec.ts` を作成。カバーしたユーザーフロー:
  - 「タスク作成はサーバー応答を待たず即座にボードへ反映され、コンポーザもすぐ次の入力に使える」
  - 「カテゴリ付けモードでもピッカーはグループ取得・タスク作成の応答を待たず即座に開く」
  - 「タスク作成に失敗した場合は一度現れたカードが消えてロールバックされる」
  - 「Ctrl+Enterでも詳細パネルが応答を待たず即座に開き、ノートに入力しても遅延応答後に消えない」
  - `git stash push -- server/static/js/kanban.js` → `CI=1 npx playwright test` で4件とも失敗（赤）を確認
    → `git stash pop` で4件とも成功（緑）を確認。red-proof 済み
- [x] 5.6 `npm test`（279件）と全 e2e（31件、既存＋新規すべて）を実行し回帰なしを確認
