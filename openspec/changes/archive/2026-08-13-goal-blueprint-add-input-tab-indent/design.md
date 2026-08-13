## Context

タスク一覧のエフェメラルな追加入力（`S.addAfter`）は、`renderAll()` のたびに `addInlineRowEl()` で `<input>` を丸ごと作り直す状態駆動の描画（design D9）。既存ノードの `Tab`/`Shift+Tab` はツリー全体の `keydown` ハンドラ（`onTreeKeydown`）で処理するが、`onTreeKeydown` は `.bp-add-input` を明示的に除外しており（専用ハンドラに任せる設計）、追加入力自身の `keydown` ハンドラには `Tab` の分岐が無かった。結果、`Tab` はブラウザ既定の動作でフォーカスを外へ抜け、`blur` ハンドラの「空のまま閉じる」処理（design D3）が誤発火していた。

## Goals / Non-Goals

**Goals:**
- 追加入力で `Tab` を押したとき、既存ノードの `Tab`（直前の兄弟の子にする）と対称の体験にする。
- モード切り替え（再描画）をまたいで、打ちかけのタイトル文字列とカーソル位置を失わない。

**Non-Goals:**
- 追加入力からの複数段インデント（2段以上先読みでの子の子など）は対象外。対称にするのは「直前のタスクの子になる」1段だけ。
- 兄弟モードでの挿入位置（どの兄弟の直後か）を変える操作は対象外。

## Decisions

- **状態は `S.addAfter` に `asChild` フラグを持たせる**（`{ afterTaskId, asChild }`）。`asChild` が真のとき、`submitAdd` は `api.createSiblingTask` の代わりに `api.createChildTask(afterTaskId, { title })` を呼ぶ。
  - 代替案: 別の入力欄（子専用の入力欄）を用意する案は、状態と DOM が二重管理になり `restoreFocus` / `blur` の既存ロジックを複製する必要が出るため却下。
- **描画**: `renderSiblingList` は `asChild` のときは対象ノードの直後に追加入力を差し込まない。代わりに `nodeEl` 側で、対象ノードが `S.addAfter.afterTaskId` かつ `asChild` のとき、`isLeaf`/`openSet` の状態に関わらず子コンテナを強制的に開き、末尾に追加入力を差し込む。
  - 代替案: 対象ノードを常に「開いている」ものとして `S.openSet` に追加する案もあったが、それだと再描画のたびに `openSet` を汚染し、追加入力を閉じたあとも展開状態が残ってしまうため、`nodeEl` 側の描画分岐のみで対応した（`Tab` を押した瞬間だけは `S.openSet.add()` して見た目を開くが、子ノード自体の展開状態としても以後残ってよい—既存ノードの `handleTab` も移動先の祖先を開いたままにする、design task 4.7 と同じ扱い）。
- **打ちかけ文字列の保持**: `Tab`/`Shift+Tab` を押した瞬間の `input.value` を `draft` として次の `S.addAfter` に持たせ、`addInlineRowEl` は新しい `<input>` の初期値を `S.addAfter.draft` から復元する。`restoreFocus` は `focus()` に加えて `setSelectionRange(value.length, value.length)` でカーソルを末尾へ戻す。
  - 代替案: `renderAll()` 後に DOM を直接パッチする案（前の `<input>` の値を新しい `<input>` にコピー）は、この画面の他の再描画がすべて状態駆動（`S.caret` など）である慣習と食い違うため、状態経由の方式を採った。

## Risks / Trade-offs

- [対称性が崩れる: 追加入力からは1段しか潜れない（既存ノードの `Tab` は繰り返し押せば深い階層へ潜れる）] → 追加入力はまだ存在しないノードのプレースホルダであり、`createChildTask` は常に「対象タスクの子の末尾」に作る API 仕様のため、多段先読みは複雑さに見合わない。1段の対称操作のみを提供する。
- [`asChild` のとき葉ノードの子コンテナを強制的に開くため、確定前は「0/1」等のバッジが出ない見た目になる] → 実データ上まだ子は存在しないため正しい表示であり、確定後の再描画（`reload()`）で正しいバッジに切り替わる。

## Migration Plan

なし（クライアント側のみの挙動修正。データモデル・API 変更なし）。

## Open Questions

なし。
