## 1. renderAll の再入ガード

- [x] 1.1 `server/static/js/kanban.js` のモジュールレベル状態（`rootEl`/`S`/`O` の近く）に `let isRendering = false;` `let renderQueued = false;` を追加する（design D1）。
- [x] 1.2 `renderAll()`（269行〜）の先頭で `isRendering` が true なら `renderQueued = true` を立てて即 return する（実際の描画本体は実行しない）よう変更する。
- [x] 1.3 `isRendering` が false の場合は `isRendering = true` にしてから既存の描画本体（`clear(rootEl)` 以降の分岐すべて）を実行し、`finally` で `isRendering = false` に戻す（design D1: try/finallyで確実に解除する）。
- [x] 1.4 描画本体の完了後（`finally` を抜けた直後）、`renderQueued` が true なら false へ戻したうえで直後にもう一度 `renderAll()` を呼ぶ（design D2: 追いキューは最大1回分のフラグのみで多重ループ化しない。連鎖的に再度立った場合は自然に次の1回として処理される）。

## 2. 既存e2eの赤化確認（propose時点で実施・記録用）

- [x] 2.1 `e2e/kanban-reorder-pending-create.spec.ts` から、ドラッグ前にコンポーザを `Escape` で閉じていた回避策を削除し、コンポーザを開いたまま（フォーカスしたまま）並べ替える元々の想定フローに戻した（issue #85 の再現をそのまま検証できる形にするため）。
- [x] 2.2 修正前（本change未実装）の状態で `CI=1 npx playwright test e2e/kanban-reorder-pending-create.spec.ts` を実行し、2テストとも「並べ替え確定後の順序がリロード後に戻ってしまう」形で赤くなることを確認済み（`renderAll` 再入クラッシュにより `saveReorder` まで到達しないため）。apply はこの2テストを緑にすることが実装完了の条件になる。

## 3. 動作確認

- [x] 3.1 `CI=1 npx playwright test e2e/kanban-reorder-pending-create.spec.ts` を実行し、2テストとも緑になることを確認する。
- [x] 3.2 `CI=1 npx playwright test e2e/kanban-task-create-optimistic.spec.ts` を実行し、既存アサーション（即時反映・focus・ロールバック・Ctrl+Enter詳細・コンポーザが開いたまま次の入力に使える挙動）が壊れていないことを確認する。
- [x] 3.3 `npm test` を実行し既存テストがグリーンのままであることを確認する（本変更はサーバー/サービス層の契約を変えないため新規vitestは追加しない — 理由: 変更対象の `renderAll`/`clear` は `server/static/js/` にありvitest対象glob(`server/src/**`, `extension/src/**`, `packages/*/src/**`)の外で、ブラウザDOM・フォーカス/blurの実イベント依存のためユニットテスト化は本修正のスコープ外）。

## 4. 新規e2e（apply側でDOM確定後に作成・任意だが推奨）

- [x] 4.1 同じ再入クラッシュの経路がカードタイトルのインライン編集（リネーム）でも起こり得る（`cardTitleEl` の `blur` ハンドラ、空文字確定時の早期return `renderAll()`）。以下のユーザーフローを新規e2eとして追加する（セレクタは実装後のDOMに合わせて決める）：
  「カードタイトルをダブルクリックしてリネーム編集中（空文字にした状態でフォーカスしたまま）に、別のカードをドラッグして同じ列を並べ替えても、エラーにならず並べ替えが正しく反映・永続化される」
