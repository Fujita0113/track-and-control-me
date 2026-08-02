## ADDED Requirements

### Requirement: 「目標を終える」モーダルは Ctrl/Cmd+Enter で保存できる

「目標を終える」モーダルは、フォームの任意の位置で Ctrl+Enter（Mac は Cmd+Enter）を押すと「この目標を終える」ボタン相当のアクションを実行 SHALL する。IME 変換確定 Enter はスキップ SHALL し、ボタンが disabled 中は二重送信しない SHALL。

#### Scenario: Ctrl+Enter で目標終了を確定できる

- **WHEN** 「目標を終える」モーダルが開いた状態で、理由 textarea などフォーム内の要素にフォーカスがある状態で Ctrl+Enter を押す
- **THEN** 「この目標を終える」ボタン相当の保存処理が実行される（理由が空なら toast エラーが出てキャンセルされる）

#### Scenario: ボタン disabled 中の Ctrl+Enter は無視される

- **WHEN** 保存処理が進行中で「この目標を終える」ボタンが disabled の状態で Ctrl+Enter を押す
- **THEN** 二重送信は発生しない
