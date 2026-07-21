## 1. DB スキーマ & マイグレーション

- [x] 1.1 `goal_plan` テーブルを追加（`id, goal_id, day_key, body, status, withdraw_reason, created_at`）
- [x] 1.2 `goal_check` テーブルを追加（`id, plan_id, kind, caption, question_text, schedule, start_day_key, span_days, place_note, time_note, status, cancel_reason, created_at`）
- [x] 1.3 `goal_check_result` テーブルを追加（`id, check_id, day_key, image_id, answer_text, created_at`）＋ `(check_id, day_key)` の一意制約
- [x] 1.4 `server/src/db/migrations.ts` に追記し、`db.test.ts` でスキーマ生成を確認

## 2. 契約スキーマ（packages/contract）

- [x] 2.1 `GoalPlan` / `GoalCheck`（kind・schedule の enum 含む）／`GoalCheckResult` の zod スキーマを追加
- [x] 2.2 作成・回答・取り下げ・沿革取得の入出力スキーマを追加
- [x] 2.3 `contract/src/index.test.ts` に enum・round-trip のテストを追加

## 3. Plan / Check のサービス層

- [x] 3.1 Plan 作成：進行中の目標のみ許可・本文非空・種別選択なし（`goal-plan-check`）
- [x] 3.2 Check 作成：**種類と「いつ」が独立した2軸**であることを型で担保（📷×範囲・💬×単発 の全4通りが作れる）
- [x] 3.3 Check のバリデーション：photo はキャプション非空／question は質問文非空／range は `span_days >= 2`／相対・絶対どちらの入力も固定 `start_day_key` へ解決
- [x] 3.4 写真Check のキャプションは作成後変更不可（拒否）
- [x] 3.5 Check なしの Plan を作れること
- [x] 3.6 取り下げ：理由非空必須／Plan 取り下げで配下の未達 Check も `cancelled`／達成済み Check は拒否
- [x] 3.7 ユニットテスト：上記の許可・拒否ケース

## 4. Check の状態導出（純関数）

- [x] 4.1 `(check, dayKey)` → `有効か` / `met` を導出する純関数（design D2 の式）。状態は永続化しない
- [x] 4.2 単発：`start_day_key <= dayKey` で有効、達成日以降ずっと met（**繰り越し**）
- [x] 4.3 範囲：`[start, start+span)` のみ有効、met はその日の result のみを見る（**繰り越さない・期間後は消える**）
- [x] 4.4 ユニットテスト：単発の繰り越し／範囲のサボり非繰り越し／期間終了後の消滅／取り下げ後の無効化（★日付が絡む挙動はここで固める。e2e では扱わない）

## 5. 解錠評価への合流

- [x] 5.1 `evaluateDay` で対象日に有効な Check を列挙し、合成条件（`conditionKey='check:<id>'`・`target='CHECK'`）を AND 追加
- [x] 5.2 `label` にキャプション／質問文を載せ、今日タブが不足条件として表示できるようにする
- [x] 5.3 `is_final` スナップショット・latch との整合を確認（過去確定日は再評価しない／提出日以降のみ met）
- [x] 5.4 `rules.test.ts` に追加：「未達 Check で他条件充足でも LOCKED」「回答後 UNLOCKED」「開始日前は非合流」「取り下げ後は非合流」「範囲の各日が独立してゲートを閉じる」

## 6. 沿革（goal-chronicle）のサービス層

- [x] 6.1 目標ごとに Plan（`day_key` 昇順・同日内は記録順）＋配下 Check ＋ result を入れ子で返す取得 API
- [x] 6.2 **日記を含めない**こと（`goal_journal` を引かない）
- [x] 6.3 取り下げた Plan / Check を理由つきで残すこと
- [x] 6.4 範囲Check は「N日中M日提出」に相当する事実を返すこと
- [x] 6.5 ユニットテスト：決定的な並び／日記が混入しない／取り下げが消えない

## 7. レポートの鍵を外す（goal-report 変更）

- [x] 7.1 レポート生成が進行中（`today >= start_day`）を受け付ける。開始前は従来どおり拒否
- [x] 7.2 ①達成カレンダーを3値化：達成／未達成（欠測含む）／**未到来（`day_key > today`）＝空白**
- [x] 7.3 ③の After を「現時点で最も新しい記録のある日」に、最終日写真 CTA を**完走後のみ**に
- [x] 7.4 ⑤沿革ブロックをレポートのレスポンスに含める
- [x] 7.5 部分データで壊れないこと（時間型実践が0〜1日分しか無い場合の②など）
- [x] 7.6 `goals.test.ts` に追加：進行中で 200 が返る／未到来が空白になる／完走後は空白が無い／進行中は CTA が出ない

## 8. API エンドポイント（server/src/api）

- [x] 8.1 Plan / Check の作成・一覧・取り下げ
- [x] 8.2 Check への回答（写真提出・質問回答）。写真は `goal_image` へ**先指定キャプション**で保存し `image_id` を result に持つ
- [x] 8.3 沿革取得
- [x] 8.4 「その日に回答すべき Check があるか」を返すエンドポイント（トースト用）

## 9. ダッシュボード UI ― 振り返りタブ（書く）

- [x] 9.1 目標コーナーに「＋ Plan」フォーム（短文・種別選択なし）
- [x] 9.2 「＋ Check」フォーム：**種類（📷/💬）と いつ（単発⇄範囲トグル）を独立した2軸**として配置。種類の切替が「いつ」に影響しないこと
- [x] 9.3 場所メモ・時刻メモ（任意・「判定には使わない」と明示）
- [x] 9.4 仕掛け中の Check 一覧表示／Plan の取り下げ（理由入力必須）
- [x] 9.5 既存の日記エディタはそのまま下に置く（Plan/Check とは独立に保存）

## 10. ダッシュボード UI ― 今日タブ（詰まる）

- [x] 10.1 ゲートの不足条件に Check を表示（キャプション／質問文＋どの Plan 由来か）
- [x] 10.2 その場で写真提出（貼付／ファイル選択。**キャプションは聞かない**）
- [x] 10.3 その場で質問回答（質問文を提示し、空回答は拒否）
- [x] 10.4 その場で理由つき取り下げ（理由必須）
- [x] 10.5 **その日はじめてダッシュボードを開いたとき1回だけ**トースト（既存 `toast()`・`day_key` 単位のフラグ・時刻起動しない）

## 11. ダッシュボード UI ― 目標タブ（読む）

- [x] 11.1 進行中カードに **「レポートプレビュー」** ボタン（完走後は既存の「レポートを開く」）
- [x] 11.2 ①カレンダーで未到来を空白として描画
- [x] 11.3 **⑤沿革ブロック**の描画：Plan の下に Check を入れ子。写真は画像、質問は Q&A のペア。取り下げは理由つき。スコア・演出なし

## 12. デモモード

- [x] 12.1 `demo-seed.ts` に Plan/Check/回答/取り下げのサンプルを固定 `day_key`・固定タイムスタンプで追加（既存の谷日付近へ寄せる）。📷×単発・📷×範囲・💬×単発・取り下げ済み を1つずつ揃えて沿革が読み物になるようにする
- [x] 12.2 `demo.test.ts` の期待値を更新（達成 24/30・中盤の谷の筋書きを壊さないこと）
- [x] 12.3 デモは閲覧専用：Plan/Check の作成・回答・取り下げ導線を出さない

## 13. 検証（★ユーザーフロー.md が受け入れ基準）

- [x] 13.1 `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動 → `POST /api/demo/reset` → `GET /api/demo/goals/:id/report?now=<完走後の day_key>` で本物の集計経路を通し、⑤沿革と達成筋書きを確認してユーザーに明示
- [x] 13.2 走行中プレビューをデモで確認（`now=<期間中の day_key>` で未到来が空白・CTA 非表示）
- [x] 13.3 **通し e2e を1本**（Playwright）：`ユーザーフロー.md` の背骨を踏む
      → 振り返りタブで Plan＋Check を仕掛ける → 今日タブで不足条件に出る＆パスワードが出ない
      → その場で写真を出す → ゲートが開く → 目標タブでレポートプレビュー → ⑤沿革に載っている
      ※日付を跨ぐ挙動（繰り越し・期間・未到来）は 4.4 / 5.4 / 7.6 のユニット側で担保し、e2e では扱わない
- [x] 13.4 `npm test` / `npm run typecheck` 全通過
- [x] 13.5 `ユーザーフロー.md` を1シーンずつ読み合わせ、実装との差分が無いことを確認

## 14. OpenSpec 検証

- [x] 14.1 `openspec validate long-term-goal-loop --strict` が通ること
