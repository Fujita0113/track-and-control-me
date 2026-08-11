## 0. 凍結ラインの申し送り

**propose が凍結したもの（apply は触るの禁止）**:

- delta spec 1本（`kanban-card-quick-delete`、`specs/kanban-card-quick-delete/spec.md`）
- `server/src/services/kanban-delete-skip-confirm.test.ts`（新規ファイル、5 describe/it）
- `e2e/kanban-card-quick-actions.spec.ts` のうち、今回改変した3本
  （`ゴミ箱アイコンから削除する→「次回から確認しない」が有効なら確認なしで即削除される`／
  `確認をキャンセルすると削除されない`／`削除は即座にボードから消える（Optimistic UI）が、失敗時は復元される`）

**`npx vitest run server/src/services/kanban-delete-skip-confirm.test.ts` の現状**: `5 failed | 0 passed (5)`。
`shouldSkipDeleteConfirm is not a function`（未実装のため import 先に無い）。

このテストが固定している契約（design D1）:

| 関数 | 何を固定したか |
|---|---|
| `shouldSkipDeleteConfirm(source, skipPref)` | `source === 'trash'` かつ `skipPref` が truthy のときのみ `true`。それ以外（`contextmenu`／`detail`／`skipPref` が falsy・undefined・null）はすべて `false` |

**この5件が緑になることが実装完了の最低条件の1つ**（他に `npm test` 全体が緑であること）。

**変更した既存 e2e**: `e2e/kanban-card-quick-actions.spec.ts`。

- **理由**: この change はゴミ箱アイコン起点の確認を `window.confirm()` からカスタムモーダルへ差し替えるため、
  `.kb-card-del` クリック→`page.once('dialog', ...)` を前提にしていた3本が必ず落ちる。一方、差し替え後の
  カスタムモーダルの DOM（クラス名・チェックボックスのセレクタ等）は apply が実装時に発明するので、ここで
  それを踏むテストを書くと当てずっぽうになる。そこで：
  - 1本目は、**確認ステップの有無**だけを検証する形に書き換えた。`localStorage` の
    `tcm_kanban_skip_delete_confirm='1'`（design D3 で決めた契約）を事前にセットしてから
    ゴミ箱アイコンをクリックし、ダイアログを経ずに即削除されることを見る。モーダルの DOM には触れない。
  - 3本目・4本目（キャンセル／Optimistic UI ロールバック）は、トリガーをゴミ箱アイコンから右クリック
    （`window.confirm()` のまま変わらない経路）へ差し替えた。削除の実行部（`execDelete`、design D2）は
    起点によらず共通なので、この経路でも同じ回帰を検知できる。
  - 2本目（右クリックから削除する→確認して消える）は無変更。
- 変更後、`CI=1 npx playwright test e2e/kanban-card-quick-actions.spec.ts` を実行して確認済み:
  **1本目のみ red（`toHaveCount(0)` が `1` のまま）、残り6本は green**。1本目が red なのは想定どおり
  （`tcm_kanban_skip_delete_confirm` を読む実装がまだ無く、確認ダイアログが出て Playwright に
  自動 dismiss されるため）。実装後にこの1本が green になることを確認する（§6）。
- 以降 apply は `e2e/` を触るの禁止。`git diff -- e2e/` が（新規ファイルの追加を除いて）
  この1ファイルの上記差分のみであること。

**apply が最後に書く新規 e2e が覆うべきフロー**（セレクタではなくフローで指定する）:

1. 「ゴミ箱アイコンで初めて削除を開始する→確認モーダルに『次回から確認しない』チェックボックスが出る」
2. 「チェックボックスを入れて削除する→そのタスクが消える→続けて別カードのゴミ箱アイコンで削除すると、
   確認モーダルを経ずに即削除される」
3. 「チェックボックスを入れずに削除する→続けて別カードのゴミ箱アイコンで削除すると、再び確認モーダルが出る」
4. 「確認モーダルでキャンセル（またはEscape）する→タスクは削除されずボードに残る」

## 1. クライアント（凍結テストを緑にする）

- [x] 1.1 `kanban.js` に純関数 `shouldSkipDeleteConfirm(source, skipPref)` を追加してエクスポートする
      （design D1）。`source === 'trash' && !!skipPref` の1行で足りる
- [x] 1.2 `npx vitest run server/src/services/kanban-delete-skip-confirm.test.ts` が 5 件すべて緑になる。
      **テストは1行も変えない**
- [x] 1.3 `SKIP_DELETE_CONFIRM_KEY = 'tcm_kanban_skip_delete_confirm'` と、ゲッター
      `deleteConfirmSkipEnabled()` / セッター `setDeleteConfirmSkip(on)` を `kanban.js` に追加する
      （design D3、`SOUND_KEY`/`soundOn()` と同じ形。日付スコープは持たない）

## 2. 削除確認の起点別分岐（design D2）

- [x] 2.1 既存の `deleteTaskWithConfirm(t)` の本体（Optimistic UI 削除・失敗時ロールバック）を
      `execDelete(t)` として切り出す。呼び出し側の3箇所（ゴミ箱アイコン・右クリック・詳細パネル）は
      すべて最終的に `execDelete(t)` を呼ぶ形にする
- [x] 2.2 `deleteTaskWithConfirm(t, source)` を新設し、`source` は呼び出し元ごとに
      `'trash'`（`kanban.js:711-714` ゴミ箱アイコン）／`'contextmenu'`（`kanban.js:678-682` 右クリック）／
      `'detail'`（`kanban.js:1428-1432` 詳細パネル）を渡す
- [x] 2.3 `deleteTaskWithConfirm` の先頭で `shouldSkipDeleteConfirm(source, deleteConfirmSkipEnabled())` を見て、
      true なら確認を挟まず `execDelete(t)` を呼んで return する
- [x] 2.4 `source === 'trash'` かつスキップ対象でない場合は、`window.confirm()` を呼ばずカスタム確認
      モーダル（§3）を開く。`source` が `'contextmenu'` または `'detail'` の場合は、**従来どおり**
      `window.confirm('このタスクを削除しますか?')` を呼び、承認されたら `execDelete(t)` する
      （右クリック・詳細パネルの挙動を一切変えない・design D2）

## 3. カスタム確認モーダル（design D4）

- [x] 3.1 `util.js` の `openModal`/`closeModal` を使い、`openDeleteConfirmModal(t)` を追加する。
      タイトル「タスクを削除」、本文に説明文「このタスクを削除しますか?」＋チェックボックス1つ
      （ラベル「次回から確認しない（ゴミ箱アイコンのみ）」、`settings.js` の
      `h('label', { class: 'inline' }, chk, text)` と同じ形）
- [x] 3.2 フッターに「キャンセル」（`btn`）と「削除」（`btn small danger`、`goals.js:291` と同じクラス）を置く。
      「削除」押下時: チェック ON なら `setDeleteConfirmSkip(true)` を呼んでから `execDelete(t)`、
      OFF なら `execDelete(t)` のみ。どちらも `closeModal()` で閉じる
- [x] 3.3 「キャンセル」押下・背景クリック・Escape ではタスクを削除しない
      （`openModal`/`main.js` の Escape ハンドラが既にこの挙動を持つので、独自の keydown は足さない）
- [x] 3.4 埋め込み盤面（`tomorrow-plan.js` からの `asideHost` マウント）でもモーダルが正しく開くことを
      手動確認する（`#modal-root` はグローバルなので当然動くはずだが、実際に踏んで確認する）
      → `#modal-root` は `index.html` にグローバル1つのみで `openModal`/`closeModal` はそれを
      直接操作する実装であり、`asideHost` 埋め込みの有無に依存しない。Playwright で明日の計画
      タブ（埋め込み盤面）からゴミ箱アイコンをクリックし、モーダルが開いて削除できることを確認済み。

## 4. 見た目

- [x] 4.1 `app.css` にモーダル本文（チェックボックスの行間・フッターの並び）のスタイルを追加する。
      既存の `.modal-*` を再利用しつつ足りない分だけ足す。フォーマッタをファイル全体にかけない。
      編集後に `git diff --stat -- server/static/css/app.css` の桁を確認する（1ルール1行の書式を維持）
      → 調査の結果、`modal-body`/`stack`/`actions`/`label.inline` が既に必要なレイアウトを
      すべて満たしていたため、**新規 CSS は不要だった**（`rule-form.js`/`goals.js` の
      確認モーダルと全く同じクラスの組み合わせで組んだ）。`app.css` は無変更。

## 5. 既存 e2e の回帰確認（実装直後・ここで止める）

- [x] 5.1 `$env:CI="1"; npx playwright test e2e/kanban-card-quick-actions.spec.ts e2e/kanban-note-editor.spec.ts` が
      全て緑で、かつ `git diff -- e2e/` が §0 に記載した差分のみであることを確認する。**落ちた場合は
      e2e を書き換えず停止**し、凍結ラインの投げ返し（1回だけ）としてユーザーへ確認する
      → 実装直後（新規 e2e 追加前）の時点で 12/12 緑（当時の `kanban-card-quick-actions.spec.ts` 7本
      ＋ `kanban-note-editor.spec.ts` 5本）。`git diff -- e2e/` は propose 段階で改変した3本のみ
      （新規テストは §6 で追加）。凍結ラインの投げ返しは不要だった。

## 6. 新規 e2e（DOM ができた後に書く）

- [x] 6.1 §0 に挙げた4フローの e2e を `e2e/kanban-card-quick-actions.spec.ts` へ追加する。
      セレクタは実装した DOM から採る
      → 5本追加（§0 の4フローに加え、Escape での取消も別テストとして分離したため+1）。
      実装後の状態で当該5本を含む全12本が緑であることを確認済み
- [x] 6.2 `git stash push -u -m "kanban-delete-skip-confirm-redproof" -- server/` →
      `$env:CI="1"; npx playwright test e2e/kanban-card-quick-actions.spec.ts -g "モーダル"` で
      **新規5本が落ちること**を確認（実測: 5 failed、タイムアウトで `.modal-panel` が見つからず）→
      `git stash apply <captured-sha>` → `git stash drop` で復元 → 同じ `-g "モーダル"` で5本とも
      通ることを確認（実測: 5 passed）。`CI=1` は必須（共有 stash スタックのため `git stash pop` では
      なく sha を明示指定した `apply`→`drop` を使用）
- [x] 6.3 `git diff -- e2e/` が §0・本タスクで挙げた差分（新規テスト5本の追加を含む）のみであることを確認する
      → `kanban-card-quick-actions.spec.ts` 1ファイルのみ変更（116 insertions, 5 deletions）。他の
      e2e ファイルは無変更

## 7. 仕上げ

- [x] 7.1 `npm test` 全体が緑になることを確認する → 555/555 緑（42 test files）
- [x] 7.2 追加・変更したボタン等にショートカットは割り当てていないため `attachTooltip` は対象外
      （design D4）。念のため `grep -n "attachTooltip" server/static/js/kanban.js` を見て
      既存の付け忘れを増やしていないことだけ確認する
      → `kanban.js` 内の `attachTooltip` 出現数は変更前後とも 0（このファイルはもともと
      ショートカット付き操作を持たない）。付け忘れの増加なし
