## Context

`goal-freeze` は「当日凍結」（`kind='same_day'`・当日発効・期限延長なし）と「期間凍結」（`kind='period'`・翌日発効・期限延長あり）の2種別を、`goal_freeze.kind` 列で持ち分けたうえで同じ月1回枠を共有している（`server/src/services/goal-freeze.ts`）。`goal-lifecycle-fork` の「終える」は `goal.ended_day_key`/`end_reason`/`outcome_met`/`final_pace_json` の単一カラム群で1回きりの終了イベントを表現し、発効前（`today < ended_day_key`）のみ取消できる。

issue #103 により、この2種別を1つの「当日発効・終了日自由指定」の凍結へ統合し、さらに「終える」に「再開する」を追加して終了→再開のサイクルを無制限に繰り返せるようにする。両者とも、既存の「凍結日数ぶん `end_day` を前方向に延長し、その日数をペースの分母・達成カレンダーの分母から除外する」という設計（`effectiveEndDay`/`frozenDaysUpTo`）と同じ思想を踏襲する。

対象コード: `server/src/services/goal-freeze.ts`、`server/src/services/goals.ts`、`server/src/services/goal-history.ts`、`server/src/services/goal-chronicle.ts`、`server/src/db/migrations.ts`、`server/static/js/goal-freeze.js`・`goals.js`、`packages/contract/src/index.ts`。

## Goals / Non-Goals

**Goals:**
- 一時凍結を単一種別（当日発効・終了日自由指定・月1回・延長可・即日解除可）に統合する。
- 発効済みの終了を「再開する」で取り消せるようにし、終了→再開サイクルを無制限に繰り返せるようにする。
- 終了していた日数を、凍結日数と同じ思想（`end_day` 前方向延長・ペース分母除外・達成カレンダー対象外表示）で扱う。
- 既存の「凍結は月1回・翌日発効の終了取消不可」等、変更対象外の規則はそのまま保つ。

**Non-Goals:**
- 目標の削除（作成当日のみ）フローの変更。
- 完走フォーク（続ける／終える）で新しい目標を作る経路の変更。
- 凍結・終了の月/回数制限そのものの値を変えること（凍結は引き続き月1回、終了・再開は引き続き無制限＝現状の「終える」に回数制限が無いのを維持するだけ）。

## Decisions

### D1: 凍結は常に当日発効・`kind` 列を廃止する

`goal_freeze` から `kind` 列を削除し、`start_day` は常に予約日（＝当日）で固定する。`end_day` は当日以上の任意の日を要求する（従来「当日固定」だった当日凍結の代わりに、ユーザーが同じ日を指定すれば実質1日だけの凍結になる）。

- 経過日数の計算 (`frozenDaysUpTo`) は種別フィルタが不要になり、全区間を対象にする。
- 月枠判定は常に `today` の月（`quotaMonthOf(today) = today.slice(0, 7)`）になり、`sameDayQuotaMonthOf`・月末の二重月判定は丸ごと不要になる。
- 「発効前の予約」フェーズが無くなるため、`cancelFreeze`（発効前取消）は削除する。同日中に取りやめたい場合は既存の `releaseFreeze`（即日解除・凍結日数0扱い）で受ける。
- **代替案**: `kind` 列を残しつつ常に `'period'` を書き込む案もあったが、無意味な列を残すと「なぜ2種別の名残があるのか」を後から読む人が誤読するため、列ごと削除する。

### D2: 終了→再開は「開いている1サイクル」＋「閉じた過去サイクルの履歴テーブル」で持つ

`goal` に `resumed_day_key`（再開の発効日・翌日固定）・`resume_reason` を追加する。既存の `ended_day_key`/`end_reason`/`outcome_met`/`final_pace_json` と合わせて「今アクティブな1サイクル」を表す。

過去に閉じた（再開まで完了した）サイクルは `goal_end_interval`（`goal_id, ended_day_key, resumed_day_key, end_reason, resume_reason, outcome_met, final_pace_json`）に**アーカイブ**する。アーカイブが起きるのは、**再開済みの目標に対してもう一度「終える」が呼ばれた瞬間**だけである: そのとき初めて `goal` の現サイクル列を上書きする必要が生じるため、上書き前に現在の列内容を `goal_end_interval` へ INSERT してから新しい `ended_day_key` 等を書き込む（同一トランザクション）。

日次 cron を持たない既存方針（`goal-check-gate`・`goal-freeze` と同じ）に合わせ、**「再開の発効」自体は物理的な書き込みを伴わない**。状態導出はすべて比較で行う:

```
isEnded(goal, today) =
  goal.ended_day_key != null
  && today >= goal.ended_day_key
  && (goal.resumed_day_key == null || today < goal.resumed_day_key)
```

`today >= resumed_day_key` になった瞬間、`isEnded` は自動的に false へ倒れ、目標は「進行中」または「完走」の通常導出に戻る。現サイクルの列（`ended_day_key` 等）は次に「終える」が呼ばれるまでそのまま `goal` 行に残り続けるが、これは実害がない（`isEnded` が false を返す限り読み手はそれを「進行中」として扱うため）。

- **代替案**: 再開発効のタイミングで即座にアーカイブへ書き込む案（lazy write-on-read）も検討したが、「いつ誰が読んだかに依存して書き込みが発生する」という新しい非決定性を持ち込み、既存の「状態は保存せず導出する」方針（`goal-challenge`）と衝突するため採らない。

### D3: 実効 `end_day` の延長は「凍結の経過日数」＋「終了していた経過日数」の合算

`effectiveEndDayOf` を拡張し、凍結区間の経過日数 (`frozenDaysUpTo`) に加えて、終了区間の経過日数を合算する。終了区間の集合は、`goal_end_interval` の全行（アーカイブ済み）＋ `goal` の現サイクル（`resumed_day_key` が設定済みなら、`goal.ended_day_key`〜`goal.resumed_day_key - 1` の区間も含める）から構成する。`resumed_day_key` が未設定（＝再開の予約すらまだ無い、または今まさに「終了」中）の区間はカウントしない（凍結の「未到来の凍結予定日は期限に影響しない」と同じく、確定していない・まだ到来していない終了区間を延長に混ぜない）。

各区間の経過日数計算は `frozenDaysUpTo` と同じ `min(区間終端, today)` キャップのロジックを再利用する（`endedDaysUpTo` として実装し、両者を合算した値を `end_day` に加算する）。

ペースの分母・達成カレンダーの「対象外」表示も、同じ終了区間の集合を凍結区間と同列に扱う（既存の「凍結日を分母から除く」実装に終了区間を混ぜ込む）。

### D4: 再開も「翌日発効・発効前は取消可」で終了と対称にする

`resumeGoal(goalId, reason)` は `isEnded(goal, today)` が真のときのみ許可し、`resumed_day_key = today + 1` と `resume_reason` を書き込む（アーカイブは発生しない・上記 D2）。`cancelResumeGoal(goalId)` は `resumed_day_key != null && today < resumed_day_key` のときのみ許可し、`resumed_day_key`/`resume_reason` を null に戻す（`ended_day_key` 等はそのまま＝目標は「終了」に留まる）。この形は既存の「終了は翌日発効・発効前のみ取消可」（`cancelEndGoal`）と完全に対称であり、UI・確認文言も流用できる。

## Risks / Trade-offs

- [`goal_freeze` から `kind` 列を削除する破壊的マイグレーション] → 個人利用アプリで本番データの後方互換を保つ必要が薄いため、`ALTER TABLE goal_freeze DROP COLUMN kind` で列ごと削除する（better-sqlite3 が同梱する SQLite は DROP COLUMN をサポート）。既存の凍結行は `kind` を読まなくなるだけで `start_day`/`end_day`/`reason` は保持される。
- [`goal` 行に未アーカイブの「閉じたサイクル」が残ったまま長期間放置される（再開後、二度と「終える」を呼ばない）] → 実害はない（D2 の通り `isEnded` は false のまま）。ただし `goal-history`/`goal-chronicle` は「アーカイブ済み `goal_end_interval` の行」と「`goal` 行上の未アーカイブな閉じたサイクル」の両方を読んで年表に合成する必要がある（アーカイブされていないからといって年表から消えてはならない）。
- [終了→再開の繰り返しで `goal_end_interval` が際限なく増える] → 個人の目標運用サイクルの頻度を考えれば実用上問題にならない。上限は設けない（issue の要求どおり）。
- [凍結と終了/再開が同時に効く目標] → 直交する機構として扱う。終了により当該目標の永続ルールはゲートから外れるため、進行中の凍結の有無は解錠評価に影響しない。凍結の月枠と終了/再開の可否も独立（既存どおり）。

## Migration Plan

1. 新規マイグレーション（version 32）: `goal_freeze` から `kind` 列を削除し、`goal` に `resumed_day_key`/`resume_reason` を追加、`goal_end_interval` テーブルを新設する。
2. `server/src/services/goal-freeze.ts`: `sameDayFreeze*`/`sameDayQuotaMonthOf`/`FreezeKind`/`cancelFreeze` を削除し、`reserveFreeze*` を「当日発効」に書き替える（関数名は `freezeGoal`/`freezeGoalMulti` へ改名）。`frozenDaysUpTo`/`effectiveEndDay` から種別フィルタを外す。
3. `server/src/services/goals.ts`: `resumeGoal`/`cancelResumeGoal` を追加、`endGoal` にアーカイブ処理を追加、`effectiveEndDayOf`/ペース算出/達成カレンダー算出に終了区間を合算する。
4. `server/src/services/goal-history.ts`・`goal-chronicle.ts`: 新しい行種別（再開・簡素化した凍結イベント）に対応する。
5. `packages/contract/src/index.ts`: `FreezeEntryKindSchema`（`reserve`/`cancel` を削除）、`FreezeStateSchema`（`reserved` を削除）、`FreezeInputSchema`（種別選択を削除）、新規 `ResumeGoal` 系スキーマを追加する。
6. `server/static/js/goal-freeze.js`・`goals.js`: 種別選択 UI を削除し、目標カードへ「再開する」導線を追加する。
7. 影響を受ける既存 e2e（凍結モーダルの種別選択・当日凍結固有の文言）を更新する。

ロールバック: 単一コミット/PR 内で完結するため、問題が出た場合はこの変更をまるごと revert する（マイグレーションは前方専用の追加バージョンなので、DB は再作成（開発環境）または旧カラムを読まない新コード側のロールバックで対応する）。

## Open Questions

- 終了→再開を繰り返した目標のレポート①〜⑤・達成カレンダーの UI 表現（複数の「終了区間」帯をどう積み重ねて見せるか）は tasks 側の実装で詰める（本 design は「対象外として除外する」という規則のみを固定する）。
