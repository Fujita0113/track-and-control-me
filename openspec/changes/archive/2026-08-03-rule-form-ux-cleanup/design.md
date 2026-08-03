# Design: rule-form-ux-cleanup

## Context

ルールフォームにおけるグループ作業条件の設定UIが `GROUP`（単一）と `GROUP_OR`（複数OR）に二分されており、ユーザーが選択時に迷う設計になっている。また、ドロップダウン項目が平坦に並び選択しづらく、プロジェクトの操作性原則として `Ctrl + Enter` の統一が明記されていない。

## Goals / Non-Goals

### Goals

1. ルールフォームの選択肢において「単一グループ」と「グループOR集計」を1つの「グループ作業時間」項目に統合する。
2. フォーム読み取り (`read()`) 時に選択されたチェックボックスの数（1件 vs 2件以上）によって `GROUP` と `GROUP_OR` の API パラメータを自動決定する。
3. 条件ドロップダウンを `<optgroup>` で「作業時間・計測」「計画・振り返り」「チェック・手動記録」の3カテゴリに分類し視認性を改善する。
4. `CLAUDE.md` / `GEMINI.md` / `.agents/AGENTS.md` の3ファイルを同時更新し、`Ctrl + Enter` フォーム送信の原則ルールを追記する。

### Non-Goals

- サーバーの DB スキーマ（`rule` / `rule_group_member`）や評価ロジックを変更すること。
- 他のルールターゲット（`TIMELINE`, `MANUAL_CHECK`, `PLANNING`）のサーバー処理を変更すること。

## Technical Details

### 1. `targets.js` の改修
- `CONDITION_KINDS` をカテゴリ（`category` プロパティ）付きで定義。
- `GROUP` と `GROUP_OR` の選択肢を統合し、`v: 'GROUP_SELECT'`（表示名: `'グループ作業時間'`）として1つのエントリへまとめる。

### 2. `rule-form.js` の改修
- 条件 `<select>` の構築時に `optgroup` を生成し、カテゴリごとに選択肢をグループ化。
- `v: 'GROUP_SELECT'` 選択時、グループ選択UI（チェックボックス）を表示。最低1件選択を必須化。
- `read()` 処理:
  - 選択数が 1 件 ➔ `target: 'GROUP'`, `groupIdentityId: selectedIds[0]` を返却。
  - 選択数が 2 件以上 ➔ `target: 'GROUP_OR'`, `groupIdentityIds: selectedIds` を返却。
- 編集時 (`syncKind`):
  - `GROUP` または `GROUP_OR` のルール編集時、自動的に `'GROUP_SELECT'` を選択状態にし、該当するチェックボックスを復元 (prefill)。

### 3. プロジェクトルール（3ファイル）の同期
- `CLAUDE.md`, `GEMINI.md`, `.agents/AGENTS.md` に同一の「フォーム・モーダルの操作性（Ctrl + Enter 送信）」セクションを追加する。

## Risks / Trade-offs

- **既存 E2E テストとの互換性**: ドロップダウンの表示名や HTML 構造（`<optgroup>` の挿入）が変わるため、既存 spec のセレクト操作が影響を受けないか検証が必要。
