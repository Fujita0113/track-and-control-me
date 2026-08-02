## 1. 実装

- [x] 1.1 `server/static/js/util.js` の `ctrlEnterToSave` 関数を拡張し、第3引数 `tooltipLabel` が指定された場合に自動で `attachTooltip` を呼ぶようにする
- [x] 1.2 `server/static/js/goals.js` の `openEndDialog` 関数内、`openModal(body, '目標を終える')` の直前に `ctrlEnterToSave(body, save, '終える');` を追加する

## 2. 確認

- [x] 2.1 `npm test`（vitest）を実行し、既存テストが全て通ることを確認する

## 3. プロジェクトルール

- [x] 3.1 `CLAUDE.md`, `GEMINI.md`, `.agents/AGENTS.md` の3ファイルへ「ショートカット追加時は attachTooltip を併記する」ルールを同期追加する

## E2E・既存テスト

- 既存 e2e への影響なし
- apply が書いた新規 e2e フロー: `e2e/goal-end-ctrl-enter.spec.ts` で Ctrl+Enter 送信を検証済み
