## Why

目標作成画面の「採用する実践」という語彙が分かりにくく（"採用"は内部モデル由来で、ユーザーには意味が伝わらない）、さらに「採用する実践（既存の実効ルールから選ぶ）」と「その場で作る習慣（新規TIMELINE作成）」が別ブロックに分かれていて操作が二段構えになっている。加えてその場での新規作成はTIMELINE（カテゴリ＋分数）に限定されており、今日タブでは作れる他の条件（総作業時間・グループ作業・手動チェック・翌日計画）を目標作成からは作れない。目標を立てるその場で、今日タブと同じ表現力で「毎日やること」を自由に組み立てられるようにする。（issue #49）

## What Changes

- 目標作成画面の「採用する実践」ブロックと「その場で作る習慣」ブロックを、**「毎日やること」という1つのブロックに統合**する。語彙を「毎日やること」に統一し、内部語の「採用/実践」をユーザー向け文言から排除する。
- 見出し「毎日やること」の横に**＋ボタン**を置き、そこから毎日やることを追加する。既存の実効ルールから選ぶ（採用）ことも、その場で新規に作ることも、この1つの導線に集約する。
- **その場での新規作成を全5ターゲットに拡張**する（現状はTIMELINEのみ）。今日タブの条件エディタと同等に、総作業時間（TOTAL_WORK）・グループ作業（GROUP）・タイムライン記録（TIMELINE）・手動チェック（MANUAL_CHECK）・翌日計画（PLANNING）を目標作成のインライン作成から作れるようにする。作成した条件は開始日の実効ルールへ追記され、同時にその目標へ採用される（既存のインライン作成の一体トランザクション・失敗時ロールバックの原則を踏襲）。
- ＋から追加する際、入力中の条件が開始日の実効ルールに既存であれば、重複追記せず既存条件の採用へ寄せる（既存候補のサジェスト／重複回避）。

## Capabilities

### New Capabilities
<!-- なし（既存 capability の要件変更のため） -->

### Modified Capabilities
- `goal-inline-condition`: 目標作成時のインライン条件作成の対応ターゲットを、TIMELINE のみから**全5ターゲット（TOTAL_WORK / GROUP / TIMELINE / MANUAL_CHECK / PLANNING）**へ拡張する。各ターゲットの condition_key 導出・singleton（TOTAL_WORK / PLANNING）や既存キーの重複回避、開始日ルールへの追記と採用を一体で行う要件へ更新する。「TIMELINE以外は拒否」の要件は撤回する。

## Impact

- **コード（クライアント）**: `server/static/js/goals.js`（目標作成モーダルのUI・「毎日やること」ブロックと＋導線）、`server/static/js/rules.js`（条件エディタ行 `condEditorRow` の再利用可能化）、`server/static/js/targets.js`（種別語彙の共有）、`server/static/css/app.css`（統合ブロックの見た目）。
- **コード（サーバー）**: `server/src/services/goals.ts`（`NewInlineCondition` 型の全ターゲット対応、condition_key 導出・重複回避・追記ロジック、`createGoal` のバリデーション）、`server/src/api/goals.ts`（受け口）。
- **API**: `POST /api/goals` の `newConditions` ペイロードが TIMELINE 固定形から target 別の形（stableGroupId / signalKey / thresholdSeconds / label）に拡張される（後方互換：TIMELINE 形はそのまま受理）。
- **仕様**: `openspec/specs/goal-inline-condition/spec.md` を更新（delta）。
- **テスト**: `server/src/services/goals.test.ts`（全ターゲットのインライン作成・重複回避・失敗ロールバック）。
- **確認**: デモモードで新ターゲットをインライン作成した目標が作成・採用・集計経路を通ることを確認（CLAUDE.md の日数機能デモ明示ルール）。
