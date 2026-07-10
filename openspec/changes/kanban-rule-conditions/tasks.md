## 1. スキーマ（タスクのロックフラグ）

- [x] 1.1 `server/src/db/migrations.ts` に `task.due_locked INTEGER NOT NULL DEFAULT 0` を追加する（既存 DB へ `ALTER TABLE ADD COLUMN`、既存行は既定0）
- [x] 1.2 `server/src/db/index.ts` / `server/src/services/tasks.ts` の `TaskRow` 型・`PATCHABLE`・`createTask` に `due_locked` を反映する

## 2. サーバー: シグナル解決とゲート評価

- [x] 2.1 `server/src/services/planning.ts` に単独シグナル解決を追加する（`reflection_done`=既存 `reflectionDone` 相当、`tomorrow_tasks_registered`=`tomorrowTaskCount >= planning_min_tomorrow_tasks`、`tomorrow_planned`=既存 `planningDone`）。未知キーは false＋`console.warn`
- [x] 2.2 `null` の signal_key を `tomorrow_planned` にマップする後方互換を実装する
- [x] 2.3 `server/src/rules/evaluate.ts` の `case 'PLANNING'` を `condition.signal_key` によるシグナル解決へ変更する
- [x] 2.4 既存 `PLANNING`（signal_key=null）の評価結果が現行 `planningDone` と一致することを確認する（回帰なし）

## 3. サーバー: テスト

- [x] 3.1 各シグナル（`reflection_done` / `tomorrow_tasks_registered` / `tomorrow_planned`）の評価ユニットテスト（充足/不充足・閾値変更・DONE除外）
- [x] 3.2 後方互換テスト（signal_key=null が従来 `planningDone` と一致、未知キーは false＋非解錠）

## 4. フロント: 自動 due エンジン

- [x] 4.1 `server/static/js/kanban.js` に明日トグル状態を追加する（localStorage を日付キーで保持、翌日 OFF リセット、UI トグル）
- [x] 4.2 期日決定の純関数を実装する（入力: 遷移後の列・明日トグル・作業日 → 出力: due。非HOLD=today/明日、HOLD=+7、非HOLD→非HOLD/DONE=変更なし。design D3 の表どおり）
- [x] 4.3 `commitComposer`（作成）を、`due:null` 固定から 4.2 で算出した `due` ＋ `due_locked:0` の送信に変更する
- [x] 4.4 `onDrop`（列移動、DONE以外）で、非ロックなら 4.2 で `due` を再計算して `updateTask` する。ロック時・DONE 完了時は `due` を触らない
- [x] 4.5 計画モード中に「明日のタスク n/`planning_min_tomorrow_tasks` 登録」の進捗を表示する

## 5. フロント: 手動ロックと「自動に戻す」

- [x] 5.1 `pickDue`（今日/明日/期限なし/任意日付）で `due_locked:1` を送るようにする
- [x] 5.2 期限ピッカーのクイック行に「自動に戻す」を追加し、選択で `due_locked:0` ＋現在の列・トグルから 4.2 で `due` を再計算する
- [x] 5.3 カードの期日表示がロック/自動を判別できるよう必要なら軽い視覚差を付ける（任意）

## 6. フロント: 振り返り移行ボタンとルール UI

- [x] 6.1 `server/static/js/reflection.js` に「振り返りを終えて明日の計画へ」ボタンを追加する（保存＋明日トグル ON＋カンバンへ遷移）。空本文時は無効化/保存促し
- [x] 6.2 `server/static/js/targets.js` の `PLANNING` ラベルを更新し、既知シグナルの語彙（キー↔日本語ラベル）を定義・共有する
- [x] 6.3 `server/static/js/rules.js` の `signalKey` 自由入力を既知シグナルの `<select>` に置き換える（凍結済みの未知値は選択肢に温存）。`condText`・ゲート画面の条件行を日本語ラベル表示にする
- [x] 6.4 `server/static/js/settings.js` に `planning_min_tomorrow_tasks`（閾値）の入力・編集項目を追加する（既存項目のラベルを明確化）

## 7. 契約（あれば）

- [x] 7.1 `packages/contract` に条件/設定・タスク型がある場合、既知シグナル語彙と `due_locked` を追記し既存テストで後方互換を担保（無ければスキップ）→ contract は WS/ingest プロトコルのみで条件/タスク型を持たないためスキップ

## 8. 検証

- [x] 8.1 `npm run typecheck` と `npm test` が全ワークスペースで通る（76 tests passed / 全 workspace typecheck OK / 変更 JS は node --check 通過）
- [x] 8.2 手動確認（自動 due）: 通常作成=今日 / 明日トグルON作成=明日 / HOLD作成=+7 / HOLD→TODO=今日か明日 / 非HOLD間移動=据え置き / DONE=据え置き
- [x] 8.3 手動確認（ロック）: 手動指定→列移動で不変 / 「自動に戻す」で再計算
- [ ] 8.4 手動確認（フロー）: 4h作業→振り返り記載→「明日の計画へ」→明日タスクを閾値以上登録→ゲート UNLOCK。振り返り未記録や明日タスク不足では LOCKED
- [ ] 8.5 手動確認（後方互換）: 既存 `PLANNING`（signal_key未設定）ルールが従来どおり評価される
