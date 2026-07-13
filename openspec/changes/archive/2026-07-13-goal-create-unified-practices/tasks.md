## 1. サーバー: インライン条件を全ターゲット対応にする

- [x] 1.1 `server/src/services/goals.ts` の `NewInlineCondition` 型を、`condEditorRow._get()` と同形の target 別 union（`TOTAL_WORK`/`GROUP`/`TIMELINE`/`MANUAL_CHECK`/`PLANNING` ＋ `thresholdSeconds?`/`stableGroupId?`/`label?`/`signalKey?`）へ拡張する
- [x] 1.2 `createGoal` のインライン条件バリデーション（現 TIMELINE 限定）を target 別に置換: 時間型は `thresholdSeconds > 0`、`GROUP` は `stableGroupId` 必須、`TIMELINE`/`MANUAL_CHECK` は `label` 非空、`PLANNING` は `signalKey`、未対応 target は 400
- [x] 1.3 追記ロジックを一般化: `newConditions` を `ConditionInput` へ写し、`deriveConditionKey`（`server/src/rules/rules.ts`）で各キーを算出。開始日の実効ルールに既存のキー（singleton 含む）は追記から除外し既存採用へ寄せる。残りを `upsertFutureRuleSet` で追記
- [x] 1.4 `inlineKeys` を `newConditions.map(deriveConditionKey)` に変更し、採用キー合流（`keys` の Set uniq）と候補照合が全ターゲットで通ることを確認
- [x] 1.5 `server/src/api/goals.ts` の `newConditions` 受け口を新しい型で受理（TIMELINE 形の後方互換を維持）

## 2. サーバー: テスト

- [x] 2.1 `server/src/services/goals.test.ts` に各ターゲット（TOTAL_WORK/GROUP/TIMELINE/MANUAL_CHECK/PLANNING）のインライン作成→追記→採用の成功ケースを追加
- [x] 2.2 既存キーと重複する新規作成が重複追記されず既存採用へ寄る（singleton の TOTAL_WORK/PLANNING 含む）ケースを追加
- [x] 2.3 バリデーション失敗（label 空・分数0・GROUP の stableGroupId 不正・未対応 target）で 400 になり、目標もルールも作られない（ロールバック）ケースを追加
- [x] 2.4 `npm test` 相当でサーバーテストが緑になることを確認

## 3. クライアント: 条件エディタ行の再利用

- [x] 3.1 `server/static/js/rules.js` の `condEditorRow` を `export` する（純粋な行ビルダーのみ公開・ルールエディタ本体は非公開のまま）
- [x] 3.2 `condEditorRow` が locked=false・goals.js からの利用で自己完結する（datalist id 生成・カテゴリ補完・group 選択）ことを確認

## 4. クライアント: 「毎日やること」ブロックへ統合

- [x] 4.1 `server/static/js/goals.js` の目標作成モーダルで、「採用する実践」と「その場で作る習慣」の2ブロックを「毎日やること」1ブロックへ統合。見出し横に＋ボタン（`api.getGroups()` を事前ロード）を配置
- [x] 4.2 既存候補は従来どおりチェックボックス行で表示（採用）。空状態・補足文から「採用/実践」語を外し「毎日やること」に整える
- [x] 4.3 ＋ボタンで `condEditorRow(c, groups, false)` の新規行を追加ホストへ挿入（「これから作成」相当の見せ方）。削除も可能にする
- [x] 4.4 保存時に `practices`＝チェック済み既存候補の condition_key、`newConditions`＝追加行 `_get()` の配列を送る。両方空ならエラートースト。既存の初日写真ステージング・作成後処理は維持
- [x] 4.5 旧「その場で作る習慣」専用フォーム（catInp/minInp/addBtn・newRows）関連の不要コードを撤去

## 5. スタイル

- [x] 5.1 `server/static/css/app.css` に統合ブロック（見出し＋＋ボタン・追加行）の見た目を整える。既存の `gr-newcond*` クラスで不要になったものを整理

## 6. 動作確認

- [x] 6.1 開発サーバーを起動し、目標作成で各ターゲット（少なくとも TOTAL_WORK・MANUAL_CHECK・TIMELINE）を＋から新規作成して目標が作成・採用されることを手動確認
- [x] 6.2 CLAUDE.md ルールに従い、デモモード（`POST /api/demo/reset`）でインライン作成した新ターゲットの目標が作成・採用・レポート集計経路を通ることを確認し、ユーザーに明示する
- [x] 6.3 `openspec validate goal-create-unified-practices` が緑であることを確認
