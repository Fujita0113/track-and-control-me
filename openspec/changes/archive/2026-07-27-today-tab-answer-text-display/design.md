## Context

質問ルールの回答は既に `rule_answer.answer_text` に保存されており、振り返りタブの目標沿革（`goal-chronicle`）では表示されている。しかし今日タブのゲート行は、`met=true` になった時点で早期リターンし、状態ラベル（「回答済み」）しか出さない。データは既にあるので、欠けているのは (1) ゲート評価結果に当日の回答テキストを載せる経路、(2) それをレンダリングするフロント側の分岐、の2点のみ。新規テーブル・マイグレーションは不要。

調査済みの該当箇所:
- `server/src/rules/evaluate.ts:28-54` の `ConditionResult` に `answerText` フィールドが無い。
- `server/src/rules/evaluate.ts:89-93`（`answerDayKeysFor`）は `SELECT day_key` のみで `answer_text` を取っていない。
- `server/src/rules/evaluate.ts:180-190`（`evaluateRule` の `PHOTO`/`QUESTION` 分岐）は `met`/`rangeDayNumber`/`spanDays`/`label` のみ返す。
- `server/static/js/today.js:265`（`ruleAnswerRow`）は `if (met) return row;` で met 行の中身を組み立てずに返している。

## Goals / Non-Goals

**Goals:**
- 質問ルールが達成された今日タブの行に、当日の回答テキストを表示する。
- 表示対象は「当日 (`dayKey`) の回答」に限定する（範囲ルールで前日以前の回答を誤って出さない）。

**Non-Goals:**
- 写真ルール（`target=PHOTO`）の達成後表示（サムネイル表示等）は今回のスコープ外。「提出済み」表示のまま据え置く。
- 回答の編集・再送信 UI は対象外（既存どおり、取り下げは振り返りタブへ一本化のまま）。
- `rule_answer` のスキーマ変更・新規マイグレーションは不要（既存カラムで足りる）。

## Decisions

- **`ConditionResult` に `answerText?: string` を追加**し、`QUESTION` かつ `met=true` の場合に当日 `dayKey` の `rule_answer.answer_text` を1件取得して詰める。`answerDayKeysFor` とは別に、`(rule.id, dayKey)` 単位で `answer_text` を取る小さなクエリを `evaluate.ts` 内に追加する（既存の集合取得クエリを汎用化して text も返す形に寄せるか、別クエリを足すかは実装時に既存関数の呼び出し箇所を見て決める）。
  - 代替案: `answerDayKeysFor` の返り値を `Map<dayKey, answerText>` に変えて呼び出し元すべてを書き換える案は影響範囲が広く、今回は当日分だけ必要なため見送り、当日 `dayKey` 用の単発クエリを追加する方針とする。
- **表示は今日タブの `ruleAnswerRow` のみ変更**し、`met` 早期リターンをやめて、`QUESTION` かつ `answerText` があればタイトル下の2行目（`.cond-sub` 相当）にその文面を、無ければ既存の「回答済み」を出すフォールバックにする（写真ルールの `met` 行は現状のまま「提出済み」を出す）。
- **範囲ルールでの当日限定**は `goal-check-gate` の既存要件（範囲ルールはその日限りのゲート）と整合させ、`answerText` は常に「評価対象日 `dayKey`」の回答のみを見る。前日以前の回答は出さない。

## Risks / Trade-offs

- [Risk] 当日分の回答取得クエリを `evaluateRule` のホットパスに増やすと、日次評価のクエリ数が増える → [Mitigation] `QUESTION` かつ `met=true` の場合のみ実行し、対象ルール数は少ないため影響は軽微。
- [Risk] フロント側で長い回答テキストが行のレイアウトを崩す可能性 → [Mitigation] 既存の `.cond-sub` の折り返し・省略スタイルを踏襲し、新規スタイルは追加しない。
