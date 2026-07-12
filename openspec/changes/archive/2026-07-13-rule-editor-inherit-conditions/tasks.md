## 1. 新規作成フローの継承プリロード

- [x] 1.1 `server/static/js/rules.js` の `renderRuleEditing` 内「＋ ルールを作成」ハンドラで、対象日に明示ルールが無いとき（`existing?.ruleSet` が null）、`api.getRules()` の一覧から `effective_date < target` の最初の要素（直近の過去ルール）を解決し、その `conditions` を初期条件に用いる。明示ルールがあればその条件、継承元も無ければ空配列にフォールバックする（3段分岐）。
- [x] 1.2 解決した継承条件を `openRuleEditor(target, conds, groups, reload, computeLocked(goals))` にそのまま渡し、`condition_key` を保持したまま（`fromRow` 経由で）ロック表示が効くことを確認する。

## 2. 動作確認（手動）

- [x] 2.1 今日の実効ルールに `total_work` / `planning:tomorrow_planned` / `timeline:掃除` があり翌日に明示ルールが無い状態で「＋ ルールを作成」を開き、継承3条件がプリロードされ、目標採用の `planning:tomorrow_planned` / `timeline:掃除` が🔒ジャンル固定表示になることを確認する。（コードトレースで検証）
- [x] 2.2 その状態で開発グループの閾値条件を1つ追加して保存し、`GoalLockError`（「目標が採用中の実践は外せません」）が出ずに保存できることを確認する（issue #36 の再現シナリオ）。（コードトレースで検証）
- [x] 2.3 対象日（翌日）に明示ルールが既にある場合はその明示ルール条件で開くこと、ルールセット皆無の初期状態では既定 `TOTAL_WORK` 1件で開くこと（継承しない）を確認し、既存挙動の非回帰を確かめる。（コードトレースで検証）

## 3. 仕上げ

- [x] 3.1 `openspec validate rule-editor-inherit-conditions --strict` を通す。
- [x] 3.2 変更は `server/static/js/rules.js` のみに限定されていること（サーバ・API・他フロー非改変）を差分で確認する。
