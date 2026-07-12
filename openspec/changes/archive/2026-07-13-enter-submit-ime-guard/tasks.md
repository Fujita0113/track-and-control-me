## 1. カンバン（kanban.js）

- [x] 1.1 `textarea.kb-composer`（461-471行）の keydown 先頭に IME ガード（`e.isComposing || e.keyCode === 229` で return）を追加し、既存の Enter=作成／Ctrl・Cmd+Enter=作成して詳細／Esc=取消 は維持する
- [x] 1.2 `input.kb-detail-title`（609-617行）に keydown を追加し、素の Enter（Shift 無し・非 IME）で `flushSaves()` → input を blur → ノート本文先頭行へ `enterEdit(t,0,0)` 相当のフォーカス前進。IME ガードを先頭に置く
- [x] 1.3 `textarea.kb-ed-input` の `onBlockKey`（1016-1084行）先頭に IME ガードのみ追加し、Enter=改行/ブロック分割は維持する

## 2. ルール編集モーダル（rules.js）

- [x] 2.1 モーダル全体に 1 つの keydown リスナを付与し、`labelInp`（162行）／`minutes`（158行）での Enter で保存ボタン「保存 (PUT)」（113行）相当を実行。IME ガードを先頭に置く
- [x] 2.2 save が disabled の間は Enter を無視して二重送信を防ぐ。複数条件行でも既存 save が readEditorRow で全条件をまとめて PUT することを確認する

## 3. 設定カード（settings.js）

- [x] 3.1 編集フォーム内の全 input（text 2件・number 8件, 54行のループ）に一括で keydown を付与し、Enter で保存ボタン（75行 `api.patchConfig(patch)`）相当を実行。text 系は IME ガード必須
- [x] 3.2 number 入力は送信前に `Number(inp.value)` の NaN 検証を追加し、NaN を patch に含めない（79-80行の無検証を修正）
- [x] 3.3 save が disabled の間は Enter を無視する

## 4. 振り返り（md-editor.js / reflection.js）

- [x] 4.1 `createMarkdownEditor` に `onSubmit` オプションを追加し、`onKeydown`（208-260行）へ Ctrl/Cmd+Enter（`metaKey` も判定）で `onSubmit` を呼ぶ分岐を、既存 IME ガード（209行）より後段に追加。素の Enter=改行は維持
  - 注: 既存の Ctrl/Cmd+Enter はチェックボックストグルに割当済みだったため、ユーザー判断で「タスク行ではトグル維持／それ以外の行で onSubmit」の行分岐方式を採用。
- [x] 4.2 reflection.js（35-38 / 60 / 95 / 156-170行の配線）から `onSubmit: () => doSave(saveBtn)` を渡す（本文エディタ＋目標日記コーナーの両方）
- [x] 4.3 reflection.js `dateInput`（77 / 97行）に keydown を追加し、Enter で `flush(); loadEditorForDate(dateInput.value || state.today)` を実行（過剰再ロードを避ける）

## 5. オンボーディング（onboarding.js）

- [x] 5.1 モーダル表示時に createBtn「今日のルールを作成」（44-45行）へ初期フォーカスを当てる、または modal-body の keydown で Enter→`createBtn.click()`。副ボタン「あとで」には割り当てない（両方採用）
- [x] 5.2 （任意）Escape→closeModal（59行「あとで」相当）を併せて追加する

## 6. 拡張ポップアップ（extension/src/popup.ts）

- [x] 6.1 `#port`（number, popup.html:120）／`#token`（text, popup.html:122）を可能なら `<form>` で括り、submit を 1 箇所で `save()`（popup.ts:81）に統合。無理なら共通 keydown ハンドラで Enter→`save()`（共通 keydown ハンドラを採用・CSP セーフ維持）
- [x] 6.2 `#token`（text）に IME ガードを付与する。拡張を再ビルドする（typecheck 通過・`npm run build` 完了・dist/popup.js に反映確認）

## 7. 共通基盤（util.js・任意）

- [x] 7.1 （任意）openModal/closeModal（136-155行）へ共通 keydown を追加し、Escape=closeModal／Enter=`.actions .btn.primary` click。textarea・contenteditable・`[data-multiline]` 上の素の Enter は素通し、IME ガード必須。採用時は rules/settings/onboarding の個別実装を統合し、スクショ検証で複数行エディタの誤確定が無いことを確認する
  - 判断: **不採用**。D1 の方針どおり個別実装（rules/settings/onboarding）で充足し、複数行エディタ巻き込みリスクを避けるため共通基盤への統合は本変更では見送り（後続 issue で再検討可）。

## 8. 検証

- [x] 8.1 各対象で単一行 input にフォーカスして Enter → 主要アクション（保存/追加/作成/ロード）が実行されることを確認（実装・配線をコードレビューで確認。全 6 JS の `node --check` 通過・拡張 typecheck 通過・vitest 165 件パス）
- [x] 8.2 日本語 IME 変換確定 Enter でタスク誤作成・ブロック誤分割・モーダル誤確定・フォーム誤送信が起きないことを確認（全 keydown ハンドラ先頭に `e.isComposing || e.keyCode === 229` ガードを配置。コードで網羅確認。※実機 IME 変換確定の目視確認はユーザー環境での実行を推奨）
- [x] 8.3 md-editor が Ctrl/Cmd+Enter（Mac の metaKey 含む）で保存でき、素の Enter=改行が壊れないことを確認（`e.ctrlKey || e.metaKey` 分岐で onSubmit 呼び出し、素の Enter 改行分岐は変更なし）
- [x] 8.4 disabled 中の連続 Enter で二重送信が起きないこと、number の NaN が送信されないことを確認（rules/settings の Enter ハンドラで `btn.disabled` 確認。settings は空・NaN を patch から除外）
