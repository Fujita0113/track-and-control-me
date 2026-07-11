## 1. 自動スクロール: 基盤（rAF ループ）

- [x] 1.1 `server/static/js/kanban.js` にモジュールレベルの自動スクロール状態（`autoScrollRAF` / `autoScrollDir` / `autoScrollSpeed` と対象 `.kb-board-scroll` 要素参照）を追加
- [x] 1.2 `startAutoScroll(dir, intensity)` を実装（既存ループがあれば方向・速度の更新のみ、無ければ rAF ループ開始）。速度は `MAX_SPEED * intensity`、定数 `EDGE_ZONE` / `MAX_SPEED` を定義
- [x] 1.3 rAF ループ本体を実装（毎フレーム `scroll.scrollLeft += autoScrollDir * autoScrollSpeed`、`scrollLeft` が端に達したら現状維持で継続）
- [x] 1.4 `stopAutoScroll()` を実装（`cancelAnimationFrame` ＋状態クリア、冪等）。`S.draggingId` が無い時は `startAutoScroll` を無視する保険を入れる

## 2. 自動スクロール: ドラッグイベント結線

- [x] 2.1 `boardEl()` のスクロール要素（`.kb-board-scroll`）に `dragover` リスナを追加。`e.clientX` と `getBoundingClientRect()` から左右端の食い込みを判定し、端近傍なら `startAutoScroll(dir, intensity)`、非端なら `stopAutoScroll()` を呼ぶ（`intensity = (EDGE_ZONE - distanceFromEdge) / EDGE_ZONE`）
- [x] 2.2 スクロール要素の `dragleave` で `relatedTarget` がコンテナ外なら `stopAutoScroll()`
- [x] 2.3 カードの `dragend` ハンドラ（既存のオーバーレイ除去箇所）に `stopAutoScroll()` を追加
- [x] 2.4 `onDrop` の確定処理に `stopAutoScroll()` を追加（全列共通で必ず止める）
- [x] 2.5 既存の列 `dragover`/`drop`（`kanban-task-reorder` の挿入インジケータ）と干渉しないことを確認（コンテナ側はスクロール判定のみ、列側の挙動は不変）

## 3. エディタ: Enter カーソル消失の修正

- [x] 3.1 `onLineBlur(t)` の遅延タイマー発火時に、`document.activeElement` が `.kb-ed-input`（別の編集入力）なら `return` して編集を終了しないガードを追加
- [x] 3.2 既存の `cancelBlur` 経路・130ms 遅延・チェックボックス mousedown preventDefault が従来どおり機能することを確認（他行クリック／項目トグルに回帰が無いこと）

## 4. 検証

- [x] 4.1 詳細パネルを開いて「完了」列を画面外にした状態で、カードを右端へドラッグ→自動で横スクロールして完了列が現れ、ドロップで完了演出＋アーカイブになることを確認
- [x] 4.2 端から離すとスクロールが止まること、ポインタを端で静止させてもスクロールが継続すること（rAF 動作）を確認
- [x] 4.3 左側列を画面外にした状態で左端ドラッグ→左へ自動スクロールすることを確認
- [x] 4.4 ドロップ／ドラッグ中止（ESC・ボード外 drop）後にボードが自動スクロールし続けないことを確認
- [x] 4.5 ノート編集中に Enter で改行→カーソルが新しい行の先頭に残り、続けて入力できること（消えないこと）を確認。Enter 連続でも維持されること
- [x] 4.6 エディタ外（タイトル入力・ボード領域）をクリックすると従来どおり編集が終了しプレビュー表示に戻ることを確認
- [x] 4.7 参照実装のトーン（クリーム背景・列見た目）が崩れていないことをスクリーンショットで目視確認
