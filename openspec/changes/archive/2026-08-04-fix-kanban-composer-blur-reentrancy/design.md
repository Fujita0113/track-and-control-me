## Context

`server/static/js/kanban.js` の `renderAll()`（269行〜）は、状態変更のたびに `clear(rootEl)`（`server/static/js/util.js`、DOM子要素を全除去）してから盤面全体を作り直す、素朴な「毎回フルリビルド」方式のレンダラである。この方式は、フォーカスされたまま除去される要素（`<textarea>` や `<input>`）が**除去の瞬間にブラウザ標準の同期 `blur` イベントを発火する**という前提と相性が悪い。

現在、盤面上でフォーカス可能かつ `blur` ハンドラの中で状態を変更して同期的に `renderAll()` を呼び直す要素が2箇所ある：

- 列コンポーザの `<textarea>`（`composerEl`、964行の `blur` リスナ）: `blur` で `commitComposer(false, false)` を呼び、テキストが空なら1001行の早期returnパスで `S.composingCol = null; S.composerText = ''; renderAll();` を同期実行する。
- カードタイトルのインライン編集 `<input>`（`cardTitleEl`、721行の `blur` リスナ）: `blur` でリネームを確定するが、入力が空文字の場合は725行 `if (!next) { renderAll(); return; }` で同期的に `renderAll()` を呼ぶ（`await api.updateTask` を経由する保存成功パスの729行 `renderAll()` はawait後なので非同期＝非reentrant）。

これらの要素がフォーカスされたまま**別の理由で `renderAll()` が呼ばれる**と（例: ドラッグ&ドロップの並べ替え確定、`onDrop` 829行〜887行）、外側の `renderAll()` の `clear(rootEl)` が実行中に上記要素を除去 → 同期 `blur` 発火 → 上記ハンドラが（早期returnパスの場合）同期的に `renderAll()` を再入呼び出し → 内側の `clear()`/再構築が外側の処理中のDOMに対して行われ、`NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be removed is no longer a child of this node.` で例外になる（issue #85、`onDrop` からの並べ替え確定時に実際に再現・特定）。

`onDrop` はイベントリスナーから `await` されずに呼ばれている（622行 `el.addEventListener('drop', (e) => onDrop(e, col.key, el))`）ため、この例外は未処理の Promise rejection として握りつぶされ、`saveReorder` の呼び出し（並べ替えの永続化）まで到達しない。

## Goals / Non-Goals

**Goals:**
- `renderAll()` が（どの経路からであれ）同期的に再入呼び出しされても、DOM操作が競合してクラッシュしないこと。
- 再入によって行われた状態変更（例: コンポーザを閉じる・リネームを確定する）が失われず、最終的な描画に正しく反映されること。
- 列コンポーザが開いたまま（フォーカスされたまま）でも、同一列内・列間移動いずれの並べ替えも失敗しない（クラッシュしない・`saveReorder` まで到達する）こと。
- 既存の「Enterで作成後もコンポーザが開いたまま次の入力に使える」UX、および「リネーム入力からフォーカスが外れると確定保存される」UXを変えないこと。

**Non-Goals:**
- `onDrop` が呼び出し元から `await` されていない点（未処理rejectionが握りつぶされる一般的な設計）自体の是正は行わない。今回の再入クラッシュという具体的な症状を根絶すれば、この経路で例外が発生すること自体がなくなるため、上位の是正は本変更の範囲外とする。
- `renderAll()` の「毎回フルリビルド」という設計方針自体（差分描画への刷新等）の見直しは行わない。
- 列間移動時の due 再計算永続化（issue #79 の前回変更の Non-Goals で切り出し済み）は引き続き対象外。

## Decisions

### D1: `renderAll()` 自体に再入ガード（enqueue方式）を入れ、個々の `blur` ハンドラは変更しない

- **採用**: モジュールレベルに `let isRendering = false; let renderQueued = false;` を持ち、`renderAll()` の先頭で `isRendering` が true なら実際の描画を行わず `renderQueued = true` を立てて即return する。`isRendering` が false なら `isRendering = true` にしてから既存の描画本体を実行し、完了後（`finally`）に `isRendering = false` へ戻したうえで、`renderQueued` が立っていればクリアして直後にもう一度 `renderAll()` を呼ぶ。
- **却下した案A**: 各 `blur` ハンドラ（コンポーザ・リネーム入力）側で、状態変更後の `renderAll()` 呼び出しを `queueMicrotask`/`setTimeout(0)` で1ティック遅延させる。
  - **却下理由**: 現在判明している2箇所（コンポーザ・リネーム）には効くが、将来 `blur` に限らず「フォーカス除去に伴い同期的に `renderAll()` を呼ぶ」ハンドラが増えるたびに個別対応が要る、いわゆるモグラ叩きになる。`renderAll()`/`clear()` という共通基盤側が非reentrantであること自体が根本原因であり、そちらを直すほうが同種の不具合を将来分も含めて塞げる。
- **却下した案B**: `renderAll()` の `clear(rootEl)` 実行前に、`document.activeElement` が盤面内にあれば明示的に `.blur()` を先出しして同期的に処理してから `clear()` する。
  - **却下理由**: 「除去前に能動的にblurさせる」だけでは、そのblurハンドラ自身が呼ぶ `renderAll()` の再入問題は解消しない（結局この時点で再入が起きる）。加えて `renderAll()` がDOMの外側の状態（`document.activeElement`）に依存する形になり、`asideHost` 埋め込み時（`O.asideHost` 経由で複数ホスト要素にまたがる、298行〜）などフォーカスの所在が単純でないケースの考慮が別途必要になり複雑さが増す。
- **理由**: 「`renderAll()` は同期的にネストして呼ばれても安全（副作用が失われず、DOM破壊も起きない）」という不変条件を、レンダラ自身の責務として持たせるのが最も影響範囲が小さく、既知の2ケースだけでなく未知の将来ケースにも自動的に効く。既存呼び出し元（`onDrop`・`commitComposer`・リネーム確定など）は一切変更不要。

### D2: 再入時は「即時実行」ではなく「完了後に1回だけ追いキュー」する（毎回無条件に実行し直す多重ループにはしない）

- **採用**: `renderQueued` は真偽値のフラグ1つのみ（カウンタではない）。再入呼び出しが描画本体の実行中に何回発生しても、完了後に走る追加描画は最大1回（その1回の中でさらに描画DOM除去に伴う新たなblur再入が起きれば、そこでまた `renderQueued` が立ち、さらにもう1回…という形で自然に収束する）。
- **理由**: 既知のケース（コンポーザ/リネームを閉じる）はいずれも「状態を確定させて閉じる」操作であり、閉じた後は当該要素がフォーカスされなくなるため後続の再blurは発生せず、実務上は1〜2パスで収束する。無条件の多重ループにすると、万が一何らかの理由で毎回blurが再発生し続けるコードパスがあった場合に体感できるフリーズを招くため、フラグ方式でシンプルに留める。

## Risks / Trade-offs

- **[Risk]** 再入で追いキューされた描画が完了するまでの間、`onDrop` 側の後続処理（`await saveReorder(...)`）の実行が一瞬遅れる可能性がある。
  → **Mitigation**: 追い描画は `renderAll()` 呼び出しの中（同期呼び出しのfinally節直後）で完結してから呼び出し元へ制御が戻るため、`onDrop` から見た遅延はマイクロ秒オーダーのDOM再構築1回分のみで、`await saveReorder(...)` の実行順序自体は変わらない。
- **[Risk]** `isRendering`/`renderQueued` はモジュールレベルの単一フラグであり、複数マウント時（design D1既存コメント: 「同時に2つマウントされない」ことだけを保証）を前提にしている。
  → **Mitigation**: 既存の `mount`/`unmount` の単一マウント制約と矛盾しないため新規リスクではない。
