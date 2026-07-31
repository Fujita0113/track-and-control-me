## Context

単発（`schedule=single`、`start_day===end_day`）の写真/質問ルールは、`rule-registry.ts` の `carryoverPolicy` で `'carry'` 判定される。`isRuleActiveOn` はこの場合 `end_day` を上限にせず常に `true` を返すため（`goal-check-gate` 既存要件「単発ルールは達成するまでロックを繰り越す」）、提出済みの単発ルールは提出から何日・何ヶ月経っても `listActiveRules` に含まれ続け、`evaluateRule` は `met=true` を返し続ける。これは「達成状態が latch されゲートを relock しない」という設計として正しい。

問題は**表示**側にある。

- 今日タブ（`server/static/js/today.js` `renderGate`）は `GET /api/unlock/:date` の `perCondition` をそのまま行として描画する（`server/src/rules/evaluate.ts:117-144`）。`met` 行は `ruleAnswerRow` 内で早期リターンするだけで（`today.js:273`）、行自体は消えない。
- 一時凍結モーダル（`server/static/js/goal-freeze.js:99-114`）は `goal.rules`（`GoalRuleView[]`、`server/src/services/goals.ts:279-281`）をフィルタなしで箇条書きにする。

どちらも「その goal/日に紐づくルールを漏れなく見せる」という当初の実装のままで、達成済みの単発ルールを外すという発想が無かった（issue #73）。

`GoalRuleView`（振り返りタブのルール管理・目標カードのチップにも使われる、`server/static/js/rule-form.js:338-341`・`server/static/js/goals.js:129`）や `unlock_evaluation.per_condition_results`（完走レポート①カレンダー・⑤沿革が直接 SQL で読む、`server/src/services/goals.ts:840-887`）は、達成済みの単発ルールを消してはいけない別の消費者である。ここを壊さずに「今日やること」表示だけを絞り込む必要がある。

デモモード（`server/src/services/demo-seed.ts`）は `evaluateDay`/`toRuleView` を経由せず、`per_condition_results` を日ごとに直接焼き込む方式のため、既存の単発サンプル（`RULE_PHOTO_MORNING_ID`＝D14提出、`RULE_QUESTION_FOCUS_ID`＝D15提出）にも今回追加するフラグを手で焼き込まないと、デモではこの修正が再現されない。

## Goals / Non-Goals

**Goals:**
- 今日タブの「条件の進捗」欄と一時凍結モーダルのルール一覧から、**提出日を過ぎた**単発の写真/質問ルールを外す。
- `met`・`conditionsMet`・`status`（UNLOCKED/LOCKED）・`firstMetAt`（latch）には一切影響を与えない。除外は表示専用。
- 提出した**当日**は従来どおり達成済み行として表示する（既存 e2e `today-tab-answer-text-display.spec.ts`・`goal-rule-gate-loop.spec.ts` は当日の挙動のみを検証しており、これを壊さない）。
- ルール管理（`editable-rule-registry`）・目標カードのチップ・完走レポート①⑤は今回の表示フィルタの対象外とし、従来どおり全ルールを見せ続ける。
- デモモードで再現できるよう、既存の単発サンプル2件に新フラグを焼き込む。

**Non-Goals:**
- 範囲・永続・時間型・`MANUAL_CHECK`・`PLANNING` ルールの表示ロジックは変えない（`carryoverPolicy` が `'none'` のものは対象外）。
- ゲートの合流条件・latch・凍結の除外ロジック（`goal-check-gate` の既存要件・`goal-freeze` の凍結時ゲート除外）は変えない。
- `unlock_evaluation.per_condition_results` に保存する内容（過去日の確定スナップショット）は変えない。フィルタは API 応答を組み立てる際にのみ適用し、DB へ書き戻さない。
- 凍結モーダルで「表示するルールが0件になった目標」の具体的な文言は本設計で固定しない（実装時に既存の空表示と見分けられればよい）。

## Decisions

- **`carryStale` という表示専用フラグを追加する**（`met` とは別フィールド）。`rule-registry.ts` に純関数 `isCarryStale(target, schedule, answerDayKeys, dayKey)` を追加し、`carryoverPolicy(target, schedule) === 'carry' && isRuleMetOn(...) && !answerDayKeys.includes(dayKey)` を返す。
  - 代替案: `met` をその日提出したものだけ `true` にし、それ以前の提出は `false` にする案は却下。ゲートの latch（「一度 met になったら relock しない」）と矛盾し、`goal-check-gate` の既存要件（「そのルールは met=true となり、7/20 以降の評価でも met=true として扱われる」）を破る。
  - 代替案: フロント側（`today.js`/`goal-freeze.js`）で `schedule`/`answerDayKeys` から同じ判定を再実装する案も却下。判定ロジックが2箇所に分散し、`carryoverPolicy` の変更時に同期漏れが起きうる。サーバ側で1箇所（`rule-registry.ts`）に判定を集約し、クライアントは真偽値をそのまま使う。
- **除外は API 応答の組み立て時にのみ適用する**（`evaluate.ts` に `filterForDisplay(perCondition)` を追加し、`server/src/api/index.ts` の `GET /api/unlock/:date`・`PUT /api/checks/:date/:conditionKey`、`server/src/api/demo.ts` の `GET /api/demo/today` で `perCondition` を差し替えて返す）。`evaluateDay` 自体が返す `EvalResult`（`conditionsMet`/`status`/`firstMetAt`/`hasRuleSet`）は無フィルタの計算結果のまま保つ。
  - 完走レポート（`goals.ts` の `getGoalReport`）は `unlock_evaluation.per_condition_results` を直接 SQL で読んでおり、`evaluate.ts` の関数を経由しない。今回の変更はそこに触れないため、レポートの①カレンダーは影響を受けない（達成済み単発ルールは引き続き M日カレンダーに met として残る＝正しい挙動）。
- **`GoalRuleView` にも同じ `carryStale` を追加する**（`toRuleView` で、`PHOTO`/`QUESTION` かつ `carryoverPolicy==='carry'` のときだけ算出。他のルール種別は常に `false`）。凍結モーダル（`goal-freeze.js`）だけがこのフィールドで `rules` をフィルタし、ルール管理（`rule-form.js`）・目標カードのチップ（`goals.js`）はフィールドを無視して従来どおり全件表示する。
  - これにより `GoalRuleView` は「単一の情報源」のまま保たれ、消費者ごとに個別のエンドポイント/型を増やさずに済む。
- **`answerDayKeysFor` を `rule-registry.ts` に `ruleAnswerDayKeys` として引き上げ、`evaluate.ts`・`goals.ts` の双方から使う**（同じ SQL のコピーを避ける）。

## Risks / Trade-offs

- [Risk] `carryStale` の判定に必要な「当日提出したか」を得るため、`toRuleView`（凍結モーダル用）でルールごとに `rule_answer` を追加クエリする → [Mitigation] 対象は `PHOTO`/`QUESTION` かつ単発のときだけで、1目標あたりのルール数は少なく、凍結モーダルはユーザー操作時にのみ開く画面のため負荷は軽微。
- [Risk] 凍結モーダルで「紐づくルールが表示上0件」になった目標が、既存の「ルール: （登録ルールなし）」文言と混同され、ユーザーが「ルールが消えた」と誤解する → [Mitigation] 文言を区別する（spec: `goal-freeze` ADDED 文言要件）。
- [Risk] デモの焼き込みデータ（`per_condition_results`）に `carryStale` を手で埋め込み漏れると、デモでは修正前の見た目のまま（再現できない） → [Mitigation] `demo-seed.ts` の該当2行（`RULE_PHOTO_MORNING_ID`・`RULE_QUESTION_FOCUS_ID`）を提出日翌日以降 `carryStale: true` に更新し、apply 完了後に `POST /api/demo/reset` → `GET /api/demo/goals/:id/report?...` ではなく `GET /api/demo/today?now=<D14/D15より後の day_key>` で目視確認する（CLAUDE.md のデモモード確認ルール）。
