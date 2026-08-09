## 0. 凍結済みのテスト（propose が置いた・apply は変更禁止）

propose の時点で決まっている契約はここで赤のまま置いてある。apply はこれを**通す**のであって、
**書き換えてはならない**。凍結側が事実と食い違うと判断した場合のみ、CLAUDE.md の
「1回だけ投げ返す」手順で停止してユーザーへ確認すること。

**追加した vitest（凍結）**
- `server/src/services/activity-exclusion.test.ts` — サービス／集計層。除外の永続化と再集計をまたいだ持続、
  同時オープンの再按分（2→1、3→2）、全除外区間の非計上（`ungrouped` へ落ちない）とギャップ化、
  確定日の `force` 再集計・`force` 再評価とスコープ限定、取り消しと冪等性。
- `server/src/api/timeline-exclusion.test.ts` — API 層。`POST /api/timeline/:date/exclusions` と
  `DELETE /api/timeline/exclusion/:id` の応答、応答時点で集計が反映されていること、400 の検証、確定日での実行。

**現在の結果**: 新規2ファイルのみ赤（21 failed / 456 passed）。落ちている理由は
`addAutoExclusion` / `removeAutoExclusion` が未実装であること、および `recompute` / `evaluateDay` の
`force` オプションが未実装であること。既存テストは全て緑で、この変更による回帰は無い。

**変更した既存 e2e**: なし（`e2e/` に AUTO 詳細ポップオーバーを触る spec は存在しない）。

**apply が最後に書く新規 e2e（1本）**: フローとして — 「閉じ忘れたタブグループの自動記録ブロックを開く →
削除操作 → 確認を承認 → タイムラインからそのブロックが消える」。あわせて確認ステップで
取り止めたときに消えないことも同じ spec で押さえる。セレクタは実装した DOM に合わせて決めること。
書いたら CLAUDE.md の手順（`git stash` ＋ `CI=1`）で、実装抜きだと落ちることを機械で示す。

## 1. データ層: 除外レコード

- [x] 1.1 `server/src/db/migrations.ts` に `activity_exclusion` テーブルを追加する（design D1 のスキーマ・`day_key` の索引付き）。既存 DB へ安全に付与されること（`openDb(':memory:')` で migration が通ること）を確認する
- [x] 1.2 `server/src/services/timeline.ts` に `addAutoExclusion(db, dayKey, { identityKey, startAt, endAt }): number` / `removeAutoExclusion(db, id): boolean` / `loadExclusions(db, dayKeys)` を追加する（`loadSplitOverrides` と同じ並び・同じ流儀）
- [x] 1.3 `removeAutoExclusion` は行が無ければ例外を投げず `false` を返す（冪等）

## 2. 集計層: 除外の適用

- [x] 2.1 `server/src/aggregation/aggregate.ts` の `ExcludeReason` に `DELETED` を追加し、`gapCloseReason` の既定経路（`SLEEP_GAP`）で扱われることを確認する
- [x] 2.2 `aggregateSamples` に除外の入力（`{ exclusions, identityKeyOf }`）を受け取る引数を追加する。除外が空のときは `identityKeyOf` を呼ばず、既存の計算経路と結果が一致すること（design D4）
- [x] 2.3 区間ごとに中点判定（`overrideFor` と同じ規則）で該当する除外を引き、一致する identity の open グループを `openKeys` から落とす。`stream` へ積む slab の `openKeys` も同じフィルタ後の集合にする（design D2）
- [x] 2.4 残った open グループがある区間は、その集合で `distribute` / `distributeWeighted` する（分母が N−1 になる＝再按分）。区間の総計上が削除前後で変わらないことを確認する
- [x] 2.5 元は実グループが1つ以上あり、除外の結果 open が空になった区間は `ungrouped` へ計上せず、`excludedMs` へ `DELETED` として積み、`stream` へ `{ kind: 'gap', reason: 'DELETED' }` を積む（design D3）
- [x] 2.6 `server/src/services/recompute.ts` で `loadExclusions` と `loadIdentityResolver(db)` を読み、`identityKeyOf` コールバックとともに `aggregateSamples` へ渡す

## 3. 確定日の訂正

- [x] 3.1 `recompute(db, { onlyDays, force })` を追加する。`force` は `onlyDays` を伴う場合のみ有効とし、`persist()` の `target()` 判定で `onlyDays` に含まれる日に限り `finalDays` / `finalEval` のガードを無視する（design D5）
- [x] 3.2 `persist()` の `DELETE FROM daily_totals_snapshot ... AND is_final = 0`（`recompute.ts:149`）を、`force` 対象日では `is_final` 条件を外して消すようにする。再作成する行の `is_final` は 1 のまま維持する
- [x] 3.3 `evaluateDay(db, dayKey, nowMs, { force })` を追加する。`force` のとき `is_final === 1` の早期 return を飛ばし、値だけ更新する（`ON CONFLICT DO UPDATE` は `is_final` を書き換えないので確定フラグは保たれる）
- [x] 3.4 `force` が `onlyDays` 指定日以外の確定日を巻き込まないことを、既存の呼び出し元（`runPipeline`・`rollover`）が従来どおり動くことと併せて確認する

## 4. API

- [x] 4.1 `server/src/api/timeline.ts` に `POST /api/timeline/:date/exclusions`（body: `identityKey`, `startAt`, `endAt`）を追加する。`identityKey` 欠落・`endAt <= startAt` は 400
- [x] 4.2 登録後に対象日だけを `recompute(db, { onlyDays: [date], force: true })` ＋ `evaluateDay(db, date, Date.now(), { force: true })` してから `{ id }` を返す
- [x] 4.3 `DELETE /api/timeline/exclusion/:id` を追加する。行の `day_key` を読んでから削除し、同じ日を再集計・再評価して `{ restored: boolean }` を返す。行が無ければ `{ restored: false }`
- [x] 4.4 `server/static/js/api.js` に `addExclusion(date, body)` / `removeExclusion(id)` を追加する（既存の並びに合わせる）

## 5. UI: 詳細ポップオーバーの削除導線

- [x] 5.1 `server/static/js/timeline.js` の `runBreakdown()` 末尾（`timeline.js:704`）の「自動記録ブロックは削除できません。」を、削除操作へ置き換える
- [x] 5.2 削除操作は2段階にする。1回目で確認表示（対象時間帯 `HH:MM – HH:MM` ＋ 実行／取り止め）へ切り替わり、取り止めると元の表示へ戻る（design D7）
- [x] 5.3 実行時は `run.startAt` – `run.endAt`（ランのスパン全体）と `run.identityKey` を送る。成功したらポップオーバーを閉じて `renderCore` で再描画する
- [x] 5.4 成功トーストから取り消せるようにする（`removeExclusion(id)` → 再描画）
- [x] 5.5 `server/static/css/app.css` に確認ステップ用のスタイルを追加する。**1ルール1行のコンパクト書式を守り、フォーマッタを全体にかけない**。編集後に `git diff --stat` で差分の桁を確認する

## 6. 検証

- [x] 6.1 凍結済み vitest 2ファイルを緑にする（`npx vitest run server/src/services/activity-exclusion.test.ts server/src/api/timeline-exclusion.test.ts`）
- [x] 6.2 `npm test` 全体が緑であることを確認する（回帰なし。とくに `recompute.test.ts` / `rollover.test.ts` / `aggregate.test.ts` / `exclude-ungrouped.test.ts`）
- [x] 6.3 新規 e2e を1本書く（0章のフロー）。`git stash push -- server/ extension/ packages/` ＋ `$env:CI="1"` で**実装抜きだと落ちる**ことを示してから `git stash pop` で通す
- [x] 6.4 デモモードで成果を再現してユーザーへ提示する（CLAUDE.md 必須ルール）。`server/src/services/demo-seed.ts` へ「閉じ忘れ」相当の長時間ブロックを追加（`DEMO_FORGOTTEN_DAY` = 谷日 Day16・2026-06-26。raw_sample で本物の集計経路を通す唯一の日にした）。`PORT=48213 DB_PATH=:memory: npm run server` → `POST /api/demo/reset` → `GET /api/demo/goals/1/report?now=2026-07-13` で確認: achievedDays 26/32・Day16 の total_work 320分（=通常200分＋閉じ忘れ「動画視聴」120分）。デモ DB にはタイムライン書き込み用の HTTP 経路が無い（`/api/demo/timeline/*` は allocation の読み取り専用）ため、削除操作そのものは `server/src/services/demo.test.ts` に追加した新規テストで検証（`addAutoExclusion` → `recompute(force)` → `evaluateDay(force)` の実サービス経路）: 削除後は Day16 が 320分→200分（-2時間）、achievedDays は26のまま不変（既存の谷＝振り返り抜けは変わらないため）、取り消すと320分へ完全に戻る
- [x] 6.5 除外理由 `DELETED` を表示する箇所があれば日本語ラベルを確認する（`daily_excluded_snapshot` の診断表示）— 確認の結果、`ExcludeReason`（IDLE/LOCKED/GAP_EXCEEDED/NEGATIVE_GAP/CLOCK_JUMP 含む既存理由も）を表示する UI/API は現状どこにも無い（診断専用でクライアント非露出）。表示箇所が無いため対応不要
