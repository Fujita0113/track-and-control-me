## Context

タイムライン（`server/static/js/timeline.js` + `server/static/css/app.css`）はサーバー API・データ層を変更しない純粋な表示レイヤーの調整。関連する現状:

- 記録ポップオーバーは `openDraft()` が組み立てた DOM を汎用の `openPopover(x, y, width, node)` で `position: fixed` 配置する。`openPopover` は高さを定数 `h0 = 320` と仮定してクランプしているだけで、実際のパネル高（チップ展開・複数行）を測っていない。`.tlc-pop` に `max-height` / `overflow` が無いため、内容が伸びると下端の「記録」ボタンがビューポート外へ出る。ドラッグ移動も未実装。
- `openDraft()` 内の Enter 処理は `catInp`（カテゴリ入力）の keydown だけで、Enter＝カテゴリ追加。フォーム全体の Enter＝記録は無い。`submit()` は `addBtn` を `disabled` にして二重送信を防いでいる。時刻欄は `type=time`。
- `blockEl()` は高さ `Math.max(18, ...)`（PXM=1.2px/分なので 15 分で最小 18px）で描画。`short = height < 40` のとき時間帯を隠すが、名前 `.tlc-b-name`（12.5px, nowrap+ellipsis）は残り、ブロックが `overflow:hidden` のため縦に見切れる（issue #32 の「掃除」見切れ）。

issue #8（Enter 横断整備）は openDraft の Enter を対象に含むが、memo 欄は既に廃止済みで内容が古い。本 change に集約する。

## Goals / Non-Goals

**Goals:**
- 「記録」操作が内容量・画面サイズに関わらず常に到達可能（ドラッグ移動＋内部スクロール＋配置クランプ）。
- Enter で記録確定できる（時刻欄＝記録／カテゴリ欄＝文脈依存、IME・二重送信ガード）。
- 短時間ブロックの名前が縦に見切れない（高さ3段階描画＋極短はホバー tooltip）。

**Non-Goals:**
- サーバー API・データ層（session / creditedMs / gaps）の変更。
- 詳細ポップオーバー（`openDetail`）の情報構成変更。
- ブロックの時間軸スケール（PXM）や最小高さ 18px 自体の変更。
- タイムライン以外のフォームの Enter 整備（issue #8 の他項目は範囲外）。

## Decisions

### D1: ドラッグ移動はヘッダーを掴む pointer ドラッグで実装
`openPopover` にドラッグハンドルを導入する。ハンドルは各ポップオーバーの先頭要素（`.tlc-pop-title` または `.tlc-pop-head`）とし、`data-drag-handle` 属性で明示。ハンドル上の `pointerdown` で開始し、`pointermove` で `panel.style.left/top` を差分更新、`pointerup` で終了。`setPointercapture` を使いパネル外へ出ても追従させる。ドラッグ中に生じる `mousedown`/`click` がバックドロップへ伝播して閉じないよう、既存の `panel` 側 `stopPropagation` を維持しつつ、ドラッグ確定後のクリックを抑止する。
- 代替案: パネル全体をドラッグ可能にする → 入力欄・チップのクリックとドラッグが競合するため却下。ハンドル限定が安全。

### D2: パネルは `max-height: calc(100vh - 24px)` ＋ `overflow-y: auto`
`.tlc-pop` に `max-height` と `overflow-y:auto` を付け、内容が縦に伸びても内部スクロールで「記録」ボタンへ到達できるようにする。`openPopover` の配置クランプは、固定推定値 `h0=320` をやめ、パネルを一旦挿入して `panel.offsetHeight`（`max-height` 適用後の実測値）で `top` をクランプする。これで下端見切れを避けつつ、`max-height` を超える内容はスクロールで担保する。
- 代替案: 実測せず推定値のまま → チップ展開時に破綻するため却下。

### D3: Enter は「時刻欄＝記録／カテゴリ欄＝文脈依存」を個別ハンドラで
フォーム化して requestSubmit する方式もあるが、カテゴリ欄の Enter は「文字あり＝追加／空＝記録」の分岐が必要なため、素直に各入力へ keydown を付ける。
- `startInp` / `endInp`（`type=time`, IME 無関係）: Enter → `submit()`。
- `catInp`（`type=text`）: keydown 先頭で `if (e.isComposing || e.keyCode === 229) return;`。値が非空なら `addTyped()`（現状維持）、空なら `submit()`。いずれも `preventDefault`。
- `submit()` は既存どおり `addBtn.disabled` で二重送信を防ぐため、Enter からの多重呼び出しも自然に無害化される（disabled 中の submit は `end>start` 検証前に到達しても、実処理は API 呼び出し前に `disabled=true` 済み）。念のため `submit()` 冒頭で `if (addBtn.disabled) return;` を追加してガードを明示する。
- 代替案: `<form>`＋`type=submit` → カテゴリ欄の文脈依存分岐と相性が悪く、Enter が常に submit になるため却下。

### D4: 3段階ラベルは高さ閾値で分岐（通常／短／極短）
`blockEl()` の高さ（`height`）で段階を決める。PXM=1.2px/分。
- **極短**: `height < SHORT_TEXT_MIN`（＝名前1行が縦に収まらない高さ）。目安 22px（最小 18px〜約 20 分）。この段階はブロックに名前・時間帯を **appendChild しない**。代わりに `el.title = block.title`（ネイティブ tooltip）を設定。クリックで `openDetail` は従前どおり動く。CSS クラス `tiny` を付与。
- **短**: `SHORT_TEXT_MIN <= height < 40`（現行 `short` の範囲を踏襲）。名前1行のみ append、時間帯は非表示。`.tlc-block.short` に `justify-content:center`（縦中央）＋ `line-height:1.1` の詰めを与え、名前を確実に1行内へ収める。`.tlc-b-name` は横 nowrap+ellipsis のまま（縦は詰めで見切れ回避）。
- **通常**: `height >= 40`。現状どおり名前＋時間帯。
- 閾値は定数 `SHORT_TEXT_MIN`（=22）として `PXM`/`HATCH_MIN_PX` 近くに定義。`40` も既存の `short` 判定値なので定数化して意図を明示（`TIME_LABEL_MIN`）。
- 代替案（却下）:
  - 極短でも 10px まで縮小して1行表示 → 極端に短いと可読性が落ち、ユーザーは tooltip 方式を選択済み。
  - 名前をブロック右横へ出す → 同時記録で複数カラムが並ぶと隣カラムと衝突するため却下（ユーザーと合意済み）。

### D5: `title` 属性は極短のみに限定
tooltip は極短ブロックの唯一の名前提示手段なので必須。短・通常でも `title` を付けても害は無いが、常時ネイティブ tooltip が出るのは煩わしいので極短限定とする。詳細は全段階でクリック→`openDetail` から辿れる。

## Risks / Trade-offs

- [ドラッグ実装がバックドロップ close と競合し、移動後に閉じてしまう] → `pointerdown` を `stopPropagation` し、ドラッグ発生時は直後の `click`/`mousedown` を無効化するフラグを立てる。既存の `panel` の `mousedown` stopPropagation と整合させる。
- [`max-height`＋内部スクロールで、チップの「もっと見る」展開時に体験が縦長になる] → 実害は小。スクロール可能なら「記録」到達性は満たす。初期配置クランプで上寄せしておく。
- [極短でテキストを消すと、一目で何のブロックか分からなくなる] → ユーザーは tooltip 方式を明示選択。色バー＋ホバー＋クリック詳細で情報は失われない。境界（22px 前後）のブロックが「短」と「極短」で見え方が変わる点は、閾値を実機スクショで微調整して吸収する。
- [`offsetHeight` 実測はレイアウト強制（reflow）を起こす] → ポップオーバーは低頻度の単発生成であり性能影響は無視できる。

## Migration Plan

コード変更のみ、データ移行なし。デプロイは静的アセット更新。ロールバックは revert で足りる。
issue #8 のチェックリスト編集（openDraft 3項目の削除）は本 change 実装後に GitHub 側で実施し、#32 へ集約した旨を追記する。

## Open Questions

- `SHORT_TEXT_MIN`（極短の境界）の具体値は実機スクショ検証で最終調整する（初期値 22px）。日本語1文字が縦に収まる下限を目視で確認する。
