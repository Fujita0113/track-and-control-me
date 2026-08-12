## 1. スタイル

- [x] 1.1 `server/static/css/app.css` に detail オーバーレイ用のスタイルを追加する: スクリム（`kb-main` 全体を覆う半透明レイヤー、`position: fixed`）と、パネルの `position: fixed` 配置（右寄せ・幅 `min(60vw, 720px)`・高さ100%）。既存の `.kb-detail` 系スタイル（`kb-detail-close-row` 等）は変更しない。
- [x] 1.2 `@media (max-width: 1100px)`（既存ブレークポイント）でパネル幅を `100vw` にするルールを追加する。
- [x] 1.3 `git diff --stat` で app.css の差分行数が想定（数十行程度の追加）を超えていないか確認する（既存書式の一括整形混入防止）。

## 2. JS（独立カンバンタブのレイアウト）

- [x] 2.1 `asideEl()`（`server/static/js/kanban.js:1316`）から detail 差し替えロジックを外し、常に進捗リング＋ログを表示するようにする。
- [x] 2.2 独立タブのページ組み立て箇所（`server/static/js/kanban.js:300` 付近、`kb-main` を組む分岐）に、`S.detailId` が立っているときだけ描画するオーバーレイ要素（スクリム＋ `detailEl(t)`）を追加する。埋め込みモード（`renderAsideInto` / `asideHost.detail`）の分岐には手を入れない。
- [x] 2.3 スクリム要素に `onclick` で `closeDetail` を発火させる。実装は `stopPropagation` ではなく、既存の `.modal-backdrop`（`util.js` の `openModal`）と同じ `e.target === overlay` 判定方式を採用した（パネル内クリックは e.target がパネル配下の要素になるため自然に閉じない。既存パターンとの一貫性を優先）。
- [x] 2.4 `kb-board-scroll` の背景クリックで `closeDetail()` を呼んでいた既存ハンドラ（`kanban.js:579`）を削除する（オーバーレイ導入後は到達不能なデッドコードになるため）。
- [x] 2.5 `detailEl(t)` 関数自体（タイトル欄・優先度・期限・ノート・削除ボタン等のDOM構造）は変更しない。

## 3. 既存動作の確認

- [x] 3.1 `npm run server` でカンバンタブを開き、カードクリックでオーバーレイが画面の約6割で表示されること、スクリムクリックで閉じること、✕ボタンで閉じることを目視確認する（Playwright で一時検証specを書きスクリーンショットで確認。パネル幅は1280px中720px≒56%）。
- [x] 3.2 進捗リング・ログが detail オーバーレイの背後に表示され続けることを確認する（同上のスクリーンショットで確認。当初 `right:0` 実装ではサイドバーが完全に隠れる不具合があり、`padding-right: 340px` を追加して背後に見える帯を残すよう修正した）。**§5 で撤回**: issueコメントで「右端まで広げる」が明示されたため、`padding-right: 340px` は削除しサイドバーは完全に隠れる仕様へ変更した。
- [x] 3.3 既存 e2e への影響確認: `kanban-note-editor.spec.ts` は4テスト全て単体実行で pass。`kanban-card-quick-actions.spec.ts` / `kanban-task-create-optimistic.spec.ts` は該当セレクタ（`.kb-detail` / `.kb-detail-close` / `.kb-detail-body .rf-ed`）を使うテストのうち複数を単体実行で pass 確認（実際に失敗したケースは全て「Fixture "workerServerURL" timeout」というインフラ側のサーバ起動タイムアウトで、テスト本体のアサーションには到達していない。原因を調査したところ、このセッション中に自分が起動した `npm run dev` 系の残留プロセス（ポート専有・CPU圧迫）が主因と判明し停止したが、その後もマシン負荷変動により断続的に再現した）。3ファイル同時実行でのバッチ確認は今回のセッションでは環境要因により完走できなかった。実装のコード（DOM構造は変更していない）に起因する失敗は確認されていない。クリーンな環境での `npm run test:e2e` 再実行を推奨。
- [x] 3.4 vitest: 本変更はサーバ側サービス／APIを変更しないフロントエンドDOM/CSSのみの変更のため、新規 vitest 追加なし（既存 vitest への影響もなし）。

## 4. 新規 e2e（DOM確定後、実装の最後に追加）

- [x] 4.1 `e2e/kanban-detail-overlay.spec.ts` を追加（フロー「カードを開く→オーバーレイが画面の大部分を占有して表示される→余白クリックで閉じてボード操作に戻る」）。実装前後（`git stash` で `server/` を退避）での red/green 比較を試みたが、両状態とも同一の「Fixture "workerServerURL" timeout」インフラエラーで終わり、決定的な red-proof は取得できなかった（3.3 と同根のセッション内インフラ問題）。テスト内容自体は、同一アサーションで実際に pass することを確認済みの一時検証spec（実装確認用に作成し削除済み）と等価。クリーンな環境での実行確認を推奨。

## 5. issue #92 追加コメント対応（右端まで拡張・フッターボタン撤去）

issue #92 に「ボタンを消してテキスト欄を広く使いたい」「サイドバーを覗かせず右端まで広げてほしい」「モーダルではなく覆いかぶさっているだけのUIにしてほしい」という追加コメントがあり、proposal/design/spec を改訂した上で以下を実施（AskUserQuestion でユーザーに方針確認済み: 分解ボタンは削除ボタンと共に両方撤去し、分解フローの既存e2eも削除、機能自体はいったんカンバンから外す）。

- [x] 5.1 `server/static/css/app.css`: `.kb-detail-overlay` の `padding-right: 340px` を削除し、パネルが右端まで隙間なく拡張されるようにする（狭幅時の `padding-right: 0` 上書きも不要になるため削除）。`.kb-decompose*`（不要になった分解UIのスタイル）を削除する。
- [x] 5.2 `server/static/js/kanban.js`: `detailEl(t)` の `kb-detail-foot` から「タスクを削除」ボタン（`kb-del-btn`）を削除し、ヒント文のみ残す。`decomposeEl(t)` 関数・その呼び出し・`S.decomposeOpen` state（初期化・`openDetail`/`closeDetail` でのリセット含む）を削除する。`api.createChildTask` やサーバ側 `/api/tasks/:id/children` はタスクツリー機能の一部として維持し、触らない。
- [x] 5.3 `e2e/kanban-note-editor.spec.ts`: `.kb-del-btn` へのフォーカス移動を前提にしていた2アサーション（`not.toBeFocused()` / `toBeFocused()`）を、ボタン非依存の表現（`editor` 自体の focus 有無）へ書き換える。
- [x] 5.4 `e2e/goal-blueprint-task-tree.spec.ts`: 「盤面のカードを分解する→子が同じ列に現れる」テストを削除する（UI導線撤去のため実行不能になるため）。ヘッダーコメントに削除の経緯を追記する。分解機能自体・`task-tree.test.ts` は変更しない。
- [x] 5.5 `git diff --stat` で app.css / kanban.js の差分が想定範囲か確認する。
- [x] 5.6 目視確認: Playwright標準の `npx playwright test`（fixtures.ts経由）はこのセッションのインフラ不安定（3.3参照）で使えなかったため、`npm run dev` で手動起動したサーバへ直接接続するスクリプトで代替確認した。結果: パネル右端が viewport 右端とほぼ一致（1288.98px vs 1280px、誤差はスクロールバー等の丸め）、`.kb-del-btn` / `.kb-decompose-toggle` は共に0件、フッターにはヒント文のみ表示。スクリーンショットでも目視確認済み。
- [x] 5.7 既存 e2e の再確認: 同じく手動起動サーバへ直接接続するスクリプトで、書き換えた2アサーションの前提となる実際のフォーカス挙動を検証した。非リスト行（段落）で Tab → `document.activeElement` はエディタから外れ `BODY` になる（`not.toBeFocused()` は成立、他要素への意図しないフォーカス漏れも無し）。リスト行（todo）で Tab → エディタに留まる（既存アサーション `toBeFocused()` は変更なしで成立）。`goal-blueprint-task-tree.spec.ts` の残り1ケースは分解機能に触れないため無変更・影響なし。Playwrightのテストランナー（fixtures.ts）経由での正式な実行確認は、クリーンな環境で `npm run test:e2e` を推奨。

## 6. 引き継ぎセッションでの正式な red/green 証明・回帰修正（issue #92 最新コメント対応の続き）

3.3/4.1/5.6/5.7 で「`Fixture "workerServerURL" timeout` はセッション中の残留 `npm run dev` プロセスが主因」と推測していたが誤りだった。実際の原因は **この worktree に `node_modules` が一度もインストールされていなかったこと**（`npm install` 未実施のため、fixtures.ts が spawn するサーバーが `MODULE_NOT_FOUND` で即死しポートが開かず 30 秒でタイムアウトしていた）。5.6/5.7 の「手動起動サーバへの直接接続で代替確認」はこの worktree のコードを実際には検証できていなかった可能性が高い。

- [x] 6.1 `npm install` を worktree ルートで実行し、`node_modules` を用意した。
- [x] 6.2 `CI=1 npx playwright test`（fixtures.ts 経由の正規ランナー）で影響 5 spec を一括実行 → `kanban-card-quick-actions.spec.ts` のダブルクリックリネーム3ケースが失敗する回帰を検出。
- [x] 6.3 `git stash push -- server/` → 同コマンドで赤/緑を比較し、この回帰が **本変更が持ち込んだもの**（stash 前＝旧コードでは13件全 pass）であり、既存の不安定さではないと確定した。同時に新規 e2e `kanban-detail-overlay.spec.ts` の red 証明もこの stash で取得（赤：`.kb-detail-overlay` not found）。
- [x] 6.4 回帰原因を特定: `.kb-detail-overlay`（`inset:0`, `z-index:45`）が全画面を覆うため、カードの dblclick（click→click→dblclick）の2回目が overlay に奪われカードへ届かなくなっていた。`server/static/js/kanban.js` に `lastCardClickId`/`lastCardClickAt` の直近クリック記録と、overlay 背景クリック時に「500ms 以内・同一カードなら dblclick とみなしリネームへ切り替える」判定を追加して修正（design.md D5 に詳細を記録）。
- [x] 6.5 `git stash pop` → `CI=1 npx playwright test`（同5spec, 23件）で green 証明完了（新規spec・quick-actions とも全 pass）。
- [x] 6.6 影響範囲を広げ、`kanban`/`goal-blueprint`/`tomorrow-plan` 系 e2e 全27件（未実行だった残り）と `npm run test`（vitest 555件）を追加実行し、他への影響がないことを確認した（計 kanban 関連 e2e 50件 + vitest 555件、すべて green）。

## 7. issue #92 2巡目コメント対応（スクロール一体化・7割拡大・プレースホルダー）

issue #92 に2026-08-11T23:43:46Zの追加コメントがあり、(1) ノート本文だけでなくタイトル・優先度・期限も一緒にスクロールしたい、(2) 画面占有を約6割→7割へ拡大、(3) ノート入力欄のプレースホルダーはフォーカス時点（入力前でも）で隠したい、の3点の要望があった。ユーザーと相談し、propose の作り直しはせず本changeの延長として対応する方針を確認した（AskUserQuestion 実施済み）。

- [x] 7.1 `proposal.md`/`design.md`（D6/D7）/`specs/kanban-detail-overlay/spec.md` を改訂: 「約6割」→「約7割」、スクロール一体化・プレースホルダーのフォーカス連動を新規 Requirement/Scenario として追加。
- [x] 7.2 `server/static/css/app.css`: `.kb-detail-overlay .kb-detail` の幅を `min(70vw, 840px)` に変更し `overflow-y: auto` を付与。`.kb-detail-overlay .kb-detail-body` の `flex`/`overflow`/`max-height` をリセットし独立スクロールをやめる（D6）。
- [x] 7.3 `server/static/js/kanban.js`: `detailEl(t)` のノートエディタに `focus`/`blur` リスナーを追加しプレースホルダー表示をフォーカスに連動させる（D7、kanban detail ローカル）。
- [x] 7.4 `e2e/kanban-detail-overlay.spec.ts` に新規シナリオ2件（スクロール一体化・プレースホルダーのフォーカス連動）を追加。
- [x] 7.5 **回帰の再発と原因調査**: 7.2/7.3実装後にバッチ実行したところ、既存の「余白クリックで閉じる」テストおよび `kanban-rename-reorder-reentrancy.spec.ts` が再び赤くなった。診断用の一時spec（`_diag-evtest.spec.ts`、確認後削除）で `click`/`dblclick` の実イベントを実測し、「dblclickの2回目のclickは、カードの画面上の位置次第でoverlay背景ではなくパネル本体（`.kb-detail-body`等）に落ちることがある」「`e.detail` もクリック対象要素をまたぐと信頼できない」と判明。D5（直近クリックの500ms判定）・`e.detail`判定はいずれも位置/target依存で頑健でないため撤回し、D8（クリックそのものをdblclick確定まで遅延させるアーキテクチャ変更）へ切り替えた。詳細は design.md D5〜D8。
- [x] 7.6 D8実装（`CARD_OPEN_DELAY_MS=300`でdetailオープンを遅延、dblclickはタイマーを取り消してリネームへ）。`git stash push -- server/` → `CI=1 npx playwright test e2e/kanban-detail-overlay.spec.ts e2e/kanban-card-quick-actions.spec.ts e2e/kanban-rename-reorder-reentrancy.spec.ts`（新規3specが赤・既存13件green）→ `git stash pop` → 同コマンド（16件全green）で red/green 証明完了。
- [x] 7.7 影響確認: `kanban`/`goal-blueprint`/`tomorrow-plan` 系 e2e 全52件・`npm run test`（vitest 555件）を再実行し、すべて green であることを確認した。
- [x] 7.8 `git diff --stat` で app.css / kanban.js の差分が想定範囲か確認する。
