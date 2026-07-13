## Context

目標作成モーダル（`server/static/js/goals.js` の `openCreate` 相当・L200–357）は現在2ブロック構成:

1. **採用する実践**（L234–269）: 開始日の実効ルール候補（`api.getGoalCandidates(start)`）をチェックボックスで採用。value は `condition_key`。
2. **その場で作る習慣**（L271–322）: カテゴリ＋分数の新規 TIMELINE 条件のみを作れる簡易フォーム。`newRows` に貯め、作成時 `newConditions=[{target:'TIMELINE',label,thresholdSeconds}]` として送る。

サーバー側 `createGoal`（`server/src/services/goals.ts` L287–）は `newConditions` を TIMELINE 限定でバリデーションし（L294–300）、`inlineKeys = timeline:<label>`（L303）で採用へ合流。追記は `getEffectiveRuleSet` → `upsertFutureRuleSet`（L315–334）で行う。`upsertFutureRuleSet`／`deriveConditionKey`（`server/src/rules/rules.ts` L148）は既に全5ターゲットの condition_key 導出・追記に対応している。

今日タブの条件エディタ `condEditorRow`（`server/static/js/rules.js` L383）は全5ターゲット（`CONDITION_KINDS`・PLANNING フラット化含む）を1つの `<select>` で扱い、`_get()` で `{target, thresholdSeconds?, stableGroupId?, label?, signalKey?}` を返す。ただし現在 module-private でエクスポートされていない。

## Goals / Non-Goals

**Goals:**
- 「採用する実践」＋「その場で作る習慣」を「毎日やること」1ブロックへ統合し、見出し横の＋から追加できる。
- ＋からの新規作成を全5ターゲットへ拡張（今日タブと同等）。作成→追記→採用を一体トランザクションで保つ。
- 語彙を「毎日やること」に統一し、内部語（採用/実践）をユーザー向け文言から排除。
- 既存キーと重複する新規作成は重複追記せず既存採用へ寄せる。

**Non-Goals:**
- 目標作成後の実践の編集・追加・削除（作成時のみが対象。運用中はジャンル固定）。
- 閾値変更の理由フロー（既存挙動のまま）。
- 今日タブ／ルールエディタ側のUI変更。
- レポート・集計ロジックの変更。

## Decisions

### D1: 今日タブの条件エディタ `condEditorRow` を再利用する（新規実装しない）
`server/static/js/rules.js` の `condEditorRow` を `export` し、goals.js から import して「毎日やること」の新規行に使う。`_get()` の戻り値（target 別の ConditionInput 形）をそのまま `newConditions` の要素として送る。

- **なぜ**: 全5ターゲット＋PLANNING フラット化＋カテゴリ補完＋グループ選択のロジックを二重実装しない。今日タブと見た目・挙動を揃える（issue の「今日タブと同様に」に忠実）。
- **代替**: goals.js に専用の簡易エディタを新設 → 5ターゲット分岐・PLANNING の signal_key 展開を再実装することになり乖離リスク大。却下。
- **注意**: `condEditorRow` は `groups`（`api.getGroups()`）と `locked` 引数を取る。goals.js からは `locked=false` で呼ぶ。datalist の id 生成やカテゴリ補完は行内で自己完結しているため、そのまま流用できる。

### D2: 「毎日やること」ブロックのモデル＝「既存候補チェック」＋「＋で追加した新規行」
- 開始日の実効ルール候補（`getGoalCandidates`）は従来どおりチェックボックス行で表示（採用）。
- 見出し「毎日やること」の横の＋ボタンで `condEditorRow` の1行を追加ホストへ挿入。追加行は「これから作成」バッジ付きで、種別選択と入力欄を持つ。
- 保存時: `practices` = チェック済み既存候補の `condition_key` 配列、`newConditions` = 追加行 `_get()` の配列。両方空なら従来どおりエラー。
- **重複の扱い**: クライアントは軽い重複ガードのみ（同じ種別・同じキー相当の新規行が既存候補と重なる場合の見た目調整は最小限）。正の重複回避はサーバーの `deriveConditionKey` 突合に委ねる（D3）。UIの単純さを優先。
- **代替（却下）**: 既存候補も編集可能な行として展開する案（Q1の第2案）。既存条件の閾値をこの画面で変えられると閾値変更理由フローとジャンル固定に絡み複雑化するため、既存はチェック採用のまま据え置く。

### D3: サーバーの `newConditions` を全ターゲット対応にし、`deriveConditionKey` で採用キーを導出
`NewInlineCondition` を TIMELINE 固定から、`condEditorRow._get()` と同形の discriminated union（`target` ＋ target 別フィールド）へ拡張する。`createGoal` の処理を次のとおり変更:

1. **バリデーション**（現 L294–300 を置換）: target ごとに検証。時間型（`TOTAL_WORK`/`GROUP`/`TIMELINE`）は `thresholdSeconds > 0`、`GROUP` は `stableGroupId` 必須（存在するグループ）、`TIMELINE`/`MANUAL_CHECK` は `label` 非空、`PLANNING` は `signalKey`。全5ターゲット以外は 400。
2. **追記**（現 L315–334）: `newConditions` を `ConditionInput` へ写し、`deriveConditionKey` で各キーを算出。開始日実効ルールに既存のキー（`total_work`/`planning:*` の singleton や同名 `group:`/`timeline:`/`manual:`）は追記対象から除外し、既存採用へ寄せる。残りを `upsertFutureRuleSet` で追記（既存の materialize・DRAFT_TODAY 経路をそのまま利用）。
3. **採用合流**（現 L303）: `inlineKeys = newConditions.map(deriveConditionKey)` に変更。以降の候補照合・スナップショットは現状のまま（`adoptCandidates` が追記後の実効ルールから解決）。

- **なぜ**: `deriveConditionKey`・`upsertFutureRuleSet` が既に全ターゲット対応済みのため、`createGoal` 側は「TIMELINE 限定」の枷を外すだけで済む。追記・ジャンル固定・失敗ロールバックの既存不変条件を維持。
- **API 後方互換**: 既存の TIMELINE 形（`{target:'TIMELINE',label,thresholdSeconds}`）はそのまま受理される。

### D4: 語彙の統一
- 見出し: 「毎日やること」。＋ボタンのラベル/aria: 「毎日やることを追加」。
- 既存候補の補足文・空状態メッセージから「採用/実践」を外し、「毎日やること」に整える（例: 空状態「今日の実効ルールに追加できる項目がありません。＋から新しく作れます」）。
- レポート等ほかの画面の語彙は本changeの対象外（Non-Goal）。混在は許容（作成画面のみ整える）。

## Risks / Trade-offs

- **[condEditorRow のエクスポートで結合が増える]** → goals.js が rules.js に依存する。既に targets.js を共有しており方向性は一致。純粋な行ビルダーのみ export し、ルールエディタ本体は非公開のまま保つ。
- **[GROUP 新規作成には既存グループが必要]** → グループが無い環境では GROUP 種別は選べても保存不可。`condEditorRow` の groupSel が空になるだけで、サーバーが `stableGroupId` 不正を 400 で弾く。UI では最低限のトーストで足りる（今日タブと同挙動）。
- **[PLANNING/TOTAL_WORK の singleton を＋から重複追加しようとする]** → D3 の既存キー突合で重複追記を回避し、既存採用へ寄せる。二重採用にはならない（`keys` を Set で uniq 済み・L304）。
- **[クライアント重複ガードが緩い]** → 見た目上は新規行と既存チェックが重なりうるが、保存結果は正しい（サーバーが正の重複回避）。UX 上の軽微な冗長のみでデータ不整合はなし。

## Migration Plan

- スキーマ変更なし。API は後方互換（TIMELINE 形はそのまま受理）。
- デプロイは静的JS＋サーバーTSの同時反映で完結。ロールバックは revert のみ（永続データ形は不変）。
- CLAUDE.md の日数機能デモ明示ルールに従い、実装後にデモモードで新ターゲット（例: MANUAL_CHECK / TOTAL_WORK）をインライン作成した目標が作成・採用・レポート集計経路を通ることを確認する。

## Open Questions

- なし（UI構造・対象ターゲット・語彙は事前確認で確定済み）。
