# track-and-control-me プロジェクトルール

## 日数が関わる機能はデモモードで成果を明示する（必須）

日付・日数が絡む機能（30日チャレンジ／完走レポート／タイムライン／振り返り等）を作る・変えるときは、
実装後に**デモモード**（`server/src/services/demo-seed.ts` の固定 day_key サンプル）で成果を再現し、
ユーザーに明示すること。使い捨ての本番 DB ではなくデモモードを使う。

- 見せたい機能がデモのサンプルに無い場合は、`demo-seed.ts` にサンプルデータを足してから見せる
  （集計が読むテーブルへ直接焼き込む方式。`Date.now()` 非依存の固定 day_key／固定タイムスタンプを守る）。
- サンプルを足したら `server/src/services/demo.test.ts` の期待値（実践数・達成日数など）も併せて更新する。
- 確認は `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動し、
  `POST /api/demo/reset` → `GET /api/demo/goals/:id/report?now=<完走後の day_key>` で本物の集計経路を通す。
  達成日数など既存の筋書き（達成 24/30・中盤の谷）を壊さないよう、サンプル追加は既存の谷日に寄せる。
