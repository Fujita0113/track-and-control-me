## 1. プロジェクトルールの更新 (CLAUDE.md / GEMINI.md / .agents/AGENTS.md)

- [x] 1.1 `CLAUDE.md`, `GEMINI.md`, `.agents/AGENTS.md` の3ファイルすべてに「フォーム・モーダルの操作性（Ctrl + Enter 送信）」の共通ルールを同内容で追記する（タイトル行のみ各ファイル固有）
- [x] 1.2 `Compare-Object` 等で3ファイルの同期状態を確認する

## 2. クライアント: 種別定義と optgroup 構造化 (`targets.js`)

- [x] 2.1 `server/static/js/targets.js` の `CONDITION_KINDS` を更新し、`GROUP` と `GROUP_OR` を `v: 'GROUP_SELECT'`（ラベル: `'グループ作業時間'`）へ統合する
- [x] 2.2 `CONDITION_KINDS` にカテゴリ情報（`group` プロパティ: `'作業時間・計測'`, `'計画・振り返り'`, `'チェック・手動記録'`）を付与する
- [x] 2.3 `conditionKindTarget` および `conditionKindValue` 関数を `'GROUP_SELECT'` 対応用に更新する

## 3. クライアント: ルールフォーム UI 統合・optgroup 対応 (`rule-form.js`)

- [x] 3.1 `server/static/js/rule-form.js` の条件 `<select>` 構築処理で `<optgroup>` を生成してレンダリングする
- [x] 3.2 `syncKind` で `'GROUP_SELECT'` 選択時にグループ一覧のチェックボックスを表示し、1件以上の選択をUIレベルでバリデーションする
- [x] 3.3 `read()` 内でチェックボックスの選択件数を判定し、1件なら `target: 'GROUP'`, 2件以上なら `target: 'GROUP_OR'` のデータを生成して返す
- [x] 3.4 編集モード (`syncKind`) で既存の `GROUP`（単一）および `GROUP_OR`（複数）ルールの選択状態を `'GROUP_SELECT'` ＋ 対応チェックボックスのチェック状態として復元する (prefill)

## 4. テスト・確認

- [x] 4.1 `npm test`（vitest）を実行し、全ユニットテストが緑であることを確認する
- [x] 4.2 既存 e2e テストを実行し、セレクト操作の選択肢変更による回帰がないことを確認する
- [x] 4.3 新規 e2e テストで「グループ作業時間」からの 1 件選択（GROUP）および 2 件選択（GROUP_OR）の作成・表示フローを検証する

---
