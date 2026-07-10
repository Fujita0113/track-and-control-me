## Why

解錠ゲートに就寝前リチュアル「①4時間作業 → ②振り返り記載 → ③明日の予定を見て明日のタスクを登録 → ④ゲーム用パスワード発行」を強制させたい。②③は現状 `MANUAL_CHECK`（自己申告チェック）でしか表現できず、実際に振り返りを書いたか・明日のタスクを登録したかと無関係にチェックできてしまう（ゲーミング可能）。さらに③を実データから検出しようにも、カンバンは列（HOLD/TODO/DOING/DONE）ベースで「明日やる」を表す専用フィールドが無く、`due`（締切）が明日かで推測するしかなく意図が曖昧だった。

これを、**期日を列とモードから自動決定する仕組み＋「明日トグル（明日の計画モード）」でユーザーの意図を明示的にスタンプする**ことで解消する。ゲートは「`due=明日` の未完了カード数 ≥ 閾値」という実データだけを見て判定する。

## What Changes

### ゲート層（ルール評価・サーバー）

- **`PLANNING` ターゲットを `signal_key` 駆動にする**（現状 `signal_key` は保存・表示されるが `evaluateDay` が無視）:
  - `reflection_done`: 当日 `reflection_entry` が非空 = 「今日の振り返りをした」
  - `tomorrow_tasks_registered`: 翌日を対象（`due = 翌日` または `planned_for = 翌日`）とする未完了タスクが `planning_min_tomorrow_tasks` 以上 = 「明日のタスクを登録した」
  - `tomorrow_planned`（既定 / `signal_key` 未設定の後方互換）: 既存合成 `planningDone`（振り返り済み AND 翌日タスク≥N）
- `reflection_done` を単独シグナルとして公開（既存 `getPlanningSignal` の内部値を再利用）。`tomorrow_tasks_registered` は既存 `tomorrowTaskCount` を流用。**閾値は既存 config `planning_min_tomorrow_tasks` を流用**（新 config 追加なし）。
- 後方互換: `signal_key=null` は `tomorrow_planned` として従来評価。未知 `signal_key` は false＋警告ログ。`MANUAL_CHECK` は存置。

### 自動 due エンジン（クライアント・カンバン）

新規作成／列移動時に、**ロックされていない**タスクへ期日を自動付与する（決定表は design.md D3）。要点:

- **非HOLD 作成/HOLD→非HOLD 移動**: 明日トグル OFF なら「今日」、ON なら「明日」。
- **HOLD 作成/非HOLD→HOLD 移動**: 作業日から「+7日」。
- **非HOLD→非HOLD 移動・DONE 移動**: 期日据え置き（変更しない）。
- **手動で期日を指定**（具体日付・今日・明日・期限なし）した場合は **ロック**し、以後 auto は上書きしない。期限ピッカーに「自動に戻す」を追加し、選ぶとロック解除して現在の列＋トグルから再計算する。

### 明日トグル / 計画モード（クライアント）

- **明日トグル（明日の計画モード）を新設**（クライアント状態、その日限りでリセット）。ON の間、非HOLD の新規カード期日が「明日」になる。
- 移行トリガ2系統: (a) 振り返り画面の「振り返りを終えて明日の計画へ」ボタン（保存＝`reflection_done` 成立＋カンバンへ遷移＋トグル ON）、(b) カンバン上の手動トグル（振り返り済みの日に計画だけやり直す用）。
- 計画モード中は「明日のタスク n/閾値 登録」の進捗を表示する。

### スキーマ（タスクのロックフラグ）

- `task.due_locked INTEGER NOT NULL DEFAULT 0` を追加（手動指定の永続化）。既存 DB へはマイグレーションで既定0を追加。

### Non-Goals（このchangeでは扱わない）

- 今日タブの拡充（達成タスク一覧・振り返り表示・週間/月間推移）は別 change。
- `planned_for` フィールドの UI 復活はしない（意図スタンプは `due` と明日トグルで表現）。
- カンバンの列構成・振り返りモデルのスキーマ変更、ルール評価の latch/凍結/combinator の挙動変更はしない。

## Capabilities

### New Capabilities
<!-- openspec/specs/ は空（既存 change は sync せず archive 済み）ため New。 -->
- `kanban-rule-conditions`: 解錠ルールに振り返り記録・明日タスク登録を実データで自動評価する行動条件（`PLANNING` の `signal_key` 選択）を追加し、それを摩擦なく正しく満たすための「自動 due エンジン＋明日トグル（計画モード）」（列とモードから期日を自動決定、手動指定でロック／自動に戻す、振り返り完了ボタンでモード移行）を提供する。

### Modified Capabilities
<!-- openspec/specs/ に既存 spec が無いため無し。 -->

## Impact

- **サーバー（中）**:
  - `server/src/db/migrations.ts` / `db/index.ts` — `task.due_locked` 列の追加、型・`PATCHABLE` への反映。
  - `server/src/services/tasks.ts` — `due_locked` の read/write 対応。
  - `server/src/services/planning.ts` — `reflection_done` / `tomorrow_tasks_registered` を単独解決するレジストリ関数を追加。
  - `server/src/rules/evaluate.ts` — `case 'PLANNING'` を `signal_key` でディスパッチ。
- **フロント（主）**:
  - `server/static/js/kanban.js` — 自動 due エンジン（作成/移動フック）、明日トグル、期限ピッカーの「自動に戻す」＋ロック、「明日のタスク n/N」進捗。
  - `server/static/js/reflection.js` — 「振り返りを終えて明日の計画へ」ボタン。
  - `server/static/js/targets.js` / `rules.js` — `PLANNING` ラベル更新、`signal_key` ドロップダウン化、条件テキストの日本語ラベル。
  - `server/static/js/settings.js` — `planning_min_tomorrow_tasks`（閾値）を入力・編集可能に。
- **契約（小）**: `packages/contract` に条件/設定・タスク型があればシグナル語彙・`due_locked` を追記。
- **無変更**: `reflection_entry` スキーマ、カンバン列構成、集計、`MANUAL_CHECK` の既存挙動、config スキーマ（新カラム追加なし＝閾値は既存流用）。
- **リスク**: (1) 自動 due の誤付与 → ロック優先・「作成/移動時のみ」・DONE 非対象で限定。gate はモードでなくデータ(due=翌日)を見るので判定は独立に正しい。(2) 既存カードの due が変わる不安 → 自動付与は新規作成と列移動時のみで既存カードを一括変更しない。(3) 未知 `signal_key` → false＋ログ。
