## 1. 実装

- [ ] 1.1 `server/static/js/goals.js` の `endGoalModal` 関数内、`openModal(body, '目標を終える')` の直前に `ctrlEnterToSave(body, save);` を1行追加する

## 2. 確認

- [ ] 2.1 `npm test`（vitest）を実行し、既存テストが全て通ることを確認する（新規 vitest テストなし：この変更はクライアント JS の1行追加のみで、サービス層・API 層のテスト対象がない）

## E2E・既存テスト

- 既存 e2e への影響なし（追加なのでセレクタが壊れない）
- apply が書く新規 e2e フロー: 「目標を終える」モーダルを開き → 理由を入力 → Ctrl+Enter で送信 → モーダルが閉じて目標が終了状態になる
