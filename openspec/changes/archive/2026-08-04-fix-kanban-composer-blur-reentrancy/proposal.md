## Why

かんばんの列内コンポーザは、Enterでの新規タスク作成後も次の入力のために開いたまま・フォーカスされたままになる（既存の意図した挙動）。この状態で、サーバー応答が返る前に同じ盤面上で別カードをドラッグ&ドロップして並べ替えると、並べ替えの `renderAll()` が盤面全体を作り直す際にフォーカス中のコンポーザ `<textarea>` がDOMから外れて同期的に `blur` が発火し、その `blur` ハンドラが呼ぶ `commitComposer` の早期return内 `renderAll()` が、外側の `renderAll()` の `clear()` 実行中に再入してしまう。結果として `NotFoundError: Failed to execute 'removeChild' on 'Node'` が例外として発生し、`onDrop` は呼び出し元でawaitされていないため未処理のPromise rejectionとして握りつぶされ、並べ替え（`saveReorder`）が実行されないまま処理が中断する（issue #85。issue #79 の修正作業中に発見）。

## What Changes

- `renderAll()` の再入（同期実行中に再度 `renderAll()` が呼ばれること）を安全に防止する。再入が発生した場合も、外側の描画が完了するまで内側の呼び出しを待避・合流させ、DOM操作が競合しないようにする。
- コンポーザが開いたまま盤面全体が再描画される経路（同一列内の並べ替え・列間移動のどちらも該当）で、`blur` に起因する `commitComposer` の呼び出しが `renderAll()` の途中実行と衝突しないようにする。
- 既存の「Enterで作成後もコンポーザが開いたまま次の入力に使える」UXは変えない。

## Capabilities

### New Capabilities
（なし）

### Modified Capabilities
- `kanban-task-reorder`: 「列内ドラッグ&ドロップによる並べ替え」「列間移動時の挿入位置指定」の両要件に、コンポーザが開いたまま（フォーカスされたまま）でも並べ替え操作が失敗しない（クラッシュしない・並べ替えが正しく永続化される）ことを追加する。

## Impact

- `server/static/js/kanban.js`: `renderAll`（269行〜）、`onDrop`（829行〜、同一列内・列間移動の両パス）、`commitComposer`（997行〜、blurハンドラからの早期return経路）。
- `server/static/js/util.js`: `clear`（DOM除去の挙動自体は変更しない想定だが、再入防止の実装箇所次第で影響範囲に含む）。
- 既存e2e `e2e/kanban-task-create-optimistic.spec.ts`・`e2e/kanban-reorder-pending-create.spec.ts`: いずれもコンポーザ/並べ替えのライフサイクルに触れるため影響確認が必要（`e2e/kanban-reorder-pending-create.spec.ts` は現状ドラッグ前に `Escape` でコンポーザを閉じて本バグの経路を回避しているため、直接の再現アサーションは持たない）。
