## Why

レポート③の「Day1 と Day30 の文面を左右に並べる Before/After」は、実際には読まれていない（issue #91）。読みたいのは初日と最終日の対比ではなく、30日ぶんの日記を**流れとして**めくることであり、いまの④「日記リーダーは常に1件表示」はそれを禁じている（`goal-report` の MUST NOT）。1日の精読はすでに①クリックの日別詳細モーダル（`goal-report-day-detail`）が担っており、④の「1件ずつ静かに読む」は役割が重複したまま、流し読みという実際の用途を塞いでいる。

一方、③の**写真の比較**（同じキャプションの最古と最新を並べる／全枚数を並べる）は時系列ストリップでは代替できない唯一の機能であり、残す。

## What Changes

- **BREAKING（仕様の反転）**: ④日記リーダーの「常に1件表示 / 30日分を同時に並べてはならない（MUST NOT）」を撤回し、**日記を横スクロールのストリップで全件提示**する。記録のある日だけがカードになり、各カードはその日の本文とその日の画像を持つ。
- ③から**文面の Before/After 並置（Day1 / 最終日の左右2カラム）を削除**する。ブロックの見出しは「③ Before / After」から「③ 写真の比較」へ改める。
- ③の**写真比較（デフォルト＝最古/最新、全比較モード）と最終日写真の CTA は現状のまま残す**。③が写真専用ブロックになるだけで、画像まわりの挙動は変えない。
- ①のマスをクリックしたときの④との連動を、「セレクタで1件を選ぶ」から「**該当日のカードへスクロールして強調する**」へ読み替える。①⇔④の連動そのものは捨てない。
- ①の日別詳細モーダル（`goal-report-day-detail`）は挙動を変えない。④の形が変わることに追随して文言のみ更新する。

## Capabilities

### New Capabilities

（なし。既存レポート画面の要件変更のみ）

### Modified Capabilities

- `goal-report`: ③の要件から文面並置を削除し写真比較ブロックとして規定し直す／④の要件を「常に1件」から「横スクロールで全件」へ反転する
- `goal-report-day-detail`: ①のマスクリック時に維持すべき④側の挙動を「選択・ハイライト更新」から「該当カードへのスクロールと強調」へ改める

## Impact

- `server/static/js/goals.js`: `blockBeforeAfter`（文面並置 `gr-ba` / `baCol` の削除）、`blockReader`（セレクタ＋単一本文 → ストリップ）、`renderReport` の `readerState` 連動
- `server/static/css/app.css`: `.gr-ba` / `.gr-ba-col` / `.gr-ba-head` / `.gr-ba-tag` / `.gr-ba-day` の削除（`.gr-ba-pair` / `.gr-ba-imgs` / `.gr-ba-figslot` は写真比較が使い続けるので残す。`.gr-hist-row .gr-ba-pair` も履歴行で使われているため残す）、`.gr-reader-*` の置き換え、ストリップ用クラスの追加
- サーバ・API・DB は変更なし。`GET /api/goals/:id/report` のレスポンス形（`days[]` / `reportImages[]` / `goal.afterDayNumber`）は変えない
- デモモード（`/api/demo/goals/:id/report`）も同じレスポンスを返すため、そのまま新しい④で描画される
- 既存 e2e への影響なし（`goal-report-day-detail.spec.ts` は `.gr-cell` と `.gr-daytip` のみを参照し、③④のセレクタに触れていない）
