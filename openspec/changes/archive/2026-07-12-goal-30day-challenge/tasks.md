# Tasks: goal-30day-challenge

## 1. DB・データモデル

- [x] 1.1 migration v11 を追加: `goal` / `goal_practice`（condition_key＋ラベルスナップショット）/ `practice_threshold_change` / `goal_journal`（PK=(goal_id, day_key)）。`db.test.ts` にテーブル存在・制約のテストを追加
- [x] 1.2 `npm test` で既存マイグレーションチェーンが壊れていないことを確認

## 2. サーバー: 目標ライフサイクル（spec: goal-challenge）

- [x] 2.1 `services/goals.ts` を新設: 作成（翌日開始・end=+29・採用候補は翌日実効ルールの TOTAL_WORK/GROUP/PLANNING のみ・MANUAL_CHECK 拒否）、一覧（day_key 比較で 開始前/進行中/完走 を導出）、作成当日限りの削除（日記・実践ごと CASCADE）
- [x] 2.2 `rules.ts` にジャンル固定を追加: `upsertFutureRuleSet` / `deleteRuleSet` のトランザクション内で、適用後にアクティブ目標の残期間（翌日〜end_day）の実効ルールを解決し、全実践 condition_key の存在を検証。欠けたら `GoalLockError` で ABORT
- [x] 2.3 閾値変更の理由必須化: `PUT /api/rules/:date` に `threshold_change_reason` を追加し、採用中条件の threshold_seconds 変更時に非空を要求（無ければ 400）。`practice_threshold_change` へ old/new/適用日/理由を記録
- [x] 2.4 API ルート追加: `POST/GET /api/goals`・`DELETE /api/goals/:id`。ユニットテスト（作成・並行・翌日開始・削除猶予・ジャンル固定の拒否/許可/期間外・理由必須）を `goals.test.ts` / `rules.test.ts` に追加

## 3. サーバー: 目標日記（spec: goal-journal）

- [x] 3.1 `PUT/GET /api/goals/:id/journal/:date`: 進行中の日のみ書き込み可（完走後・開始前は拒否）、`reflection_entry` 非接触。テスト（日記のみ保存で `reflection_done` が false のまま、完走後 PUT 拒否）

## 4. サーバー: レポート集計（spec: goal-report）

- [x] 4.1 `GET /api/goals/:id/report`: 完走前は 409。30日×実践の行列（`per_condition_results` を condition_key で照合、欠測・キー不在は未達成）、②用の actualSeconds/thresholdSeconds 列、閾値変更マーカー（理由つき）、ヘッダ用達成日数（全実践 met の日数）、③④用の Day 別文面（goal_journal→reflection_entry の日単位フォールバック）を返す。テスト（欠測=未達成、フォールバック、409）

## 5. ダッシュボード: 目標タブ

- [x] 5.1 `static/js/goals.js`＋タブ「目標」を新設: 一覧（進行中= Day N/30、完走=「レポートを開く」）、新規作成フォーム（名前・目的・翌日実効ルールからの実践選択）、作成当日のみの削除ボタン。CSP 適合（インライン style 禁止、既存の class＋CSSOM 方式）
- [x] 5.2 レポートビュー: ヘッダ＋4ブロックの1カラム構成（`ref/goal-report/design-brief.md` 準拠・指定外要素なし・合否語なし）。②は同梱 Chart.js、①のマスクリック→④の日記リーダー連動、③は左右並置

## 6. ダッシュボード: 既存タブへの組み込み

- [x] 6.1 `rules.js`: 採用中条件に「ジャンル固定」バッジ表示・削除操作の無効化・閾値変更時の理由入力プロンプト（未入力なら送信しない）
- [x] 6.2 `reflection.js`: 進行中目標ごとの日記コーナー（`createMarkdownEditor` 再利用）。保存ボタン・離脱時フラッシュに相乗りして振り返り本文と同時保存

## 7. 検証

- [x] 7.1 `npm test`・`npm run typecheck` 全通過
- [x] 7.2 実機スモーク: 目標作成→ルール編集でジャンル固定が効く→理由つき閾値変更→日記記入まで実際の UI で確認。完走レポートはテストデータ（過去日開始の目標を DB へ直挿入するシードスクリプト）で表示し、4ブロック構成をスクリーンショットで確認
