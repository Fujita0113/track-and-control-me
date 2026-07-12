## 1. サーバー: インライン条件作成＋採用（createGoal 拡張）

- [ ] 1.1 `services/goals.ts` の `CreateGoalInput` に `newConditions?: { target: 'TIMELINE'; label: string; thresholdSeconds: number }[]` を追加する
- [ ] 1.2 `createGoal` を拡張し、`newConditions` があるとき開始日（翌日）の実効ルール条件を materialize（フォールバック継承なら複製）し、既存条件を据え置きで＋新規条件を追記した配列で `upsertFutureRuleSet(翌日, ...)` を呼ぶ（同一トランザクション/失敗時 rollback）
- [ ] 1.3 追記で得た `condition_key`（`timeline:<ラベル>`）を採用リストへ足し、以降は既存の採用検証・`goal_practice` 挿入経路に合流させる
- [ ] 1.4 バリデーション: `target` は `TIMELINE` のみ許容（他は `GoalPracticeError`）、`label` 非空・`thresholdSeconds > 0` を検証する
- [ ] 1.5 既存条件の閾値を変えないため理由要求（`recordThresholdChanges`）が発火しないこと・既存採用条件のジャンル固定を破らないことを保証する（据え置き渡し）

## 2. サーバー: API

- [ ] 2.1 `api/goals.ts` の `POST /api/goals` 入力に `newConditions` を受け、`createGoal` へ渡す。`GoalPracticeError`/`GoalLockError`/`ThresholdReasonRequiredError`/`FrozenRuleError` を適切な HTTP コードへマップする
- [ ] 2.2 レスポンスの `practices` にインライン作成分の `condition_key` が含まれることを確認する

## 3. サーバー: テスト

- [ ] 3.1 goals: 新規「掃除15分」をインライン作成して採用でき、翌日ルールへ `timeline:掃除`（threshold 900）が追記される
- [ ] 3.2 goals: インライン作成が既存の翌日条件（`total_work` 等）を保持する（据え置き）
- [ ] 3.3 goals: 別目標が採用中の条件を壊さない（GoalLockError にならない）／既存条件の閾値据え置きで理由要求が出ない
- [ ] 3.4 goals: `TIMELINE` 以外・label 空・分数0 は拒否（`GoalPracticeError`）。失敗時は目標も条件も作られない（rollback）
- [ ] 3.5 goals: フォールバック継承の翌日でも materialize されて追記・採用が成功する

## 4. フロント: 目標作成フォームのインライン作成

- [ ] 4.1 `static/js/goals.js` の作成フォームに「＋ 習慣を追加（タイムライン記録）」導線を追加する
- [ ] 4.2 開くとカテゴリ入力（`GET /api/categories` を datalist 補完・自由入力可）＋分数入力を出し、追加行を「これから作成」として一覧表示する
- [ ] 4.3 作成時に追加行を `newConditions:[{target:'TIMELINE', label, thresholdSeconds}]` として `POST /api/goals` に積む（既存候補の採用と併用可能）
- [ ] 4.4 エラー（400/409）時のトースト表示（バリデーション・ジャンル固定・凍結）を出す

## 5. フロント: タイムライン強調表示

- [ ] 5.1 `static/js/timeline.js` で追跡中カテゴリ集合を導出する（`GET /api/goals` の active/upcoming 目標の `timeline:*` 採用キーから接尾辞ラベルを集める）
- [ ] 5.2 手動記録ブロック（`tlc-block leisure`）の `categoryKey` が追跡集合に一致するとき `tracked` 修飾クラスを付与し、対応 CSS を追加する
- [ ] 5.3 記録ポップオーバーのカテゴリチップも追跡一致で強調する
- [ ] 5.4 追跡目標が無い／不一致カテゴリでは強調されないこと、強調が評価・集計に非影響であることを確認する

## 6. 検証

- [ ] 6.1 `npm test` と typecheck をクリアする
- [ ] 6.2 実機スモーク: 目標作成画面から「掃除15分」を新規作成→採用→翌日ルールに `timeline:掃除` が追記され目標に乗る。当日「掃除」記録で met。タイムラインで「掃除」記録が強調表示される
- [ ] 6.3 既存フロー（`newConditions` 無しの採用のみ・強調対象なし）が完全 no-op で不変であることを確認する
