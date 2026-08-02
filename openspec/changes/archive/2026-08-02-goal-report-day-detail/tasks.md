## 0. 凍結テスト（該当なし）

> プロジェクトルール「テストの凍結ライン」に従い、vitest（サービス・API 層）は propose が赤で置く決まりだが、
> **本 change はサーバー層（DB・API・サービス）を一切変更しない**（design 参照: 既存の
> `GET /api/summary`・`GET /api/reflection/:date`・`PUT /api/reflection/:date` を再利用するのみ）。
> したがって凍結すべき vitest 対象が無い。**新規 vitest は無し。**
>
> 新規 e2e は propose では書かない（DOM が未確定のため）。apply が実装後に、以下のフローで1本書く：
> **「①のマスにホバーするとプレビューが出る → クリックするとモーダルが開く → 振り返りを編集して保存 →
>   レポートが再描画され①のプレビュー・④の本文の両方に反映される」**
>
> 既存 e2e への影響: **無し**（①のクリック時に既存どおり④選択・ハイライトが動くことは変更しない。
> モーダルを追加で開くだけなので、既存の `goal-rule-gate-loop.spec.ts`・`goal-target-hours.spec.ts` 等、
> レポート画面に触れる e2e の挙動は変わらない）。`git diff -- e2e/` で無変更であることを確認する。

## 1. ホバープレビュー

- [x] 1.1 `server/static/js/goals.js` の `blockCalendar()` で、ヘッダの Day 番号（`.gr-cal-dh`）とルール行のセル（`.gr-cell`）の両方に `mouseenter`/`mouseleave`（または `title` 属性ではなく独自ツールチップ）を追加する。
  - 表示内容は `rep.days[dayNumber-1].text`（空なら「未記入」）。**新規の API 呼び出しをしない**。
  - 既存の `title` 属性（`Day N: やった/やってない/...`）と役割が重複しないよう整理する（両方出すか、ツールチップに一本化するかは実装時に決める）。
- [x] 1.2 ツールチップの CSS を `server/static/css/app.css` に追加する（`.gr-cal` 周辺の既存クラスと衝突しない命名にする）。
- [x] 1.3 デモモードでも同じホバー処理が動くことを確認する（`rep.days` はデモの report レスポンスにも含まれるため、分岐不要のはず）。

## 2. 日別詳細モーダル

- [x] 2.1 `blockCalendar()` の既存 `click` ハンドラ（`rs.renderReader(dayNumber)` 呼び出し）に、モーダルオープン処理を追記する。**既存の `renderReader` 呼び出しは削除しない**。
- [x] 2.2 `isDemo()` が true のときはモーダルオープンをスキップする（既存の `renderReader` のみ実行）。
- [x] 2.3 モーダル本体を新設する（`server/static/js/goals.js` に関数追加、例 `openDayDetailModal(rep, dayNumber)`）。
  - ブロック1「この日にやったこと」: `rep.rules[*].cells[dayNumber-1]` を並べる。既存の①のラベル・アイコン関数（`ruleKindIcon` / `ruleNiceLabel`）を再利用する。
  - ブロック2「時間の内訳」: `api.getSummary(dayKey)` を呼び、グループ別秒数を表示する（今日タブのグループ別表示と同じ整形関数を再利用できないか確認する）。目標時間があれば対象グループの実測とその日1日ぶんの目標時間（`secondsPerDay`）を並べて表示する。
  - ブロック3「気分・振り返り」: `api.getReflection(dayKey)` を呼び、気分（5段階・`.rf-mood-seg` と同じ見た目を再利用）と本文（textarea）を表示する。
- [x] 2.4 `rep.days[dayNumber-1].source === 'journal'` の場合、目標日記の本文（`rep.days[dayNumber-1].text`）を読み取り専用ブロックとして追加表示する（編集導線は出さない）。
- [x] 2.5 保存ボタン: `api.putReflection(dayKey, content, satisfaction)` を呼び、成功したらモーダルを閉じて `renderReport(root, goalId)` を呼び直す（差分更新はしない）。
- [x] 2.6 変更せずに閉じた場合は `putReflection` を呼ばないことを確認する。

## 3. 手動確認

- [x] 3.1 `npm run server` で起動し、目標を1つ作って数日ぶんデータを溜め、実機でホバー・クリック・編集・保存・再描画を確認する。
- [x] 3.2 デモモードで①のマスをクリックしてもモーダルが開かず、④の選択・ハイライトのみ動くことを確認する。
- [x] 3.3 目標日記が存在する日を作り、モーダル内に読み取り専用で表示されることを確認する。

## 4. e2e（DOM 確定後に apply が書く）

- [x] 4.1 `e2e/goal-report-day-detail.spec.ts` を追加する。背骨1本: ①のマスにホバー→プレビュー確認 → クリック→モーダルが開く → 気分・本文を入力して保存 → レポート再描画後、①の同じマスのホバープレビューに新しい文面が出る。
- [x] 4.2 骨抜きでないことを機械で証明する:
  ```pwsh
  git stash push -- server/ extension/ packages/
  $env:CI="1"; npx playwright test e2e/goal-report-day-detail.spec.ts   # 落ちること
  git stash pop
  npx playwright test e2e/goal-report-day-detail.spec.ts                # 通ること
  ```
- [x] 4.3 `CI=1 npx playwright test`（フルスイート）で既存 e2e に回帰が無いことを確認する。

## 5. 最終確認

- [x] 5.1 `git diff -- server/src/` が空であることを確認する（design: サーバー層は一切変更しない）。
- [x] 5.2 `openspec validate goal-report-day-detail --strict` が通ることを確認する。
- [x] 5.3 `/opsx:archive` で delta spec（`goal-report-day-detail`）をメインspecへ sync してからアーカイブする。
