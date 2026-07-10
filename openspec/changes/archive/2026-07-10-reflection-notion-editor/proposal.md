## Why

現在の振り返りタブは textarea ＋ 右側ライブプレビューの 2 ペイン構成で書き味が素っ気なく、Markdown を書く体験が弱い。claude.ai design で作成した `振り返り.dc.html` に忠実移植し、Notion/Obsidian 風のインライン・ライブ Markdown エディタへ刷新することで、日々の振り返りを気持ちよく書けるようにする。

## What Changes

- 振り返りエディタを **単一 `contenteditable` のインライン・ライブ Markdown エディタ**へ刷新（構文マーカーを淡色表示しつつ同じ行に整形結果をインライン描画）。従来の textarea＋別ペインプレビューは廃止（**BREAKING**: 振り返りタブの DOM 構造・CSS クラスが刷新される）。
- **Notion 風キーボード挙動を追加**（設計ファイルには無い中核機能）:
  - `- `/`*`/`1.` 箇条書きで Enter → 同じマーカーで次行を自動生成。空マーカー行で Enter → マーカーを外して抜ける。
  - ` ``` ` を打つと下に閉じ ` ``` ` を自動挿入し、間にキャレットを置く。
  - 行頭で `[ ]` だけ打つと todo チェックボックス（`- [ ] `）に変換。
  - 空の todo/箇条書き項目で Backspace 1 回でマーカーごと削除。
  - 描画済みチェックボックスのクリックで `[ ]`⇄`[x]` トグル。
- 気分入力を設計の **5 段階ピル**（いまひとつ／まあまあ／ふつう／良い／とても良い = satisfaction 1..5）に刷新。
- 右レール「過去の振り返り」に **本文 2 行抜粋**を表示。`GET /api/reflections` に markdown 除去済みの短い `excerpt` を追加。
- 保存は手動「保存する」ボタン＋「保存しました」表示に加え、日付切替・過去エントリ選択・タブ離脱時に未保存分を自動フラッシュ。
- 設計を忠実移植: 配色 hex・px・レイアウトを `rf-*` CSS クラスへリテラル転記（CSP のためインライン style 禁止、クラス＋CSSOM）。フォントのみ CSP 制約で `system-ui` フォールバック。

## Capabilities

### New Capabilities
- `reflection-journal`: 振り返りタブの UI と編集体験。インライン・ライブ Markdown エディタ、Notion 風キーボード挙動、5 段階気分、過去振り返り一覧（抜粋付き）、保存挙動、設計への視覚的忠実性を定義する。

### Modified Capabilities
<!-- 既存の main spec に振り返り capability は存在しないため無し。 -->

## Impact

- **新規**: `server/static/js/md-editor.js`（再利用可能な Notion 風インラインエディタ）、`ref/reflection/振り返り.dc.html`＋`reference.png`（参照 vendoring）。
- **書換**: `server/static/js/reflection.js`（全面刷新）、`server/static/css/app.css`（振り返り専用 `rf-*`/`.md-preview` ブロックを差し替え。ただし kanban が共用する `.md-body/.md-h/.md-p/.md-list/.md-task-item/.md-quote/.md-pre/.md-code` は保持）。
- **変更（小）**: `server/src/services/reflection.ts`（`ReflectionListItem` に `excerpt` 追加、`listReflections` の生成ロジック）。
- **不変**: `server/src/main.ts`（CSP）、`server/static/index.html`・`main.js`（タブ配線は既存流用）、`server/static/js/markdown.js`（read-only レンダラ、kanban 共用）、`api.js`（GET 署名不変）、`packages/contract`（振り返り型は無い）、DB スキーマ（`reflection_entry` は本文 markdown 保存のまま → `planning.ts` の PLANNING ロック解除シグナルは無傷）。
