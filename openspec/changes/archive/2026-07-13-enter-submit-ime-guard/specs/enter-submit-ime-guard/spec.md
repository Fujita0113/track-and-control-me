## ADDED Requirements

### Requirement: IME 変換確定 Enter のガード

キーボード Enter を処理する全ての keydown ハンドラは、ハンドラ先頭で IME 変換中の Enter を無視 SHALL する。判定は `e.isComposing || e.keyCode === 229` を用い、真の場合は確定・送信・改行分割いずれも実行せず即 return する。

#### Scenario: 日本語変換確定 Enter で誤動作しない

- **WHEN** ユーザーが日本語入力中に IME 変換候補を確定するための Enter を押す（`e.isComposing === true`）
- **THEN** そのフォーム／エディタは保存・追加・作成・ブロック分割・モーダル確定のいずれも実行せず、変換確定のみが行われる

#### Scenario: 確定後の素の Enter は通常どおり処理される

- **WHEN** IME 変換が確定済みの状態（`e.isComposing === false` かつ `e.keyCode !== 229`）でユーザーが Enter を押す
- **THEN** そのハンドラの通常の Enter 処理（確定・送信・改行等）が実行される

### Requirement: 単一行フォームの Enter による主要アクション実行

単一行 input（text / number / date）にフォーカスがある状態で素の Enter（Shift なし・非 IME）を押したとき、システムはその画面の主要ボタン相当のアクション（保存 / 追加 / 作成 / ロード）を実行 SHALL する。Enter は主要（前進）ボタンにのみ割り当て、副ボタン（キャンセル・「あとで」等）や破壊的画面遷移ボタンには割り当てない。

#### Scenario: ルール編集モーダルの入力で保存

- **WHEN** ルール編集モーダルの `labelInp`（チェック項目名）または `minutes`（しきい値・分）にフォーカスがある状態で Enter を押す
- **THEN** 保存ボタン（PUT）相当の処理が実行され、全条件行が readEditorRow でまとめて保存される

#### Scenario: 設定カードの入力で保存

- **WHEN** 設定「設定の編集」カードの text／number 入力のいずれかにフォーカスがある状態で Enter を押す
- **THEN** 保存ボタン（patchConfig）相当の処理が実行される

#### Scenario: 振り返り日付ピッカーでロード

- **WHEN** 振り返りの `dateInput`（日付）にフォーカスがある状態で Enter を押す
- **THEN** 現在編集内容を flush した上で選択日のエディタがロードされる

#### Scenario: 拡張ポップアップの設定で保存して再接続

- **WHEN** 拡張ポップアップの `#port`（number）または `#token`（text）にフォーカスがある状態で Enter を押す
- **THEN** `save()`（保存して再接続）が実行される

#### Scenario: 副ボタン・破壊的遷移には割り当てない

- **WHEN** オンボーディングの「あとで」や振り返りの「明日の計画へ」など副ボタン／破壊的遷移が主要アクションでない画面で Enter を押す
- **THEN** 副ボタンや画面遷移は Enter で発火せず、主要（前進）ボタンのみが対象となる

### Requirement: 複数行エディタの Enter=改行維持と Ctrl/Cmd+Enter 送信

複数行エディタ（md-editor.js の contenteditable ライブ Markdown、kanban.js の `kb-ed-input` ノート本文ブロック）では素の Enter=改行/ブロック分割を維持 SHALL し、送信/確定に奪ってはならない。md-editor.js は **Ctrl/Cmd+Enter で保存**を実行 SHALL する（Mac の `metaKey` も判定）。この送信分岐は既存 IME ガードより後段に置く。

#### Scenario: 素の Enter は改行のまま

- **WHEN** md-editor.js の contenteditable または kanban.js の `kb-ed-input` で素の Enter を押す
- **THEN** 改行またはブロック分割が行われ、保存・送信は実行されない

#### Scenario: Ctrl/Cmd+Enter で振り返りを保存

- **WHEN** md-editor.js のエディタで Ctrl+Enter または Cmd+Enter を押す
- **THEN** `onSubmit`（doSave → putReflection → markSaved → showSaved）が実行される

### Requirement: disabled ボタン中の二重送信防止

非同期処理中に `disabled` になる主要ボタン（rules.js／settings.js の save）に対しては、Enter によるアクション実行時にボタンの disabled 状態を確認 SHALL し、disabled の場合は Enter を無視して二重送信を防ぐ。

#### Scenario: 送信処理中の連続 Enter を無視

- **WHEN** 保存処理が進行中で主要ボタンが disabled の状態でユーザーが再度 Enter を押す
- **THEN** アクションは再実行されず、二重送信は発生しない

### Requirement: number 入力の NaN 検証

number 入力を Enter で送信する際、システムは送信前に `Number(inp.value)` が NaN でないことを検証 SHALL し、NaN の値をサーバへ送信してはならない。

#### Scenario: 空・非数値の number 入力を送信しない

- **WHEN** settings.js の number 入力が空または非数値のまま Enter を押す
- **THEN** その値は patch に含めず送信せず、NaN がサーバへ渡らない
