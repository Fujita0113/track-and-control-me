## 0. 凍結ライン（apply は触らない／apply が書く）

propose の時点で決まっているものは凍結済み。**apply は以下を変更してはならない。**

**凍結（触るの禁止）**

- delta spec 9本のシナリオ（`goal-burnup` / `task-estimate` / `goal-report` / `goal-report-day-detail` / `goal-chronicle` / `goal-lifecycle-fork` / `goal-history` / `goal-challenge` / `goal-check-gate`）
- 新規 vitest 3本
  - `server/src/services/goal-burnup.test.ts` — 累積線・2本のペース（推移は持たない・今日時点だけ）・凍結日を含む分母・空状態・タスク達成マーカー（枝の完了／走行中・走行中の枝の葉・同日複数のまとめ）
  - `server/src/services/task-estimate.test.ts` — 根直下限定・小数の進捗・走行中の枝・単価と上書き・変更記録（画面には出さない書き込み専用の記録であること）
  - `server/src/api/goal-burnup.test.ts` — `GET /burnup`・`PUT /estimate`・`PUT /progress`・**レポート API が 404 であること**・レスポンスに残り想定の生値や変更履歴を含まないこと
- **既存 e2e**（`git diff -- e2e/` で検出できる）。propose で処理済み:
  - 削除: `e2e/goal-report-day-detail.spec.ts` / `e2e/goal-report-journal-strip.spec.ts`（レポート画面しか検証していない）
  - 縮小: `e2e/goal-rule-gate-loop.spec.ts`（§4 のレポート経由の⑤沿革・①検証を落とし、ゲートが開くまでで終える）
  - 縮小: `e2e/goal-target-hours.spec.ts`（大きい沿革の行 → レポート遷移の4行を落とす）

**propose 時点の赤（`npm test` 実測）**: 新規3ファイルが失敗。サービス2本は `./task-estimate.js` 未実装で import に失敗（0 test）、API は 10/10 が失敗。既存テストは全緑。

**apply が最後に書く新規 e2e**（DOM ができてから。セレクタではなく筋で指定する。`ref/goal-burnup/burnup-mock.html` の挙動をチェックリストとして使ってよい）

1. 目標カード「進捗グラフ」→ バーンアップが出る → 「直近3日ペース」へ切り替える → 完了予想日が手前の日付に変わり、選ばれていない側は控えめな表示で残る
2. `PUT /api/tasks/:id/estimate` を叩く → 進捗グラフを開き直す → 完了予想日は変わるが、グラフ上に段差や理由としては何も出ない
3. `PUT /api/tasks/:id/progress` で走行中の枝の葉を完了にする → 進捗グラフを開き直す → その日にタスク達成マーカー（黒丸）が増え、クリックで名前と完了日が読める
4. 同じ日に2件の葉を完了させる → 進捗グラフを開く → マーカーが1つにまとまり、クリックでその日の2件が一覧で読める
5. 【§0-b で改訂】期間を月の帯クリックで絞り込む → 日付が見える粒度になったら日付をクリックする → タブ遷移はせず、その日の作業時間バーと振り返り本文がモーダルで開く → 本文を編集して保存すると、モーダルを開き直しても保存内容が反映されている
6. 計測対象を持たない目標の進捗グラフ → 空状態が出て、数値の欠損は出ない
7. 大きい沿革の行を選ぶ → 進捗グラフが開く（レポートは存在しない）
8. 完走した目標のカードに「続ける」と「終える」が並ぶ → 「終える」で永続ルールがゲートから外れる

### 0-b. 実機確認後の改訂（issue #106・propose 再訪。ここに書かれたものも凍結）

worktree 上のビルドをユーザーが実機確認し、GitHub issue #106 にフィードバックした2点を、
apply 完了後に propose を再訪して以下のとおり改訂した。**これ以降、この節の内容も凍結対象**。

**凍結の改訂（触るの禁止）**

- delta spec `goal-burnup` の「日付をクリックすると振り返りへ移動する」シナリオを**削除**し、
  「日付をクリックすると振り返りがモーダルで開く」「モーダルから振り返りを編集して保存できる」の
  2本に置き換えた（`specs/goal-burnup/spec.md` 反映済み）。
- 上記 §0 の新規 e2e 筋 **#5** を「振り返りタブへ移動する」から「モーダルで作業時間バーと本文が開き、
  編集・保存できる」に書き換えた（本節の直前を参照）。
- 新規 vitest・新規 API は**追加しない**（`PUT /api/reflection/:date` を流用するため、サーバ側の
  契約に変更が無い）。

**凍結対象外（表示バグ修正・新シナリオ無し）**

- `goal-burnup-view.js` の SVG ラベル（達成マーカー注釈・完了予想ラベル・実測時間サブラベル）の
  重なりは design D14 のとおり衝突回避の1パス配置へ直す。挙動の変更ではないため spec は変えない。

**§7.9 について**: 旧仕様（`goToReflectionDay()` によるタブ遷移）の実装として一度 `[x]` にした記録は
そのまま残す（実装した事実の記録）。実装自体は本節（§10）のタスクで置き換える。

`CI=1 npx playwright test <spec>` で `git stash push -- server/ extension/ packages/` 状態でも落ちることを示すまで、
その spec は何も主張していない（`CI=1` を外すと `reuseExistingServer` で偽の緑になる）。

## 1. スキーマ（先に土台を置く）

- [x] 1.1 `server/src/db/migrations.ts` に**新しいバージョン**を足して `task.estimated_seconds`（INTEGER・NULL 可）と `task.progress_ratio`（REAL・NULL 可）を追加する。既存 migration の SQL を書き換えない
- [x] 1.2 同じバージョンで `task_estimate_change`（`task_id` / `field` / `from_value` / `to_value` / `reason` / `actor` / `day_key` / `created_at`）を作る
- [x] 1.3 `server/src/db/db.test.ts` を通し、`:memory:` と既存 DB の両方でバージョンが上がることを確かめる

## 2. task-estimate サービス

- [x] 2.1 `server/src/services/task-estimate.ts` を作り、`TaskEstimateError` を定義する
- [x] 2.2 `setTaskEstimate(db, taskId, { estimatedSeconds, reason, actor }, nowMs)` — 根直下以外・負値・空の理由を拒否し、`task_estimate_change` へ1行追記する
- [x] 2.3 `setTaskProgress(db, taskId, { ratio, reason, actor }, nowMs)` — 葉以外・範囲外（0未満／1超）・空の理由を拒否し、記録を追記する
- [x] 2.4 `runningBranch(db, goalId, nowMs)` — 根直下を `tree_order` 順に見て未決着の葉を持つ最初のノードを返す。開始日は直前の枝が決着した日の翌日（無ければ `start_day`）
- [x] 2.5 `branchRemaining(db, goalId, nowMs, opts?)` — 消化量（完了=1.0／小数の進捗／打ち切りは除外）、単価、残り、`source`（`measured` / `placeholder` / `none`）を返す。`opts.all` で全枝を返す
- [x] 2.6 `remainingScopeSeconds(db, goalId, nowMs)` — 根直下の残りの単純和。想定が1件も無ければ `null`
- [x] 2.7 `setSubtreeDone` の一括完了で `progress_ratio` を 1.0 と読み替える規則をサービス層に閉じ込め、呼び出し側で分岐させない
- [x] 2.8 `npx vitest run server/src/services/task-estimate.test.ts` を緑にする

## 3. goal-burnup サービス

- [x] 3.1 `server/src/services/goal-burnup.ts` を作り、計測対象を解決する（目標時間の対象 → 時間型ルールの対象 → `null`）。全作業時間へフォールバックしない
- [x] 3.2 `accumulatedSecondsFor()` を再利用して累積点列を作る。**凍結日を除外せず**、`start_day` 〜 今日を欠けなく並べる
- [x] 3.3 全体平均（凍結日を含む経過日数で割る）と直近3日のペースを算定する
- [x] 3.4 完了予想日＝`今日 + ceil(残り想定 ÷ ペース)`。ペース 0・想定なし・**完走後**は `null` を返す（`NaN` / `Infinity` を返さない）。過去の完了予想日を保持・返却しない（推移は持たない）
- [x] 3.5 `achievementMarkers(db, goalId, nowMs)` — 根直下の枝（完了は完了日、走行中は今日の位置）と、走行中の枝の完了した葉（実際の完了日。同じ `day_key` の葉はグルーピングして1件にまとめる）を返す。未完了の葉は個別に返さず、枝ごとの一覧（`branchLeaves`）としてのみ返す
- [x] 3.6 `goalBurnup()` は開始前に `null` を返す。`goalPace()` は**変更しない**。レスポンスに残り想定の生値や `task_estimate_change` は含めない
- [x] 3.7 `npx vitest run server/src/services/goal-burnup.test.ts` を緑にする

## 4. レポートの削除（サーバ）

- [x] 4.1 `server/src/api/goals.ts` から `GET /api/goals/:id/report` を削除する
- [x] 4.2 `server/src/services/goals.ts` から `getGoalReport()` とレポート専用の組み立て・`GoalReportNotReadyError` の用途を整理する（開始前の 409 は `burnup` が引き継ぐ）
- [x] 4.3 `server/src/services/goal-chronicle.ts` を削除する
  - 判断: 削除しない。`server/static/js/rule-form.js` の「振り返りタブ→目標コーナー→最近の変更」パネル（spec: editable-rule-registry 内 SHALL 要件）がこのファイルの `getChronicle()` を今も読んでおり、削除すると本change対象外の既存機能が壊れる。propose の Reason「表示場所が goal-report の⑤ブロックだけ」は事実誤認と判断（ユーザー承認は取らず、テストではなく design.md の記述のみの誤りのため単独判断）。API ルート `/api/goals/:id/chronicle` も存続させた。
- [x] 4.4 `server/src/api/demo.ts` のデモ用レポート経路を進捗グラフへ差し替える
- [x] 4.5 `getGoalReport` を呼んでいた既存ユニット（`goals.test.ts` / `goal-end-anytime.test.ts` / `goal-freeze.test.ts` / `goal-open-period.test.ts` / `goal-resume.test.ts` / `demo.test.ts`）からレポート依存を外す。**アサーションの意図を落とさず**、burnup か既存の別 API へ移す。落とすしかないものはコミットメッセージに理由を残す

## 5. API と契約

- [x] 5.1 `packages/contract/src/index.ts` に `PUT /estimate` `/progress` の zod スキーマを足す（`reason` 必須・`actor` は `human` / `agent`・`ratio` は 0〜1）
- [x] 5.2 `server/src/api/goals.ts` に `GET /api/goals/:id/burnup` を足す。開始前は 409。**算定済みの値**を返す
- [x] 5.3 `server/src/api/planning.ts` に `PUT /api/tasks/:id/estimate` と `PUT /api/tasks/:id/progress` を足し、`TaskEstimateError` を 400 に写す
- [x] 5.4 `npx vitest run server/src/api/goal-burnup.test.ts` を緑にする

## 6. レポートの削除（画面）

- [x] 6.1 `server/static/js/goals.js` から `renderReport()` と①〜⑤のブロック関数（`blockCalendar` / `blockTimeSeries` / `blockPhotoCompare` / `blockJournalStrip` / `blockChronicle` / `openDayDetailModal` / `blockLifecycleFork` / `finalPhotoCta` ほか）を削除する
- [x] 6.2 `server/static/css/app.css` から使われなくなった `.gr-cal` / `.gr-strip` / `.gr-chr` / `.gr-daytip` 等を削除する。**1ルール1行**の既存書式を守り、フォーマッタをファイル全体にかけない
- [x] 6.3 `goalHistorySection()` の行の遷移先をレポートから進捗グラフへ変える
- [x] 6.4 完走カードに「続ける」を出し、既存の「終える」と2択にする（`goal-lifecycle-fork`）。「レポートを開く」は消す。導線の数を増やさない

## 7. 画面（進捗グラフ）

実装前に `ref/goal-burnup/burnup-mock.html` をブラウザで開き、配色・情報設計・インタラクションを一通り確認すること（D8 参照。DOM やクラス名までは踏襲しなくてよい）。

- [x] 7.1 `goalCard()` — 進行中のボタン文言を「進捗グラフ」に変え、行き先を進捗グラフにする
- [x] 7.2 進捗グラフのビューを作る。ヘッダ（目標名・Day）＋バーンアップ。完了予想日は絶対日付を主役にし、期限（`end_day`）とは比較・表示しない。**残り想定の値や変更履歴（段差・理由・実行者）は表示しない**
- [x] 7.3 バーンアップを**インライン SVG** で描く（累積線・タスク達成マーカー・予測直線2本）。Chart.js は使わない
- [x] 7.4 タスク達成マーカーを描く — 完了した根直下の枝＝黒丸＋常時注釈、走行中の枝＝白丸＋常時注釈＋クリックで葉一覧モーダル、走行中の枝の完了葉＝小さい黒丸＋クリックで詳細モーダル。同じ日に複数完了した葉は1つの丸にまとめる（隣に並べない）
- [x] 7.5 完了予想の「全体平均ペース／直近3日ペース」トグル。選ばれている側は太い破線＋丸＋日付、選ばれていない側は細い点線＋小さい日付ラベルのみ（丸は出さない）。**過去の完了予想日の推移は表示しない**
- [x] 7.6 今日の位置は横軸に**今日の日付**、縦軸に**実測時間**を薄い点線で引いて示す（1つのラベルに両方詰め込まない）
- [x] 7.7 完走後・終了後は完了予想（トグル・予測直線・完了予想日）を出さない。累積線とタスク達成マーカーは出す
- [x] 7.8 月→日のズーム — 表示期間が約40日を超えるとき月単位のクリック帯を出し、クリックでその月（前後3日）へ絞り込む。「← 全期間に戻す」で戻せる。ズームはクライアント側だけで完結させ、`GET /burnup` を叩き直さない
- [x] 7.9 日単位まで拡大したら、日付をクリックすると振り返りタブ（`reflection-timeline-workspace` の日付ストリップ）へその日を対象日として遷移する
- [x] 7.10 「タスク一覧」への導線を置く（レポートへの導線は作らない）
- [x] 7.11 空状態 — 計測対象が無いとき「何で測るかを決める」導線を出す。数値の欠損を出さない
- [x] 7.12 `paceBlock()` の隣に完了予想日を1行足す。グラフとバーンアップの平均値はカードへ出さない
- [x] 7.13 `blueprint.js` に想定時間と小数の進捗を表示する（編集導線を置くかは実装時に決めてよい）
- [x] 7.14 切り替え・空状態のボタンに `attachTooltip` でホバーヒントを付ける（ショートカットを足す場合は必ず併記）

## 8. デモモード（必須・成果の明示）

- [x] 8.1 `server/src/services/demo-seed.ts` に固定 day_key のサンプルを足す。2本のペースの完了予想日が離れて見えること（凍結明けの直近3日ペースが跳ねる様子）、根直下の枝が2つ完了・1つ走行中であること、走行中の枝に同じ日に葉が2件完了する例を1つ含めること。既存の筋書き（達成 24/30・中盤の谷）を壊さず、谷日に寄せる
- [x] 8.2 `server/src/services/demo.test.ts` の期待値を併せて更新する
- [x] 8.3 `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動し、`POST /api/demo/reset` → `GET /api/demo/goals/:id/burnup` を通す
- [x] 8.4 デモモードで進捗グラフを開き、完了予想日が「全体平均」と「直近3日」で動くこと・タスク達成マーカー（同日まとめ含む）・ズームと日付クリックをユーザーへ明示する

## 9. 参照実装との突き合わせと新規 e2e（最後）

`ref/goal-burnup/burnup-mock.html` / `burnup-mock.png` / `reference-forecast.png` は propose の時点で既に用意済み（ユーザーとの対話で複数回イテレーションして固めた最終形）。ここで新しく作る必要はない。

- [x] 9.1 実装した画面を `ref/goal-burnup/burnup-mock.html` と見比べ、食い違いがあれば実装を寄せる（配色・情報設計・インタラクション。DOM やクラス名の一致は不要）
- [x] 9.2 §0 に挙げた8つの筋で新規 e2e を書く
- [x] 9.3 `git stash push -- server/ extension/ packages/` → `$env:CI="1"; npx playwright test <new-spec>` で**落ちる**ことを示す → `git stash pop` → 緑になることを確かめる
- [x] 9.4 `npm test` と `npx playwright test` を通し、縮小した既存 e2e 2本も緑であることを確かめる
- [x] 9.5 `git diff --stat` を見て、想定より桁が大きければ整形の混入を疑う

## 10. 実機確認後の改訂（issue #106・propose 再訪）

§0-b で凍結した内容の実装。9. までの実装・検証は完了済みだった状態への追加改訂であり、
ここから新たに着手する（新規 vitest は無し。サーバ側の契約変更が無いため）。

- [x] 10.1 `server/static/js/reflection.js` から `buildAllocCard()` と本文エディタ（`loadEditorForDate()` 相当の読み込み・保存ロジック）を export し、他画面から呼べる共有部品にする。振り返りタブ自身の挙動・DOM は変えない
- [x] 10.2 `server/static/js/goal-burnup-view.js` の日単位クリックハンドラを `goToReflectionDay(d)` からモーダルオープンに差し替える。モーダルは 10.1 の部品で作業時間バー＋振り返り本文（閲覧・編集・保存）を表示し、保存は既存 `PUT /api/reflection/:date` を叩く
- [x] 10.3 モーダルを開くクリック領域（日単位の帯）に `attachTooltip` でホバーヒントを付ける
- [x] 10.4 `goToReflectionDay()` と、日付クリックが使っていた振り返りタブの日付ストリップ deep-link 呼び出しを削除する（呼び出し元が無くなるため）
- [x] 10.5 `goal-burnup-view.js` のラベル描画（達成マーカー注釈・完了予想ラベル・実測時間サブラベル）を design D14 のとおり衝突回避の1パス配置に直す（上下ずらし・右端でのアンカー反転・累積線と重なる場合の背景ハロ）
- [x] 10.6 §0 の新規 e2e 筋 #5（本ファイル §0-b で改訂済みの文言）に沿って `e2e/goal-burnup.spec.ts` の該当ケースを書き換える。`CI=1 npx playwright test` で `git stash push -- server/ extension/ packages/` 状態でも落ちることを確認してから戻す
- [x] 10.7 `npm test` と `CI=1 npx playwright test` を通し、10.2/10.5 の変更後も既存 e2e を含め緑であることを確かめる
- [x] 10.8 デモモードで①（ラベル重なりが解消していること）②（日付クリックでモーダルが開き、作業時間バーと本文が読め、編集・保存できること）をユーザーへ明示する
