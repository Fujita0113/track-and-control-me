## 0. 凍結テスト（propose 完了・**apply は触らない**）

> プロジェクトルール「テストの凍結ライン」に従い、**vitest（サービス・API 層）は propose が赤で置き、apply は触らない**。
> 新規 e2e は propose では書かない（DOM が未確定のため）。apply が実装後に書く（セクション8）。
>
> **実行結果（propose 時点）**: `npx vitest run` → **47 failed / 351 passed**。
> 失敗はすべて本 change の未実装によるもの（`goalPace is not a function` / `goal-history.js` 未作成 /
> `endGoal` の新シグネチャ未対応 / `targetHours` 未保持）。既存テストの回帰は無い。

- [x] 0.1 `server/src/services/goal-target-hours.test.ts`（16件・赤）— `goal-target-hours` の Scenario:
  目標時間なしでも作れる／時間型以外は拒否／`GROUP_SET` は対象1件以上／下限ルールが無い対象にも置ける／
  2グループの合計で積む／同名同色の開き直しで分裂しない／同じ対象を2回入れない／束ねた並びは決定的／
  分母は今日を含む（目標2h・4日目・累計4h12m → 平均1h03m・今日あと3h48m）／到達済みは 0／
  伸びるほど必要量が増える／凍結日は分母に入らない／`elapsedDays === 0` はペースなし／`TOTAL_WORK` は総作業秒。
- [x] 0.2 **`evaluate.ts` の非回帰テスト**（同ファイル内・赤）— 本 change の中核禁止事項:
  目標時間を持つ目標が進行中の日の `per_condition_results` に目標時間由来のエントリが**1件も現れない**／
  目標時間が大きく未達でも下限を満たせば UNLOCKED。
  **どちらも「目標時間が確かに保持されている／確かに未達である」ことを前提として先に主張する**
  （そうしないと未実装のまま空虚に通ってしまうため。実測で確認済み）。
- [x] 0.3 `server/src/services/goal-open-period.test.ts`（15件・赤）— `goal-challenge` の Scenario:
  期限を日付指定で作成（6日）／90日でも作れる／同日1日も作れる／`end_day < start_day` は拒否／
  **期限の指定が無いと拒否（暗黙の30日にフォールバックしない）**／明日開始でも指定期限が使われる／
  期限を早める手段が無い／めざす状態が空だと拒否／作成理由が空だと拒否／両者は別々に保持される／
  証拠写真: 求めない=null／キャプションだけ指定／初期写真は `start_day` に保存されレポート③へ流入／
  キャプション無しで初期写真だけは拒否。
- [x] 0.4 `server/src/services/goal-end-anytime.test.ts`（15件・赤）— `goal-lifecycle-fork` の ADDED Scenario:
  進行中でも終えられる／理由なしは拒否／**当日からゲートを外れる**／過去日の判定は変わらない／
  終えてもレポート・沿革は残る／二度目は拒否／めざした状態は3値（できた／できなかった／答えない）／
  証拠写真は当日にキャプションつきで保存／出さずに終えられる／未設定の目標に写真を渡すと拒否／
  **完走の「終える」でも同じ3つを問い、同じく当日効く**／凍結予約は取り消され適用済みの延長と沿革は残る。
- [x] 0.5 `server/src/services/goal-history.test.ts`（赤・モジュール未作成のため収集不可）— `goal-history` の Scenario:
  作成・終了・完走が時系列に並ぶ／期限超過は completed として載る／ルール操作は載らない／
  作成理由が「＋作成」に載る／並びは決定的／**3つ（到達判定・めざした状態の答え・証拠写真）が同じ行に並ぶ**／
  目標時間が無い行では到達判定を出さない／未回答・写真なしは欠けたまま返す／
  終えた後に改名しても焼き込んだ数字が動かない／後から出した写真は反映されるが数字と答えは動かない／
  終えた事実は消せない。
- [x] 0.6 **既存 vitest の呼び出しを新シグネチャへ移行**（apply は vitest を触れないため propose が行う）:
  `goals.test.ts`（41件）・`goal-freeze.test.ts`（2件）の `createGoal` に `purpose` / `startReason` / `endDay` を追加し、
  従来の30日相当を保つ定数（`END_FROM_TODAY` / `GOAL_END`）を導入。`goals.test.ts` の `endGoal` 呼び出し1件を
  オブジェクト引数へ変更。**移行後 73/74 が通り、残る1件は意図した赤**（`endGoal` の新シグネチャ）。
- [x] 0.7 **既存 e2e の影響分を修正**（`POST /api/goals` の必須項目が増えるため。DOM の推測ではなく API 契約なので propose が行う）:
  `e2e/goal-input.ts` を新設（`addDaysKey` / `thirtyDayEnd`）し、`goal-freeze-reserve-flow` /
  `goal-rule-gate-loop` / `hide-achieved-once-rules` / `today-tab-answer-text-display` の4本へ
  `startReason` と `endDay` を追加。**現行サーバーで4本とも green を確認済み**（`CI=1 npx playwright test`）。
  `git diff -- e2e/` に差分あり。
- [x] 0.8 apply が実装後に書く新規 e2e が満たすべきフローを記録する（セレクタではなくフローで書く）:
  **「期限を決めて目標時間つきで目標を作る → 目標タブのカードに『今日あと N』が出る → 理由つきで終える → 大きい沿革の行に到達判定・めざした状態の答え・Before→After が並ぶ」**。

## 1. スキーマ

- [x] 1.1 `server/src/db/migrations.ts` に新規マイグレーションを追加する:
  - `goal_target_hours(goal_id PK, kind, seconds_per_day, label_snapshot, created_at)` ＋ `goal_id` に FK・CASCADE
  - `goal_target_hours_member(goal_id, ref, ord)` ＋ `(goal_id, ref)` UNIQUE（二重計上の防止）
  - `goal` へ `ended_day_key TEXT NULL` / `end_reason TEXT NULL` / `final_pace_json TEXT NULL` を追加
  - `goal` へ `start_reason TEXT NOT NULL`（作成理由・既存行には移行時に空文字を入れる）を追加
  - `goal` へ `outcome_caption TEXT NULL`（NULL＝証拠写真を求めない）/ `outcome_met INTEGER NULL`（NULL＝未回答・0＝できなかった・1＝できた）を追加
- [x] 1.2 既存 DB に対して no-op で当たり、**目標時間・証拠写真を持たない既存の目標が従来どおり動く**こと（`end_day = start_day + 29` のデータも有効・`purpose` が空の既存行を壊さない）を確認する。

## 2. サービス層

- [x] 2.1 `server/src/services/goals.ts` の作成処理を変更する: `endDay` を受け取り `end_day >= start_day` を検証。**30日既定を撤廃**する。`purpose`（めざす状態）と `startReason`（なぜ始めるのか）を**必須**にする。`targetHours` を任意で受け取り `goal_target_hours` / `_member` へ保存する。`outcomeCaption` を任意で受け取り、初期写真があれば**そのキャプションで `start_day` に保存**する（既存の目標画像の保存経路を使う）。
- [x] 2.2 `goalPace(db, goalId, today)` を追加する:
  - `elapsedDays` は `start_day` 〜 `min(today, 実効 end_day)`（今日を含む・**凍結日を除く**）
  - `accumulated` は kind ごとに既存集計へ委譲。`GROUP_SET` は**名前＋色 identity** で束ねた member 和（`today-group-breakdown` と同じ規則）、`TIMELINE` は持ち分秒、`TOTAL_WORK` は日次サマリの総作業秒
  - `todayRemain = max(0, seconds_per_day × elapsedDays − accumulated)`。到達済みは 0
  - `elapsedDays === 0` は null（ペースなし）
- [x] 2.3 `endGoal(db, goalId, { reason, outcomeMet, photo }, today)` を追加する（既存の完走フォーク「終える」処理を再利用。**進行中と完走で分岐しない**）:
  - 理由が空なら 400。`outcomeMet` は 3値（未指定＝NULL を許す）。`photo` は `outcome_caption` があるときのみ受け付け、当日 `day_key` にそのキャプションで保存する
  - `ended_day_key = today` を設定（**当日から効く**。既存の `editable-rule-registry` にそろえる）
  - 永続ルールを `status='removed'` にしてその日のゲートから外す（過去日の判定は変えない）。未発効の凍結予約を取り消し、**適用済みの延長と凍結の沿革は残す**
  - 終了時点のペースを `final_pace_json` へ、`outcomeMet` を `outcome_met` へ**焼き込む**
- [x] 2.4 目標の状態導出に「終了」（`today >= ended_day_key`）を加える。既存の開始前／進行中／完走の判定を壊さない。
- [x] 2.5 `goalHistory(db)` を追加する: 作成・終了・完走を `day_key` 昇順（同日内は id 昇順）で**決定的**に返す。
  - 到達/未達と `outcome_met` は**焼き込み値から読む**（再計算・再取得しない）
  - 証拠写真は**都度解決**する（`outcome_caption` に一致する `goal_image` を `day_key` 昇順で引き、最古＝Before・最新＝After）。解決規則は `goal-report ③` と一致させ、独自のグループ化を持たない
  - 欠けている要素（目標時間なし・未回答・写真なし）は**欠けたまま返す**（埋めない）
- [x] 2.6 `npx vitest run server/src/services/goal-target-hours.test.ts server/src/services/goals.test.ts server/src/services/goal-history.test.ts` が green になることを確認する（0.1・0.3・0.4・0.5 の赤を通す）。

## 3. API と契約

- [x] 3.1 `packages/contract/src/index.ts` に `GoalTargetHours` / `GoalPace` / `GoalHistoryEntry` を追加する。
- [x] 3.2 `POST /api/goals` を `endDay` 必須・`purpose` 必須・`startReason` 必須・`targetHours` / `outcomeCaption` 任意に拡張する（後方互換は不要。UI と同時に更新する）。
- [x] 3.3 `POST /api/goals/:id/end`（**理由必須**・`outcomeMet` 任意3値・`photo` 任意）を追加する。`GET /api/goals` のレスポンスに `pace` と `status='ended'` を含める。
- [x] 3.4 `GET /api/goals/history` を追加する。
- [x] 3.5 `server/static/js/api.js` に対応クライアントを追加する。

## 4. 目標タブ

- [x] 4.1 `server/static/js/goals.js` の作成フォームを変更する:
  - 「目的の一文」を **「めざす状態」** として前面に出し、**必須**にする。「終わるときにこれができたかを聞かれます」旨を添える
  - **「なぜ始めるのか」（作成理由）欄を新設**し、**必須**にする（終えるときの理由と対で大きい沿革に並ぶ）
  - **証拠写真の欄**（任意）: 「終わるときに写真を出す」チェック → キャプション入力 → 初期写真（任意・既存の `buildCreateImageStager` を再利用し、キャプションは固定にする）
  - 期限を**日付入力**にする。1週間 / 2週間 / 30日は**入力補助のボタン**（サーバーへは日付だけ送る）
  - 目標時間の欄（任意）: 対象の種類（グループ／総作業時間／カテゴリ）＋**グループは複数選択（or）**＋1日あたりの時間
  - 文言は **「パスワードの条件になりません／なります」** で統一する（「ゲートに効く」等の内部語彙を出さない）
- [x] 4.2 進行中カードに**めざす状態**を常時表示し、ペースブロックを描く: 対象名・目標時間・現在の平均・進捗バー・`今日 あと Z で到達`。
  - **到達済みは必要量の数字を出さない**（`✓ 到達` のみ）
  - **目標時間を持たない目標にはペースブロックごと出さない**
- [x] 4.3 カードに **「終える」** 導線を追加する（進行中・完走フォークの両方から**同じダイアログ**）:
  - めざした状態の3値（できた／できなかった／答えない）・証拠写真（`outcome_caption` があるときのみ）・理由（必須）
  - **当日から効く**旨を文面に出す（既存のルール削除と同じ挙動）
- [x] 4.4 カード一覧の**下**に「これまでの目標」（大きい沿革）を描く。行クリックでレポートへ。
  - 各行: 作成／終了／完走 ＋ 理由 ＋ 到達/未達 ＋ **めざした状態の答え** ＋ **証拠写真（Before → After）**
  - **欠けている要素は欠けたまま描く**（埋めない・行の形を変えない）
  - 未達・「できなかった」には **`×` を付けてよい**（診断であって断罪ではない）。ただし合格・不合格・スコア・点数・ランク・紙吹雪・バッジは出さない
  - **`×` を大きい沿革の外へ漏らさない**。到達判定を返すサーバーは記号を持たず、記号の付与は沿革の描画側だけが行う（レポート①〜⑤・カード・今日タブと表示コンポーネントを共有しない）
  - ルール操作・凍結・日記を載せない。今回は**縦の一覧**（横スクロールUIは次の change）

## 5. 今日タブ

- [x] 5.1 `server/static/js/today.js` の `show()` で、**既存の `overviewRegion` より前**にペース行の region を挿入する。
- [x] 5.2 目標時間を持つ進行中の目標について1行ずつ（`平均 X / 目標Y`・`今日 あと Z`・目標タブへの導線）を描く。該当なしなら**何も描かない**。
- [x] 5.3 **既存のゲート表示（`gate-hero` / 条件の進捗 / パスワード）の DOM 構造・クラス名・意味を変更しない**ことを確認する。30秒リフレッシュの対象はゲート領域のまま。

## 6. レポート②

- [x] 6.1 目標時間がある場合、②のグラフに**水準線を1本**足す。既存の下限の閾値表示と**視覚的に区別**する。
- [x] 6.2 目標時間が無ければ水準線を描かない。②のブロックが現れる条件（時間型実践を持つこと）を変えない。**新しいブロックを足さない。**
- [x] 6.3 **③（Before/After）は一切変更しない**ことを確認する。証拠写真は `outcome_caption` で保存されるため、既存のキャプション・グループ化機構がそのまま Before/After を描くはずである（実機で確認する）。

## 7. デモモード

- [x] 7.1 `server/src/services/demo-seed.ts` に、目標時間と証拠写真を持つサンプルと、**理由・めざした状態の答え・Before/After 写真つきで終了した目標1本**を固定 `day_key` で追加する（`Date.now()` 非依存）。既存の達成 24/30・中盤の谷の筋書きを壊さない位置へ寄せる。
  - 大きい沿革の「3つが並ぶ行」がデモで実際に見えることを、この change の成果として明示する。
- [x] 7.2 ペース表示はデモの**仮想日付**を分母に使う経路を通す。
- [x] 7.3 `server/src/services/demo.test.ts` の期待値を更新する。
- [x] 7.4 `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動し、`POST /api/demo/reset` → 目標タブでペースと大きい沿革が出ること、レポート②に水準線が出ることを実サーバー経路で確認する（プロジェクトルール: 日数が関わる機能はデモモードで成果を明示する）。

## 8. e2e（DOM 確定後に apply が書く）

- [x] 8.1 `e2e/goal-target-hours.spec.ts` を追加する。背骨1本: 期限を日付指定し、目標時間つき・証拠写真キャプションつき・初期写真つきで作成 → カードにめざす状態と `今日 あと …` が出る → めざした状態「できなかった」＋写真＋理由で終える → **大きい沿革の行に3つ（到達判定・答え・Before→After）が並ぶ**。
- [x] 8.2 **骨抜きでないことを機械で証明する**:
  ```pwsh
  git stash push -- server/ extension/ packages/
  $env:CI="1"; npx playwright test e2e/goal-target-hours.spec.ts   # 落ちること
  git stash pop
  npx playwright test e2e/goal-target-hours.spec.ts                # 通ること
  ```
  stash 側が通ってしまったら書き直す（`CI=1` は必須。無いと `reuseExistingServer` で偽の緑になる）。
- [x] 8.3 `CI=1 npx playwright test`（フルスイート）で既存 e2e に回帰が無いことを確認する。

## 9. 最終確認

- [x] 9.1 `npm test`（vitest 全体）と typecheck が green であることを確認する。
- [x] 9.2 **`git diff -- server/src/rules/evaluate.ts` が空であること**を確認する（design D3: 目標時間はゲートに合流しない）。
- [x] 9.3 目標時間・証拠写真を持つ目標が1つも無いとき、今日タブ・ゲート・レポート・凍結の挙動が変更前と完全に一致することを確認する。
- [x] 9.3b **`git diff -- server/src/services/goals.ts` のレポート③生成部が空であること**を確認する（証拠写真は既存のキャプション機構に乗るだけで、③の実装を触らない）。
- [x] 9.4 `openspec validate goal-target-hours-and-open-period --strict` が通ることを確認する。
- [x] 9.5 `/opsx:archive` で delta spec（`goal-target-hours` / `goal-history` / `goal-challenge` / `goal-lifecycle-fork` / `goal-report`）をメインspecへ sync してからアーカイブする。
