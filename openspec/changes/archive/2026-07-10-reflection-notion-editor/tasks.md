## 1. 参照 vendoring

- [x] 1.1 `ref/reflection/` を作成し、DesignSync `get_file`（project `1f2589fa-…`）で `振り返り.dc.html` を保存する
- [x] 1.2 参照のレンダリング/スクショを `ref/reflection/reference.webp` として保存する（設計の `.thumbnail` を採用。視覚突合用）

## 2. エディタコア（server/static/js/md-editor.js 新規）

- [x] 2.1 factory `createMarkdownEditor({ initial, placeholder, onChange }) → { el, getValue, setValue, focus, isDirty }` の骨組みを作る
- [x] 2.2 raw/caret モデルを移植: `getContent`/`getCaret`/`setCaret`/`placeIn`（設計から逐語移植）
- [x] 2.3 `render_()` を DOM ノード構築へ移植（`h()` で生成し `replaceChildren`、キャレット復元、CSP 適合。innerHTML 文字列は使わない）
- [x] 2.4 `fmtLine`/`inline` をクラスベースで実装: 見出し `rf-ed-h1..h6`・hr・引用・リスト（インデントは CSSOM）・タスク・段落、装飾 `rf-ed-marker/strong/em/code/strike`
- [x] 2.5 IME ガード（`compositionstart`/`compositionend`）と `input` ハンドラを実装
- [x] 2.6 プレースホルダ表示制御と文字数カウント（空白除外）を実装

## 3. Notion 風キーボード挙動（md-editor.js）

- [x] 3.1 Enter: リスト継続（`-`/`*`/`+`/`1.`/`- [ ]`、番号は +1）。行末で同マーカーの新行を挿入しキャレット配置
- [x] 3.2 Enter: 空マーカー行はマーカーを除去して空段落化（新箇条を足さない）
- [x] 3.3 コードフェンス自動クローズ: 行が ```` ``` ````（言語可）になったら下に閉じ ```` ``` ```` を挿入、間の空行にキャレット
- [x] 3.4 todo ショートハンド: 行頭（または `- ` 直後）の `[ ]`/`[]`＋スペースで `- [ ] ` に変換
- [x] 3.5 スマート Backspace: 空リスト/todo 項目でマーカー接頭辞ごと 1 回削除（前行結合しない）
- [x] 3.6 チェックボックスクリックで raw の `[ ]`⇄`[x]` トグル＋再描画

## 4. 振り返り画面（server/static/js/reflection.js 書換）

- [x] 4.1 `show(root)`: `body.rf-page` 付与、タイトル／気分ピル／エディタカード（`md-editor` 埋込・下部クローム）／右レール（対象日・過去一覧）を構築
- [x] 4.2 5 段気分ピル（いまひとつ/まあまあ/ふつう/良い/とても良い→satisfaction 1..5、同値で解除）
- [x] 4.3 手動保存ボタン → `api.putReflection(date, editor.getValue(), satisfaction)` →「保存しました」約 2.2s 表示
- [x] 4.4 `hide()`／日付切替／過去選択の直前に dirty ならフラッシュ保存、`body.rf-page` を除去
- [x] 4.5 過去一覧: `api.getReflections()`（excerpt 付き）で日付・気分ラベル・2 行抜粋を描画、クリックでロード、空状態表示

## 5. スタイル（server/static/css/app.css）

- [x] 5.1 現行の振り返り専用クラス（`.rf-layout/.rf-editor/.rf-sat*/.rf-split*/.rf-history*`）と `.md-preview`/`.md-preview-label` を削除（共有 `.md-body/.md-h/.md-p/.md-list/.md-task-item/.md-quote/.md-pre/.md-code` は保持）
- [x] 5.2 設計 hex をリテラル転記した新 `rf-*` ブロックを追記（`body.rf-page`/`.rf-main`/`.rf-title`/`.rf-mood*`/`.rf-card`/`.rf-ed`/`.rf-ph`/`.rf-chrome`/`.rf-hint`/`.rf-count`/`.rf-saved`/`.rf-save`/右レール/`.rf-ed-*` 装飾）
- [x] 5.3 冒頭コメントに「ref/reflection/振り返り.dc.html 忠実移植・CSP のためクラス+CSSOM・フォントのみ system-ui フォールバック」を明記

## 6. サーバ API（excerpt）

- [x] 6.1 `server/src/services/reflection.ts`: `ReflectionListItem` に `excerpt: string` を追加
- [x] 6.2 `listReflections` の SELECT に `content` を含め、markdown 除去＋空白圧縮で先頭 ~80 字の excerpt を生成（本文全文は返さない）。`reflectionExcerpt()` として切り出し
- [x] 6.3 excerpt 生成の単体テストを追加（`server/src/services/reflection.test.ts`）

## 7. 検証

- [x] 7.1 `npm run typecheck` と `npm test` を通す（67 tests passed、reflection.test.ts 追加分含む）
- [x] 7.2 Playwright で Notion 各挙動を自動検証（3.1 箇条継続/3.2 空行抜け/3.3 フェンス自動クローズ/3.4 `[ ]` todo/3.5 空 todo Backspace 1 回/3.6 □トグル）— 12/12 checks passed
- [x] 7.3 IME（compositionstart/end）で変換確定後もテキスト保持・キャレット破壊なしを自動検証 — pass
- [x] 7.4 保存→リロードで本文・気分が復元、`GET /api/planning/:date` の reflectionDone が従来どおり立つことを確認（API で検証: excerpt/reload/reflectionDone=true）
- [x] 7.5 過去一覧の抜粋表示・空状態、`ref/reflection/reference.webp` との視覚突合（rf-empty.png / rf-decorated.png で確認、設計とほぼ一致）
