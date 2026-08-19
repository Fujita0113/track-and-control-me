## REMOVED Requirements

capability `goal-report` を**丸ごと廃止**する。進行中・完走後のいずれでもレポート画面は開けなくなり、`GET /api/goals/:id/report` も無くなる。走行中に見たいのは「この調子だといつ終わるのか」だけで、5ブロックはそのどれも答えていなかった。行き先は `goal-burnup`（見通し）1つに統一する。

積み上げたデータ（`unlock_evaluation` / `goal_journal` / `goal_journal_image` / `rule_change` / `rule_answer`）は**削除しない**。読み手が消えるだけで、後から別の画面へ出せる。

### Requirement: レポートは進行中でも開ける（走行中プレビュー）

**Reason**: レポート画面そのものを廃止するため。進行中の行き先は `goal-burnup`（見通し）に一本化する。
**Migration**: 目標カードの導線は進行中・完走後とも「見通し」になる。`GET /api/goals/:id/report` は削除する。

### Requirement: ヘッダ＋5ブロック構成（指定外の要素を足さない）

**Reason**: 5ブロックのうち②以外は走行中に素材が溜まらず、完走後も開く動機がなかった。②はバーンアップとして `goal-burnup` へ移る。
**Migration**: 見通しがヘッダ（目標名・Day・期限）とバーンアップで構成される。①③④⑤に相当する画面は無くなる。

### Requirement: ① 達成カレンダーは per_condition_results から描く

**Reason**: 日ごとの達成/未達成のマス目は「今日の自分に印が付く画面」であり、毎日開く動機にならなかった。積み上がりは累積線が示す。
**Migration**: 代替の画面は用意しない。`unlock_evaluation.per_condition_results` は解錠評価のために従来どおり書かれ続ける。

### Requirement: 完走レポートは続ける／終えるフォークを提示する

**Reason**: フォークの**提示場所**がレポート先頭だったため、レポートの廃止に伴い場所を失う。フォーク自体は残す（`goal-lifecycle-fork` MODIFIED で目標カードへ移す）。
**Migration**: 完走した目標のカードに「続ける」「終える」が直接並ぶ。未回答の間に永続ルールがゲートへ残る規則は変えない。

### Requirement: ② 時間の推移は評価時の焼き込み値で描く

**Reason**: 日々の実測と閾値の折れ線は「その日ノルマを守れたか」を示すもので、①と同じ問いに二度答えていた。「どれだけ積み上がったか」「いつ終わるのか」はどこにも無かった。
**Migration**: 累積作業時間のバーンアップ（`goal-burnup`）が置き換える。目標時間の水準線は、累積を縦軸に取るバーンアップに対応する表現が無いため併せて廃止する。`goal-target-hours` 本体と目標カード・今日タブのペース表示は変更しない。

### Requirement: ③ 写真の比較

**Reason**: レポート画面の廃止に伴い表示場所を失う。証拠写真は大きい沿革（`goal-history`）が終了・完走の行で Before→After を表示しており、そちらが唯一の読み手になる。
**Migration**: `goal-history` MODIFIED で証拠写真の解決規則を自前の要件として持たせる。`goal_journal_image` と `rule_answer` の保存は変更しない。

### Requirement: ④ 日記ストリップは記録のある日を横スクロールで全件並べる

**Reason**: レポート画面の廃止に伴い表示場所を失う。日記の読み書きは `goal-journal`（振り返りタブの目標コーナー）に独立して存在する。
**Migration**: 日記は振り返りタブの目標コーナーで従来どおり書ける。過去日の一覧表示は無くなる。

### Requirement: ①のマスから④の該当カードへ寄る

**Reason**: ①と④の両方が無くなるため、この連動も存在しなくなる。
**Migration**: なし。

### Requirement: 凍結日は対象外として、開始前・削除後と区別して描く

**Reason**: 描画対象の①が無くなるため。
**Migration**: バーンアップは凍結日を除外せず 0h の実績として暦どおり数える（`goal-burnup`）。凍結の記録そのもの（`goal_freeze` / `goal_freeze_change`）は変更しない。

### Requirement: 凍結日は達成日数の分母にも分子にも入らない

**Reason**: 達成 N/M を出すヘッダが無くなるため。
**Migration**: `goal-target-hours` のペース（凍結日を分母から除く）は**変更せず**そのまま残る。
