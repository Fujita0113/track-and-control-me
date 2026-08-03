## 1. サービス層（バックエンド）

- [x] 1.1 `server/src/services/day-allocation.ts` の `DayAllocation` に `workSeconds: number` と `avgWorkSeconds7d: number` を追加する。
- [x] 1.2 `getDayAllocation()` で `workSeconds` を `totalWorkSecondsForDay(db, dayKey)`（`services/categories.ts`、`daySummary().totalWorkSeconds` と同一関数）から求める。
- [x] 1.3 `getDayAllocation()` で `avgWorkSeconds7d` を、`addDaysKey(dayKey, -1)`〜`addDaysKey(dayKey, -7)` の7日分について `totalWorkSecondsForDay()` を呼び、合計を7で割って（`Math.round`）求める。記録の無い日は自然に0として加算される（レコードが無ければ `totalWorkSecondsForDay` は0を返す＝分母から除外する特別処理は書かない）。
- [x] 1.4 記録が1件も無い日（早期リターンする分岐、`day-allocation.ts:75-77`）でも `workSeconds`/`avgWorkSeconds7d` は通常どおり計算して返す（母数ゼロと独立に計算できることを確認）。
- [x] 1.5 `server/src/services/day-allocation.test.ts` の (h)(i)(j) を通す（このテストは propose 時点で赤にしてある。凍結対象＝変更禁止）。

## 2. フロントエンド（振り返りタブ）

- [x] 2.1 `server/static/js/reflection.js` の `buildAllocCard()` を、`alloc.workSeconds`/`alloc.avgWorkSeconds7d` から差分を計算し `.rf-alloc-head` 内に表示するよう変更する。
- [x] 2.2 差分の表示形式: 差分 > 0 は `+Nh Nm`、差分 < 0 は `-Nh Nm`、差分 === 0 は `±0`（`fmtDur` 等の既存フォーマッタを流用し符号を付与するヘルパーを追加）。
- [x] 2.3 空状態（記録が無い日・`alloc.totalSeconds === 0`）の分岐でも同じ差分表示を出す（design.md の通り、母数ゼロでも `workSeconds`/`avgWorkSeconds7d` は独立に計算されているため）。
- [x] 2.4 `server/static/css/app.css` に差分表示用のクラスを追加する（`.rf-alloc-head` は既に `display:flex; flex-wrap:wrap;` なので子要素を1つ足すだけで良い）。色は価値判断をしない中立トーン（`.gr-marker-delta` 相当）。既存ルールは変更しない・ファイル全体の再整形はしない。

## 2.5 issue #81 追加コメントによる補完（propose 不要・同一 change 内で対応）

issue #81 の最新コメントで、差分表示だけでは「実際に何時間使ったか」の絶対値が読み取れないという
フィードバックがあった。`design.md` の Goals には元々「対象日の総作業時間を表示する」が含まれていたが、
`specs/.../spec.md` の Requirement 文言・シナリオが差分のみに絞られ、`tasks.md` もそれに従っていたため
実装から漏れていた。`workSeconds` は既に API が返しているためバックエンド変更は不要、フロント表示の追加のみ。

- [x] 2.5.1 `specs/reflection-day-overview/spec.md` の「一日の配分バー」要件に、総作業時間の絶対値表示を
      明記する箇条書きとシナリオ「総作業時間の絶対値が表示される」を追加する。
- [x] 2.5.2 `buildAllocCard()` に、今日タブの `.stat .num`/`.stat .lbl` と同じ「大きな数字＋ラベル」の
      視覚言語で総作業時間の絶対値（`fmtDur(alloc.workSeconds)` + `総作業時間`）を表示する行を追加する。
      差分表示（`.rf-alloc-delta`）はその隣へニュートラルなピル（バッジ）として並べ、視認性を上げる。
- [x] 2.5.3 デモモードで実測し、既存 e2e（`reflection-alloc-today-avg.spec.ts`）を新しい絶対値表示も
      アサートするよう拡張する（新規 e2e は凍結対象外・apply が最後に書く運用のため編集してよい）。

## 3. デモモードでの確認（プロジェクト必須ルール）

- [x] 3.1 `PORT=<空きポート> DB_PATH=:memory: npm run server` を起動し、`POST /api/demo/reset` → デモの一日の配分表示（`GET /api/demo/timeline/:date/allocation` 経由、`showDemo()`）で `workSeconds`/`avgWorkSeconds7d`/差分表示が実際に出ることを確認する。デモは `getDayAllocation()` をそのまま呼ぶだけなので追加実装は不要なはずだが、既存の谷日（Day15）を壊していないか実測で確認する。
  → 確認済み。Day15（2026-06-25）: `workSeconds=7800`（2h10m）・`avgWorkSeconds7d=12720`（3h32m）→ 差分 `-1h 22m`。既存の谷（作業が伸びない）の筋書きと整合する負の差分になっており、谷日の演出を壊していない。
- [x] 3.2 デモの既存サンプルで差分が意味のある値（0でない、極端でない）になっているか確認し、必要なら `demo-seed.ts` の直近日データを見直す（既存の達成日数・谷日の筋書きは壊さない）。
  → 全30日ぶんの `workSeconds`/`avgWorkSeconds7d` を実測（`+15000`〜`-5743` 秒の範囲で分布）。0秒・極端な値は無く、`demo-seed.ts` の変更は不要だった。

## 4. 既存 e2e への影響

既存 E2E への影響なし。`.rf-alloc-head` の内容を直接アサートしている既存 e2e は無い
（`e2e/demo-allocation.spec.ts` は `.rf-alloc-card` 内の `.rf-bar-row`/`.rf-bar-label`/`.rf-bar-val` のみを見ており、
`e2e/reflection-plan-view-chrome.spec.ts` は `.rf-viewtab` のタブ切替のみを見ている。いずれも今回のヘッダ追加とは無関係）。

## 5. 新規 e2e（apply が DOM 確定後に書く）

- [x] 5.1 フロー「振り返りタブで一日の配分ビューを開くと、今日の作業時間と直近7日平均との差分が表示される」を新規 e2e としてカバーする。
      `e2e/reflection-alloc-today-avg.spec.ts` として追加。`.rf-alloc-delta` に表示される。
      観点: (c) はデモ開始前の素の状態（記録皆無 → 総作業時間・平均とも0）で `±0` を確認。
      (a) はデモ開始直後のプレビュー日（Day4）で `+3h 11m` を確認。
      (b)(d) はデモを Day15 まで進め、`demo:refresh` による自動再描画で `-1h 22m` へ更新されることを確認。
      赤証明済み（`git stash` + `CI=1` で実装無しは失敗、実装ありは成功）。

## 6. 動作確認

- [x] 6.1 `npm test`（vitest）を実行し、1.5 の新規テストが通ることと既存テストにデグレが無いことを確認する。
  → 36 files / 421 tests すべて成功。
- [x] 6.2 `npx playwright test`（既存 e2e 一式）を実行し、デグレが無いことを確認する。
  → 44 tests すべて成功（新規 `reflection-alloc-today-avg.spec.ts` を含む）。
