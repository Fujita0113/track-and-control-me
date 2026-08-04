## 1. 未送信入力の退避・復元ロジック（today.js）

- [x] 1.1 `renderGate`（`today.js:148`）の `clear(region)` 直前に、既存の `region.querySelectorAll('.cond-answer')` を走査し、値が非空の入力を `ruleId → { value, focused, selectionStart, selectionEnd }` の Map として退避するヘルパーを追加する（`ruleId` は `data-rule-id` 属性で入力から引けるようにする）。
- [x] 1.2 `ruleAnswerRow`（`today.js:288`）の質問分岐（`today.js:341-360`）で、入力 `<input class="cond-answer">` 生成時に `data-rule-id` 属性を付与し、渡された退避 Map に `c.ruleId` のエントリがあれば `input.value` を復元する。
- [x] 1.3 `renderGate` が新しい `condCard`/`list` を `region` に appendChild した後、退避 Map の中で `focused: true` だったエントリに対応する入力へ `input.focus()` + `try { input.setSelectionRange(start, end) } catch {}` でカーソル位置を復元する。
- [x] 1.4 `condRow`/`ruleAnswerRow` の呼び出し経路（`renderGate` 内 `today.js:170` および `revealCard` 経由でない別呼び出し `today.js:484`）に退避 Map を引数として通す配線を行う。退避 Map が無い（初回描画）場合は空 Map を渡し、既存の挙動を変えない。

## 2. vitest（サービス/ロジック層のユニットテスト）

`vitest.config.ts` の `include` は `packages/*/src`・`server/src`・`extension/src` の `*.test.ts` のみを対象とし、`server/static/js`（今日タブのバニラJS・DOM操作）はそもそも収集対象外（extension のブラウザ実行時依存コードと同じ理由でスコープ外）。今回の修正は API/サービス層に変更が無く、影響範囲はすべて `server/static/js/today.js` のDOM描画ロジックのため、**vitestで書ける継ぎ目が無い**。新規 vitest テストは追加しない（既存パターンとの整合を優先し、このためだけに `include` を広げることはしない）。
- [x] 2.1 `npm test` を実行し、既存テストに影響が無いこと（今回の変更に起因する新規の赤テストが無いこと）を確認して結果を報告する。→ 37 test files / 424 tests 全パス（propose 時点でのベースライン、今回の変更は未実装のため差分なしは想定通り）。

## 3. 既存 e2e への影響確認

- [x] 3.1 `e2e/today-tab-answer-text-display.spec.ts` / `e2e/goal-rule-gate-loop.spec.ts` / `e2e/hide-achieved-once-rules.spec.ts` を確認済み — いずれも `setInterval(refreshGate, 30000)` の発火を待つ・タイマーを進める実装ではないため、今回の変更による既存 e2e への影響なし。

## 4. 新規 e2e（apply が DOM 確定後に追加）

- [x] 4.1 フロー「質問ルールの回答欄に入力中、ゲートの自動更新が走っても入力が消えない」を検証する新規 e2e を追加する。タイマーの実時間30秒待ちはテストが重くなるため、`page.clock`（Playwright の時計モック）等でタイマーを進める方式を検討し、実装済みDOM（`data-rule-id` 等の実際のセレクタ）に合わせてapply時に書く。→ `e2e/today-question-input-clear-on-refresh.spec.ts` を追加。`page.clock.install()` + `runFor(30000)` でタイマーを進め、`git stash` + `CI=1` で赤（未実装だと失敗）→緑（実装後は成功）を確認済み。
