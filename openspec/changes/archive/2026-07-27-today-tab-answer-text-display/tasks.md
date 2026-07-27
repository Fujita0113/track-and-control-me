## 1. サーバー: ConditionResult に answerText を載せる

- [x] 1.1 `server/src/rules/evaluate.ts` の `ConditionResult` に `answerText?: string` を追加する。
- [x] 1.2 `evaluateRule` の `QUESTION` 分岐で、当日 `dayKey` の `rule_answer.answer_text` を取得し `answerText` に詰める（未回答/PHOTO では詰めない）。範囲ルールで前日以前の回答を拾わないよう、必ず `(rule.id, dayKey)` 単位で取得する。
- [x] 1.3 `server/src/rules/evaluate.test.ts` に赤で置いた次の3テストを通す（このタスクの受け入れ基準。テスト自体は propose 段階で凍結済みのため変更禁止）:
  - 「達成した質問ルールの ConditionResult に当日の answer_text が入る」
  - 「未達の質問ルールは answerText を持たない」
  - 「範囲ルールで前日回答済みでも、当日の answerText には前日分が出ない」
  - 追加（apply 中に発見したギャップを埋める非凍結テスト）: 「単発ルールは提出日の翌日以降も同じ answerText を保つ（繰り越し）」。単発（carry）QUESTION は提出日以降ずっと met のままだが、`answer_text` の取得を厳密に「当日 dayKey 一致」だけにすると翌日以降 `answerText` が消えて「回答済み」へフォールバックしてしまう回帰を防ぐ。`carryoverPolicy` を見て carry は「提出日 <= dayKey」で拾うよう `evaluate.ts` を修正。

## 2. フロント: 今日タブの行に回答テキストを表示する

- [x] 2.1 `server/static/js/today.js` の `ruleAnswerRow`（`met` 早期リターン箇所）を見直し、`QUESTION` かつ `met=true` の行では「回答済み」ではなく `answerText` をタイトル下の2行目（既存の `.cond-sub` 相当のスタイル）に表示する。`answerText` が無い場合（データ欠落時のフォールバック）のみ従来どおり「回答済み」を出す。（実際には既存の `.cond-sub` 文言生成部を差し替えるだけで済み、早期リターン自体は変更不要だった）
- [x] 2.2 `PHOTO` の `met` 行は今回のスコープ外として現状の「提出済み」表示を変更しない。

## 3. テスト・確認

- [x] 3.1 `npm test`（vitest）を実行し、1.3 の3テストを含め全体が green であることを確認する。（28 files / 282 tests すべて green）
- [x] 3.2 新規 e2e を実装した DOM に対して追加した。当初案（`goal-rule-gate-loop.spec.ts` への追記）から変更し、`e2e/today-tab-answer-text-display.spec.ts` を新規ファイルとして作成（apply の凍結ルールで既存 e2e ファイルは無編集が必須のため）。質問ルールに今日タブで回答して達成すると、「回答済み」ではなく回答テキストが `.cond-sub` に表示されることを検証。`git stash` + `CI=1` で red-proof 済み（実装なしで red／実装ありで green）。
- [x] 3.3 既存 e2e への影響: なし。`git diff --stat -- e2e/` は新規ファイルの追加のみで、既存ファイルの変更はゼロ。`goal-rule-gate-loop.spec.ts` を `CI=1` で再実行し pass を確認。
- [x] 3.4 デモモードで確認した（プロジェクトルール）。デモは `unlock_evaluation.per_condition_results` を `is_final=1` で焼き込み済みのため `evaluateRule` を経由しない。`server/src/services/demo-seed.ts` の焼き込み `per` に既存の質問ルール2種の `answerText` を追加:
  - 単発（`RULE_QUESTION_FOCUS_ID`、D15 提出・carry）: D15 以降すべての日に同じ回答文面「朝は入りが速い。前夜に眠れないと崩れる。」を追加。
  - 範囲（`RULE_QUESTION_PHONE_ID`、D21〜D22・daily）: 日ごとに実際の提出文面（D21「見ずに寝られた。朝の目覚めは軽い。」／D22「ベッドで30分見てしまった。手の届く場所にあるのが因。」）を分けて追加。
  `server/src/services/demo.test.ts`（20 tests）は既存の chronicle 系アサーションのみで per_condition_results の answerText は見ておらず、期待値変更は不要（全 green のまま）。`PORT=8977 DB_PATH=:memory: npm run server` → `POST /api/demo/reset` → `GET /api/demo/today?now=2026-06-26`（D16・単発の翌日）と `?now=2026-07-01`/`2026-07-02`（D21/D22・範囲）で `perCondition[].answerText` を確認: 単発は繰り越し後も同じ回答文面、範囲は日ごとに別々の回答文面が出ることを確認した。

## 4. issue #70 コメントを受けた追加調整（レイアウト・見やすさ）

ユーザーから「回答テキストが2行目に出るだけでは見づらい。`長期目標：メンタルを安定させる` → `└ 朝マスべするな` → `回答` のツリー状のほうが見やすい」とコメントが来た
（[コメント](https://github.com/Fujita0113/track-and-control-me/issues/70#issuecomment-5087060667)）。今日タブの行の並びを、目標名を見出しにしたツリー表示へ組み直した。

- [x] 4.1 `server/static/js/today.js` の `ruleAnswerRow`: DOM の子要素順は変えず（既存 e2e `goal-rule-gate-loop.spec.ts:109-110` が `.cond-sub` の1件目=状態行を前提にしているため）、`.cond-title` に「└ 」を前置し、`.cond-plan`（目標名。既存 e2e が参照するクラス名なのでリネームしない）の文言を「長期目標：${goalName}」に変更。
- [x] 4.2 `server/static/css/app.css`: `.cond-check .cond-main` を `flex-direction: column` にし、`.cond-plan` に `order: -1` を与えて、DOM順そのままに目標名だけを視覚的に先頭へ出す。`.cond-title`/`.cond-sub` に `cond-nested` 修飾クラスでインデントを追加。
- [x] 4.3 `npm test`（283 tests）・`CI=1 npx playwright test`（36 tests、新規/既存 e2e とも）を再実行し green を確認。`git diff --stat -- e2e/`・`git status --short e2e/` で凍結対象（既存 e2e ファイル）に差分がないことを再確認。
- [x] 4.4 実際に目標作成→今日タブ回答のフローを起動して見た目を確認。「長期目標：メンタルを安定させる」→「└ 💬 朝マスべするな」→回答文面、の順にツリー表示されることを目視で確認した。
