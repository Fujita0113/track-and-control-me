> 受け入れ基準の唯一のソースは `ユーザーフロー.md`。各段は旧テーブルを残したまま進める（design.md Migration Plan）。

## 1. DB とマイグレーション（並走構築）

- [x] 1.1 `migrations.ts` 新版: `rule`（id / target / 各 params / start_day / end_day(null=永続) / status(active|removed) / legacy_condition_key / created_at）を作成する
- [x] 1.2 `rule_change`（id / rule_id / day_key / op(add|update|remove) / before(JSON) / after(JSON) / reason / created_at）を作成する
- [x] 1.3 `goal_rule`（goal_id / rule_id、`(goal_id, rule_id)` UNIQUE）を作成する
- [x] 1.4 `goal.end_day` を可変（前方向のみ延長）扱いにする（列は既存・更新経路を後段で追加）
- [x] 1.5 既存 `rule_condition` の distinct 条件から `rule` 行を生成し、旧 `condition_key` を `legacy_condition_key` に保存する（既存行・過去日評価は書き換えない）
- [x] 1.6 `practice_threshold_change` を `rule_change`（op='update'）へ移送する
- [x] 1.7 `goal_practice.condition_key` → `rule_id` 対応を張り、`goal_rule` を初期構築する（旧 `group:<uuid>`/`group:<identityId>` は legacy として維持）
- [x] 1.8 マイグレーションのテスト: 既存条件が1条件=1ルールに割り付く／`legacy_condition_key` が保存される／過去日評価は不変

## 2. ルールレジストリ（サービス・第一級 rule）

- [x] 2.1 `services/rule-registry.ts` を新設: `createRule` / `updateRule` / `removeRule`（全操作 reason 必須・`rule_change` 記録）・`getRule` / `listActiveRules`
- [x] 2.2 `condition_key='rule:<id>'` の生成と、`legacy_condition_key` 解決ヘルパ（`resolveByStableOrLegacy`）を実装する
- [x] 2.3 PHOTO/QUESTION ルールの params（caption 後変更不可・question_text）とスケジュール（永続/単発/範囲）を扱えるようにする
- [x] 2.4 種類×スケジュールから繰り越し可否を導く純関数（単発 PHOTO/QUESTION のみ繰り越し・範囲=当日限り・時間型=無し）
- [x] 2.5 単体テスト: 中身変更で `rule:<id>` 不変／理由なし操作は拒否／`rule_change` が1操作1行／caption 後変更拒否

## 3. 評価の rule:<id> 化

- [x] 3.1 `rules/evaluate.ts` の条件解決を `rule:<id>` 起点にし、過去日は `legacy_condition_key` フォールバックで引く
- [x] 3.2 PHOTO/QUESTION ルールをゲートへ `rule:<id>` で合流する（旧 `check:<checkId>` 名前空間を廃止）
- [x] 3.3 繰り越し規則（2.4）を評価へ組み込む（単発の遅延導出・範囲は当日限り）
- [x] 3.4 `ConditionResult` に表示名・色・種別・実績/閾値を載せ、UI が安定キーだけで描けるようにする
- [x] 3.5 テスト: 内訳秒と GROUP 実績の一致／差し替え前後で過去日 met が不変／移行前後で判定不変／PHOTO 単発の繰り越し

## 4. 凍結モデルの撤去

- [x] 4.1 `rules/rules.ts` から `RuleStatus`(4状態)・`SAME_DAY_BASE`・`resolveTodayBaseline`・`sameConditionAttrs`・baseline 包含検証を撤去する（→ `rules.ts` 自体が全撤去。役割は `rule-registry.ts`/`evaluate.ts` へ移設済み）
- [x] 4.2 `ensureFrozenIfDue`/freeze-on-read・`upsertTodayRuleSet`(materialize/reopen)・`retractTodayAdditions`・`canWriteTodayRule` を撤去する
- [x] 4.3 `assertGoalsSatisfied`（ジャンル固定 ABORT）を撤去し、採用中でも理由つき変更・削除を通す（`rule-registry.ts` にジャンル固定なし）
- [x] 4.4 `services/rollover.ts`・`recompute.ts` の凍結前提（`markPast` 等）を整理する（過去日凍結 `is_final` は維持）
- [x] 4.5 既存 `rules.test.ts` を新モデルへ更新（凍結・当日追加・ジャンル固定の期待値を除去/差し替え）→ `rules.ts` 撤去に伴い削除。中身は `rule-registry.test.ts`/`evaluate.test.ts` へ移設済み

## 5. 目標サービス（採用廃止・完走フォーク・延長）

- [x] 5.1 `services/goals.ts`: 作成時のインライン条件を「新規ルール作成＋`goal_rule` 自動紐付け」に変更（採用選択・DRAFT_TODAY 追記経路を撤去・理由必須）
- [x] 5.2 レポート①カレンダーの参照を `rule:<id>`→`legacy_condition_key` で解決し、Day N/M（`end_day` 可変）に対応する
- [x] 5.3 `services/goal-chronicle.ts`: 沿革を `rule_change` の時系列年表へ（写真=画像・質問=Q&A をぶら下げる）
- [x] 5.4 完走フォーク: `continueGoal`（新30日目標作成＋永続ルール続投）・`endGoal`（永続ルール `status='removed'`・理由任意・レポート保持）
- [x] 5.5 期間延長: ルール終端が目標 `end_day` を越えるとき延長（`end_day` 前方向更新）／切り詰め（範囲短縮）を選べる経路
- [x] 5.6 完走判定を「30日経過 かつ 全ルール決着」に整合させ、`Day N/M` を導出する
- [x] 5.7 テスト: 採用廃止で自動紐付け／差し替えで①が途切れない／続ける=新目標+続投／終える=ゲート除外+記録保持／延長=Day N/M・切り詰め

## 6. API

- [x] 6.1 目標コーナーのルールCRUD（追加・変更・削除、全操作 reason 必須）エンドポイントを追加する
- [x] 6.2 完走フォーク（続ける／終える）・延長フォーク（伸ばす／やめる）のエンドポイントを追加する
- [x] 6.3 `goal_plan`/`goal_check`/`goal_check_result` の API を撤去し、PHOTO/QUESTION 回答（画像/回答保存）を `rule_id` 参照へ移す
- [x] 6.4 今日タブのルール作成・編集・削除の書き込みエンドポイント/動線を撤去する（ゲート回答・取り下げは残す）
- [x] 6.5 API テスト: reason 必須の 400／完走フォーク両分岐／延長フォーク両分岐／今日タブ書き込み動線が無い

## 7. UI

- [x] 7.1 `static/js/reflection.js`: 目標コーナーにルール一覧＋「＋追加」＋各行の ✎/− ＋「最近の変更」を描く
- [x] 7.2 共通ダイアログ（種類=⏱/☑/📷/💬・いつ=永続/単発/範囲・理由必須）を実装する（種類変更が「いつ」に触れない）
- [x] 7.3 壊れたルールに「⚠ 参照が壊れています」を出し、✎ で `/api/groups/recent` から差し替えられるようにする
- [x] 7.4 `static/js/today.js`: ルール編集動線を撤去し、ゲート不足条件からの写真提出・質問回答は維持する（取り下げボタンは今日タブに置かない＝ユーザーフロー.md の実際の画面遷移に合わせ、削除は振り返りタブの目標コーナーへ一本化）
- [x] 7.5 `static/js/rules.js`: 今日タブのルール編集セクション撤去に伴い全撤去（他画面からの参照は無く、グローバル読み取り表示の需要も無いため）
- [x] 7.6 `static/js/goals.js`: ⑤沿革を rule_change 年表へ・完走フォーク UI・Day N/M 表示
- [x] 7.7 `static/js/plan-check.js`: `rule-form.js` へ改名・再構成（`buildPlanCheckBlock` → `buildGoalRulesBlock`／共通ルールフォーム／延長フォーク ダイアログ）

## 8. デモモード（チュートリアル）

- [x] 8.1 `demo-seed.ts`: 明日開始の単発ルール通知の筋書きと、完走間近の目標＋永続ルールの筋書きを固定 day_key で焼き込む
- [x] 8.2 `static/js/demo.js`＋API: 「1日後」「30日後」ボタンで `now` を進め、通知・完走フォークを実サーバー経路で発火する
- [x] 8.3 単発ルール通知チュートリアル（作成→1日後→トースト確認）を配線する
- [x] 8.4 完走フォークチュートリアル（30日後→続ける/終える）を配線する
- [x] 8.5 `demo.test.ts` の期待値を更新（達成 24/30 等の既存筋書きを壊さない）

## 9. 検証

- [x] 9.1 実 DB（`server/data/track.sqlite`）にマイグレーションを適用し、既存の内訳・タイムライン・レポートが壊れないこと、壊れた `group:<uuid>` ルールが「⚠ 参照が壊れています」で表示され差し替え後に①が途切れないことを確認する
- [x] 9.2 `PORT=<空きポート> DB_PATH=:memory: npm run server` で `POST /api/demo/reset` → 「1日後」で単発通知、「30日後」で完走フォークを実経路で確認する
- [x] 9.3 Plan/Check の語彙・データが UI・API から消えていることを確認する
- [x] 9.4 `npm run typecheck && npm test` を全ワークスペースで通す
