## 1. `deleteGoal` に終了済みガードを追加（サーバ）

- [x] 1.1 `server/src/services/goals.ts` に `GoalDeleteAfterEndError`（`GoalDeleteWindowError` と同様のパターン、メッセージ例「終了した目標は削除できません」）を追加する
- [x] 1.2 `deleteGoal` に、`GoalDeleteWindowError` のチェックの直後（削除可能ウィンドウの判定と同じ場所）で `row.ended_day_key != null` を見て `GoalDeleteAfterEndError` を投げるガードを追加する（design D3）
- [x] 1.3 `server/src/api/goals.ts` の削除エンドポイントで `GoalDeleteAfterEndError` を 409 にマッピングする（既存の `GoalDeleteWindowError` ハンドリングと同じ形）
- [x] 1.4 `server/static/js/goals.js:264` の削除ボタン描画条件は変更しない（既にステータス起因で非表示になっているため）が、`server/static/js/goals.js:270` のエラーメッセージ分岐に 409 時の文言を追加する（「終了した目標は削除できません」）

## 2. vitest: 削除ガードの回帰テスト（凍結ライン）

- [x] 2.1 `server/src/services/goals.test.ts` の「削除猶予（作成当日のみ）」describe に、以下を追加する（propose 時点で追加済み）:
  - 作成当日に `endGoal` で終了した目標を、同じ当日中に `deleteGoal` しようとすると `GoalDeleteAfterEndError` を投げ、目標・ルール・終了時の理由が残ることを確認するテスト
- [x] 2.2 `npm test` を実行し、実装前（1章未着手）の状態でこのテストが red であることを確認済み（`expected [Function] to throw an error` — 1 failed / 424 passed。他テストへの影響なし）。apply はこのテストを変更してはならない（凍結ライン）

## 3. 振り返りタブ: ルール一覧・最近の変更の折りたたみ化

- [x] 3.1 `server/static/js/rule-form.js` の `buildGoalRulesBlock` を `(goal, todayKey, onReload, { frozen = false, startOpen = false } = {})` に拡張し、戻り値を `<details class="pc-rules-collapse"><summary class="pc-rules-summary">...</summary>{既存の pc-block}</details>` にする（design D1）
- [x] 3.2 `summary` のテキストを `reload()` 内で更新する（非凍結時は `ルール（${件数}件）`、`frozen: true` のときは既存の「ルール（凍結中は編集できません）」のまま）
- [x] 3.3 `server/static/js/reflection.js` の `journalCorner`（`reflection.js:434-446` 付近）を、`isFrozenNow(goal)` の分岐と外側 `<details class="gf-rules-collapse">` の二重折りたたみを削除し、`buildGoalRulesBlock(goal, date, null, { frozen: isFrozenNow(goal) })` の呼び出し1本に統合する
- [x] 3.4 `reflection.js` の `showDemo`（チュートリアル、`reflection.js:126`）の呼び出しに `{ startOpen: true }` を渡す（「下の＋追加から」という案内文と矛盾しないように）
- [x] 3.5 `server/static/css/app.css` から `.gf-rules-collapse` 関連ルール（`app.css:1254-1256`）を削除し、`.pc-rules-collapse` / `.pc-rules-summary` の対応するスタイルを追加する（1ルール1行の既存書式を踏襲し、ファイル全体は整形しない）

## 4. 視覚階層の調整（CSS のみ）

- [x] 4.1 `.pc-plan-body` / `.pc-pending-when`（ルール1行のラベルとスケジュール）の間のコントラストを調整し、主行（ラベル＋しきい値）とスケジュールの主従がはっきりするようにする
- [x] 4.2 `.pc-pending-row` / `.pc-pending-note`（最近の変更1行の操作ラベルと理由）の余白・色を調整し、理由が長文でも折り返しで主張しすぎないようにする
- [x] 4.3 変更後、`.pc-collapse` を開いた状態のスクリーンショットで既存デモ（`goal-rule-gate-loop.spec.ts` が通る状態）を目視確認する

## 5. 一時凍結の未予約エントリーポイントを1箇所に集約

- [x] 5.1 `server/static/js/reflection.js` の `loadJournals`（`reflection.js:567`）で、`h2 目標の日記` の直後・目標ループの前に、凍結中/予約中でないアクティブ目標が1件以上あれば `id="rf-freeze-shared"` の一時凍結ブロックを1回だけ描画する（`unreservedView` をそのまま再利用、design D4）
- [x] 5.2 `journalCorner` から `unreservedView` 相当の呼び出しを取り除き、`reserved`/`frozen` のときだけ `reservedView`/`frozenView` を出すようにする（`buildFreezeBlock` の呼び出し箇所・分岐を見直す）
- [x] 5.3 凍結中/予約中でないアクティブ目標が0件のときは `#rf-freeze-shared` を描画しない

## 6. 既存 e2e の更新（フリーズ済みなのでここだけで完結させる）

- [x] 6.1 `e2e/rule-form-edit-note-visibility.spec.ts` — `.pc-rules-collapse summary` を開いてから `.pc-block` を操作するよう更新済み（propose 時点で先行実施。apply はこのファイルを変更してはならない）
- [x] 6.2 `e2e/goal-rule-gate-loop.spec.ts` — 同上、`.pc-rules-collapse summary` を開くステップを追加済み（apply はこのファイルを変更してはならない）
- [x] 6.3 `e2e/goal-freeze-reserve-flow.spec.ts` — `#rf-freeze-shared` を使う形へ更新済み（目標カードごとの `.gf-block` 重複が無いことも確認するアサーションを追加。apply はこのファイルを変更してはならない）
- [x] 6.4 上記3ファイル以外に `.pc-block` / `.gf-block` / `一時凍結` を扱う e2e が無いか最終確認する（`grep -rl "pc-block\|gf-block" e2e`）。これら3ファイルは実装前は red のままでよい（DOM が `.pc-rules-collapse` / `#rf-freeze-shared` を持たないため）。実装完了後に green になることを確認する

## 7. 新規 e2e（apply の最後にDOM確定後、実装から書く）

- [x] 7.1 「振り返りタブの目標コーナーで、ルール一覧と最近の変更が既定で閉じていて、開くと中身が見え、対象日を切り替えると再び閉じる」フローを新規 e2e として追加する（`e2e/reflection-goal-corner-collapse.spec.ts`。git stash + CI=1 で red-proof 済み）
- [x] 7.2 「作成当日に目標を終える→同日中に削除しようとすると拒否され、目標が残る」フローを新規 e2e として追加する（`e2e/goal-delete-after-end-rejected.spec.ts`。UI の削除ボタンは status='ended' で非表示になるため、削除拒否そのものは API 直叩きで確認。git stash + CI=1 で red-proof 済み）
- [x] 7.3 「複数のアクティブな長期目標がある状態で振り返りタブを開くと、一時凍結の入口（月枠状況＋ボタン）が1つだけ表示される」フローは `goal-freeze-reserve-flow.spec.ts` の更新（6.3）で実質カバー済みのため、新規追加は不要

## 8. 最終確認

- [x] 8.1 `npm test`（vitest）が全て green（425 passed）
- [x] 8.2 `npx playwright test`（更新・追加した e2e を含む）が全て green（51 passed）
- [x] 8.3 `git diff --stat` で `app.css` の差分行数が想定以上に大きくないことを確認する（フォーマッタ混入チェック・プロジェクトルール。7 insertions / 7 deletions のみ）

## 9. issue #86 実機確認後の追加指摘（未アーカイブのためこの change 内で追従）

- [x] 9.1 `.pc-rules-summary` のネイティブ開閉三角がカードの角丸からはみ出す不具合を修正する（`list-style-position: inside` ＋左右 padding 12px）
- [x] 9.2 `最近の変更`（`changeLine` / `.pc-pending-row`）を「操作＋ラベル」と「理由」の2行構成に変え、行間に区切り線を入れて視認性を上げる（色・透明度だけの調整では不十分だったため）
- [x] 9.3 3つの既存 e2e（`goal-freeze-reserve-flow` / `goal-rule-gate-loop` / `rule-form-edit-note-visibility`）＋新規2本（`reflection-goal-corner-collapse` / `goal-delete-after-end-rejected`）が green のまま、`npm test` も green のままであることを再確認する
