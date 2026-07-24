## Why

解錠ルールの「実践採用」モデルは、採用した条件を期間中いじれない前提（ジャンル固定・凍結）で組まれている。その結果、拡張機能のバグで壊れた `group:<uuid>` を指す条件が「面接の時間で解錠される」状態のまま**変更もできない**（issue #59）。さらに #54 で入れた Plan / Check は「賭けを書く→答え合わせを仕掛ける」の2段階が直感的でなく、実運用でうまく使えていない。

根本原因は2つ。(1) 条件の同一性が**内容から導出したキー**（`group:<uuid>` / `timeline:<ラベル>` 等）で、内容を直すとキーが変わり過去の評価記録と縁が切れるため、「直す」を仕様で禁止するしかなかった。(2) 過去日の判定はすでに `unlock_evaluation` に凍結されているのに、凍結モデル（`DRAFT_TODAY` / `FROZEN_ACTIVE` / freeze-on-read / 当日 baseline 包含検証）が「当日ルールを緩ませない」ためだけに大きく居座り、変更・削除・差し替えの動線を塞いでいる。

方針は「ゆるく作り、締めたくなった箇所だけ後から締める」。効果のない制限（理由を書けば外せる＝抑止にならない）で UX を落とすより、いつでも変更でき、その事実と理由が沿革に残るほうがよい。

受け入れ基準の唯一のソースは本変更の `ユーザーフロー.md` とする。

## What Changes

- **BREAKING（内部モデル）**: 解錠ルールを**第一級エンティティ**にする。`rule` 行を持ち、安定キーは行の id（`condition_key = 'rule:<id>'`）。中身（target / 閾値 / グループ identity / ラベル / キャプション / 質問文 / スケジュール）が変わっても **id は不変**。過去日の凍結済み評価（`unlock_evaluation.per_condition_results` の旧キー）とは `legacy_condition_key` で橋渡しする。既存データはマイグレーションで `rule` 行へ移送し、旧 `condition_key` を `legacy_condition_key` に保存する（過去日は書き換えない）。
- **BREAKING（凍結モデル撤廃）**: `RuleStatus`（`DRAFT_FUTURE`/`DRAFT_TODAY`/`FROZEN_ACTIVE`/`PAST`）・`SAME_DAY_BASE` 下駄・freeze-on-read・当日 baseline 包含検証・ジャンル固定（採用中条件の削除禁止）を撤去する。ルールは**いつでも追加・変更・削除でき、その日から効く**。過去日の判定は凍結済みなので歴史は書き換わらない。
- **理由を全操作で必須化**: ルールの追加・変更・削除はどれも非空の理由を伴う（場合分けしない）。操作は `rule_change`（`rule_id` / `day_key` / `op` / `before` / `after` / `reason`）に記録し、これが**沿革の実体**になる。既存の `practice_threshold_change` は `rule_change` に一般化・移送する。
- **Plan / Check を畳む**: `goal_plan` / `goal_check` / `goal_check_result` の語彙・データを廃止し、**写真ルール（PHOTO）／質問ルール（QUESTION）**へ移す。種類（何を判定するか）と いつ（永続／単発／範囲）は独立2軸。繰り越しは種類から決まる（PHOTO/QUESTION の単発のみ達成まで繰り越し、範囲はその日限り、時間型は繰り越し無し）。既存 Plan/Check データ（Plan 1件・Check 0件）は破棄する。
- **「採用」概念の廃止**: ルールを足せる入口を **目標作成時** と **振り返りタブの目標コーナー** の2つに限り、足したルールを自動でその目標に紐づける。**今日タブのルール操作（作成・編集・削除）は全撤去**する。ルールは従来どおりグローバルに効く（ゲートは1つ）。
- **完走フォーク**: 目標の完走時に「続ける／終える」を問う。続ける＝新30日目標を作り直し永続ルールを続投。終える（理由は任意）＝永続ルールをゲートから外し、目標は完走済みでアーカイブ（レポート・沿革は残す）。未回答の間は永続ルールがゲートに残り縛る。
- **完走期間の延長**: 目標内で作るルールの終了が目標の終了を越えるとき「目標を伸ばすか」を問う。伸ばす＝`end_day` を前方向に延長（「30日固定」→「30日以上」・`Day N/M` 表示）。やめる＝ルールを目標末尾まで自動で切り詰める。
- **デモモードのチュートリアル検証**: 日付が絡む2動線（単発ルールの当日通知・完走フォーク）を、デモモードの「1日後」「30日後」ボタンで日付を進めて体験・検証できるようにする（固定 day_key・実サーバー経路）。

## Capabilities

### New Capabilities

- `editable-rule-registry`: 解錠ルールを第一級 `rule` 行（安定キー `rule:<id>`・`legacy_condition_key` 橋渡し）にし、いつでも追加・変更・削除できて当日から効く。全操作に理由が必須で、`rule_change` が沿革の実体になる。写真（PHOTO）・質問（QUESTION）ターゲットを含む。
- `goal-lifecycle-fork`: 目標の完走で「続ける／終える」を問い、末尾を越えるルールを作るときに目標期間の前方向延長を問う。目標は「ぶら下がる全ルールが決着するまで完走しない」。
- `demo-rule-tutorial`: デモモードで「1日後」「30日後」ボタンにより日付を進め、単発ルールの当日通知と完走フォークをチュートリアルとして体験・検証する。

### Modified Capabilities

- `goal-challenge`: 実践の「採用」を廃止（目標作成時・振り返りで足したルールを自動紐付け）。ジャンル固定（採用中条件の削除禁止）を撤廃。期間「30日固定」を「30日以上（末尾ルールを見届けるため前方向に延長されうる）」へ緩め、状態表示を `Day N/M` にする。閾値変更のみ理由必須だったのを全ルール操作の理由必須へ拡張。
- `goal-check-gate`: Check の合流を `check:<checkId>` から `rule:<id>`（写真/質問ルール）へ置き換える。繰り越しは種類から決まる（単発のみ繰り越し・範囲は当日限り）を維持し、今日タブから直接回答・取り下げできる動線を保つ。
- `goal-chronicle`: 沿革を「Plan の入れ子」から「`rule_change` の時系列年表（追加・変更・削除＋理由）」へ再構成。写真ルールは提出画像、質問ルールは Q&A を中身として残す。日記は載せない（不変）。
- `goal-report`: ①達成カレンダーの参照キーを `rule:<id>`（無ければ `legacy_condition_key`）で解決し、差し替え後も過去日が途切れないようにする。レポート先頭に完走フォークを出し、`Day N/M` 表示に対応する。
- `goal-inline-condition`: 目標作成時のインライン条件作成を「新規ルール作成＋自動紐付け」へ変更（採用選択を廃止・理由必須・グループは `/api/groups/recent` 由来）。
- `goal-plan-check`: **REMOVED**。Plan / Check の要件をすべて撤去し、`editable-rule-registry`（写真/質問ルール）へ畳む。
- `same-day-rule-additions`: **REMOVED**。凍結モデルに依存した「当日追加のみ許可・baseline 包含検証」の要件をすべて撤去する（ルールはいつでも変更可能になるため不要）。

## Impact

- **DB**: 新テーブル `rule`（第一級ルール・`legacy_condition_key`・`start_day`/`end_day`/`status`）と `rule_change`（操作ログ＝沿革）。`rule_condition` からの移送マイグレーション（distinct 条件→ `rule` 行、旧キーを `legacy_condition_key` へ）。`practice_threshold_change` → `rule_change` へ一般化・移送。`goal_plan`/`goal_check`/`goal_check_result` を廃止。`goal_practice.condition_key` を `rule_id` 参照へ（旧 `group:<uuid>`/`group:<identityId>` キーは legacy として維持）。目標に `end_day` 可変列。
- **サーバー**: `rules/rules.ts`（凍結モデル撤去・第一級ルールCRUD・理由必須・rule_change 記録）、`rules/evaluate.ts`（`rule:<id>` 参照・legacy フォールバック）、`services/goals.ts`（採用廃止・自動紐付け・完走フォーク・期間延長・沿革を rule_change から）、`services/goal-chronicle.ts`、`api/index.ts`（ルールCRUD の目標コーナー動線・完走フォーク・延長フォーク・デモ日付送り）。`services/rollover.ts` / `recompute.ts` の凍結前提の見直し。
- **UI**: `static/js/reflection.js`（目標コーナーにルール一覧＋共通ダイアログ＋最近の変更）、`static/js/plan-check.js`（廃止 or ルール部品へ再構成）、`static/js/today.js`（ルール編集動線の撤去・ゲート回答動線は維持）、`static/js/rules.js`（今日タブ動線撤去に伴う整理）、`static/js/goals.js`（⑤沿革を rule_change 年表へ・完走フォーク・Day N/M）、`static/js/demo.js`（1日後/30日後ボタンのチュートリアル）。
- **デモモード**: `demo-seed.ts` に単発ルール通知・完走フォークの筋書きを焼き込み、`demo.test.ts` の期待値を更新（達成 24/30 等の既存筋書きは壊さない）。
- **非対象**: 同一内容ルールの dedup、`daily_totals_snapshot` 生データ・総作業時間の算入スコープ・divide-by-N 配分・日境界分割、group identity レジストリ／改名追随／拡張の採番（`group-rule-snapshot-identity` で完了済み。本変更はその上に乗る）。
