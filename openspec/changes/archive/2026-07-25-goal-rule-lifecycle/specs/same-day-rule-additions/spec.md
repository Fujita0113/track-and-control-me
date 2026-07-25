## REMOVED Requirements

### Requirement: 当日ルールへの新規条件の追加を許可する

**Reason**: 凍結モデル（`DRAFT_TODAY`・`FROZEN_ACTIVE`・freeze-on-read）の撤廃により、「当日は追加のみ許可」という限定が不要になった。ルールはいつでも追加・変更・削除でき当日から効く（`editable-rule-registry`「ルールはいつでも追加・変更・削除でき当日から効く」）。

**Migration**: 当日の追加は通常のルール追加として行う（理由必須）。`DRAFT_TODAY` ルールセットの materialize は行わない。

### Requirement: 当日追加分は同日中に限り自由に編集・削除できる

**Reason**: 「当日追加分だけ自由・既存は凍結」という区別は凍結モデル前提。全ルールがいつでも編集可能になったため区別が消えた。

**Migration**: すべてのルールを同日中も含めいつでも理由つきで編集・削除できる（`editable-rule-registry`）。`SAME_DAY_BASE` 下駄・`retractTodayAdditions` は撤去する。

### Requirement: 当日編集は day 開始時点のゲートを緩めてはならない

**Reason**: 「day 開始時点 baseline を包含し緩めさせない」という制約は、当日ゲートを緩ませないための機構だった。ユーザー方針（ゆるく作り締めたい箇所だけ締める）により、この制約自体を降ろす。過去日の判定は凍結済みで不変のため、当日を緩めても歴史は書き換わらない。

**Migration**: baseline 包含検証（`resolveTodayBaseline` / `sameConditionAttrs`）を撤去する。当日の緩和・削除は理由つきで `rule_change` に残す（`editable-rule-registry` / `goal-chronicle`）。

### Requirement: 当日追加条件を目標が採用すると同日でも骨抜き不可になる

**Reason**: 「採用したら同日でも削除不可」はジャンル固定の一部。ジャンル固定の撤廃（`goal-challenge`）により、採用中でも理由つきで削除できるようになった。

**Migration**: 目標が追うルールも理由つきでいつでも削除・変更できる（`goal-challenge`「閾値変更には理由が必須で、記録される」の削除シナリオ）。過去の達成日数は凍結済みで不変。
