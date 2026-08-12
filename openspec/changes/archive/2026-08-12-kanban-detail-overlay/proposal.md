## Why

カンバンタブのカード詳細は、右サイドバー（幅340px固定）に常設される小さな領域に表示されており、ノート編集など内容量が多い操作には手狭。GitHub の Issue 詳細のように画面の大部分を覆うオーバーレイへ変えることで、閲覧・編集に十分な面積を確保する（issue #92）。

## What Changes

- 独立したカンバンタブ（`kb-board` + `kb-aside` のレイアウト）でカードを開いたとき、detail パネルを右サイドバー常設表示から、画面の約7割・右端まで隙間なく覆うオーバーレイ表示へ変更する（issueコメントでの追加要望: 右端まで広げる。サイドバーはパネルの下に完全に隠れる形へ変更。2巡目コメントで6割→7割へ再変更）。
- オーバーレイのスクロールはパネル全体で一体化する: ノート本文だけの独立スクロール領域にはせず、スクロールするとタスクタイトル・優先度・期限欄もノートと一緒に動く（issue #92 2巡目コメント）。
- ノート入力欄のプレースホルダー（「クリックして入力…」）は、カーソルを合わせた時点（フォーカス時）で隠れるようにする。入力前でも隠れ、未入力のままフォーカスが外れたら再表示する（issue #92 2巡目コメント: 入力し始めた文字とプレースホルダーが重なるのを防ぐ）。
- オーバーレイ表示中は、パネル外側の余白（背景）をクリックすると閉じる。
- オーバーレイ表示中は、背景の操作（カードのドラッグ開始や誤操作）を防ぐため、背景にスクリム（半透明オーバーレイ）を敷く。
- 見た目は中央寄せの「モーダル」ではなく、画面の一部にただ覆いかぶさっているだけの平板なUI（角丸なし）にする。
- 既存の閉じる手段（✕ボタン）はそのまま維持する。
- **BREAKING**: 詳細パネル下部の「タスクを削除」「このタスクを分解する」ボタンを撤去する。`detailEl(t)` は独立カンバンタブと明日の計画（埋め込み）で共有する関数のため、この撤去は両方の文脈に及ぶ（表示位置・オーバーレイ化は独立カンバンタブのみが対象だが、フッターボタンの撤去は detailEl 自体の変更なので埋め込み側にも波及する）。理由: これらのボタンが原因でテキスト（ノート）欄が狭く見え、かつ実運用でほぼ使われていないため。削除操作は引き続きカード上のゴミ箱アイコン・右クリックから可能（詳細パネル経由の削除導線のみ撤去）。タスク分解機能はいったんカンバンから完全に撤去する（バックエンドAPI・vitestは維持、UI導線とその e2e のみ削除）。
- 明日の計画（reflection画面の右サイドバー・タブ切替に埋め込まれる detail）は、オーバーレイ化（表示位置・スクリム・6割/右端拡張）の対象外。現状どおりインライン表示のまま。ただしフッターボタン撤去は上記の通り共有関数の変更として及ぶ。
- detail オーバーレイの左端をドラッグして幅（画面占有率）を手動調整できるようにし、選んだ幅は `localStorage` で永続化して次回開いたときも保持する（ユーザーとのセッション内フィードバック）。
- `kb-detail-foot` のヒント文（「ノートは自動保存されます。カードは…」）を撤去する（ノート編集欄を狭く見せるため）。`detailEl(t)` 自体の変更のため、独立カンバンタブ・明日の計画（埋め込み）の両方に及ぶ。

## Capabilities

### New Capabilities
- `kanban-detail-overlay`: 独立カンバンタブにおける、カード詳細パネルのオーバーレイ表示（画面占有割合・右端まで拡張・背景クリックで閉じる・背景スクリム・フッターボタンの撤去）を規定する。

### Modified Capabilities
(なし。表示位置・トリガー・フッター構成の変更のみで、`kanban-detail-title` 等の既存要件は変わらない)

## Impact

- `server/static/js/kanban.js`: 独立タブのレイアウト分岐（`kb-main` を組む箇所）でオーバーレイ用のラッパー・スクリムを追加し、`closeDetail` の呼び出し導線（スクリムクリック）を追加する。`detailEl(t)` から「タスクを削除」ボタンと `decomposeEl(t)`（このタスクを分解する導線・関連state `S.decomposeOpen`）を削除する。埋め込みモード（`renderAsideInto` / `asideHost.detail`）のレイアウトには影響させないが、`detailEl(t)` は共有関数のため埋め込み側もボタンが無くなる。
- `server/static/css/app.css`: `.kb-detail` 系のスタイルに、独立タブ用のオーバーレイ配置（固定位置・画面6割の幅・右端フラッシュ・スクリム）を追加する。`.kb-decompose*` の不要になったスタイルを削除する。
- `e2e/kanban-note-editor.spec.ts`: `.kb-del-btn` へのフォーカス移動を前提にしていた2アサーションを、ボタン非依存の表現（エディタにフォーカスが留まる／留まらない）へ書き換える。
- `e2e/goal-blueprint-task-tree.spec.ts`: 「盤面のカードを分解する→子が同じ列に現れる」テストを削除する（分解のUI導線がカンバンから無くなるため）。分解機能自体・バックエンドAPI・`task-tree.test.ts` は変更しない。
- `server/static/css/app.css`（2巡目）: `.kb-detail-overlay .kb-detail` の幅を `min(70vw, 840px)` に変更し、`overflow-y: auto` をパネル自体に付与。`.kb-detail-overlay .kb-detail-body` の `flex`/`overflow`/`max-height` をリセットし、独立した内部スクロール領域にしない。
- `server/static/js/kanban.js`（2巡目）: `detailEl(t)` のノートエディタに `focus`/`blur` リスナーを追加し、フォーカス時にプレースホルダーを隠す（`md-editor.js` 本体・他画面の `.rf-ph` 利用箇所には触れない。kanban detail のみのローカルな変更）。
- `server/static/js/kanban.js`（2巡目・design D8）: `cardEl(t)` の単発クリックによる detail オープンを、独立カンバンタブ（`O.asideHost` 無し）に限り `CARD_OPEN_DELAY_MS`（300ms）遅延させ、dblclick が overlay 生成前に確定するようにする。埋め込み盤面（`O.asideHost` あり、明日の計画）はオーバーレイを使わずこの問題が無いため従来通り即時に開く。オーバーレイ導入で「ダブルクリックでカードタイトルをリネーム」（`kanban-card-quick-actions.spec.ts`/`kanban-rename-reorder-reentrancy.spec.ts`）が構造的に壊れる問題への対処（詳細は design.md D5〜D8）。
- `server/static/css/app.css`（3巡目・design D9）: `.kb-detail-overlay .kb-detail-body` の `min-height` を `0` → `80vh` に変更（デフォルトでも縦に長くスクロールが前提の状態にする）。`.kb-detail-resize` ハンドルのスタイルを追加し、`.kb-detail-overlay .kb-detail` に `position: relative` を付与。狭幅ブレークポイントの `width: 100vw` に `!important` を追加（インラインの手動幅より優先させる）。`.kb-detail-foot`/`.kb-detail-hint` のスタイルを削除。
- `server/static/js/kanban.js`（3巡目・design D9）: プレースホルダー表示を `notesFocused` フラグで一元化した `updatePh(raw)` に統合し、フォーカス中は内容の有無に関わらず常に非表示にする（全消去して再入力しても被らないように）。`detailOverlayEl(t)` に `.kb-detail-resize` ドラッグハンドルを追加し、`localStorage`（`tcm_kanban_detail_width`）で幅を永続化する。`detailEl(t)` から `kb-detail-foot`（ヒント文）を削除する。
