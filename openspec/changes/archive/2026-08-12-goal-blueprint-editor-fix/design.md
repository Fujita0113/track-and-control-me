## Context

`server/static/js/blueprint.js` はタスク一覧（長期目標エディタ）のフロントエンド。行のタイトルは design D7 により**常に `<input>` として描画**され（ダブルクリック改名は廃止済み）、`renderAll()` を呼ぶたびに `restoreFocus()` が `S.selId` の指すノードの `<input>` へ無条件でフォーカスとキャレットを戻す（`goal-blueprint` spec 200行目台の「編集の直後はフォーカスが戻る」という既存 SHALL のための実装）。

issue #99 で報告された2つのバグ:

1. **タイトル編集後、外へクリックしても入力枠から抜けられない。↑↓でのタスク移動もできない。**
   - `nodeTitleEl()` の `blur` ハンドラ `commitTitle()` は、値が変わっていれば `await api.updateTask(...); await reload();` を呼ぶ。`reload()` は `renderAll()` を呼び、`renderAll()` は無条件に `restoreFocus()` を呼ぶ。
   - `restoreFocus()` は常に `S.selId`（＝直前に編集していたノードの id、blur だけでは更新されない）の `<input>` へ `.focus()` する。
   - つまり「タイトルを直して、ツリーの外の何でもない場所をクリックする」→ ブラウザは一旦 `blur` するが、`commitTitle` の非同期処理が終わった時点で `reload()` → `renderAll()` → `restoreFocus()` が発火し、**同じ入力枠へフォーカスを勝手に奪い返す**。見た目には「クリックしても編集状態が終わらない」ように見える。
   - フォーカスがツリーの外（`document.body` など）へ完全に出てしまうと、`↑↓` のキー処理は `.bp-tree-wrap` に貼った `keydown` リスナーでしか拾えない（イベントはフォーカス中の要素から上へバブルするため）。奪い返しが効かないケース（値を変えずに blur した場合など）では、フォーカスがツリーの外にあるままなので `↑↓` を押してもツリーに届かず、何も起きない。

2. **Detail モーダルに書いた本文がツリーの行の下にプレビューとして漏れる。**
   - `nodeEl()` が葉ノードかつ `node.notes` があるとき `wrapNode.appendChild(h('div', { class: 'bp-node-notes', ... }))` を無条件に追加している。
   - `openspec/specs/goal-blueprint/spec.md` にも、見た目の正典 `ref/goal-blueprint/task-tree-mock.html` にもこの挙動は存在しない。実装時に紛れ込んだ仕様外の描画で、単純に消してよい。

## Goals / Non-Goals

**Goals:**
- タイトル編集を終えて（値を変えても変えなくても）ツリーの外へクリックしたら、入力枠のフォーカスと選択枠 (`.sel`) が実際に外れる。
- 既存のキーボード駆動フロー（Enter で兄弟追加→続けて入力、Tab/Shift+Tab、Alt+C、↑↓、Ctrl+Enter）でのフォーカス継続は今まで通り壊さない。
- 行の下に本文のプレビューが出ないようにする。

**Non-Goals:**
- タイトルを「常に `<input>`」から「選択時だけ `<input>`」に変える設計変更はしない（design D7 の既存 SHALL を維持）。
- Detail モーダル自体の挙動・本文エディタは変更しない。
- サーバ側（API・DB）の変更はしない。

## Decisions

### D1: `restoreFocus()` は「タイトル編集の blur から来た再描画で、かつフォーカスがツリーの外にある場合だけ」スキップする

**（apply 時に精緻化）** 当初案は「`renderAll()` を呼ぶたびに、直前にフォーカスがツリーの中にあったかどうかで無条件にガードする」だった。しかし初期表示（空のツリーを開いたときに追加入力へ自動フォーカスする、凍結済み e2e `e2e/goal-blueprint-keyboard-tree.spec.ts` の「空のツリーで Enter を続けて押し…」）は、`renderAll()` が呼ばれる時点でまだ何もフォーカスされていない（`document.activeElement` はツリーの外）。ここに同じ条件を適用すると初期フォーカスが飛ばなくなり、既存 e2e を壊す。

そのため、ガードは **`commitTitle()` から来る `reload()` 呼び出しだけ** に絞った:

- `renderAll(opts)` は `opts.skipFocusRestoreIfOutside` を受け取る。true のときだけ、`clear(root)` の前に `document.activeElement` がツリー（`S.root`）の中にあるかを見て、外にあれば `restoreFocus()` をスキップする。それ以外の再描画（初期表示・↑↓・Tab・Enter追加・Alt+C・チェック・メニュー・詳細モーダルの保存など）は今まで通り無条件に `restoreFocus()` する。
- `reload()` はこの `opts` をそのまま `renderAll()` へ橋渡しする。`commitTitle()` だけが `reload({ skipFocusRestoreIfOutside: true })` を呼ぶ。
- スキップが成立したときは、`S.selId` / `S.caret` も一緒に `null` にする。フォーカスだけ外して選択枠 (`.sel`) が残ると「選択は常にちょうど1行」という既存要件と見た目上つじつまが合わなくなるため（→ 下記 D1-b）。

判定ロジック（キー操作・乗り換え時に既存挙動を壊さない理由）は当初案と同じ:
- ツリー内でのキー操作は、押した瞬間はまだ古い `<input>` にフォーカスがある状態で `renderAll()` が呼ばれるため、ツリーの中と判定されフォーカスが引き継がれる。
- タイトル編集中にツリーの外の何でもない場所をクリックした場合は、ネイティブな `blur` で `document.activeElement` は既に `document.body`（またはクリック先の別要素）になっている。`commitTitle` の非同期処理が `reload({ skipFocusRestoreIfOutside: true })` を呼ぶ時点でツリーの外と判定され、`restoreFocus()` はスキップされる。
- 別のノードのタイトルをクリックして乗り換えた場合は、ネイティブな `blur(旧)`→`focus(新)` の順で発火し、`focus` ハンドラが `S.selId` を新ノードへ更新する。その後の `reload()` の時点でも `document.activeElement` は新ノードの `<input>`（＝ツリーの中）のままなので、`restoreFocus()` は `S.selId`（＝新ノード）へ正しくフォーカスを戻す。乗り換え自体は壊れない。

### D1-b: 離脱時は選択枠 (`.sel`) も一緒に外す（apply 時に user 承認のうえ spec delta を1点修正）

propose 時点の delta spec には、既存要件「選択は常にちょうど1行 SHALL とする」（無変更で引き継いだ記述）と、新規追加した「ツリー外へクリックすると選択枠も外れる」シナリオが両立しない矛盾があった。apply 時にこれを検出し、AskUserQuestion で一度だけ確認したところ「外クリックで選択枠も外す」を正としてよいと承認を得たため、`specs/goal-blueprint/spec.md` の当該行を「ツリーの中で操作している間は常にちょうど1行。ただし明示的な外クリック離脱時は0行になる」という例外つきの表現に修正した。

### D2: `.bp-node-notes` の描画を削除する

`nodeEl()` 内の以下を削除する:

```js
if (isLeaf && node.notes) {
  wrapNode.appendChild(h('div', { class: 'bp-node-notes', text: node.notes }));
}
```

`server/static/css/app.css` の `.bp-node-notes` ルールも未使用になるため削除する（既存 CLAUDE.md の「触っていない行の書式を変えない」に従い、この1行のみを削除しファイル全体の整形はしない）。

### D3: 空のエフェメラルな追加入力（design D5）は、Escape (Esc) / Delete キーと自動クローズで消せる（issue #99 の追加コメントを受けて apply 時に追加）

**背景**: issue #99 に「①②は直った。ただし Enter を余計に1回押してできた空の追加入力（プレースホルダー『タイトルを入力』）が、他の場所をクリックしても消えない。サンプルにカーソルを合わせて上下に動かそうとしても、下の空の追加入力に吸い寄せられる。Escape (Esc) / Delete キーや外クリックで消せるようにしてほしい」という追加コメントが付いた。

**原因**: `restoreFocus()` は

```js
if (S.addAfter) {
  const el = S.root.querySelector('.bp-add-input');
  if (el) el.focus();
  return;
}
```

を **`S.selId` より無条件で優先**している。`S.addAfter` は Enter や末尾の＋で開いたエフェメラル入力が Enter/Escape で確定・取消されるまでずっと立ったままで、クリックだけでは消えない（`addInlineRowEl()` に `blur` ハンドラが無い）。したがって:
- 他のノードをクリックして選んでも、次に何か（↑↓など）が再描画を起こすたびに `restoreFocus()` が `S.selId` を無視して追加入力へフォーカスを戻す＝「サンプル2にカーソルを合わせても吸い寄せられる」。
- `onTreeKeydown` の先頭 `if (e.target.closest('.bp-add-input')) return;` は、フォーカスが追加入力にある間 `↑↓` を含む全キー操作を握りつぶす。上記で吸い寄せられた後は、この早期リターンにより `↑` を押しても何も起きない＝「上矢印を押すともうサンプルは選択できない」。

**修正**:
- `addInlineRowEl()` の `<input>` に `Escape` (Esc) キーおよび `Delete` キーのクローズ処理を適用する。`Escape` キーを押すか、または `Delete` キーで値が空（trim後）のとき `e.preventDefault(); S.addAfter = null; renderAll();` により空の追加入力を消す（`Delete` キーで値が入っているときは通常のテキスト編集として素通しする）。
- 同じ `<input>` に `blur` ハンドラを追加する。ただし **blur した瞬間はまだフォーカスの移り先が確定していない**ため（クリック先の要素がこれから作り直されるかもしれない）、遅延させてから、そのとき点でも `S.addAfter` が立ったまま・値が空・かつフォーカスがもうその入力に無いことを確認できたら `S.addAfter = null` にして `renderAll({ skipFocusRestoreIfOutside: true })` を呼ぶ。
  - **遅延手段は `queueMicrotask` ではなく `setTimeout(fn, 0)`（マクロタスク）にする。** 実測したところ、クリックによる `mousedown → mouseup → click` は複数タスクに分かれてブラウザに処理される。`queueMicrotask` は次のマクロタスク（＝クリック先要素へのフォーカス確定）より先に走ってしまい、まだフォーカスが乗っていない別ノードの `<input>` をこちらの再描画で先に壊してしまう結果、そのクリックのフォーカス確定自体が不成立になり、どこにもフォーカスが乗らなくなる不具合が実際に発生した（e2e で検出）。`setTimeout(0)` にしてクリック起因の一連の処理が終わるのを待ってから判定するよう修正した。
  - `skipFocusRestoreIfOutside` は D1 で作った既存の仕組みをそのまま再利用する: 移り先がツリーの中（別ノードなど）なら通常どおり `S.selId` に基づいて `restoreFocus()` する。移り先がツリーの外なら、フォーカスを奪い返さない。
  - 値に1文字でも入っている場合は何もしない（打ちかけの内容を失わないため）。`Enter` で正規の確定処理（`submitAdd`）に入るときは `input.disabled = true` を先に行っており、その時点で `input.value` はまだ確定前のタイトル文字列（非空）のままなので、この blur ハンドラは何もしない（早期 return）。誤って自分自身の正規の送信フローを妨害しない。

**代替案として検討したもの**:
- 「`restoreFocus()` 自体の優先順位を `S.addAfter` より `S.selId` を先に見るよう単純に入れ替える」も検討したが、`openAddAfter()` 呼び出し直後（まだユーザーが1文字も打っていない瞬間）に追加入力へ自動でフォーカスが飛ぶという既存の凍結挙動（`e2e/goal-blueprint-keyboard-tree.spec.ts` の「空のツリーで Enter を続けて押し…」）と衝突するため見送った。「空になったら自分から閉じる」方式なら、開いた直後は空だが誰もまだ離脱していないので問題なく、離脱した瞬間だけ閉じるので両立する。

## Risks / Trade-offs

- [Risk] `document.activeElement` ベースの判定は、フォーカスがツリー内の**別の**要素（例: `⋯` メニューのボタン）にある状態で再描画されるケースを「ツリーの中にいる」と扱う。→ これは意図通り（メニュー操作中も選択枠が消えるのは不自然なため、許容する）。
- [Risk] 既存 e2e (`e2e/goal-blueprint-keyboard-tree.spec.ts`, `e2e/goal-blueprint-task-tree.spec.ts`) はフォーカス外れ→再取得のフローを直接検証していないため、今回の変更で壊れる想定は無いが、実装後に両方を実行して確認する。
- [Risk] `.bp-node-notes` を削除すると、これまで「行を見ただけで本文の有無・中身が分かる」という副次的な使い方をしていたユーザーがいた場合に体感速度が落ちる。→ 仕様・視覚正典のどちらにも存在しない挙動であり、issue #99 で明示的にバグ報告されているため優先して除去する。

## Migration Plan

- DB・API 変更なし。フロントエンドのみの修正なので、デプロイは通常のリリースと同じ。ロールバックは単純な revert で足りる。
