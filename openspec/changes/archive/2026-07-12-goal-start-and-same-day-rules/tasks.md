## 1. マイグレーション（凍結トリガの緩和）

- [x] 1.1 新マイグレーションを追加し、`rule_condition` の INSERT/UPDATE/DELETE トリガと `daily_rule_set` の content/delete トリガを drop→recreate して、可変判定を `status IN ('DRAFT_FUTURE','DRAFT_TODAY')` に緩める（既存行は無変更）
- [x] 1.2 マイグレーション適用でスキーマ変更が無い（`status` は TEXT・CHECK 無し）ことと、既存 `DRAFT_FUTURE`/`FROZEN_ACTIVE`/`PAST` 挙動が不変であることを確認

## 2. サーバー: 当日ルール追加（same-day-rule-additions）

- [x] 2.1 `RuleStatus` に `DRAFT_TODAY` を追加し、型・状態ハンドリング（`getRuleSet`/`listRuleSets`/評価取得）が新値を安全に扱えるようにする
- [x] 2.2 baseline 解決ヘルパを追加（`effective_date < today` の latest から day 開始時点の実効条件を解決）
- [x] 2.3 当日 add-only 書き込み経路を実装（`upsertFutureRuleSet` の `effectiveDate==today` 分岐 or `upsertTodayRuleSet`）：当日ルール未存在なら baseline を `effective_date=today` へ materialize、既存 `FROZEN_ACTIVE` 当日行なら `DRAFT_TODAY` へ開き直し、新規条件を追記
- [x] 2.4 baseline 保存アサートをトランザクション内に実装（書込後の当日実効ゲートが baseline を包含・combinator が緩んでいないことを検証し、破れば ABORT）。ブートストラップ（実効ルール皆無）は従来どおり当日フル編集可のまま
- [x] 2.5 `ensureFrozenIfDue` を分岐（`effective_date==today` の `DRAFT_TODAY` は当日凍結しない／`effective_date < today` の `DRAFT_TODAY` は `FROZEN_ACTIVE` へ）。rollover の `DRAFT_TODAY→FROZEN_ACTIVE→PAST` を担保
- [x] 2.6 `deleteRuleSet(today)` が当日追加分だけを撤回し baseline（追加前）へ戻る挙動を実装（採用中条件は `assertGoalsSatisfied` で保護）

## 3. サーバー: 目標の開始日選択とジャンル固定起点

- [x] 3.1 `services/goals.ts` の作成入力に `start`（`'today' | 'tomorrow'`、既定 `today`）を追加し、`start_day`/`end_day`（30日固定）を選択に応じて算出
- [x] 3.2 採用候補・採用検証・ラベルスナップショットを `getEffectiveRuleSet(start_day)` に対して行うよう変更（今日開始は当日実効ルール＝当日追加を含む）
- [x] 3.3 `assertGoalsSatisfied` のロック起点を `max(tomorrow, start_day)` → `max(today, start_day)` に変更（今日開始で当日採用した条件を当日から保護）
- [x] 3.4 インライン条件（`newConditions`）の追記先を開始日で分岐（今日開始→当日 `DRAFT_TODAY` 経路／明日開始→翌日ルール）。作成＋採用の一体トランザクションを維持
- [x] 3.5 `deriveStatus`/一覧の Day 番号が今日開始で「進行中 Day 1/30」になることを確認（既存導出でカバーされるはず）

## 4. API

- [x] 4.1 目標作成 API に開始日選択パラメータを追加（zod 契約更新・既定 today）
- [x] 4.2 ルール PUT/DELETE の当日 add-only 経路を配線し、拒否時のステータス（baseline 違反=400、ジャンル固定=409 等）を既存に揃える

## 5. フロント（拡張ダッシュボード）

- [x] 5.1 `static/js/goals.js` 作成 UI に開始日選択（今日から／明日から・既定 今日）と、選択に連動した採用候補の解決元を実装
- [x] 5.2 `static/js/rules.js` に当日の条件追加動線を追加（既存の凍結条件は当日ロック表示のまま・追加のみ可）
- [x] 5.3 当日追加→自由編集／削除、baseline 違反時のエラー表示を配線

## 6. デモの振り返り記録プレビュー

- [x] 6.1 `static/js/reflection.js` のデモ経路で、仮想日付が目標期間外（開始前含む）のとき代表日のサンプル記録を読み取り専用プレビュー表示に変更（空表示のみを解消）
- [x] 6.2 `services/demo-seed.ts` / `demo.js` を必要に応じ調整し、記録の見え方が確認できる代表日サンプルを用意
- [x] 6.3 本番モードの振り返り（進行中目標への記入動線）が不変であることを確認

## 7. テスト・検証

- [x] 7.1 当日追加のユニットテスト（追加可・既存凍結条件は不可・baseline 違反 ABORT・同日自由編集/削除・翌日凍結・ブートストラップ全編集）
- [x] 7.2 目標開始日選択のテスト（今日開始で進行中 Day1・当日実効ルールから採用・明日開始で開始前・削除は作成当日のみ）
- [x] 7.3 ジャンル固定・理由必須が今日開始で当日から効くテスト（当日採用条件の当日削除拒否・当日追加採用条件の閾値変更理由必須）
- [x] 7.4 インライン条件の開始日分岐テスト（今日→当日ルール追記＋当日採用／明日→翌日ルール）
- [x] 7.5 目標テーブル空・当日追加未使用時に既存挙動が完全不変であることの回帰テスト（`npm test` グリーン・typecheck クリーン）
- [x] 7.6 実機スモーク（今日開始目標の作成→当日ゲート反映、当日ルール追加→自由編集→翌日凍結、デモ振り返りの記録プレビュー表示）
