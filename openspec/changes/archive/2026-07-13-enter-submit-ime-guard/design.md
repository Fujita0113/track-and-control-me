## Context

Enter 確定と IME ガードは複数の独立した UI モジュール（kanban / rules / settings / md-editor / reflection / onboarding / extension popup）にまたがる横断課題。既に Enter を処理している箇所（kanban コンポーザ `kanban.js:461-471`、md-editor `md-editor.js:209` の `composing || e.isComposing` ガード）が参照パターンとして存在するため、これらに揃えて統一する。UI・入力ともに日本語前提で、IME 変換確定 Enter のガードは全対象で必須。空き時間記録ポップオーバー（`memoInp`/`startInp`/`endInp`）は #32 で対応済みのため本変更のスコープ外。

## Goals / Non-Goals

**Goals:**
- 単一行フォームで Enter=主要アクション（保存/追加/作成/ロード）を横断的に実現する
- 全 keydown 先頭に `e.isComposing || e.keyCode === 229` の IME ガードを置き、日本語変換確定 Enter による誤動作を根絶する
- 複数行エディタは Enter=改行を維持し、md-editor は Ctrl/Cmd+Enter 送信を追加する
- disabled 中の二重送信と number の NaN 送信を防ぐ

**Non-Goals:**
- 空き時間記録ポップオーバー（#32 で対応済み）
- 破壊的画面遷移（振り返り planBtn）や副ボタン（「あとで」）への Enter 割り当て
- キーボードショートカット全般の再設計（本変更は Enter/Ctrl・Cmd+Enter/Esc に限定）

## Decisions

### D1: 各モジュール個別実装を基本とし、util.js 共通基盤は任意扱い

各画面（rules/settings/onboarding）は担当・DOM 構造が異なるため、まず個別に keydown を付与する方針を基本とする。issue で最もレバレッジが高いとされる `util.js` の openModal/closeModal 共通基盤（Escape=closeModal、Enter=`.actions .btn.primary` click、textarea/contenteditable/`[data-multiline]` 素通し）は、複数行エディタを巻き込むリスクがあり横断調整が必要なため、本変更では**任意（採否は実装時に判断）**とする。採用する場合は IME ガードと Enter=改行分岐を必須とし、rules/settings/onboarding の個別実装を統合する。
- 代替案: 最初から util.js 共通化 → 複数行エディタ誤確定リスクが高く、段階導入の方が安全と判断。

### D2: IME ガードは全 keydown ハンドラ先頭に統一配置

`if (e.isComposing || e.keyCode === 229) return;` をハンドラ最先頭に置く。md-editor の Ctrl/Cmd+Enter 送信分岐は既存 IME ガード（209行）より**後段**に配置し、変換確定 Enter が送信を誘発しないようにする。
- 代替案: `compositionstart/end` フラグ管理 → `isComposing` で足りるため過剰。ただし md-editor は既存の `composing` フラグを併用しており既存踏襲。

### D3: md-editor の送信は `onSubmit` オプション注入で疎結合化

`createMarkdownEditor` に `onSubmit` オプションを追加し、reflection.js から `onSubmit: () => doSave(saveBtn)` を渡す。エディタ本体は保存処理の詳細（api.putReflection / markSaved / showSaved）を知らずに Ctrl/Cmd+Enter → onSubmit を呼ぶだけにする。
- 代替案: エディタ内に保存処理を直書き → reflection.js との結合が強くなり再利用性が下がる。

### D4: 単一行 Enter は「主要ボタンを探して click」ではなく既存アクション関数を直接呼ぶ

rules/settings では既存の save 処理関数を Enter から直接呼び、disabled ガードはボタンの `disabled` プロパティ確認で行う。onboarding は createBtn への初期フォーカス＋Enter→`createBtn.click()` を採用（ネイティブ button のデフォルト Enter 挙動も活用）。

## Risks / Trade-offs

- [util.js 共通化を採用した場合に複数行エディタを誤確定] → IME ガード＋textarea/contenteditable/`[data-multiline]` 上の素の Enter 素通し分岐を必須とし、採用可否は実装時にスクショ検証で確認。
- [change と loadEditorForDate の二重発火（reflection dateInput）] → `loadEditorForDate` は冪等のため実害小。過剰再ロードを避けるため flush 後に一度だけ呼ぶ。
- [number の NaN 送信で設定破壊] → 送信前 `Number(inp.value)` 検証を必須化し、NaN は patch から除外。
- [disabled ボタン中の連続 Enter で二重送信] → Enter ハンドラで `btn.disabled` を確認して無視。

## Migration Plan

デプロイは静的 JS / 拡張ビルドの差し替えのみでデータ移行なし。各対象箇所を独立してコミット可能。ロールバックは該当 JS の revert で完結。拡張（popup.ts）は再ビルドが必要。

## Open Questions

- util.js 共通基盤を本変更で採用するか、後続 issue に切り出すか（実装時にスクショ検証で判断）。
- onboarding の Escape=closeModal（「あとで」相当）を併せて入れるか（任意・impact low）。
