## MODIFIED Requirements

### Requirement: 状態は導出され、成否ラベルは存在しない

目標の状態は、`ended_day_key`／`resumed_day_key` を除いて保存せず、現在の day_key から導出 SHALL する:

- `ended_day_key` が設定済みかつ `today >= ended_day_key` かつ（`resumed_day_key` が未設定または `today < resumed_day_key`）は「**終了**」（`goal-lifecycle-fork` の「終える」が設定する）
- 上記の終了状態のうち、`resumed_day_key` が設定済み（`today < resumed_day_key`）の場合は、加えて「**再開予約中**」であることと**発効する日**を併記 SHALL する（終了予約中と対称の表示）。再開予約中であることを保存された状態として持ってはならない（MUST NOT。`resumed_day_key` と today から導出 SHALL）。再開予約中の目標には、`goal-lifecycle-fork` の再開取消導線を示す SHALL。
- `ended_day_key` が設定済みでも `resumed_day_key` が設定済みかつ `today >= resumed_day_key` になれば、終了状態から外れ、以下の通常の導出（開始前／進行中／完走）へ戻る SHALL。
- `today < start_day` は「開始前」
- `start_day <= today <= end_day` は「進行中（Day N/M・M=`end_day − start_day + 1`）」
- `today > end_day` は「完走」

`ended_day_key` が設定済みでまだ発効していない（`today < ended_day_key`）目標は、**状態としては上記のとおり進行中または完走のまま** SHALL とし、加えて「**終了予約中**」であることと**発効する日**を併記 SHALL する。終了予約中であることを保存された状態として持ってはならない（MUST NOT。`ended_day_key` と today から導出 SHALL）。終了予約中の目標には、`goal-lifecycle-fork` の取消導線を示す SHALL。

達成日数・目標時間の到達可否によらず、合格・不合格・スコアに相当する状態や表示を持ってはならない（MUST NOT）。「完走」「終了」「終了予約中」「再開予約中」「到達」「未達」の事実表記のみを許す。完走時は「続ける／終える」を問う（`goal-lifecycle-fork`）。

#### Scenario: 期限を過ぎると完走になる

- **WHEN** 実効 `end_day` の翌日以降に目標一覧を見る
- **THEN** その目標は達成日数・目標時間の到達可否が何であっても「完走」と表示され、レポートを開けるようになる

#### Scenario: 終えた目標は終了として現れる

- **WHEN** 進行中に理由つきで終えた目標を、終了が発効した日以降に見る
- **THEN** その目標は「終了」と表示され、レポート・沿革・カレンダーは読めるまま残る

#### Scenario: 終えた当日は進行中のまま「終了予約中」と併記される

- **WHEN** 進行中の目標を終えた、その同じ日に目標一覧を見る
- **THEN** その目標は「進行中（Day N/M）」のまま並び、「終了予約中（翌日から）」と発効日、および取消の導線が併記される

#### Scenario: 延長された目標は Day N/M で進行中に留まる

- **WHEN** 末尾ルールまたは凍結のため `end_day` が延長された目標を、延長後の期間内に見る
- **THEN** 「進行中（Day N/M）」と表示され、延長後の `end_day` を越えるまで完走しない

#### Scenario: 再開を要求した当日は終了のまま「再開予約中」と併記される

- **WHEN** 終了が発効済みの目標を再開した、その同じ日に目標一覧を見る
- **THEN** その目標は「終了」のまま並び、「再開予約中（翌日から）」と発効日、および取消の導線が併記される

#### Scenario: 再開が発効すると進行中に戻る

- **WHEN** 再開が発効した目標を、発効日以降に見る
- **THEN** その目標は「進行中（Day N/M）」または「完走」として、通常の導出どおり表示される
