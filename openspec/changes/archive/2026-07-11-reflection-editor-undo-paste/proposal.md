## Why

振り返りタブのインライン・ライブ Markdown エディタ（`md-editor.js`）は、入力のたびに `editor.replaceChildren(...)` でブロック DOM を丸ごと再構築するため、ブラウザ標準の Undo 履歴が毎回破棄される。結果として **Ctrl+Z で元に戻せない**（issue #6）。同じ理由で **複数行 Markdown の貼り付けも壊れる**：paste ハンドラが無く、既定のリッチ貼り付けが `<div>`/`<br>`/スタイル付きノードを注入して「1 行 = 1 ブロック div」のモデルを崩し、Notion では 4 行になる箇条書きが本アプリでは 1 かたまりに潰れる。

Undo/Redo と paste を入れる時点で `onKeydown` に「Ctrl 修飾ディスパッチ」を敷き、`setRawAndCaret` を undo 履歴のコミット境界として結線し、選択範囲のグローバルオフセットを算出する必要が生じる。**同じ関数・同じ配線に相乗りするキーボード/クリップボード操作は、この一度きりの改修に畳み込むのが合理的**である。後回しにすると `onKeydown` と `commitHistory` の結線を開き直して再導出する羽目になり、漏らすと「その操作だけ Undo できない」不整合を生む。加えて調査で **2 件のサイレントなデータ欠損バグ**（Shift+Enter の行融合、IME 変換中 `getValue` の旧値返却）を発見しており、いずれも同じコードに 1〜数行で同居できるため本 change で塞ぐ。

夜の振り返りリチュアルで日常的に触る画面であり、取り消し・貼り付け・並べ替え・装飾はいずれも基本操作なので価値が高い。

## What Changes

**アンカー（issue #6）**
- **Undo/Redo 履歴スタック**（raw + キャレットのスナップショット）を実装し `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` を配線。連続入力はコアレスし、構造変化はコミット境界にする。
- **paste ハンドラ**：`preventDefault` + `text/plain` を改行正規化してキャレット位置（選択があれば置換）に差し込み、再描画・キャレット再設定する。

**同梱する同一コードの操作（Tier A）**
- **Shift+Enter の素の改行化（バグ修正）**：Enter ハンドラを `e.key==='Enter'` に広げ、shift 時はマーカーを継続しない素の改行を挿入。既定 `<br>` 挿入による**行融合＝データ欠損**を止める。
- **IME 変換中の `getValue` 整合（バグ修正）**：`getValue` を `() => composing ? getContent(editor) : raw` に変更し、変換確定前の保存で最終行の未確定文字が欠落しないようにする。
- **行移動 Alt+↑/↓**：現在行を上下の行と入れ替える。
- **リストのインデント/アウトデント Tab / Shift+Tab**：行頭の 2 スペース単位を増減してネストを作る（描画側は既にネスト段差を持つ）。
- **選択テキストの装飾ラップ Ctrl+B / Ctrl+I / Ctrl+E**：選択を `**`/`*`/`` ` `` で囲む・解除。`execCommand` による `<b>`/span 注入を横取りして防ぐ。
- **キーボードでのチェックボックス切替 Ctrl/Cmd+Enter**：タスク行の `[ ]`⇄`[x]` を長さ不変でトグル。
- **モデル経由の切り取り cut**：選択 raw を `text/plain` に書き出し raw から除去。ブロック跨ぎの構造破壊と undo 非対応を回避。

**issue #6 追加コメントで判明した 2 件の追随修正（同一 paste/描画コードに同居）**
- **構造付き HTML 貼り付けの Markdown 化**：Notion 等からコピーした箇条書き/チェックリスト/見出し/引用は `text/plain` にマーカーが乗らず素の段落に潰れていた。`paste` を「構造タグを含む `text/html` を DOMParser で解析→`- `/`N. `/`- [ ] `/`# `/`> ` へ変換して取り込み、無ければ `text/plain` にフォールバック」へ拡張する（タグ駆動・クラス非依存）。D6 の paste 経路に閉じる。
- **タスクチェックボックスの Notion 風表示**：生の `[ ]`/`[x]`・先頭 `- ` を textContent に保持したまま CSS のみで視覚差し替えし、角丸チェックボックス（未=枠線／済=塗り＋チェック、済行は取り消し線）にする。raw/offset モデルは不変。

## Capabilities

### New Capabilities
<!-- なし。既存 reflection-journal エディタへの要件追加 -->

### Modified Capabilities
- `reflection-journal`: エディタに「Undo/Redo」「プレーンテキスト貼り付け」「Shift+Enter の素の改行」「行移動」「リストのインデント/アウトデント」「選択の装飾ラップ」「キーボードのチェック切替」「モデル経由 cut」「IME 変換中の getValue 整合」、および issue #6 追加コメント由来の「構造付き HTML 貼り付けの Markdown 化」「タスクチェックボックスの Notion 風表示」の各要件を追加する。既存の保存・気分・過去一覧・視覚的忠実性の要件は変更しない。

## Impact

- コード: `server/static/js/md-editor.js`（履歴スタック・選択オフセット/選択再設定の共有ヘルパ・`onKeydown` 分岐・`paste`/`cut` リスナ・`getValue` 1 行・`htmlToMarkdown` 変換器）と `server/static/css/app.css`（Notion 風チェックボックスの視覚差し替え）に閉じる。公開 API（`el`/`getValue`/`setValue`/`focus`/`isDirty`/`markSaved`）と `reflection.js` は変更しない。
- スタイル/CSP: チェックボックスは既存 `app.css`（`style-src 'self'`）へのクラス方式追加で、`::before`/`::after` の回転ボーダーで描画（画像 URL 非依存）。paste の HTML 解析は `DOMParser` の detached document を読むのみで live DOM へ注入しない。いずれも CSP に適合。
- API・DB・依存: 変更なし。保存フォーマット（`reflection_entry.content` の Markdown 意味）も不変。
- スコープ外（本 change では扱わず fast-follow/later）: 引用 Enter 継続・番号リスト自動振り直し・`[text](url)` 描画・Ctrl+K/URL スマート貼り付け・ブロック種別変換ショートカット・プレーンテキストの glyph/タブ正規化（HTML 構造の Markdown 化は本 change に取り込み済み）・空行プレースホルダ・slash メニュー・ドラッグ&ドロップ・a11y。
