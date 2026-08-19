## 1. サービス層: `forecastMonth` に直近7日ベースを追加

- [x] 1.1 `kakeibo.ts` に、日付範囲（`fromDayKey`〜`toDayKey`、月をまたいでよい）で `kakeibo_entry` を取得する関数を追加する（既存の `listEntries(db, monthKey)` は月キー単位のままにし、置き換えない）。
- [x] 1.2 `kakeibo-forecast.ts` の `forecastMonth` に、直近7日（今日を含む過去7日・分母は常に7固定・月をまたいでよい）の日々の出費・1日平均・残りの予想・月末予想・上限超過日を算出するロジックを追加し、`ForecastMonthResult.recent`（`dailyPoolYen` / `dailyAverageYen` / `forecastYen` / `landingYen` / `overYen` / `crossDayKey` / `actualYen` / `fixedYen` / `specialYen` / `plannedYen` / `capYen`）として返す。特別費の除外判定（`effectiveSpecial`）は既存のものを流用する。
- [x] 1.3 直近7日ぶんの折れ線データ（実績と共通の日次累計に、直近7日基準の予想を継ぎ足したもの）も `recent.series` として返す。既存の `series`（これまでの平均ベース）はフィールド名・意味とも変更しない。
- [x] 1.4 `server/src/services/kakeibo-forecast.test.ts` に追加済みの赤テスト（「直近7日ベースの予想」describe）を通す。

## 2. サービス層: 分析タブの週ごとの支出

- [x] 2.1 `kakeibo-analysis.ts` に `weeklyBreakdown(db, monthKey, todayDayKey)` を追加する。月曜始まりの暦週で、月の範囲にクリップした `weekFromDayKey` / `weekToDayKey` / `spentYen` / `targetYen`（`budgetDerived` の `weeklyTargetYen` を流用）/ `isPartial`（月境界で切れているか）/ `inProgress`（`todayDayKey` を含み、かつ `monthKey` が今日の月と一致するか）を週ごとに返す。`todayDayKey` の月と `monthKey` が異なる場合はすべての週を完了扱いで返す。
- [x] 2.2 対象月より後（`weekFromDayKey` が `todayDayKey` より未来）の週は返り値に含めない。
- [x] 2.3 `server/src/services/kakeibo-analysis.test.ts` に追加済みの赤テスト（「週ごとの支出」describe）を通す。

## 3. API

- [x] 3.1 `server/src/api/kakeibo.ts` の `GET /api/kakeibo/home` レスポンスに `landing.recent` ないし同等の直近7日ぶんの値を追加する（`forecastMonth` が返す `recent` をそのまま乗せる）。
- [x] 3.2 `GET /api/kakeibo/analysis` レスポンスに `weeks: weeklyBreakdown(db, month, todayKey(db))` を追加する。
- [x] 3.3 `server/src/api/demo.ts` の `/api/demo/kakeibo/home`・`/api/demo/kakeibo/analysis` を同様に更新し、本番と同じ形のレスポンスを返す（`DEMO_KAKEIBO_MONTH` / `DEMO_KAKEIBO_TODAY` は変更しない）。

## 4. フロントエンド: ホームの折れ線

- [x] 4.1 `server/static/js/kakeibo-chart.js` の描画を SVG の階段状パスから Canvas + 補間曲線（Catmull-Rom など）に置き換える。実績・予想（選択中の基準）・ゴースト線（選ばれていない基準）・直近7日ゾーンの帯・上限線・固定費の土台を描く。値は `forecastMonth` のレスポンスをそのまま使い、クライアント側で式を再実装しない。
- [x] 4.2 グラフ内のテキストラベルを「今日」の実績点・「予想」の着地点の2つに絞る。固定費額・予定出費額・上限額・上限交差日はグラフ内に描画しない。
- [x] 4.3 `kb-chart` の `<svg>` を `<canvas>` に置き換える（ラッパー要素のクラス名 `kb-chart` は維持し、`e2e/kakeibo-tab.spec.ts` の `.kb-chart canvas` ロケータと整合させる）。

## 5. フロントエンド: ホームの基準トグルと内訳表示

- [x] 5.1 `server/static/js/kakeibo.js` のホーム描画に、基準トグル（「これまでの平均ペース」／「直近7日ベース」）を追加する。追加のAPIリクエストは発生させず、`fetchHome` で取得済みの `landing` / `landing.recent` を切り替えて描画する。
- [x] 5.2 折れ線直下の内訳を2段に再構成する。主行＝選択中の基準の1日平均（直近7日を選んでいるときは、これまでの平均との差を併記）。副行＝特別費・予定出費・固定費の内訳＋「予想の計算内訳・調整」ボタン。
- [x] 5.3 上限額はカードヘッダーに1箇所だけ表示し、フッター文（上限超過日）は選択中の基準の `crossDayKey` を使う。

## 6. フロントエンド: 分析タブの週ごとの支出

- [x] 6.1 `server/static/js/kakeibo-analysis.js` に「週ごとの支出」カードを追加する（重要度の帯より前後どちらに置くかは実装時に決めてよいが、既存の重要度・3段ドリルの表示を壊さない）。週の目標を横断する基準線を添え、進行中の週・部分週が分かる見た目にする。
- [x] 6.2 `fetchAnalysis` のレスポンスに含まれる `weeks` をそのまま描画し、クライアント側で週の区切りを計算し直さない。

## 7. デモモードでの確認（必須・プロジェクトCLAUDE.md）

- [x] 7.1 `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動し、`POST /api/demo/reset` → `GET /api/demo/kakeibo/home` で `recent` の値が本物の計算経路（`forecastMonth`）を通って返っていることを確認する。既存の「これまでの平均ベース」の数字（実績 ¥40,030・1日平均 ¥1,759・月末 ¥77,010・超過日 8/23）は変わっていないことも確認する。
- [x] 7.2 `GET /api/demo/kakeibo/analysis` で `weeks` が返り、8/1–8/2（部分週）・8/3–8/9（フル週）・8/10–8/16（進行中の週、`DEMO_KAKEIBO_TODAY=2026-08-11` を含む）の3週が出ることを確認する。

## 8. 既存 e2e への影響（凍結・propose で対応済み）

- [x] 8.1 `e2e/kakeibo-tab.spec.ts` の `.kb-chart svg` ロケータを `.kb-chart canvas` に、`.kb-summary-items` を対象にしていた2箇所を `.kb-card`（今月の支出推移と月末予想）を対象にする形に更新済み（本コミットに含む）。

## 9. 新規 e2e（apply が最後に書く。DOM ができてから）

- [x] 9.1 「ホームで基準トグルを『直近7日ベース』に切り替える → 月末予想・1日平均・上限超過日が『これまでの平均』のときと異なる値に変わり、グラフが再描画される」フローの e2e を追加する。
- [x] 9.2 「分析タブで週ごとの支出を見る → 月をまたぐ部分週・フルの週・進行中の週がそれぞれ見分けられる」フローの e2e を追加する（新規追加した記録が該当週の棒に反映されることを確認する形でよい）。
- [x] 9.3 上記2本を追加する際は、`git stash push -- server/ extension/ packages/` → `CI=1 npx playwright test <spec>` で実装抜きに落ちることを確認してから `git stash pop` → 通ることを確認する（プロジェクトCLAUDE.mdの「新規 e2e が骨抜きでないことは機械で証明する」手順）。

## 10. 仕上げ

- [x] 10.1 `npm test` を実行し、本変更で追加した vitest がすべて green になり、既存テストにデグレが無いことを確認する。
- [x] 10.2 `npm run typecheck`（あれば）でクライアント/サーバ双方の型エラーが無いことを確認する。

## 11. 実装後のUI調整（issue #105・ユーザー直接指示、2026-08-19）

実装完了後にユーザーがworktree内でUIを直接調整し、design.md Decision 5〜7・delta specに以下を反映した（自動テストはすべてgreenのまま）。

- [x] 11.1 グラフ内の固定費額・上限額ラベルは意図的に残す（削除は不採用）。予定出費額・上限交差日はグラフ内に出さない方針は維持。spec.md「今月の支出推移と月末予想の折れ線」を修正。
- [x] 11.2 内訳主行の「これまでの平均との差」の文字併記は不採用（ごちゃつくため）。差はゴースト線で示す。spec.md「内訳が2段で示される」を修正。
- [x] 11.3 直近7日ゾーンの帯（薄青）を復活実装（`kakeibo-chart.js`）。実装過程で試した「定規」表現は不採用のまま。
- [x] 11.4 ホームの「無駄遣い」カードから変動費割合の数値・改善見込み文言を削除し、合計額と上限ゲージだけに簡略化（`kakeibo.js` `renderWasteCard`）。spec.md に「「無駄遣い」の合計と上限」のMODIFIED Requirementsを追加。調整モーダルの `.kb-effect` は対象外。
