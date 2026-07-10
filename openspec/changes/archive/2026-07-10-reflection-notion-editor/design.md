## Context

振り返りタブは vanilla-JS ES モジュール SPA（`server/static/`）の 1 タブで、`server/static/js/reflection.js`（現状 123 行）に全 UI がある。現状は textarea＋右側ライブプレビューの 2 ペイン。移植元の設計 `振り返り.dc.html` は claude.ai design のコンポーネント（`<x-dc>`＋`DCLogic`）で、単一 `contenteditable` によるインライン・ライブ Markdown エディタを `<script type="text/x-dc">` の `class Component extends DCLogic` に実装している。

制約:
- **CSP**: `server/src/main.ts` が `style-src 'self'; script-src 'self'` を設定。CDN・外部フォント・インライン `style=` 属性・`<style>` 動的注入は不可。DOM は `util.js` の `h()` ヘルパで構築し、スタイルはクラス＋CSSOM（`element.style.*`）で適用する（既存 kanban/timeline 移植と同じ）。
- **保存とロックの結合**: `server/src/services/planning.ts` は `reflection_entry.content.trim().length > 0` を「振り返り完了」とみなし PLANNING ロック解除に使う。本文の保存形式（Markdown テキスト）を変えると壊れる。
- **共有レンダラ**: `server/static/js/markdown.js` の read-only `renderMarkdown()`（`.md-*` クラス）は kanban のタスクノートでも使われる。触らない。
- 既存慣習: 参照は `ref/<feature>/` へ vendoring、`app.css` に `<prefix>-*` ブロックを配色 hex リテラルで追記、モジュールは `show/hide` エクスポート、タブ配線は `index.html`＋`main.js` に既存。

## Goals / Non-Goals

**Goals:**
- 設計に忠実なインライン・ライブ Markdown エディタへ刷新（配色・レイアウト・タイポグラフィ）。
- 設計に無い **Notion 風キーボード挙動**（リスト継続・空行抜け・コードフェンス自動クローズ・`[ ]` todo・Backspace 1 回削除・チェックボックストグル）を追加。
- IME（日本語）で安全に動作。CSP 適合（クラス＋CSSOM）。
- 過去一覧に抜粋を表示（軽量な API 拡張）。保存は手動＋離脱フラッシュ。
- エディタは再利用可能なモジュールとして切り出す（将来 kanban ノート等でも使える形）。

**Non-Goals:**
- リンク・画像・表・ネスト強調など Markdown フル対応（設計 `inline()` の範囲：見出し/hr/引用/リスト/タスク/太字/斜体/コード/打消のみ）。
- WYSIWYG シリアライズ（本文はあくまで Markdown テキスト）。
- DB スキーマ変更・`packages/contract` 変更（振り返り型は存在しない）。
- IBM Plex フォントの配信（今回は system-ui フォールバック）。
- リアルタイム/デバウンス自動保存（採用は手動＋離脱フラッシュ）。

## Decisions

### D1. エディタを新モジュール `server/static/js/md-editor.js` に切り出す
設計の `DCLogic` サブクラスは「raw テキスト ⇄ キャレットオフセット」モデルで、`getContent`/`getCaret`/`setCaret`/`placeIn`/`render_`/`fmtLine`/`inline` を持つ。これをフレームワーク非依存の factory `createMarkdownEditor({ initial, placeholder, onChange }) → { el, getValue, setValue, focus, isDirty }` として移植する。
- **代替案**: `reflection.js` に直書き。→ 200 行超のキャレット制御が混ざり見通しが悪く、再利用もできないため却下。
- **代替案**: 既存 read-only `markdown.js` を編集可能に拡張。→ read-only 前提（kanban 共用）を壊すリスク。分離が安全。

### D2. innerHTML 文字列ではなく DOM ノード構築（CSP 適合）
設計の `render_()` は `root.innerHTML = html`（インライン style 入り文字列）。CSP でインライン style は無効化されるため、`fmtLine` を `h()` による DOM ノード生成に置換し、`root.replaceChildren(...nodes)` で差し替える。キャレットは既存の `getCaret`→再構築→`setCaret` で復元（このロジックはクラス非依存なので逐語移植可能）。振り返り本文の長さでは input 毎の全再構築で性能十分。
- スタイルはすべて `rf-ed-*` クラス、リストのインデント量など動的値のみ `el.style.paddingLeft` 等 CSSOM で適用。

### D3. Notion 挙動は keydown で raw テキストを変換してから再描画
`contenteditable` の DOM を直接いじらず、「キャレットオフセット → 現在行/桁を特定 → raw 文字列を変換 → 新しいキャレットオフセットを算出 → `setValue` 相当で再描画 → `setCaret`」に統一する。既存の raw/caret モデルに素直に乗るため、DOM 変異と再描画の競合を避けられる。
- Enter/Backspace は `preventDefault` して自前処理。それ以外は既定挿入 → `input` で再描画。
- コードフェンス自動クローズと `[ ]` todo は `input`（または `beforeinput`）で行内容を判定してから raw を変換。
- **代替案**: `document.execCommand`/DOM 直接編集。→ ブラウザ差・IME との相性が悪く、キャレット制御が二重管理になるため却下。

### D4. 気分は 5 段ピル、保存形式は既存 satisfaction 1..5
設計のピル（いまひとつ/まあまあ/ふつう/良い/とても良い）を satisfaction 1..5 にマップ。API・DB は不変。同値クリックで null 解除。

### D5. 一覧 API に excerpt を追加（server のみ）
`server/src/services/reflection.ts` の `ReflectionListItem` に `excerpt: string` を追加。`listReflections` の SELECT に `content` を含め、`content.replace(/[#>*_`~-]/g,'').replace(/\s+/g,' ').trim().slice(0,80)` で excerpt を生成（設計の `save()` と同ロジック）。本文全文はレスポンスに含めない。`packages/contract` に振り返り型は無いため contract 変更不要。
- **代替案**: フロントで各エントリの本文を個別 `GET`。→ N+1 リクエスト。却下。

### D6. 保存は手動＋離脱フラッシュ
手動「保存する」ボタン＋「保存しました」表示。`hide()`・日付切替・過去選択の直前に dirty なら `putReflection` でフラッシュ（kanban の `hide()` フラッシュ踏襲）。デバウンス自動保存は、空⇄非空の頻繁な PLANNING 再評価（`runPipeline`）を避けるため採用しない。

### D7. CSS は `rf-*` ブロックを差し替え、共有 `.md-*` は保持
`app.css` の現行振り返り専用クラス（`.rf-layout`/`.rf-editor`/`.rf-sat*`/`.rf-split*`/`.rf-history*`）と `.md-preview`/`.md-preview-label` を削除し、設計 hex の新 `rf-*`/`rf-ed-*` へ置換。kanban 共用の `.md-body/.md-h/.md-p/.md-list/.md-task-item/.md-quote/.md-pre/.md-code` は残す。

## Risks / Trade-offs

- **[contenteditable のキャレット制御が壊れやすい]** → 設計実績のある `getCaret`/`setCaret`/`placeIn` を逐語移植し、IME は `compositionstart/end` ガードで保護。E2E 検証で Notion 各挙動と日本語入力を手動確認する。
- **[Notion 挙動と再描画の競合（二重挿入・キャレット飛び）]** → すべて raw テキスト変換に一本化（D3）。Enter/Backspace は preventDefault して自前処理し、既定挙動と重複させない。
- **[input 毎の全再構築コスト]** → 振り返り本文は短い前提で許容。将来長文化したら差分再構築へ最適化余地。
- **[配色 hex のベタ書きで DRY 低下]** → 既存 kanban/timeline 移植の確立した慣習に合わせる（`:root` 昇格はしない）。spec に検証可能な hex を明文化し、参照スクショと突合。
- **[フォント差（IBM Plex → system-ui）で設計と微差]** → spec に「フォントのみフォールバック可」と明記。既存慣習どおり許容。

## Migration Plan

1. 参照を `ref/reflection/振り返り.dc.html`（＋`reference.png`）へ vendoring。
2. `md-editor.js` 追加 → `reflection.js` 書換 → `app.css` の `rf-*` 差替 → `reflection.ts` の excerpt 追加。
3. `npm run typecheck` / `npm test`（excerpt 単体テスト追加）通過。
4. `npm run server` で起動し E2E 検証（Notion 挙動・IME・保存/復元・PLANNING シグナル・抜粋一覧・視覚突合）。
- ロールバック: フロント 3 ファイル＋`reflection.ts` の 1 変更を revert すれば旧 UI に戻る。DB/API 契約は不変なので後方互換。

## Open Questions

- 現時点で未解決事項なし（保存挙動・抜粋・フォントはユーザー確認済み）。将来的に IBM Plex のローカル配信を追加するかは別 change とする。
