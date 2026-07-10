## Context

解錠ゲート（`server/src/rules/evaluate.ts`）は当日集計にルール条件を評価し `first_met_at` を latch する。条件ターゲットは `TOTAL_WORK` / `GROUP` / `MANUAL_CHECK` / `PLANNING`。`PLANNING` は `getPlanningSignal(db,dayKey).planningDone` を返すのみで、**`rule_condition.signal_key` 列は UI・API入力・表示まで配線済みだが `evaluateDay` で参照されない**。

`getPlanningSignal`（`server/src/services/planning.ts`）は既に内部で算出:
- `reflectionDone`: `reflection_entry.date=dayKey` かつ `content` 非空
- `tomorrowTaskCount`: `nextDayKey(dayKey)` を `planned_for` または `due` に持つ未完了(`status<>'DONE'`)タスク数
- `planningDone = (!requireReflection || reflectionDone) && tomorrowTaskCount >= planning_min_tomorrow_tasks`

カンバン（`server/static/js/kanban.js`）の現状:
- 4列 HOLD/TODO/DOING/DONE。新規は列内インラインコンポーザで `due:null` 固定作成（`commitComposer`）。
- 期限は詳細パネルのカレンダーピッカーで設定（クイック: 今日/明日/期限なし、`pickDue`）。`planned_for` は UI 未使用。
- 完了はドラッグで DONE 列へ→アニメ後アーカイブ。

制約:
- 凍結ポリシー: 当日・過去ルールは編集不可。`signal_key=null` の既存 `PLANNING` 条件の評価結果を変えてはならない（後方互換必須）。
- 評価は `dayKey` ベース。当日/翌日は `dayKeyFor` / `nextDayKey`、クライアントは `state.today` / `addDays`。

## Goals / Non-Goals

**Goals:**
- 「振り返りをした」「明日のタスクを登録した」を**自己申告でなく実データ**でゲート評価する。
- 明日タスクの検出を、`due=翌日` の自動付与＋明日トグルによる**意図の明示スタンプ**で確実にする。
- 期日入力の摩擦を無くす（列とモードから自動決定、例外だけ手動＝ロック）。
- 既存 `signal_key=null` の `PLANNING` 条件を従来どおり評価。

**Non-Goals:**
- 今日タブ拡充は別 change。`planned_for` の UI 復活はしない。
- latch/凍結/combinator/undefined_day_policy の挙動変更なし。カンバン列構成・振り返りスキーマの変更なし。

## Decisions

### D1: `PLANNING` を `signal_key` 駆動にする（新ターゲットを足さない）

`evaluateDay` の `case 'PLANNING'` を `condition.signal_key` で分岐:

```
'reflection_done'          → reflectionDone(dayKey)
'tomorrow_tasks_registered'→ tomorrowTaskCount(dayKey) >= planning_min_tomorrow_tasks
'tomorrow_planned'         → planningDone（既存合成）
null                       → planningDone（後方互換フォールバック）
未知キー                    → false ＋ console.warn（誤解錠しない安全側）
```

`reflection_done` と `tomorrow_tasks_registered` は既存 `planningDone` の構成要素を粒度分解したもの。両者を ALL 結合したルールは従来の `tomorrow_planned` と等価になる。**新 config は不要**（`planning_min_tomorrow_tasks` を流用）。

**代替却下**: 新ターゲット `REFLECTION`/`KANBAN` を追加する案は `RuleTarget` enum・DB CHECK・contract・UI・`deriveConditionKey` の全面拡張＋移行が必要。既設の `signal_key` 拡張点があるので冗長。

### D2: シグナルは中央レジストリで解決する

`signal_key → (label, evaluate(db,dayKey,cfg))` のマップを1箇所（`planning.ts` に `resolvePlanningSignal` を追加、または `rules/signals.ts` を新設）に置き、`evaluateDay` はそれを呼ぶだけにする。UI 語彙（`targets.js`）も同じキー集合を参照。未知キーは false、`null` のみ例外的に `tomorrow_planned`。

### D3: 自動 due 決定エンジン（クライアント）

ロックされていないタスクについて、**作成時**と**列移動時**に期日を自動決定する。「明日トグル」はクライアント状態（その日限り、localStorage を日付キーで保持しリセット）。

| トリガ | 遷移後の列 | 明日トグル | 付与 due |
|---|---|---|---|
| 作成 | 非HOLD | OFF | `today` |
| 作成 | 非HOLD | ON | `addDays(today,1)` |
| 作成 | HOLD | – | `addDays(today,7)` |
| 移動 → HOLD | HOLD | – | `addDays(today,7)`（移動日=today 基準） |
| 移動 HOLD→非HOLD | 非HOLD | OFF | `today` |
| 移動 HOLD→非HOLD | 非HOLD | ON | `addDays(today,1)` |
| 移動 非HOLD→非HOLD | 非HOLD | – | 変更しない |
| 移動 → DONE | DONE | – | 変更しない（完了＝アーカイブ） |

- 「HOLD+トグルON」は簡素化して `today+7`（ユーザー合意「明日+7でもどちらでも」の範囲内）。
- エンジンはクライアント（`kanban.js`）が実装し、算出した `due` を作成/更新 API に明示送信する。トグルはクライアント状態なのでサーバーへ持ち込まない。gate はモードでなく `due` データを見るので判定は独立に正しい。

**実装フック:**
- `commitComposer`（作成）: 現状 `due:null` → 上表で算出した `due` と `due_locked:0` を送る。
- `onDrop`（列移動・DONE以外）: ロック時は据え置き、非ロックは上表で `due` を再計算し `updateTask({due, ...})`。
- DONE 完了経路（`completeTask`）: `due` に触れない。

### D4: 手動指定はロック、「自動に戻す」で解除

- `pickDue`（今日/明日/期限なし/任意日付）で手動指定したら `due_locked=1` を立て、以後 auto は上書きしない。
- 期限ピッカーのクイック行に「自動に戻す」を追加。選ぶと `due_locked=0` にし、**現在の列＋明日トグルから D3 で再計算**して `due` を更新する。
- 永続化のため `task` に `due_locked INTEGER NOT NULL DEFAULT 0` を追加（マイグレーション＋`PATCHABLE`＋型）。

**代替却下**: ロックを持たない案では、手動で締切を設定したカードが翌日の列移動で勝手に today/明日 へ書き換わり、ユーザーの明示的意図を壊す。ロック永続化は必須。

### D5: 計画モードへの移行（振り返り完了ボタン＋手動トグル）

- `reflection.js` に「振り返りを終えて明日の計画へ」ボタンを追加。押下で (1) 現在の振り返りを保存（`reflection_done` 成立）、(2) 明日トグルを ON、(3) カンバンタブへ遷移。
- `kanban.js` に明日トグル UI を置き、振り返り済みの日に計画だけやり直せるようにする。
- 計画モード中は「明日のタスク n/`planning_min_tomorrow_tasks` 登録」を表示（`due=翌日` の未完了カード数）。

`reflection_done` の判定は本文非空（既存 `reflectionDone` と一致）。ボタンは新フラグを増やさず、非空保存で成立させる（空本文では成立しないので、空時はボタンで保存を促す／無効化）。

## Risks / Trade-offs

- **[未知 signal_key で誤解錠]** → false フォールバック＋警告。`null` のみ後方互換で `tomorrow_planned`。既知集合はレジストリ1箇所管理。
- **[凍結済みルールの評価が変わる回帰]** → `signal_key=null` が現行 `planningDone` と完全一致することをテストで担保。`is_final=1` は再評価しない既存ガードも保険。
- **[自動 due が既存カードを一括改変する不安]** → 自動付与は「新規作成」と「列移動」時のみ。既存カードを走査して書き換えない。ロックは常に優先。
- **[due=締切≠予定日 の意味ズレ]** → 明日トグルで意図を明示スタンプ＋閾値設定で吸収。gate は due=翌日 件数のみ見る。
- **[トグル状態のクライアント揮発]** → その日限り・localStorage。消えても gate はデータ判定なので解錠可否に影響しない（トグルは入力補助）。

## Migration Plan

1. `migrations.ts` に `task.due_locked INTEGER NOT NULL DEFAULT 0` を `ALTER TABLE ADD COLUMN`（既存行は既定0）。`db/index.ts` の型・`tasks.ts` の `PATCHABLE`・create に反映。
2. サーバー: シグナルレジストリ＋`evaluateDay` ディスパッチ。`signal_key=null` 後方互換を保証。
3. クライアント: 自動 due エンジン（`commitComposer`/`onDrop`）、ロック＋「自動に戻す」、明日トグル、進捗、振り返りボタン、ルール UI のドロップダウン化、設定の閾値入力。
4. ロールバック: `due_locked` 列は残っても無害。コードを戻せば `PLANNING` は合成シグナルのみへ、`due` は再び手動運用へ戻る（データ破壊なし）。

## Open Questions

- `tomorrow_tasks_registered` の対象列を限定するか。現案は列不問で `due=翌日 AND status<>'DONE'` を計上（HOLD の明日締切も数える）。運用を見て `TODO`/`DOING` 限定に絞る余地あり（spec は「未完了タスク」で列非限定）。
- 明日トグルの永続範囲。現案はその日限りで翌日 OFF リセット。手動 OFF も可能。
