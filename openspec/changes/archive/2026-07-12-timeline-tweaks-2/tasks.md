## 1. 記録ポップオーバーの到達性（ドラッグ移動・スクロール・配置）

- [x] 1.1 `server/static/css/app.css` の `.tlc-pop` に `max-height: calc(100vh - 24px)` と `overflow-y: auto` を追加し、内容が伸びても内部スクロールで下端の「記録」ボタンへ到達できるようにする
- [x] 1.2 `openPopover`（timeline.js）の配置クランプを固定推定 `h0=320` から `panel.offsetHeight` 実測ベースへ変更し、下端で見切れない `top` にクランプする（パネル挿入後に測定）
- [x] 1.3 `openPopover` にヘッダー（`.tlc-pop-title` / `.tlc-pop-head`）を drag handle とする pointer ドラッグを実装（`pointerdown`→`pointermove` で `left/top` 差分更新→`pointerup`、`setPointerCapture`）。ドラッグ発生時は直後の click/mousedown を無効化しバックドロップ close と競合させない
- [x] 1.4 `.tlc-pop-title`（およびドラッグハンドル領域）に `cursor: move` を付与し、掴めることを視覚的に示す
- [ ] 1.5 ドラッグ後もポップオーバーが閉じず入力内容が保持されること、`openDetail`（詳細）側のヘッダーでも移動できることを確認

## 2. Enter による記録確定

- [x] 2.1 `openDraft` の `startInp` / `endInp`（`type=time`）に keydown を追加し、Enter で `submit()` を呼ぶ
- [x] 2.2 `catInp` の keydown を「先頭で `e.isComposing || e.keyCode === 229` を無視」→「値が非空なら `addTyped()`／空なら `submit()`」の文脈依存に変更（現状の Enter=追加を空入力時のみ記録へ拡張）
- [x] 2.3 `submit()` 冒頭に `if (addBtn.disabled) return;` を追加し、Enter 連打・処理中 Enter による二重送信を明示的にガード
- [ ] 2.4 手動確認: 時刻欄 Enter=記録／カテゴリ欄（文字あり）Enter=追加・（空）Enter=記録／IME 変換確定 Enter で誤作動しない／処理中 Enter で重複作成されない

## 3. 短ブロックのラベル3段階描画

- [x] 3.1 timeline.js に閾値定数 `TIME_LABEL_MIN`（=40, 時間帯を出す下限）と `SHORT_TEXT_MIN`（=22, 極短境界の初期値）を定義
- [x] 3.2 `blockEl` を高さで3分岐: 通常（`height>=40` 名前+時間帯）／短（`22<=height<40` 名前1行のみ・時間帯非表示）／極短（`height<22` テキスト非 append・`el.title=block.title` 設定・クラス `tiny`）
- [x] 3.3 `app.css` の `.tlc-block.short` に `justify-content:center` と `line-height:1.1` を与え、名前1行が縦中央に収まり見切れないようにする。`.tlc-block.tiny` はテキスト無し（色バーのみ）の見た目を整える
- [ ] 3.4 極短ブロックのホバー tooltip で名前が出ること、クリックで `openDetail` が開くことを確認

## 4. 視覚検証（スクショ）

- [ ] 4.1 `npm run server` で起動し、短い区間（15〜20分・掃除等）のブロックが縦に見切れないこと、極短ブロックがホバー tooltip で名前を出すことをスクショで確認
- [ ] 4.2 記録ポップオーバーをチップ「もっと見る」展開で縦長にし、「記録」ボタンへスクロール到達できること、ヘッダードラッグで移動できることをスクショで確認
- [ ] 4.3 同時記録で短ブロックが複数カラム並んだ際にラベルが隣カラムと衝突しないことを確認
- [ ] 4.4 `SHORT_TEXT_MIN`（極短境界）を実機スクショで微調整し、日本語1文字が縦に収まる下限を確定

## 5. issue #8 との重複整理

- [x] 5.1 GitHub issue #8 の「空き時間を記録ポップオーバー（openDraft）」チェックリスト3項目（memoInp／startInp／endInp）を削除し、当該要件は issue #32 で対応済み（本 change）である旨を追記する
