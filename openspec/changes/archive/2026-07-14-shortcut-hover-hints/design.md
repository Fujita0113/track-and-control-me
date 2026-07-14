## Context

フロントは `server/static/js` のバニラ ES モジュール。画面切替はタブの click ハンドラ（`main.js` の `activate(name)`）で行い、モーダルは `util.js` の `openModal`/`closeModal`。既存のキー操作は各所にローカルに散在する:

- `md-editor.js`: `Ctrl/Cmd+Enter` で `onSubmit`（＝保存）。`Ctrl+B/I/E/Z/Y`・`Alt+↑↓` 等の編集操作。
- `reflection.js`: エディタの `onSubmit` 経由で `Ctrl/Cmd+Enter` 保存。
- `settings.js` / `rules.js`: 単一行 input での**素の Enter** が保存ボタンを click（`enterToSave`／IME 変換確定はスキップ・disabled 中は無視）。
- モーダルは backdrop クリックで閉じる。`onboarding.js` と `reflection.js` の一部が個別に Esc を処理するのみで、**グローバルな Esc 閉じは無い**。
- タブは click のみ。数字キー切替は無い。
- ショートカットを UI 上に提示する仕組みは存在しない（`title` すら無い）。

制約: サーバ／API／DB は変更しない。フロントのみ。既存の `enter-submit-ime-guard`（素の Enter 送信）は壊さない。

## Goals / Non-Goals

**Goals:**
- 保存 `Ctrl/Cmd+Enter`・閉じる `Esc`・タブ切替 数字キー `1`〜`6` を実装し挙動を揃える。
- ショートカット付きボタン（保存・モーダル閉じる・タブ）にホバー／フォーカスでカスタムツールチップ（`kbd` チップ）を出す。
- 再利用可能な最小ヘルパー（`attachTooltip` と共通キーハンドラ）に集約し、各画面が同じ書き方で使えるようにする。

**Non-Goals:**
- issue #35 の「全画面ショートカット網羅ヘルプ画面／ヘルプボタン」は作らない。
- md エディタ既存操作（`Ctrl+B/I/E` 等）への新規ヒント付与や、新しい編集ショートカットの追加はしない。
- ショートカットのユーザーカスタマイズ、`title` 属性方式は採用しない。

## Decisions

### D1: カスタムツールチップ `attachTooltip(el, { label, keys })` を `util.js` に新設
- `keys` は `['Ctrl','Enter']` のような配列。表示時に各キーを `<kbd>` として描画し、`label`（例:「保存」）を添える。
- トリガは `mouseenter`/`focus` で表示、`mouseleave`/`blur`/`Esc` で非表示。単一のツールチップ DOM を body 直下に使い回し、対象要素の矩形（`getBoundingClientRect`）で配置する。
- **`title` を使わない理由**: 表示まで ~1 秒の遅延・見た目を制御できず `kbd` チップにできない。ユーザー要望（保存ボタンにホバーで綺麗に出る）を満たせない。
- キー表記はプラットフォーム非依存に `Ctrl`/`Cmd` を出し分け（`navigator.platform` で mac 判定、無ければ `Ctrl`）。アクセシビリティのため対象要素に `aria-keyshortcuts` も付与する。

### D2: 保存 `Ctrl/Cmd+Enter` は「保存ボタンを click する」形に統一
- 既に持つ `md-editor.js`／`reflection.js` はそのまま（挙動維持、ヒント付与のみ）。
- `settings.js`・`rules.js`・`goals.js` の保存ボタンに、フォーム root への keydown で `Ctrl/Cmd+Enter → saveBtn.click()` を追加。`enterToSave` と同じガード（IME 変換確定スキップ・`disabled` 中は無視）を共通化した小ヘルパー `ctrlEnterToSave(root, saveBtn)` を `util.js` に置く。
- **代替**: 各ボタンへ直接ロジックを書く案は重複が増えるため不採用。既存 `enterToSave` は素の Enter 用途が別（単一行 input 限定）なので残し、Ctrl+Enter 用は別関数にする。

### D3: グローバルキーは `main.js` に 1 つの `document` keydown ハンドラで集約
- `Esc`: モーダルが開いていれば（`#modal-root.open`）`closeModal()`。それ以外は無反応。
- 数字 `1`〜`6`: `Ctrl/Cmd/Alt/Shift` 修飾なし かつ **入力中でない**場合のみ、対応する `.tab` を `activate`。
- 入力中判定は共通ヘルパー `isTypingTarget(e)`（`document.activeElement` が input/textarea/`isContentEditable`、または `e.isComposing`/`keyCode===229`）で行う。
- 保存 `Ctrl+Enter` はフォーム root ローカルに閉じる（D2）ので、このグローバルハンドラでは扱わない（保存対象の取り違えを防ぐ）。

### D4: ヒント付与箇所
- タブ: `main.js` の `bootNav` で各 `.tab` に `attachTooltip(btn,{label:btn.textContent, keys:[String(i+1)]})`。
- モーダル閉じる: `openModal` の「✕」ボタンに `attachTooltip(closeBtn,{label:'閉じる', keys:['Esc']})`。
- 保存ボタン: 各画面で保存ボタン生成箇所に `attachTooltip(saveBtn,{label:'保存', keys:['Ctrl','Enter']})`。

## Risks / Trade-offs

- [数字キーが誤爆する（例: 目標名に数字を打ちたい）] → `isTypingTarget` で入力フォーカス中は必ずスキップ。contenteditable な md エディタも対象に含める。
- [ツールチップの配置がスクロール／画面端で崩れる] → 表示直前に矩形を再計算し、画面端では上下反転・はみ出しクランプする。
- [`Esc` が既存のローカル Esc 処理（onboarding 等）と二重発火] → グローバルは「モーダルが開いていれば閉じる」だけに限定。ローカル側が既に閉じていれば `#modal-root.open` が無くグローバルは無反応になり競合しない。
- [`navigator.platform` の非推奨] → 取得失敗時は `Ctrl` にフォールバック（表記だけの問題で機能に影響しない）。

## Migration Plan

- 追加のみで破壊的変更なし。フロント静的ファイルの差し替えで反映。ロールバックはファイルを戻すだけ。

## Open Questions

- なし（スコープ・トリガキー・見た目はユーザー確認済み: ホバーヒントのみ／カスタムツールチップ／保存 Ctrl+Enter・閉じる Esc・タブ切替数字キー）。
