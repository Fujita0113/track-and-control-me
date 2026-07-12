## 1. デモ用データセット（分離した使い捨て DB＋seed）

- [x] 1.1 `services/demo-db.ts`（仮）を追加: 本番と同じマイグレーションを流したインメモリ `better-sqlite3`（`:memory:`）を遅延構築してキャッシュするビルダー（`getDemoDb()` / `resetDemoDb()`）。本番 DB コネクションには一切触れない（D1）。
- [x] 1.2 `services/demo-seed.ts`（仮）を追加: design-brief の筋書きでサンプルを固定 day_key に seed する。目標「メンタルを安定させる」／実践3つ（振り返りを書く・明日のタスク登録・作業4時間）／期間 `2026-06-11`〜`2026-07-10`／達成24/30（中盤に谷→後半持ち直し）／Day13 閾値 4h→3h（理由「課題週間。ゼロにはしない」）／30日分の日記／Day1・Day30 の Before/After（D4）。`Date.now()` に依存しない。
- [x] 1.3 seed 対象を「集計が実際に読むテーブル」に絞る: `goal`/`goal_practice`/`practice_threshold_change`/`goal_journal` と、レポート①②が読む `unlock_evaluation.per_condition_results`（conditionKey/met/actualSeconds/thresholdSeconds を日ごと）＋時系列スナップショットを直接挿入（30日ぶんのゲート評価は再現走行しない）。
- [x] 1.4 デモ DB の config（tz・day_boundary_minutes）を本番と同じ既定にして、`todayKey`/導出ロジックが仮想 day_key から正しく `開始前/進行中/完走` を返すことを seed 単体で確認。

## 2. デモ read 専用 API（`/api/demo/*`・本番ゲートに到達しない経路）

- [x] 2.1 `api/demo.ts`（仮）に読み取り専用ルータを新設し `registerDemoRoutes(app, deps)` を `api/index.ts` から登録。reveal・パスワード生成コマンド・本番 DB 書き込み関数を **import しない**（D3）。
- [x] 2.2 `POST /api/demo/reset` — デモ DB を再 seed し、初期仮想 day_key（`start_day − 1`＝開始前）と目標概要を返す。
- [x] 2.3 `GET /api/demo/goals?now=<dayKey>` — 仮想 day_key を demo config で `nowMs` に変換し `listGoals(demoDb, virtualNow)` を呼ぶ（既存サービス再利用＝仮想 now 中央注入・D2）。
- [x] 2.4 `GET /api/demo/goals/:id/report?now=<dayKey>` — `getGoalReport(demoDb, id, virtualNow)` で4ブロックを返す（完走前は既存どおりレポート不可）。
- [x] 2.5 `GET /api/demo/goals/:id/journal/:date` — `getJournal(demoDb, id, date)` で記入済みサンプル日記を返す。
- [x] 2.6 `GET /api/demo/today?now=<dayKey>` — `daySummary(demoDb, virtualDayKey)` に仮想日付の解錠/条件進捗を載せ、パスワード欄は**ダミー**（例「デモ用 123456」）で返す。`revealPasswords` は呼ばない。

## 3. フロント: デモ状態・上部バー・入り口

- [x] 3.1 `state.js` に `state.demo = { active:false, virtualDay:null }` を追加し、デモ用 API クライアント（`api.demo.*`）を `api.js` に追加。
- [x] 3.2 全画面共通の上部バーに、`active` のときだけ `🧪 デモモード` 帯＋日付コントロール（`＋1日 / ＋7日 / ＋30日 / 完走へ / リセット`）を描画。通常モードでは非表示（spec: 入り口/日付ジャンプ）。
- [x] 3.3 日付コントロールの動作: `＋1/＋7/＋30`＝仮想 day_key 加算、`完走へ`＝`end_day + 1`、`リセット`＝`start_day − 1`（開始前）。変更で当該画面をその仮想日付で再取得・再描画。
- [x] 3.4 設定タブに入り口トグルを追加: `デモを開始`（`state.demo.active=true`＋`/api/demo/reset` で初期化し開始前へ）／`デモを終了`（`active=false`・帯撤去・通常表示へ）／`サンプルをリセット`（`/api/demo/reset` 再実行）（spec: 入り口）。

## 4. フロント: 各画面のデモ対応（通常モードは no-op）

- [x] 4.1 目標画面: `active` のとき取得先を `/api/demo/goals`＋`virtualDay` に切替。**追加ボタンを無効化/非表示・削除手段を出さない**（spec: 閲覧専用）。状態は仮想日付連動（開始前→進行中 Day N/30→完走）。完走で「レポートを開く」→ 既存4ブロック描画を流用（別物 UI にしない）。
- [x] 4.2 今日画面: `active` のとき `/api/demo/today`＋`virtualDay` から表示。パスワードは**ダミー**表示、本物の reveal ボタン/生成は動かさない（spec: ダミーパスワード）。
- [x] 4.3 振り返り画面: `active` のとき進行中サンプルの記入済み日記コーナーを仮想日付で閲覧表示（閲覧中心・保存動線はデモでは出さない）。
- [x] 4.4 完走レポートの日記コーナー（④）が `/api/demo/goals/:id/journal/:date` を引く経路をデモ時に使うよう接続（①カレンダーのマスクリックで日付移動も流用・完走レポートの `days[].text` はデモ report で焼き込み済みを流用）。

## 5. ガードレール検証・テスト・実機スモーク

- [x] 5.1 単体: デモ read API がデモ DB のみを参照し本番 DB に触れないこと、`/api/demo/*` から reveal/生成コマンド/本番書き込みが呼ばれないこと（呼び出しグラフ／モックで確認）。
- [x] 5.2 単体: 仮想 day_key を 開始前/進行中/完走 に置いたとき `listGoals`/`getGoalReport` の返す状態・レポート可否が正しく連動すること。
- [x] 5.3 ガードレール受け入れ: デモで「完走へ」まで進めた後でも、本番 `POST /api/password/reveal` の出力が操作前と不変（未来へ飛ばしても本番解禁は変わらない）／本番の目標・記録・設定が無傷であること。
- [x] 5.4 `npm test` と `npm run typecheck` がクリーン。
- [x] 5.5 実機スモーク（バックエンド）: 実サーバ起動→`reset`で開始前→`+7`で進行中 Day7→`完走`でレポート4ブロック(達成24/30・Day13閾値4h→3h・日記30日)→`today`達成日でダミーPW/未達成日でLOCKED→本番 goals 空・reveal 未達成のまま、を HTTP で確認済み。ブラウザ上の帯表示・デモ終了で通常復帰の目視確認は利用者側で最終確認を推奨。
