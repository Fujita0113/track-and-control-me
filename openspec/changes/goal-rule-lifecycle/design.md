## Context

解錠ルールは現状、日ごとの `daily_rule_set` ＋ `rule_condition` を**凍結モデル**（`DRAFT_FUTURE`/`DRAFT_TODAY`/`FROZEN_ACTIVE`/`PAST`・freeze-on-read・当日 baseline 包含検証）で運用し、条件の同一性を**内容から導出したキー**（`condition_key`＝`total_work`/`group:<uuid>`/`timeline:<ラベル>`/`manual:<ラベル>`/`planning:<signal>`）で表す。目標はこのキー文字列を `goal_practice` で「採用」し、採用中はジャンル固定で内容を変えられない。

この設計が issue #59 を生んだ：拡張のバグで壊れた `group:<uuid>` を指す条件が「面接の時間で解錠される」のに、採用中なので**変更できない**。加えて #54 の Plan/Check（`goal_plan`/`goal_check`/`goal_check_result`）は2段階で直感に合わない。

重要な観察：**過去日の判定はすでに `unlock_evaluation.per_condition_results` に凍結されており（`is_final=1`、`evaluate.ts` は再評価しない）、日ごとのルールセットは履歴の正しさに寄与していない**。凍結モデルは実質「当日ルールを緩ませない」ためだけに存在する。本変更はこの制約自体を降ろす（ゆるく作り、締めたい箇所だけ後で締める方針）。

受け入れ基準の唯一のソースは本変更の `ユーザーフロー.md`。本 design はそれを実現する技術判断を述べる。

## Goals / Non-Goals

**Goals:**
- 解錠ルールを第一級 `rule` 行にし、**中身が変わっても同じルール**として過去記録と繋げる（安定キー `rule:<id>`）。
- ルールをいつでも追加・変更・削除でき、当日から効く。全操作に理由を必須化し `rule_change` に残す（＝沿革）。
- Plan/Check を写真/質問ルールへ畳み、種類×スケジュールの2軸独立を保つ。
- 「採用」を廃止し、目標作成時・振り返りコーナーで足したルールを自動紐付け。今日タブのルール操作を全撤去。
- 完走フォーク（続ける/終える）と期間延長フォークを導入し、目標の寿命を明示的な決定点にする。
- デモモードで日付を進めて単発通知・完走フォークを検証できる。

**Non-Goals:**
- 同一内容ルールの dedup（複数目標が同内容を足すと2行になるが判定は壊れない）。
- `daily_totals_snapshot` 生データ・総作業時間の算入スコープ・divide-by-N 配分・日境界分割の変更。
- group identity レジストリ／改名追随／拡張採番（`group-rule-snapshot-identity` で完了済み。本変更はその上に乗る）。
- 過去日の評価記録の書き換え（凍結済み `per_condition_results` は不変）。

## Decisions

### D1: `condition_key` を「内容導出」から「行ID（`rule:<id>`）」へ

**決定**: `rule` テーブルを新設し、各ルールの安定キーを行 id とする（`condition_key = 'rule:<id>'`）。中身（target・閾値・`group_identity_id`・ラベル・キャプション・質問文・スケジュール）は同じ行を更新するだけで、キーは不変。

- **なぜ**: 内容導出キーは「直す＝別物になる」ため、過去の `per_condition_results` と結合できず、レポート①カレンダーが空白化する。これが「変更できない」の技術的正体。行IDに切り離せば、差し替え・閾値変更・改名すべてが同一ルールとして過去と繋がる。
- **代替案**: (a) 内容キーのまま「直すたびに別条件を作り旧条件を deprecate」→ 履歴が分裂しカレンダーが1行にならない。(b) GROUP だけ ID 化→ 変更UIを作ると TIMELINE/TOTAL_WORK でも同じ問題に当たり、キーの混在で複雑化。→ 全ターゲット ID 化を採る。

### D2: 過去日との橋 `legacy_condition_key`

**決定**: `rule.legacy_condition_key` に移行前の旧 `condition_key`（`group:<uuid>` / `timeline:<ラベル>` 等）を保存する。過去日の評価結果を読むとき、`rule:<id>` で引けなければ `legacy_condition_key` でも引く。

- **なぜ**: 凍結済み `per_condition_results` は旧キーで書かれており不変。橋がないと移行日以前が全ルールで空白化する。
- **トレードオフ**: 1ルールにつき旧キー1本しか橋渡しできない。移行時点で1条件＝1ルールに割り付くので十分。改名等で旧キーが複数あるケースは identity レジストリ側で既に解決済み。

### D3: 凍結モデルの撤廃と「当日から効く」

**決定**: `RuleStatus`（4状態）・`SAME_DAY_BASE` 下駄・`resolveTodayBaseline`/`sameConditionAttrs`/baseline 包含検証・`ensureFrozenIfDue`/freeze-on-read・`assertGoalsSatisfied`（ジャンル固定 ABORT）・`upsertTodayRuleSet` の materialize/reopen・`retractTodayAdditions` を撤去。ルールは `rule` 行を直接 CRUD し、**その日の評価から反映**する。過去日は `is_final=1` で凍結済みのため影響しない。

- **なぜ**: これらは「当日ルールを緩ませない」ためだけの機構で、履歴の正しさには不要（Context 参照）。ユーザー方針（ゆるく作る）で要件自体が降りる。
- **リスク**: 「今夜の衝動で全部緩める」を機械的には止めない。→ 抑止ではなく**理由と操作を沿革に残す**（D4）で対応。脅威モデル上、拡張を切れば止まらない以上、機械的制限は効果が薄い。

### D4: 全操作の理由必須と `rule_change`（＝沿革の実体）

**決定**: ルールの `add` / `update` / `remove` はすべて非空理由を要求（場合分けしない）。`rule_change`（`rule_id`・`day_key`・`op`・`before`(JSON)・`after`(JSON)・`reason`・`created_at`）に1操作1行で記録する。既存 `practice_threshold_change` はこの表へ一般化・移送する。沿革（`goal-chronicle`）とレポート「最近の変更」はこの表を描く。

- **なぜ**: 「ゆるめる時だけ必須」は補足が要り場合分けの利益がない（ユーザー判断）。常時必須のほうが単純で、沿革が均質になる。
- **注意**: 完走フォークの「終える」理由は任意（`goal-lifecycle-fork`）。これは*ルールフォーム*の操作ではなく目標のリチュアルなので、フォームの「常時必須」とは別surface（場合分けではない）。

### D5: Plan/Check → 写真/質問ルール（PHOTO/QUESTION）

**決定**: `rule.target` に `PHOTO` / `QUESTION` を追加。写真は `caption`（先指定・後変更不可）、質問は `question_text`（先指定）を持つ。スケジュールは `rule.start_day` ＋ `rule.end_day`（`null`=永続、`start=end`=単発、`start<end`=範囲）で表す。回答実績は既存の画像／回答保存経路（`goal_check_result` 相当）を `rule_id` 参照へ移し替える。`goal_plan`/`goal_check` は廃止。

- **繰り越しの局所化**: 「達成まで繰り越す」は PHOTO/QUESTION かつ単発のときだけ。範囲は各日独立、時間型は繰り越し無し。これは自由な軸ではなく target×schedule の関数として `evaluate` に埋め込む（`goal-check-gate` の既存規定を踏襲）。
- **代替案**: Plan/Check を語彙だけ残しデータは温存 → 2モデル併存で複雑。データ実績が Plan1・Check0 のため畳んで損失なし。

### D6: 「採用」廃止と自動紐付け・入口の限定

**決定**: `goal_practice.condition_key` を `rule_id` 参照へ。ルール作成の入口は **目標作成時** と **振り返りの目標コーナー** のみ。作成時に `goal_rule`（goal_id, rule_id）を自動で張る。今日タブのルール作成・編集・削除動線（`renderRuleEditing` の書き込み系）を撤去し、ゲートの**回答/取り下げ**動線だけ残す。ルールはグローバルに効く（ゲートは1つ）。

- **なぜ**: 採用はジャンル固定のためにあった。固定が消えれば採用は「どの目標が追うか」に痩せる。作る場所が意図を語る（Creation in Context）ので設定にしない。
- **トレードオフ**: 目標に属さない純グローバルルールは作れなくなる。移行後は全ルールが目標に紐づく想定で実害なし。既存の未紐付けルールは移行時にダミー紐付け無しの「グローバル」扱いで残し、ゲートには従来どおり効かせる。

### D7: 目標の寿命 —— 完走フォークと期間延長

**決定**:
- 目標の `end_day` を可変にする（前方向のみ）。「30日固定」を「30日以上」に緩め、表示は `Day N/M`（M=`end_day-start_day+1`）。
- **完走**（`today > end_day`）でレポート先頭に「続ける／終える」を出す。続ける＝新30日目標を作り直し（Day1/30）、永続ルール（`end_day=null`）を新目標へ紐付け続投。終える（理由任意）＝永続ルールを `status='removed'` にしてゲートから外し、目標は完走済みでアーカイブ（レポート・沿革は残す）。未回答の間、永続ルールはゲートに残る。
- **延長フォーク**: 目標コーナーで作るルールの `end_day` が目標の `end_day` を越えるとき問う。伸ばす＝目標 `end_day` をルール終端まで延長。やめる＝ルールを目標末尾まで切り詰める（範囲短縮）。
- 不変条件：**目標は、ぶら下がる全ルールが決着するまで完走しない**。

- **なぜ**: 完走を PDCA の明示的な決定点にする（ユーザー意向）。延長は「末尾ルールが宙に浮く」穴を塞ぐ最小手。
- **代替案**: ルールを目標末尾で強制打ち切り→ 範囲Checkが途中で切れて authentic に満たせない。ルールを目標外へ孤立させて走らせる→ 回答実績の帰属先が消える。→ 延長 or 切り詰めの二択を問う。
- **loophole 確認**: 延長は「縛りを増やす」方向なので、enforcement から逃げる用途には使えない（脅威モデル整合）。

### D8: デモモードのチュートリアル（日付送り）

**決定**: デモは現状閲覧専用だが、2動線だけ**日付を進めるボタン**（「1日後」「30日後」）で体験させる。固定 day_key ベースで `now` を進め、`POST /api/demo/*` の実サーバー経路で通知（初回オープン toast）と完走フォークを発火させる。`demo-seed.ts` に単発ルール通知・完走間近目標の筋書きを焼き込み、`demo.test.ts` の期待値を更新（既存の達成24/30 等は壊さない）。

- **なぜ**: 日数が絡む機能はデモモードで成果を明示する（プロジェクト必須ルール）。テストしやすさを実装段階の目標に含める。

## Risks / Trade-offs

- **大規模な削除を伴う移行** → `rules.ts` の凍結モデル撤去は広範。段階移行（D9）で、旧テーブルを残したまま `rule`/`rule_change` を並走構築し、`evaluate`/`goals` の読み取りを切り替えてから旧経路を撤去する。
- **過去日カレンダーの断線** → `legacy_condition_key` フォールバックのテストを移行前後の不変性で固める（`group-rule-snapshot-identity` の 2.4 と同種）。
- **凍結撤廃で当日ゲートが緩む** → 仕様上の意図的緩和。理由・操作を `rule_change` に残し、沿革で可視化。デモで挙動を明示。
- **Plan/Check データ損失** → 実データ Plan1・Check0 のため破棄で損失なし。移行前にカウントを確認（済）。
- **`end_day` 可変が既存集計に波及** → レポート①カレンダー・`Day N/M`・完走判定のみが `end_day` を読む。`end_day` を単調増加（前方向のみ）に限定し、短縮手段を提供しない。

## Migration Plan

1. **並走構築**: `rule` / `rule_change` / `goal_rule` テーブルと `goal.end_day` 可変化を追加（マイグレーション新版）。既存 `rule_condition` の distinct 条件から `rule` 行を生成し、旧 `condition_key` を `legacy_condition_key` に保存。`practice_threshold_change` を `rule_change` へ移送。`goal_practice.condition_key` → `rule_id` 対応表を張る。
2. **読み取り切替**: `evaluate.ts` を `rule` 起点評価＋`legacy` フォールバックへ。`goals.ts`（採用→紐付け・沿革→`rule_change`・完走フォーク・延長）と `goal-chronicle.ts` を切替。
3. **書き込み切替**: 目標作成・振り返りコーナーのルールCRUD API を `rule`/`rule_change` へ。理由必須・自動紐付け。今日タブ書き込み動線撤去。
4. **凍結モデル撤去**: `daily_rule_set`/`rule_condition` 依存（`RuleStatus`・freeze-on-read・baseline 検証・ジャンル固定）を削除。`rollover.ts`/`recompute.ts` の凍結前提を整理。
5. **Plan/Check 撤去**: `goal_plan`/`goal_check`/`goal_check_result` の API・UI・テーブルを廃止し、回答実績を `rule` 配下へ。
6. **UI**: 振り返りコーナー（一覧＋共通ダイアログ＋最近の変更）、⑤沿革、完走/延長フォーク、デモ日付送り。
7. **検証**: `demo-seed.ts`＋`demo.test.ts` 更新。`PORT=<空きポート> DB_PATH=:memory: npm run server` で `POST /api/demo/reset`→通知/完走フォークを実経路で確認。`npm run typecheck && npm test`。
- **ロールバック**: 各段は旧テーブルを残したまま進めるため、読み取り切替（2）以前なら旧経路へ戻せる。撤去（4/5）以後は forward-only。

## Open Questions

- なし（`ユーザーフロー.md` の❓一覧は解決済み）。実装中に具体的な列名・API 形状は tasks で確定する。
