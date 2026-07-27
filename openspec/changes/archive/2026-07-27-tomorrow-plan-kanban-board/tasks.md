## 1. `kanban.js` をマウント可能にする（カンバンタブの挙動は不変）

- [x] 1.1 `mount(root, opts)` / `unmount()` を追加し、既存の `show()` / `hide()` をそのラッパへ置き換える（design D1）
- [x] 1.2 `opts.bodyClass` を導入し、埋め込み時は `document.body` へ `kb-page` を付けない（`rf-page` を壊さない）
- [x] 1.3 `opts.asideHost` を導入し、`asideEl()`（進捗＋`logEl()`）と `detailEl()` を任意の外部要素へマウントできるようにする
- [x] 1.4 `opts.effects` / `opts.settingsPopover` / `opts.categorizeMode` を導入し、埋め込み時は OFF にする。**完了→アーカイブの状態遷移は演出から切り離して残す**（design D8）
- [x] 1.5 `opts.tomorrowDefault` を導入し、埋め込み時は初回マウントで `setTomorrowMode(true)` する（`computeDue` は変更しない・design D6）
- [x] 1.6 `mount()` 冒頭で既存マウントを `unmount()` し、同時に2つマウントされないことを保証する。`unmount()` はドラッグ状態（自動スクロール RAF・ドロップインジケータ）を後始末する
- [x] 1.7 カンバンタブの既存 e2e（`kanban-category` / `kanban-note-editor` / `kanban-restore` / `kanban-vertical-autoscroll`）が緑のままであることを確認する

## 2. `reflection.js`: デッキ廃止とビュー連動クローム

- [x] 2.1 `.rf-deck`（`scroll-snap-type: x mandatory`）を撤去し、アクティブビューのみ描画する構成へ変更する。`deck` の scroll リスナと `scrollTo` によるビュー移動を削除する（design D3）
- [x] 2.2 `viewChrome(view) → { strip, sidebarTabs }` の写像を導入する（design D2）
- [x] 2.3 右サイドバーをタブ器にする。`journal`（気分・本文・目標の日記）は全ビュー共通、`detail` / `log` は `plan` ビューのときのみ存在させる
- [x] 2.4 `plan` ビューのとき日付ストリップを非表示にし、対象日を持つビューへ戻ったとき離脱前の対象日を保ったまま再表示する
- [x] 2.5 `reflection.hide()` から埋め込み盤面の `unmount()` を必ず呼ぶ。ビュー離脱時（`plan` → 他）も `unmount()` する

## 3. `tomorrow-plan.js`: 縦リストを埋め込み盤面へ置き換える

- [x] 3.1 縦リスト一式（`.rf-plan-list` / `.rf-plan-item` / `.rf-plan-drop-indicator` と `planItemEl` / `onDrop` / ドロップインジケータ処理）を撤去する
- [x] 3.2 候補チップ帯（`.rf-plan-chip`）と直接入力欄（`.rf-plan-input`）は維持し、ビューのルートは `.rf-plan` のままにする（design D7 のセレクタ安定契約）
- [x] 3.3 チップ帯・入力欄の下へ埋め込み盤面をマウントする。aside（詳細・ログ）は `opts.asideHost` で右サイドバーへ渡す
- [x] 3.4 カード選択で右サイドバーを `detail` タブへ自動切替、タスク完了（アーカイブ）で `log` タブへ戻す
- [x] 3.5 期限調整は `detail` タブの既存カレンダー式ピッカーで行う（カード上に別ピッカーを新設しない・design D5）
- [x] 3.6 チップの「登録済み（`.done`）」判定が、盤面上の同名タスクに対しても従来どおり働くことを確認する

## 4. スタイルと参照実装

- [x] 4.1 埋め込みでは `.kb-main` を使わず、盤面スクロール要素のみを左メインへ置く（`@media (max-width: 1100px)` の縦積みを誤発火させない・design Risks）
- [x] 4.2 ワークスペース内で `rf-*` と `kb-*` が共存するスタイルを整える。インライン `style=` を使わない（CSP `style-src 'self'`）
- [x] 4.3 `ref/reflection/` を新レイアウト（ビュータブ切替＋盤面ビュー＋サイドバータブ）へ更新し、スクショで突き合わせる
- [x] 4.4 埋め込み盤面の見切れが `保留` / `未着手` / `進行中` の3列を完全に見せていることを実画面で確認する（design D4 の実測表）

## 5. デモモード

- [x] 5.1 デモモードの振り返り表示（`showDemo`・閲覧専用の単一ページ）が新レイアウト変更の影響を受けていないことを確認する
- [x] 5.2 `POST /api/demo/reset` 経路でデモに入り、振り返りタブの閲覧表示が壊れていないことを確認する（プロジェクトのデモ検証ルール）

## 6. テスト

**凍結ラインの記録（この change の propose 時点）**

- **追加した vitest**: **なし。** 本 change は `server/static/js/`（ブラウザ ES モジュール）のみを変更し、vitest の収集対象（`vitest.config.ts` の `packages/*/src/**/*.test.ts` / `server/src/**/*.test.ts` / `extension/src/**/*.test.ts`）に該当するコードを一切変更しない。サーバ API も無変更（`POST /api/tasks`・`PATCH /api/tasks/:id`・`POST /api/tasks/reorder`・`DELETE /api/tasks/:id` は既存で足りる）。既存の vitest は 28 ファイル / 279 テストが緑であり、これはリグレッション検知用のベースラインとして扱う。
  → したがって**凍結される契約は delta spec のシナリオと、下記の更新済み既存 e2e のみ**である。
- **変更した既存 e2e**: `e2e/tomorrow-plan-capture.spec.ts`。登録結果の確認先を撤去される縦リスト（`.rf-plan-item`）から埋め込み盤面のカード（`#screen-reflection .kb-card`）へ差し替えた。`.rf-plan` / `.rf-plan-chip` / `.rf-plan-input` / `.kb-card` は design D7 のセレクタ安定契約で維持される。**実装が入るまでこの spec は赤い**（それが正しい状態）。
- **影響を確認したが変更不要だった既存 e2e**: `e2e/goal-rule-gate-loop.spec.ts`（`.pc-block` はサイドバーの `journal` タブ内にあり、既定ビュー＝タイムラインでは従来どおり表示される）、`e2e/demo-allocation.spec.ts`（デモは `showDemo` の単一ページ経路でワークスペースを通らない）、カンバンタブの4つの spec（タブの挙動は不変）。
- **apply が新規 e2e で覆うべきフロー**（セレクタではなくフローで指定する）:
  1. 「保留に積んだタスクを未着手へ引き取ると、期日が明日になる」
  2. 「カードを選ぶと右サイドバーが詳細へ切り替わり、そこで期限を変えると盤面のカードへ反映される」
  3. 「明日の計画ビューでは日付ストリップが消え、他ビューへ戻すと離脱前の対象日のまま再表示される」

- [x] 6.1 `npm test`（vitest）が緑のままであることを確認する（ベースライン: 28 ファイル / 279 テスト）
- [x] 6.2 更新済みの `e2e/tomorrow-plan-capture.spec.ts` を通す
- [x] 6.3 上記3フローの新規 e2e を**DOM が完成してから**書く（`tomorrow-plan-board-hold-pickup.spec.ts` / `tomorrow-plan-board-detail-sidebar.spec.ts` / `reflection-plan-view-chrome.spec.ts`）
- [x] 6.4 新規 e2e が骨抜きでないことを機械で証明する: `git stash push -- server/` → `CI=1 npx playwright test <new-specs>` で**落ちる**こと（3件とも失敗を確認）→ `git stash pop` → 通ること（3件とも成功を確認）
