## 1. マイグレーション

- [x] 1.1 `server/src/db/migrations.ts` に新規バージョン（32）を追加する: `goal_freeze` から `kind` 列を `ALTER TABLE ... DROP COLUMN` で削除し、`goal` に `resumed_day_key TEXT` / `resume_reason TEXT` を追加し、`goal_end_interval`（`goal_id, ended_day_key, resumed_day_key, end_reason, resume_reason, outcome_met, final_pace_json, created_at`）を新設する（design D1・D2）。**既存のコミット済みマイグレーションは書き換えない**（新バージョンとして追加する）。

## 2. 一時凍結の統合（`server/src/services/goal-freeze.ts`）

- [x] 2.1 `FreezeKind`・`sameDayFreeze`/`sameDayFreezeMulti`/`sameDayQuotaMonthOf`/`cancelFreeze` を削除する。
- [x] 2.2 `reserveFreeze`/`reserveFreezeMulti` を `freezeGoal`/`freezeGoalMulti` へ改名し、`start_day` を常に `today` に固定する（`design D1`）。
- [x] 2.3 `frozenDaysUpTo`/`effectiveEndDay` から種別フィルタを外す（全区間を対象にする）。
- [x] 2.4 `quotaMonthOf` を `today.slice(0, 7)` に簡素化し、`FreezeState` から `'reserved'` を削除する（常に `'frozen' | 'released'`）。
- [x] 2.5 `updateFreeze`（延長）・`releaseFreeze`（解除）から `kind` 分岐を外す。
- [x] 2.6 `goal-freeze.test.ts`（本変更で更新済み・凍結）と `server/src/api/goals-freeze.test.ts`（更新済み・凍結）を通す。ルートは `/api/goals/:id/freeze`（POST・当日発効）・`/api/goals/:id/freeze/release`・`/api/goals/:id/freeze/extend` を維持し、発効前取消用の `DELETE /api/goals/:id/freeze` は削除する。
- [x] 2.7 `packages/contract/src/index.ts`: `FreezeEntryKindSchema` から `'reserve'`/`'cancel'` を削除し作成イベントは `'activate'` をそのまま使う。`FreezeStateSchema` から `'reserved'` を削除。`FreezeInputSchema` から種別選択を削除。

## 3. 終了→再開（`server/src/services/goals.ts`）

- [x] 3.1 `goal.resumed_day_key`/`resume_reason` を読み書きする `resumeGoal(db, goalId, { reason }, nowMs)` を追加する（`isEnded(goal, today)` が真のときのみ許可・`resumed_day_key = today + 1`・理由必須・design D4）。
- [x] 3.2 `cancelResumeGoal(db, goalId, nowMs)` を追加する（`today < resumed_day_key` のときのみ許可・`resumed_day_key`/`resume_reason` を null に戻す）。
- [x] 3.3 状態導出を `isEnded(goal, today) = ended_day_key != null && today >= ended_day_key && (resumed_day_key == null || today < resumed_day_key)` に更新する（`goal-challenge` MODIFIED）。`GoalView` に `resumingOn`（再開予約中の発効日・無ければ null）を追加する。
- [x] 3.4 `endGoal` を更新し、**既に閉じた（再開済みの）現サイクルが `goal` 行に残っている状態でもう一度呼ばれたら**、そのサイクルを `goal_end_interval` へアーカイブしてから新しい `ended_day_key` 等を書き込む（同一トランザクション・design D2）。二重終了ガード（`ended_day_key != null` での拒否）は `isEnded(goal, today) || (ended_day_key != null && today < ended_day_key)` に合わせて更新する（実装は、再開済み＝`resumed_day_key` 設定済みの閉じたサイクルはブロックしない形に精緻化。frozen な `goal-resume.test.ts`「サイクルを繰り返しても月枠を消費しない」との整合を優先）。
- [x] 3.5 `effectiveEndDayOf`（および `goalPace`・達成カレンダー算出）に `endedDaysUpTo` を追加し、`frozenDaysUpTo` と合算する。対象は `goal_end_interval` の全行 ＋ `goal` 行上の未アーカイブな閉じたサイクル（`resumed_day_key` が設定済みのもの）。`min(区間終端, today)` キャップで経過分のみ数える（design D3）。
- [x] 3.6 ペース分母・達成カレンダーの「対象外（frozen）」表示に、終了区間も凍結区間と同列で含める。
- [x] 3.7 `goal-resume.test.ts`（新規・本変更で作成済み）・`goal-end-anytime.test.ts`（更新済み）・`goal-target-hours.test.ts`（更新済み）を通す。
- [x] 3.8 API ルート `/api/goals/:id/resume`（POST）・`/api/goals/:id/resume/cancel`（POST）を追加する（`/api/goals/:id/end`・`/api/goals/:id/end/cancel` と対称の実装）。`server/src/api/goals-resume.test.ts`（新規・本変更で作成済み）を通す。

## 4. 大きい沿革・⑤沿革

- [x] 4.1 `server/src/services/goal-history.ts`: `goalHistory` の行種別に `'resumed'`（`resumed_day_key` から導出・`goal_end_interval` の全行 ＋ 現サイクルを合成）を追加する。`goal-history.test.ts`（更新済み）を通す。
- [x] 4.2 `server/src/services/goal-chronicle.ts`: 凍結イベントの `'reserve'`/`'cancel'` 合成ロジックを削除し、`freezeGoal` が直接ログする `'activate'` をそのまま読む形にする（`logChange` の `op` 引数から `'reserve'`/`'cancel'` を削除）。「終える」に続けて「再開」も理由つきでエントリに残るようにする。

## 5. フロントエンド

- [x] 5.1 `server/static/js/goal-freeze.js`: 一時凍結モーダルから種別選択ステップを削除し、「理由 → 終了日 → 対象目標選択 → 決定」の4ステップにする。トリガーボタン・トースト文言を統合後の文言に合わせる。ショートカット操作があれば `attachTooltip` を維持する。
- [x] 5.2 `server/static/js/goals.js`: 目標カードに「再開する」ボタン・「再開予約中」バッジ・「再開を取り消す」導線を追加する（`終える`/`終了予約中`/`終了を取り消す` と対称の配置）。`ctrlEnterToSave`/`attachTooltip` を新しいダイアログにも適用する。
- [x] 5.3 手動で `npm run server` を起動し、Playwright でブラウザ操作して確認した: 一時凍結（種別選択なしの理由→終了日→対象選択→決定の4ステップ・POST /api/goals/freeze/multi 成功・一覧に❄凍結中バッジ）と、終える（終了予約中バッジ表示）を実操作で確認（console/page エラーなし）。翌日発効の「再開する」ボタン自体は実時刻を進められないため未クリックだが、同じ導出ロジックはデモモード（6.4）で created→ended→resumed→completed の全経路を実データで確認済み。

## 6. デモモード（CLAUDE.md の「日数が関わる機能はデモモードで成果を明示する」に従う）

- [x] 6.1 `server/src/services/demo-seed.ts` の `goal_freeze` 直接 INSERT から `kind` 列を外し、統合後の単一凍結（当日発効・終了日指定）のサンプルへ作り直す。当日凍結固有だった「期限が延びない」デモ区画は、統合後の挙動（延びる）に合わせて置き換える。
- [x] 6.2 デモに終了→再開サイクルのサンプルを1つ追加し、レポート・大きい沿革でその区間が「対象外」表示され、期限が延びていることを再現する。
- [x] 6.3 `server/src/services/demo.test.ts` の期待値を 6.1・6.2 に合わせて更新する（既存の達成日数・谷日などの筋書きは崩さない）。
- [x] 6.4 `PORT=48213 DB_PATH=:memory: npm run server` で起動し、`POST /api/demo/reset` → `GET /api/demo/goals/1/report?now=2026-07-13`（主目標）・`GET /api/demo/goals/4/report?now=2026-07-13`（終了→再開目標）・`GET /api/demo/goals/history?now=2026-07-13` を確認した。主目標: dayCount 32・achievedDays 26・endDay 2026-07-12・沿革は `['activate']` の1件（種別統合前の `['reserve','activate']` から変化）。目標4: dayCount 13・achievedDays 10・endDay 2026-02-13、Day4-6（終了していた期間）が frozen=true/met=false（対象外）、大きい沿革に created→ended→resumed→completed が理由つきで並ぶ。結果は完了報告でユーザーへ提示。

## 7. e2e

- [x] 7.1 削除済みの `e2e/goal-same-day-freeze-flow.spec.ts`・`e2e/goal-freeze-reserve-flow.spec.ts` の代わりに、**統合後の一時凍結フロー**（理由＋終了日を入力 → 即座に当日のゲートから外れる → 月枠がアプリ全体で共有される → 延長・解除ができる）を新しい e2e として書く（DOM ができてから最後に）。既存2ファイルの削除理由は本変更の commit メッセージに残す。→ `e2e/goal-freeze-unified-flow.spec.ts`
- [x] 7.2 **終了→再開の往復フロー**（進行中の目標を終える → 「終了予約中」→ 翌日発効 → 目標タブから「再開する」→ 「再開予約中」→ 翌日発効 → ゲートに戻る）を新しい e2e として書く。→ `e2e/goal-resume-round-trip.spec.ts`。日をまたぐ検証は時刻モックが無いため `day_boundary_minutes`（実際にアプリが読む設定値）を動かして即時に行い、終了後は元の値へ復元する。
- [x] 7.3 新規 e2e（7.1・7.2）は、実装抜きで落ちることを確認してから実装ありで通す（`git stash push -- server/ extension/ packages/` → `CI=1` で両方赤 → `git stash pop` → 両方緑を実際に確認済み）:
  ```pwsh
  git stash push -- server/ extension/ packages/
  $env:CI="1"; npx playwright test e2e/<new-spec>.spec.ts
  git stash pop
  npx playwright test e2e/<new-spec>.spec.ts
  ```
  worktree 環境では実行前に `npm install` を済ませること。

## 8. 仕上げ

- [x] 8.1 `npx vitest run` を実行し、**634/634 緑**（`goal-freeze.test.ts`・`goal-resume.test.ts`・`goal-history.test.ts`・`goal-target-hours.test.ts`・`goals-freeze.test.ts`・`goals-resume.test.ts` の該当分すべて含む）。途中で見つかった凍結テストの日付演算の誤り2件（`goal-end-anytime.test.ts` 1件・`server/src/api/goals-resume.test.ts` の `endedGoal()` ヘルパー1件）はユーザーへ報告し承認を得たうえで修正済み。
- [x] 8.2 `npm run typecheck` を実行し、3ワークスペースとも 0 エラー。
- [x] 8.3 `git diff --stat` を確認。既存ファイルの書式一括変更は無し（差分量は変更内容に比例）。
