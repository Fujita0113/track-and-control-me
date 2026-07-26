## Context

かんばんカードは `server/static/js/kanban.js` の `cardEl(t)`（507-540行）が描画し、シングルクリックで `openDetail(t)`（510行、1017-1023行）を呼んで詳細パネル `detailEl(t)`（1038行〜）を開く一本道になっている。

削除は既に実装済みだが、詳細パネル内の `.kb-del-btn`（1104-1118行）からしか呼べない：`confirm()` で確認 → `api.deleteTask(t.id)` → `S.tasks` から除去 → `S.detailId = null` → `renderAll()`。タイトル編集も同様に詳細パネル内の `.kb-detail-title` textarea（1045-1066行）に限られ、`scheduleSave(t, 'title')`（179-193行、600msデバウンスPATCH）で保存し、カード側の `.kb-card-title` テキストノードを直接書き換えて即時反映している（1053-1054行）。

クライアント状態は `S`（84-104行）というモジュール変数一つのみで、Redux等のストアはない。`renderAll()` はユーザー操作（クリック・ドラッグ・保存完了）のたびに呼ばれる明示駆動で、ポーリングによる自動再描画は無い（`reload()` は初期表示や特定操作後にのみ呼ばれる）。したがって編集中に外部要因で `renderAll()` が割り込みインライン編集中のDOMを壊すリスクは低いが、ゼロではないため `S` に編集中フラグを持たせて再描画時も編集モードを維持する。

右クリックのコンテキストメニューは本コードベースに前例が無い（`ref/` の参照実装とチャートライブラリにのみ既存）。issue #29 の文面「右クリック**か**タスクカード内部のゴミ箱マーク**で**削除したい」は「メニューを開いて選ぶ」ではなく「右クリック／ゴミ箱アイコンのどちらでも削除トリガーになる」という意味に読める。新規UIコンポーネント（カスタムコンテキストメニュー）を作らず、右クリック（`contextmenu`）とゴミ箱アイコンクリックの両方を同じ削除フローに直結させることで、実装面積とテスト対象を最小化する。

## Goals / Non-Goals

**Goals:**
- カードを開かずに、右クリックまたはカード内ゴミ箱アイコンからタスクを削除できる（既存の確認ダイアログ運用・`api.deleteTask` を流用）
- カードをダブルクリックしてカード上でタスク名をその場編集できる（既存の `scheduleSave`／`api.updateTask` を流用）
- 既存のシングルクリック（詳細を開く）、ドラッグ＆ドロップ、詳細パネル内の削除・タイトル編集は挙動を変えない
- 既存 e2e（`.kb-card` / `.kb-card-title` セレクタに依存する `kanban-restore.spec.ts` 等）を壊さない

**Non-Goals:**
- 汎用のカスタムコンテキストメニューコンポーネントを作ること（右クリックは削除確認への直結のみ）
- 削除の取り消し（Undo）機構を作ること（確認ダイアログのみで対応する既存運用を踏襲）
- タイトル欄のIME・改行畳み込みロジックの再実装（詳細パネル側の `kanban-detail-title` 仕様は変更しない。カード上インライン編集は単一行入力 `<input>` を使い、IME確定Enter（`isComposing`/`keyCode 229`）の誤確定ガードのみ移植する）

## Decisions

- **削除フローの共通化**: 現在 `.kb-del-btn` の `onclick`（1107-1116行）にインラインで書かれている「確認→`api.deleteTask`→`S.tasks`から除去→`renderAll()`」を `deleteTaskWithConfirm(t)` という関数に切り出し、詳細パネルのボタン・カードのゴミ箱アイコン・カードの `contextmenu` ハンドラの3箇所から呼ぶ。confirm文言は既存と同じ「このタスクを削除しますか?」を再利用し、UIの一貫性を保つ。
  - 代替案（カード側だけ独自の確認トースト等を作る）は却下: 詳細パネルと挙動が二重化し、"どちらで消しても同じ確認"という利用者の予測可能性が下がる。
- **右クリック＝メニューを出さず直接削除確認**: `card.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); deleteTaskWithConfirm(t); })`。ブラウザ既定の右クリックメニューは `preventDefault` で抑止する。
  - 代替案（右クリックで小さなメニューを出し「削除」を選ばせる）は却下: 現状 delete 以外にカード右クリックで行いたい操作が無く、メニューを作るコストに見合わない。将来操作が増えたら再検討する（Open Question参照）。
- **ゴミ箱アイコン**: `cardEl` に `.kb-card-del` ボタンを追加し、`click` ハンドラで `e.stopPropagation()`（カードの `openDetail` を誤発火させないため。1110行にある `tomorrow-plan.js` の `.rf-plan-item-del` パターンと同じ考え方）してから `deleteTaskWithConfirm(t)` を呼ぶ。
- **インラインリネーム**: `S.renamingId`（新規state）を追加。`.kb-card-title` の `dblclick` で `e.stopPropagation()` した上で `S.renamingId = t.id; renderAll()`。`cardEl` は `S.renamingId === t.id` のとき `.kb-card-title` の代わりに `<input class="kb-card-title-edit">`（value=`t.title`）を描画し、自動フォーカス＋全選択する。
  - 保存タイミング: 継続入力中のデバウンス保存（`scheduleSave` 相当）ではなく、**Enter確定／blurで1回だけ** `api.updateTask(t.id, { title })` を呼び `S.renamingId = null`。理由: カード上の編集はワンショットの改名操作であり、詳細パネルのタイトル欄（連続編集・自動保存前提のtextarea）と違って「編集開始→確定→終了」の短い操作なので、デバウンスより単純な確定型のほうが状態管理が少なく済む。
  - キャンセル: `Escape` で `t.title` を変更せず `S.renamingId = null; renderAll()`。
  - IME確定Enterガード: `e.isComposing || e.keyCode === 229` の場合は確定しない（`kanban-detail-title` 仕様のタイトル欄と同じガード条件を移植、177-193行のパターンに倣う）。
  - 空文字での確定は保存せず入力前の値へ戻す（タイトル必須という既存モデルの暗黙前提を壊さない。サーバ側 `updateTask` に空文字バリデーションは無いため、クライアント側でガードする）。
- **既存DOM構造の維持**: `.kb-card` のトップレベル構造・`.kb-card-title` の存在自体は変えない（リネーム中のみ子要素を input に差し替える）。ゴミ箱アイコンは `.kb-card-top` 内の右端など、`kb-card-restore.spec.ts` 等の既存セレクタ（テキスト内容ベース）に干渉しない位置に追加する。

## Risks / Trade-offs

- [ドラッグ操作中に誤って削除/リネームが起動する] → ゴミ箱アイコン・ダブルクリックはどちらも `mousedown` 起点のドラッグ (`draggable=true`) と競合しうる。`stopPropagation` に加え、アイコン自体は `draggable` を継承させず、クリック領域をカード全体でなくアイコン/タイトル要素に限定することで軽減する。
- [右クリック削除の誤操作コスト] → ワンクリック的に見えて実際は `confirm()` を必ず挟むため、既存の詳細パネル削除と同じ誤操作耐性を持つ。誤発火自体（右クリックで即・確認なし削除）は起きない設計。
- [インライン編集中に他操作で `renderAll()` が割り込む] → `S.renamingId` を state に保持し再描画のたびに編集モードへ戻すことで、入力途中の値そのもの（DOM内のinput.value）は失われうるが「編集モードが解除されて詳細を開く挙動に戻る」事故は防ぐ。完全な入力値保持まではスコープ外（Non-Goals）。

## Open Questions

- 将来的にカード右クリックで削除以外の操作（優先度変更など）を増やす場合、その時点で汎用コンテキストメニューへ拡張するか、個別ショートカットを増やすかは未決定（今回はスコープ外）。
