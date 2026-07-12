## Why

アプリ内の多くの単一行フォーム（ルール編集モーダル・設定カード・拡張ポップアップ・オンボーディング等）は `<form>` も keydown ハンドラも持たないため、テキスト入力後に Enter を押しても no-op で、確定・保存に毎回マウス操作が必要になっている。一方、既に Enter を処理しているカンバン新規タスクコンポーザ／ノート本文ブロックは IME 変換確定 Enter をガードしておらず、日本語入力の変換確定で誤作成・誤分割が起きる。UI・入力ともに日本語前提のため、Enter 確定と IME ガードを横断的に整備する。

## What Changes

- 単一行 input／number 入力で Enter を押すと、その画面の主要ボタン相当のアクション（保存 / 追加 / 作成 / ロード）を実行する（対象: ルール編集モーダル、設定カード、振り返り日付ピッカー、拡張ポップアップ、オンボーディング）。
- 複数行エディタ（md-editor.js の contenteditable、kanban.js の `kb-ed-input`）は素の Enter=改行/ブロック分割を維持し、md-editor.js のみ **Ctrl/Cmd+Enter で保存**（`createMarkdownEditor` に `onSubmit` オプションを追加）。
- 全対象の keydown 先頭に **IME 変換確定ガード**（`e.isComposing || e.keyCode === 229` を無視）を追加し、既存の Enter 処理箇所（kanban コンポーザ／ノートブロック）も IME 安全化する。
- 非同期処理中に `disabled` になるボタン（rules/settings の save）は disabled 時に Enter を無視して二重送信を防ぐ。
- settings.js の number 入力は Enter 送信前に `Number(inp.value)` の NaN 検証を追加する。
- スコープ外: 空き時間記録ポップオーバー（`memoInp`/`startInp`/`endInp`）は #32 で対応済みのため本変更の対象外。破壊的画面遷移（振り返りの planBtn）・副ボタン（「あとで」等）には Enter を割り当てない。

## Capabilities

### New Capabilities
- `enter-submit-ime-guard`: 単一行フォームの Enter 確定・複数行エディタの Ctrl/Cmd+Enter 送信・全 keydown 先頭の IME 変換確定ガード・disabled 中の二重送信防止という、キーボード確定操作の横断的な挙動要件を定義する。

### Modified Capabilities
<!-- 既存 spec の要件変更なし。各画面の spec は個別機能の要件であり、本変更はキーボード確定という横断的な新要件のため新規 capability として定義する。 -->

## Impact

- `server/static/js/kanban.js`: `kb-composer`（IME ガード追加）、`kb-detail-title`（Enter でフォーカス前進）、`kb-ed-input`（IME ガード追加）
- `server/static/js/rules.js`: モーダル全体に keydown を付与し `labelInp`／`minutes` の Enter で save（PUT）
- `server/static/js/settings.js`: 編集フォーム input 一括 keydown、Enter で patchConfig、number の NaN 検証
- `server/static/js/md-editor.js`: `onKeydown` に Ctrl/Cmd+Enter 分岐、`createMarkdownEditor` に `onSubmit` オプション追加
- `server/static/js/reflection.js`: `dateInput` の Enter でロード、`onSubmit: () => doSave(saveBtn)` を配線
- `server/static/js/onboarding.js`: createBtn への初期フォーカス／Enter で前進
- `server/static/js/util.js`（任意）: openModal/closeModal 共通 keydown 基盤（採否は横断調整）
- `extension/src/popup.ts`: `#port`／`#token` の Enter で `save()`（可能なら `<form>` submit へ統合）
- 依存追加なし。既存の参照パターン（`md-editor.js:209` の IME ガード、`kanban.js:461-464` の Ctrl/Cmd+Enter）に揃える。
