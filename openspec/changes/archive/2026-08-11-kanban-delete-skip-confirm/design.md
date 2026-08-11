## Context

`kanban-card-quick-delete` は実装済み（`kanban.js:645` `deleteTaskWithConfirm(t)`）。3経路（ゴミ箱アイコン `kanban.js:711-714`／右クリック `kanban.js:678-682`／詳細パネルの削除ボタン `kanban.js:1428-1432`）すべてが同じ関数を呼び、内部で `window.confirm('このタスクを削除しますか?')` を挟んでから Optimistic UI で削除する。

`window.confirm()` はブラウザ標準ダイアログで、チェックボックスのような追加 UI を持てない。「次回から確認しない」を持たせるには、少なくともゴミ箱アイコン起点だけはカスタム UI に置き換える必要がある。

このアプリには非ネイティブの削除確認 UI の前例が既にある（`timeline.js:714-762` `autoDeleteSection` の `.tlc-pop-delete-confirm`）。また汎用モーダルの土台は `util.js:150` `openModal(contentNode, title)` / `closeModal()` で、`#modal-root` はどの画面構成でも存在するため、埋め込み盤面（`tomorrow-plan.js` からの `asideHost` マウント）でも使える。

## Goals / Non-Goals

**Goals:**

- ゴミ箱アイコンからの削除に「次回から確認しない」チェックボックスを持たせる
- チェックして削除した以降は、ゴミ箱アイコンからの削除確認自体を省略する
- 右クリック・詳細パネルの削除確認は一切変えない（挙動もダイアログの種類も）

**Non-Goals:**

- 「次回から確認しない」を取り消すための設定 UI（今回は無し。取り消したい場合はブラウザの localStorage を消す以外に手段が無いことを Open Questions に明記する）
- 右クリック・詳細パネルへの省略効果の拡張
- サーバー側の永続化（デバイス間で共有する必要は無い、既存の `SOUND_KEY`/`TOMORROW_KEY` と同じ localStorage 限定の設定）

## Decisions

### D1. 起点ごとの分岐を純関数に切り出す（`computeDue` と同じ流儀）

```js
export function shouldSkipDeleteConfirm(source, skipPref) {
  return source === 'trash' && !!skipPref;
}
```

`deleteTaskWithConfirm(t, source)` の `source` は `'trash' | 'contextmenu' | 'detail'`。判定を純関数に切り出すことで、DOM・localStorage 非依存のまま vitest で直接検証できる（`kanban-dedupe.test.ts` が `dedupeGroups` を直接importして検証しているのと同じ形）。

- **なぜ純関数に分けるか**: `source === 'trash'` という条件をインライン if にすると vitest から検証できるのは統合された関数呼び出し全体になり、DOM/localStorage のモックが要る。決定ロジックだけを外に出せば、`kanban-dedupe.test.ts` と同じ書き方で素の入出力を検証できる。

### D2. ゴミ箱アイコンのみカスタム確認モーダルに差し替える。右クリック・詳細パネルは `window.confirm()` のまま

3経路の分岐は `deleteTaskWithConfirm` の先頭で行う:

```js
async function deleteTaskWithConfirm(t, source) {
  if (shouldSkipDeleteConfirm(source, deleteConfirmSkipEnabled())) {
    await execDelete(t);
    return;
  }
  if (source === 'trash') {
    openDeleteConfirmModal(t); // チェックボックス付きカスタムモーダル。確定時に execDelete(t) を呼ぶ
    return;
  }
  if (!confirm('このタスクを削除しますか?')) return;
  await execDelete(t);
}
```

`execDelete(t)` は現行の `deleteTaskWithConfirm` 本体（Optimistic UI での削除・ロールバック）をそのまま抜き出したもの。3経路とも最終的にはこの同じ関数を呼ぶため、削除そのものの挙動（即座にボードから消える・失敗時にロールバックする）は経路によらず変わらない。

- **なぜ右クリック・詳細パネルを変えないか**: issue #95 の懸念どおり、右クリックは「うっかり触れただけで確認なしに消える」事故が起きやすい経路。省略の効果をゴミ箱アイコンだけに閉じることで、意図的に一度チェックを入れた操作（ゴミ箱アイコンをクリックする、という明示操作）だけが省略対象になる。
- **代替案（3経路とも同じカスタムモーダルに統一する）を採らない理由**: 実装は単純になるが、右クリックでの誤操作から確認を守るという issue の要求そのものに反する。また既存 e2e（右クリック1本）が無変更で済む利点も失う。

### D3. スキップ設定は localStorage、日付スコープなし

```js
const SKIP_DELETE_CONFIRM_KEY = 'tcm_kanban_skip_delete_confirm';
function deleteConfirmSkipEnabled() {
  return localStorage.getItem(SKIP_DELETE_CONFIRM_KEY) === '1';
}
function setDeleteConfirmSkip(on) {
  localStorage.setItem(SKIP_DELETE_CONFIRM_KEY, on ? '1' : '0');
}
```

`TOMORROW_KEY`/`CATEGORIZE_KEY` と違い「今日だけ ON」ではなく「次回から先ずっと」なので、日付キー付きJSONではなく `SOUND_KEY` と同じ単純な文字列フラグにする。

### D4. カスタム確認モーダルの構成

`openModal(body, 'タスクを削除')` で表示する。body は:

- 説明文（既存の confirm 文言を踏襲: 「このタスクを削除しますか?」）
- チェックボックス1つ + ラベル「次回から確認しない（ゴミ箱アイコンのみ）」（`settings.js:69` の `h('label', { class: 'inline' }, chk, text)` と同じ形）
- フッター: 「キャンセル」（`btn`）／「削除」（`btn small danger`。既存の `goals.js:291` 削除ボタンと同じクラス）

「削除」押下時、チェック ON なら `setDeleteConfirmSkip(true)` を呼んでから `execDelete(t)`。OFF なら `execDelete(t)` のみ。どちらもモーダルは `closeModal()` で閉じる。「キャンセル」・Escape・背景クリックは何もせず閉じる（`openModal` が既に持つ挙動）。

Ctrl+Enter 等のショートカットはここでは割り当てない(破壊的操作をキー一発で確定させない)。ボタンにショートカットが無いので `attachTooltip` の対象は無し(プロジェクトルールの「ショートカット操作の追加時」に該当しない)。

### D5. リバーシビリティは今回スコープ外

issue が要求しているのは「次回から聞かない」チェックボックスのみ。取り消し導線（設定ポップオーバーへのトグル追加など）は issue に無い機能追加であり、CLAUDE.md の「タスクが要求する以上の機能を足さない」に従い今回は入れない。Open Questions に、必要になったら別 issue として扱う旨を記す。

## Risks / Trade-offs

- [新しいモーダルが `e2e/kanban-card-quick-actions.spec.ts` のゴミ箱アイコン系3本 (`page.once('dialog', ...)` 前提) を壊す] → この propose の段階で当該3本を直す（詳細は下記）。カスタムモーダルの具体的な DOM (クラス名等) は apply が実装しながら決めるため、既存 e2e の修正では**新モーダルの DOM には依存しない形**に留める:
  - 「ゴミ箱アイコンから削除する→確認して消える」→ スキップ設定が事前に ON の状態（`localStorage` は D3 で決めた契約なのでpropose時点で確定済み）でゴミ箱アイコンをクリックし、ダイアログなしで即削除されることを検証する形に書き換える。
  - 「確認をキャンセルすると削除されない」→ トリガーを右クリックに変更（`window.confirm()` のまま変わらない経路）。
  - 「削除は即座にボードから消える（Optimistic UI）が、失敗時は復元される」→ 同じくトリガーを右クリックに変更（`execDelete` は経路によらず共通なので、右クリック経由でも同じ回帰を検知できる）。
  - 「カードを右クリックして削除する→確認して消える」は無変更。
- [カスタムモーダル自体（チェックボックスの表示・チェックして削除→以後省略・チェックせず削除→次回も確認・キャンセル/Escで何もしない）の新規 e2e は、DOM が実装まで決まらないため propose では書けない] → apply が最後にフローとして新規 e2e を書く（tasks.md に記載）。
- [`localStorage` はブラウザ・プロファイル単位。複数デバイスで確認省略の状態がずれる] → 許容する。`SOUND_KEY` 等の既存設定と同じ扱いで、サーバー同期は元々していない。

## Migration Plan

DB マイグレーション無し。クライアント限定の変更で、既存ユーザーの `localStorage` には `tcm_kanban_skip_delete_confirm` が存在しないため `deleteConfirmSkipEnabled()` は false 相当（`localStorage.getItem` が null → `=== '1'` は false）で、導入直後は従来どおり確認が出る。

## Open Questions

- 「次回から確認しない」を取り消す導線が将来欲しくなった場合、設定ポップオーバー（`kanban.js:432` `kb-set-pop`）に `サウンド` と同じ形でトグルを足すのが自然。今回は入れない。
