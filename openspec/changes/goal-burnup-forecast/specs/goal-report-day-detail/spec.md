## REMOVED Requirements

capability `goal-report-day-detail` を**丸ごと廃止**する。入口が `goal-report` の①達成カレンダーのマスだけであり、①ごと無くなるため到達手段が存在しなくなる。

### Requirement: ①のマスにホバーすると、新規取得なしでその日の文面プレビューが出る

**Reason**: ホバー対象の①達成カレンダーが `goal-report` ごと廃止されるため。
**Migration**: なし。振り返りの本文は振り返りタブで従来どおり読める。

### Requirement: ①のマスをクリックすると、既存の④選択に加えて日別詳細モーダルが開く

**Reason**: クリック対象の①と、連動先の④がいずれも廃止されるため。
**Migration**: なし。

### Requirement: 振り返り（気分・本文）はモーダルからその場で編集・保存できる

**Reason**: モーダルの入口が失われるため。編集経路そのものは `reflection-journal` に独立して存在する。
**Migration**: 気分・本文の編集は振り返りタブで行う。`PUT /api/goals/:id/journal/:date` は変更しない。

### Requirement: デモモードではモーダルを開かない

**Reason**: モーダルが存在しなくなるため。
**Migration**: なし。
