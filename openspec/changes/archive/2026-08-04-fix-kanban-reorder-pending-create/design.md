## Context

`server/static/js/kanban.js` の `commitComposer`（997-1059行）は、新規カード作成時に `api.createTask` の応答を待たず、負の仮ID（`nextTempTaskId--`、983行）を持つ `placeholder` を即座に `S.tasks` へ push し（1014行）、`renderAll()` で描画する（Optimistic UI）。仮IDは応答成功時に `placeholder.id = t.id`（1044行、オブジェクト参照は維持したままフィールドのみ書き換え）で実IDへ差し替わり、失敗時は `S.tasks` から placeholder ごと除去される（1052行）。

一方、同一列内・列間の並べ替えは `onDrop`（829-890行）が `S.tasks` を列でフィルタして `without`/`dest`/`src` 配列を作り（855, 866-867行）、それをそのまま `saveReorder`（822-827行）→ `api.reorder` へ渡す。このフィルタは「作成中でまだ実IDが確定していないカード」を区別しないため、pending中のカードがある列で何かをドラッグすると、負のIDが `ids` 配列に混入したまま `POST /api/tasks/reorder` へ送られる。

サーバー側 `server/src/api/planning.ts` の `reorderBody`（65-74行）は `ids: z.array(z.number().int().positive())` であり、負のIDを含むリクエストは即 400 になる（139-143行）。`saveReorder` の catch（826行）はこれを「並べ替えの保存に失敗」として toast し `reload()` で `S.tasks` をサーバ状態へ丸ごと上書きするため、ユーザーには「並べ替えたのにエラーが出て元に戻る」ように見える（issue #79）。

## Goals / Non-Goals

**Goals:**
- 作成中（実ID未確定）のカードが列に存在していても、その列・他列のドラッグ&ドロップ並べ替えがエラーにならないこと。
- 並べ替えのローカル反映（見た目）は現状と同じく即座（UXを一切落とさない）。
- pending中に行われた並べ替えの最終結果が、作成確定後（成功/失敗いずれでも）に取りこぼされず永続化されること。
- 列間移動で、移動元・移動先いずれかの列が作成中だった場合も同様に扱うこと。

**Non-Goals:**
- 作成中のカード自体を列間ドラッグした際の **due 再計算の即時永続化**（`onDrop` 886-889行、`api.updateTask(t.id, {due})`）は対象外とする。`t.id` が負のままサーバへ送られ得るが、この呼び出しは `reload()` を伴わず単発の toast のみで、issue #79 が指す「並べ替えが戻る」症状には該当しない。別問題として切り出す。
- サーバー側 `reorderBody` のバリデーション変更は行わない（フロントの内部実装詳細である仮IDをAPI契約に漏らさない）。

## Decisions

### D1: 「pending中か」は列ごとにカウンタで持たず、`S.tasks` から都度判定する
- **採用**: `hasPendingCard(colKey) = S.tasks.some(x => normStatus(x.status) === colKey && x.id <= 0)` という純粋関数で毎回判定する。
- **却下した案**: `commitComposer` 開始/終了で列ごとのカウンタを increment/decrement する方式。
- **理由**: カウンタ方式は「作成中カードが、確定前に別列へドラッグされる」ケースで破綻する。カウンタは作成開始時の列（`S.composingCol`）に紐付くため、カードが別列へ移動した後もカウンタは元の列に残ったままになり、移動先列（実際に負IDのカードを抱えている列）はpending扱いされずエラーが再発する。`S.tasks` の現在地から直接判定すれば、カードがどの列にいようと常に正しい。

### D2: reorder の**送信**だけを保留し、ローカル反映（`commitColumnOrder`/`renderAll`）は今まで通り即時実行する
- **採用**: `onDrop` 側のロジック（列内・列間とも）は変更しない。`saveReorder` 内で、送信対象の各 `{status, ids}` グループについて `hasPendingCard(status)` が true なら **そのグループだけ**ネットワーク送信をスキップし `S.dirtyReorderCols`（Set）に `status` を追加する。false なら安全弁（D3）を通して即送信する。
- **理由**: ユーザー要望どおりUXを一切変えない。列間移動で片方の列だけpendingの場合、pendingでない側のグループは今まで通り即送信し、pending側だけ保留する（2つの列が独立して扱われる）。

### D3: 送信直前に非正のIDを除外する安全弁を常時入れる（フィルタ）
- **採用**: `saveReorder` が実際に `api.reorder` へ渡す直前、各グループの `ids` を `ids.filter((id) => id > 0)` する。
- **理由**: D1/D2のロジックに漏れやタイミングバグがあっても400では絶対に落ちないようにする低コストな保険（ユーザーとの合意事項）。

### D4: flush は「作成の確定（成功/失敗）」をトリガに、その時点の `S.tasks` から**再計算**する（保留時のids配列を後で再利用しない）
- **採用**: `commitComposer` の成功パス（1044行 `placeholder.id = t.id` の直後）と失敗パス（1052行 placeholder除去の直後）の両方で `flushDirtyReorders()` を呼ぶ。この関数は `S.dirtyReorderCols` を走査し、`hasPendingCard(col)` が false になった列について `ids = S.tasks.filter(x => normStatus(x.status) === col).map(x => x.id)` を**その時点の最新状態から作り直し**、`saveReorder([{ status: col, ids }])` を呼んで送信する（送れたら Set から削除、送れなくても D3 のフィルタと既存の catch が効く）。
- **却下した案**: `onDrop` 時点の `ids` 配列（負IDを含む生スナップショット）を保存しておき、確定後にIDだけ実IDへ置換して再送する。
- **理由**: `placeholder.id = t.id` はオブジェクト参照のフィールド書き換えであり、`onDrop` で作った `ids` 配列は `.map(x => x.id)` によるプリミティブ値のコピーなので、後から `placeholder.id` を書き換えても配列内の値は自動更新されない。スナップショット保存だと「どの要素が仮IDだったか」を別途追跡してID差し替えする複雑な仕組みが要る。`S.tasks` から**都度再計算**すれば、成功時は実ID・失敗時は該当カード除去済みの状態が常に正しく反映され、追加の追跡状態が不要になる。
- 同じ列で複数の作成が同時に pending（連続Enterで前の `createTask` がまだ返っていないうちに次を作成）していても、`flushDirtyReorders` は `hasPendingCard` が false になるまで送信を待つため、早すぎるflushで再び負IDを送ってしまうことはない。

### D5: `dirtyReorderCols` は列間移動の両列を独立に管理する
- **採用**: `onDrop` の列間移動パスは `saveReorder([{status: fromCol, ids: src...}, {status: colKey, ids: dest...}])` を1回で呼ぶ既存のバッチ形を維持する。`saveReorder` 内部でグループ単位に pending 判定するため、`fromCol` と `colKey` が独立して即送信/保留に振り分けられる。
- **理由**: 既存の「1リクエストで一貫保存」という設計意図（コメント864-865行）をできるだけ維持しつつ、pendingな列だけを個別に遅延できる。

## Risks / Trade-offs

- **[Risk]** pending中の列の並び順は、作成が確定するまでサーバー上は古いまま。その間に別クライアント/タブから同じデータを見ると、並べ替え前の順序が見える。
  → **Mitigation**: 単一ユーザー・単一クライアント運用が前提のプロジェクトであり、確定は通常数百ms以内に完了するため実害は小さい。既存の「サーバ状態への収束（reload）」という設計方針とも矛盾しない。
- **[Risk]** `flushDirtyReorders` の送信自体が失敗した場合、既存の `saveReorder` の catch がそのまま効いて `reload()` が走る。これは作成確定の裏側で非同期に起きるため、ユーザーが今まさに次のカードを操作中に突然 `reload()` されると驚きがある。
  → **Mitigation**: 元々 `saveReorder` 失敗時の `reload()` は既存の設計（design Risks に明記済み、822行コメント）であり、新規のリスクではない。発生頻度は「pending中に並べ替え」×「flush自体も失敗」の二重発生でさらに稀。
- **[Risk]** Non-Goalsで挙げた due 永続化（886-889行）は今回直さないため、作成中カード自体を列間ドラッグしdue変更を伴うケースでは、失敗toastが単発で出うる（reload は伴わない）。
  → **Mitigation**: 別issueとして切り出せる程度に軽微。今回のスコープでは対応しない。
