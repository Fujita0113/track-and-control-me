## Context

カンバンはローカル Fastify サーバが配信する素の JS SPA（`server/static/js/kanban.js`、Cadence Board の忠実移植）。ビルド工程・npm 依存なし、CSP `style-src 'self'`（インライン style 不可・クラスベース）、単一ユーザーのローカル利用。

本変更が触れる 2 つの現状:

**1. ボードの横スクロールと D&D（issue #16 前半）**
- レイアウト: `.kb-board-scroll { flex:1; overflow-x:auto }` の中に `.kb-board { display:flex; width:max-content }` があり、4 列（保留/未着手/進行中/完了）を横スクロールで収める。詳細パネル（`.kb-aside`）を開くとボード領域が狭まり、「完了」列が画面外へ出やすい。
- D&D はライブラリ非依存の HTML5 ネイティブ。カード `dragstart` で `S.draggingId` を保持。各列 `colEl` が `dragover`/`dragleave`/`drop` を持ち、`kanban-task-reorder` の挿入位置インジケータもここで直接 DOM 操作している。ドラッグ中の `renderAll` は進行中ドラッグを壊すため禁忌（既存コメント参照）。
- 現状、ポインタが表示領域端に来ても横スクロールは起きず、画面外の列へは到達できない。

**2. ノートエディタの編集フォーカス（issue #16 後半）**
- カード詳細の `.kb-ed`（行ブロック式ライブ Markdown エディタ）。`S.editLine` がアクティブ行、その行だけ `<textarea class="kb-ed-input">` として描画される。
- 構造編集（Enter 改行、Backspace 結合、ショートカット変換、矢印移動）は `lines` を書き換え → `S.editLine`/`S.pendingCaret` を更新 → `renderEditor(t)` で `.kb-ed` 内を作り直す → `focusEditorLine()` が新テキストエリアへフォーカスしカーソル位置を復元する。
- 行の外へフォーカスが外れた時は `onLineBlur(t)` が **130ms 遅延**の `blurTimer` を仕掛け、発火時に `S.editLine = -1` にして編集終了する。130ms は「別の行や項目をクリックした場合に、その mousedown 側で `cancelBlur`（＝ `clearTimeout(blurTimer)`）してから開き直す」ための猶予。

**Enter でカーソルが消える不具合の機序**: `renderEditor` が `clear(wrap)` で編集中テキストエリアを DOM から取り除くと、その要素の `blur` が発火して `onLineBlur` が走り、新たな `blurTimer` を仕掛ける。Enter ハンドラ内の `cancelBlur()` はこの blur より**前**に実行済みのため、この新しいタイマーを取り消せない。結果、`focusEditorLine()` が新テキストエリアへフォーカスした後も 130ms 後にタイマーが発火し、`S.editLine = -1` → 再描画で編集行が消え、カーソルが消滅する。Enter に限らず `renderEditor` を伴う構造編集で共通して起こりうる。

## Goals / Non-Goals

**Goals:**
- ドラッグ中にポインタがボード表示領域の左右端近傍へ入ると、ボードが自動で横スクロールし、画面外の「完了」列（および他の画面外列）へカードを運んでドロップできる。
- 自動スクロールは端への食い込み量に応じた可変速度で、端離脱・ドロップ・ドラッグ中止で確実に止まる。
- ノートエディタで Enter などの構造編集をしてもカーソル（編集中の行）が保持され、続けて入力できる。
- エディタ外へフォーカスが真に移った時だけ編集を終了する既存挙動は維持する。

**Non-Goals:**
- タッチ/モバイルでのドラッグ・自動スクロール（HTML5 ネイティブ D&D の制約。本アプリはデスクトップ companion）。
- 縦方向の自動スクロール（列内リストの縦オートスクロール。今回の課題は横方向のみ）。
- スクロール中の視覚エフェクト追加や参照実装（Cadence Board）の見た目変更。
- エディタの入力仕様そのもの（Markdown ショートカット・ブロック種別など）の変更。今回はフォーカス／カーソル維持の不具合修正に限定。

## Decisions

### 決定1: 自動スクロールはスクロールコンテナの `dragover` ＋ rAF ループで実装

`.kb-board-scroll` 要素に `dragover` リスナを追加し、`e.clientX` と要素の `getBoundingClientRect()` から左右端の近傍ゾーン（`EDGE_ZONE` 例: 90px）への食い込みを判定する。近傍にいる間だけ `requestAnimationFrame` ループを回し、毎フレーム `scroll.scrollLeft += dir * speed` で横スクロールする。近傍から外れたら（あるいはドラッグが終わったら）ループを停止する。

- **なぜ**: HTML5 の `dragover` はドラッグ中に繰り返し発火し、かつ**バブリングする**ため、カード／列で `preventDefault` される既存の `dragover` 経路と衝突せず、祖先のスクロールコンテナで一括してポインタ x を拾える。実スクロールは rAF ループに委ね、`dragover` の発火間隔に依存しない滑らかな連続スクロールにする。`renderAll` を一切呼ばないため進行中ドラッグを壊さない（既存の禁忌に適合）。
- **代替**: `dragover` ごとに一定量スクロール。実装は簡単だが、ポインタを端で静止させると `dragover` が止まりスクロールも止まる（HTML5 D&D はポインタ静止中はイベントを出さない）ため、端に置いたまま列が出るのを待てない。rAF ループなら静止中もスクロールが続くので不採用理由になる。
- **代替**: `document`/`window` レベルの `dragover` で監視。範囲は広いが端判定はボード要素基準が自然で、詳細パネル上など無関係領域まで拾うため、スクロールコンテナに限定する。

### 決定2: 速度は食い込み量に比例（内側は緩やか・端は速い）

`intensity = (EDGE_ZONE - distanceFromEdge) / EDGE_ZONE`（0〜1）とし、`speed = MAX_SPEED * intensity`（例: `MAX_SPEED` ≈ 18px/frame）。方向 `dir` は左端で `-1`、右端で `+1`。

- **なぜ**: 端に近いほど速く、ゾーン内側では緩やかになり、微調整と素早い移動を両立できる。定数速度より狙った列で止めやすい。
- **代替**: 定数速度。単純だが速すぎ/遅すぎの二択になり操作感が劣る。

### 決定3: ライフサイクルは既存の `S.draggingId` とドラッグイベントに束ねる

- ループの開始トリガはスクロールコンテナの `dragover`（端近傍のとき `startAutoScroll(dir, intensity)`、非端のとき `stopAutoScroll()`）。
- 停止トリガは (a) カードの `dragend`（既存ハンドラでオーバーレイ除去と同時に `stopAutoScroll()`）、(b) `onDrop`（ドロップ確定時に `stopAutoScroll()`）、(c) スクロールコンテナからポインタが外れた時（`dragleave` で `relatedTarget` がコンテナ外なら停止）。
- 冪等性: `startAutoScroll` は既存ループがあれば方向/強度の更新のみ、`stopAutoScroll` は `cancelAnimationFrame` して状態をクリア。モジュールレベルに `autoScrollRAF`/`autoScrollDir`/`autoScrollSpeed` を持つ。
- **なぜ**: ドラッグの生存期間は `dragstart`〜`dragend`。停止を複数経路で二重化して「ドラッグしていないのにスクロールし続ける」状態を防ぐ。`renderAll`（列の作り直し）が起きても rAF は要素参照でなく `scroll` 要素に対して動くため影響は受けにくいが、ドロップ時に確実に止める。

### 決定4: Enter カーソル消失は `onLineBlur` の遅延タイマーにフォーカス移動ガードを追加して修正

`onLineBlur` が仕掛ける遅延タイマーの発火時に、**現在フォーカスされている要素が別の編集入力（`.kb-ed-input`）なら編集を終了しない**ガードを入れる:

```js
function onLineBlur(t) {
  blurTimer = setTimeout(() => {
    blurTimer = null;
    // 再描画で編集テキストエリアが差し替わり、フォーカスが新しい .kb-ed-input へ
    // 移っただけの場合は編集を続ける。エディタ外へ真に出た時のみ終了する。
    const a = document.activeElement;
    if (a && a.classList && a.classList.contains('kb-ed-input')) return;
    S.editLine = -1;
    renderEditor(t);
  }, 130);
}
```

- **なぜ**: 根本原因は「`renderEditor` の `clear()` が編集中テキストエリアを外す→その `blur` が `cancelBlur` の**後**に新タイマーを仕掛ける→`focusEditorLine` が新テキストエリアへフォーカス済みでも 130ms 後に編集終了してしまう」こと。タイマー発火時点では既に `focusEditorLine` が新テキストエリアへフォーカスしているため、`document.activeElement` が `.kb-ed-input` かどうかで「単なる差し替え」か「エディタ外への離脱」かを確実に判別できる。ブラウザが blur を同期／非同期どちらで発火しても、発火時点の実フォーカスで判定するため頑健。既存の 130ms 遅延・`cancelBlur` 経路・チェックボックス mousedown preventDefault はそのまま残り、他行クリックや項目トグルの挙動に回帰は無い。
- **代替**: `focusEditorLine` 内で新テキストエリアをフォーカスした直後に `clearTimeout(blurTimer)` する。同期 blur のケースは消せるが、blur が非同期発火する環境では「focus 後にタイマーが仕掛かる」順序になり取りこぼす。発火時ガードの方が順序非依存で確実なため主案とする（必要なら併用も可・害は無い）。
- **代替**: blur イベントの `relatedTarget` で移動先を判定。この UI は「旧要素を remove → 新要素を focus」の順で、blur 時点では移動先が未確定（relatedTarget が null）になりやすく不確実。不採用。

## Risks / Trade-offs

- **HTML5 ドラッグ中の再描画がドラッグを壊す** → 自動スクロールは `renderAll` を一切呼ばず、`scroll.scrollLeft` の直接操作と rAF のみ。既存の禁忌（ドラッグ中 renderAll 禁止）を踏襲。
- **ポインタ静止中に `dragover` が来ずスクロールが止まる** → rAF ループはポインタ静止中も回り続ける設計（最後に判定した方向/強度を保持）。端から離れる `dragover` かドラッグ終了で止める。
- **自動スクロールが止まらず暴走** → 停止経路を `dragend`／`drop`／コンテナ外 `dragleave` の 3 系統で二重化。`stopAutoScroll` は冪等。`draggingId` が無い時は `startAutoScroll` を無視する保険を入れる。
- **既存 `dragover` 経路（列ハイライト・挿入インジケータ）との干渉** → `dragover` はバブリングするため列とコンテナの両ハンドラが動く。コンテナ側は `preventDefault` の有無に関わらずスクロール判定のみ行い、列側の挙動を変えない。責務を分離。
- **Enter ガードの過剰適用で編集が終了しなくなる** → ガードは「発火時に `.kb-ed-input` がフォーカスされている」時のみ継続。エディタ外クリック時は `activeElement` が別要素になり従来どおり終了するため、閉じられなくなる回帰は無い。
- **タッチ環境で自動スクロール不可** → Non-goal（デスクトップ利用前提）。
- **スクロール速度が環境で速すぎ/遅すぎ** → `EDGE_ZONE`/`MAX_SPEED` を定数化し、目視で調整。まずは控えめな既定値から。

## Migration Plan

- DB・API・データ移行なし。フロントエンド `server/static/js/kanban.js` の変更のみ（自動スクロールのヒント文言を足す場合のみ `app.css` は不要／文言はJS側）。
- ロールバック: 追加した自動スクロールのリスナ／ループと `onLineBlur` ガードを戻せば従来挙動に復帰。副作用のある永続データは無い。
- 検証はローカルサーバでの手動 D&D と編集操作＋スクリーンショット目視（参照トーン維持の確認を含む）。

## Open Questions

- 端近傍ゾーン幅 `EDGE_ZONE` と最大速度 `MAX_SPEED` の既定値（初期案 90px / 18px・frame）。実操作で調整可。
- 左方向の自動スクロールも入れるか（本設計は左右対称で実装。issue の主眼は右＝完了方向だが、対称の方が自然で追加コストも小さいため既定で両方向）。
- 縦方向（列内リスト）の自動スクロールは今回対象外。将来必要になれば別変更で。
