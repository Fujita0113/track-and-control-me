## 1. サーバ: AUTO ブロックを identity 単位で生成

- [x] 1.1 `server/src/services/timeline.ts` に identity キー導出（`tab_group_name_snapshot` ＋ `group_color_snapshot`、未グループは単一 identity）を追加し、`today-group-breakdown` と同じ定義に揃える
- [x] 1.2 `coalesceSessions` のバケツキーを `stable_group_id` から identity キーへ変更し、identity が異なるセッションは同一ブロックへ入れない（`title`/`color` は identity の名前・色）
- [x] 1.3 AutoBlock に、後段の coactive 表示名解決と自己除外のため、構成 sid 集合（または identity キー）を保持する

## 2. サーバ: 同時オープングループ名の解決を identity 化

- [x] 2.1 `coactiveGroupKeys`（sid 集合）を、区間内の並行セッションのスナップショット名へ解決する経路を用意（解決不能時は sid 文字列へフォールバック）
- [x] 2.2 自己除外を「自分の identity に属する sid を除く」形へ変更する

## 3. クライアント: ラン結合・レイアウトを identity 化

- [x] 3.1 `server/static/js/timeline.js` の `buildRuns` グルーピングと「他ブロック重なり」自己除外を identity キーへ変更
- [x] 3.2 `groupNames`／`finalizeRun` の coactive 表示名解決を identity ベースへ（自己 identity 除外）
- [x] 3.3 `layout` の `keyOf`（RUN のカラム安定化キー）を `g:${identityKey}` へ変更（MANUAL は従来どおり）

## 4. テスト

- [x] 4.1 `server/src/services/timeline.test.ts` に「同一 sid を改名して使い回す」ケース（例: 開発→ブログ投稿→開発）を追加し、AUTO ブロックが名前ごとに分離することを検証
- [x] 4.2 「異なる sid・同一 identity は近接結合される」ケース（#47 相当）を追加
- [x] 4.3 権威データ不変（`daily_totals_snapshot`・総作業時間・解錠ルール評価）の回帰確認テストを追加または既存で担保されていることを確認

## 5. デモ検証（日数/集計が関わるためデモモード必須）

- [x] 5.1 `server/src/services/demo-seed.ts` に「同一 sid を改名して使い回す」区間を1本焼き込む（`Date.now()` 非依存の固定 day_key／固定タイムスタンプ）
- [x] 5.2 `server/src/services/demo.test.ts` の期待値（実践数・達成日数など既存の筋書き）を壊さないよう併せて更新
- [x] 5.3 `PORT=<空きポート> DB_PATH=:memory: npm run server` 起動 → `POST /api/demo/reset` → `GET /api/timeline?date=<対象日>` で、AUTO ブロックが名前ごとに分離し、同日の今日タブ内訳・振り返りリボンと一致することを確認し、ユーザに明示する

## 6. 仕上げ

- [x] 6.1 `npm test`（server）と型/リントを通す
- [x] 6.2 スクリーンショットで issue #52 の再現データ相当（改名使い回し日）がメインタイムライン・振り返りで一致することを確認
