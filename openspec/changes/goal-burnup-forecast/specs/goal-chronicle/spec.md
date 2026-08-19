## REMOVED Requirements

capability `goal-chronicle`（⑤沿革）を**丸ごと廃止**する。表示場所が `goal-report` の⑤ブロックだけであり、レポートの廃止で読み手が存在しなくなる。

**失われるもの（正直に記す）**: ルール追加・変更・削除の理由つき年表、目標の凍結イベント、写真ルールの答え合わせ、質問ルールの Q&A。大きい沿革（`goal-history`）は**ルール操作・凍結イベント・日記を載せてはならない**（MUST NOT）と規定されており、これらを引き取らない。

**残るもの**: `rule_change` / `rule_answer` / `goal_freeze_change` / `practice_threshold_change` のレコードは削除しない。理由テキストは DB に残り続けるため、必要になった時点で別の画面へ出せる。

### Requirement: 沿革はルール操作と答え合わせを時系列に載せる

**Reason**: 表示場所である `goal-report` ⑤が廃止されるため。
**Migration**: なし。`rule_change` / `rule_answer` は従来どおり書かれ続ける。

### Requirement: 目標の凍結は理由つきで沿革に載る

**Reason**: 同上。
**Migration**: なし。`goal_freeze_change` は従来どおり書かれ続け、凍結機能そのものは変更しない。

### Requirement: 日記は沿革に載せない

**Reason**: 沿革が無くなるため、載せる／載せないの線引き自体が不要になる。
**Migration**: なし。

### Requirement: 削除・変更・完走終了は理由つきで沿革に残す

**Reason**: 同上。終了理由は大きい沿革（`goal-history`）の「−終える」の行に理由つきで残るため、終了に限っては読み手が残る。
**Migration**: 終了・再開の理由は大きい沿革で読める。ルールの削除・変更の理由は画面から読めなくなる。

### Requirement: 範囲ルールは達成した日を事実どおり示す

**Reason**: 表示場所が廃止されるため。
**Migration**: なし。
