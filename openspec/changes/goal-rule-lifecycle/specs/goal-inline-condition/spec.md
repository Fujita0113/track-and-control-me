## MODIFIED Requirements

### Requirement: 目標作成時に新規条件を作成して採用できる

目標作成は、その場で**新規ルールを作成し、作成した目標へ自動で紐づける**（`goal_rule`）SHALL（「既存条件の採用」明示選択は廃止）。対応ターゲットは時間型・非時間型・写真・質問を含む **`TOTAL_WORK` / `GROUP` / `TIMELINE` / `MANUAL_CHECK` / `PLANNING` / `PHOTO` / `QUESTION`**。各ターゲットの新規ルールは次を持つ: `TOTAL_WORK` は `thresholdSeconds`（>0）、`GROUP` は**グループ identity**（直近使用グループから選択）と `thresholdSeconds`（>0）、`TIMELINE` はカテゴリ名 `label`（非空）と `thresholdSeconds`（>0）、`MANUAL_CHECK` はチェック名 `label`（非空・閾値なし）、`PLANNING` は `signalKey`、`PHOTO` はキャプション（非空・後変更不可）、`QUESTION` は質問文（非空）。スケジュール（永続／単発／範囲）は種類と独立に指定 SHALL する（`editable-rule-registry`）。

新規ルールの作成には**非空の理由が必須**（`editable-rule-registry`）SHALL。作成された `rule` 行は安定キー `rule:<id>` を持ち、目標はこの `rule:<id>` を紐づけ SHALL する。作成と紐づけは一体の操作として扱い、途中で失敗（バリデーション）した場合は目標もルールも作成してはならない（MUST NOT）。かつて存在した「開始日の実効ルールへ追記」「今日開始は当日 `DRAFT_TODAY` 経路で追記」「既存キーとの重複は既存採用へ寄せる」処理は、凍結モデル・採用モデルの撤廃により不要 SHALL とする。

`GROUP` のグループ選択肢は、直近に実測された identity の一覧（`group-identity-registry`）から提示 SHALL し、`tab_group` テーブルの行や UUID 文字列を提示してはならない（MUST NOT）。

#### Scenario: カテゴリ＋分数の TIMELINE ルールを作って紐づけられる

- **WHEN** 新規に「掃除・15分」の TIMELINE ルールを理由つきで追加して目標を作成する
- **THEN** `target='TIMELINE'`・`label='掃除'`・`threshold_seconds=900` の `rule` 行が作られ、`rule:<id>` が当該目標に紐づく

#### Scenario: グループ作業（GROUP）を作って紐づけられる

- **WHEN** 直近使用グループから `競技プログラミング` を選び「そのグループ・2時間」の GROUP ルールを理由つきで追加して目標を作成する
- **THEN** `target='GROUP'`・当該 identity 参照・`threshold_seconds=7200` の `rule` 行が作られ、`rule:<id>` が紐づく

#### Scenario: 写真ルールをその場で作って紐づけられる

- **WHEN** キャプション「前髪・正面」・範囲7日間の PHOTO ルールを理由つきで追加して目標を作成する
- **THEN** `target='PHOTO'` の `rule` 行が作られ、`rule:<id>` が当該目標に紐づく

#### Scenario: 理由なし・label 空・分数0は拒否される

- **WHEN** 理由が空、または `TIMELINE`/`MANUAL_CHECK` のラベルが空、または時間型の分数が 0 以下で目標を作成する
- **THEN** 400 エラーで拒否され、目標もルールも作られない

#### Scenario: 作成が失敗すると目標もルールも作られない

- **WHEN** 新規ルールの作成処理が失敗する（バリデーション不正）
- **THEN** 目標は作成されず、ルールも作られない（部分状態を残さない）

### Requirement: インライン作成は既存の採用条件・ルールを壊さない

目標作成時のインライン作成は、既存の他ルールを据え置きで保持したうえで新規ルールを加える SHALL。既存ルールの内容・安定キーを変更してはならない（MUST NOT）。凍結モデル・ジャンル固定は廃止されたため、`DRAFT_TODAY` への materialize や baseline 保存、ジャンル固定違反の検査は行わない SHALL。

#### Scenario: 既存ルールが保持される

- **WHEN** 既に `total_work` ルールがある状態で、新規「掃除15分」ルールを追加して目標を作成する
- **THEN** 既存の `total_work` ルールは内容・安定キーとも変わらず、新規ルールが加わる

#### Scenario: 他目標が追う条件を壊さない

- **WHEN** 別目標が追うルールがある状態で、新規 TIMELINE ルールのインライン追加を行う
- **THEN** 既存ルールは変更されず、追加と紐づけが成功する（ジャンル固定違反の検査は無い）
