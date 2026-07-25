## REMOVED Requirements

### Requirement: Plan は振り返りタブの目標コーナーで書く

**Reason**: Plan / Check の2段階（賭けを書く→答え合わせを仕掛ける）は直感的でなく実運用で機能しなかった（issue #59）。Plan は「ルールを足す操作の**理由**」へ畳む（`editable-rule-registry`「ルールの追加・変更・削除には理由が必須」）。

**Migration**: 振り返りタブの目標コーナーでルールを追加する際、賭けの一文を**理由テキスト**として書く。理由は `rule_change` と沿革（`goal-chronicle`）に残る。

### Requirement: 1つの Plan に Check を複数ぶら下げられる

**Reason**: Plan の入れ子構造は廃止。Check は独立した写真ルール・質問ルールになり、Plan にぶら下がらない。

**Migration**: 各答え合わせは `target=PHOTO`/`QUESTION` の第一級ルールとして作成する（`editable-rule-registry`）。関連するルールは同じ理由テキストを持たせて緩く束ねる（構造的な親子は持たない）。

### Requirement: Check は種類と「いつ」の独立した2軸を持つ

**Reason**: 種類（📷写真／💬質問）と いつ（単発／範囲）の独立2軸は、ルールの `target`（PHOTO/QUESTION 等）と スケジュール（永続／単発／範囲）へそのまま移設された。

**Migration**: `editable-rule-registry`「写真ルール・質問ルールと種類×スケジュールの独立2軸」を用いる。永続（`end_day=null`）が新たに加わる。写真キャプション・質問文の先指定・後変更不可は維持される。

### Requirement: 日記は Plan / Check とは独立に保存する

**Reason**: Plan / Check が廃止されたため、「Plan/Check と独立」という言明の対象が消えた。日記の独立保存自体は `goal-journal` で不変。

**Migration**: 日記は従来どおり `goal-journal` で保存し、沿革には載せない（`goal-chronicle` で不変）。

### Requirement: 理由つき取り下げ

**Reason**: Plan / Check の取り下げは、ルールの**削除（−削除）**へ畳む。削除は理由必須で沿革に残る。

**Migration**: ルールを理由つきで削除する（`editable-rule-registry`「ルールの追加・変更・削除には理由が必須」）。削除した事実と理由は沿革に残る（`goal-chronicle`「取り下げた Plan / Check は理由つきで沿革に残す」）。既に達成済みの日の記録は凍結済みで不変。
