## 1. 共通ヘルパー（util.js / css）

- [x] 1.1 `util.js` に `attachTooltip(el, { label, keys })` を実装（body 直下の使い回しツールチップ DOM、`mouseenter`/`focus` で表示・`mouseleave`/`blur`/`Esc` で非表示、矩形で配置＋画面端クランプ、`aria-keyshortcuts` 付与）
- [x] 1.2 `util.js` にプラットフォーム判定（mac→`Cmd`/他→`Ctrl`、取得失敗時 `Ctrl`）と、キー配列を `<kbd>` チップ列に描画するヘルパーを追加
- [x] 1.3 `util.js` に `ctrlEnterToSave(root, saveBtn)`（root の keydown で `Ctrl/Cmd+Enter → saveBtn.click()`、IME 変換確定スキップ・`disabled` 中は無視）を追加
- [x] 1.4 `util.js` に `isTypingTarget(e)`（input/textarea/`isContentEditable` フォーカス、`isComposing`/`keyCode===229`）を追加
- [x] 1.5 `css/app.css` にツールチップと `kbd` チップのスタイルを追加（表示/非表示・配置・見た目）

## 2. グローバルキー（main.js）

- [x] 2.1 `document` の keydown ハンドラを追加し、`Esc` で `#modal-root.open` があれば `closeModal()`
- [x] 2.2 同ハンドラで数字 `1`〜`6`（修飾なし・`isTypingTarget` でない）のとき対応する `.tab` を `activate`
- [x] 2.3 `bootNav` で各タブに `attachTooltip(btn,{label:<タブ名>, keys:[番号]})` を付与

## 3. モーダル閉じるヒント（util.js openModal）

- [x] 3.1 `openModal` の「✕」ボタンに `attachTooltip(closeBtn,{label:'閉じる', keys:['Esc']})` を付与

## 4. 保存 Ctrl+Enter とヒント（各画面）

- [x] 4.1 `settings.js`: 保存ボタンに `ctrlEnterToSave` と `attachTooltip(...,{label:'保存', keys:['Ctrl','Enter']})` を付与
- [x] 4.2 `rules.js`: 保存ボタン（3 箇所: PUT / 当日追加 / 条件編集）に `ctrlEnterToSave` とヒントを付与
- [x] 4.3 `goals.js`: 目標作成の保存（「作成」）ボタン等にヒントと `ctrlEnterToSave` を付与
- [x] 4.4 `md-editor.js` / `reflection.js`: 既存の `Ctrl/Cmd+Enter` 保存は維持したまま、保存ボタンにヒントのみ付与

## 5. 動作確認

- [x] 5.1 各保存ボタンにホバー／フォーカスで `Ctrl+Enter`（mac は `Cmd+Enter`）ツールチップが出て、`Ctrl+Enter` 保存が効くことを確認（disabled 中・IME 変換確定で発火しないことも）
- [x] 5.2 モーダルの「✕」ホバーで `Esc` ヒントが出て、`Esc` でモーダルが閉じることを確認（モーダル無しの `Esc` が無反応なことも）
- [x] 5.3 数字 `1`〜`6` でタブ切替が効き、入力中／修飾キー併用では発火しないことを確認。各タブのホバーで番号ヒントが出ることを確認
- [x] 5.4 画面端・スクロール時にツールチップ位置が崩れないことを確認
