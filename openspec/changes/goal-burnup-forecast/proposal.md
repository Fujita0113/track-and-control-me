## Why

長期目標の Check が続かない原因は「演出が足りない」ではなく、**毎日動く数字が無い**こと。いまのレポート画面（ヘッダ＋①達成カレンダー ②時間の推移 ③写真の比較 ④日記ストリップ ⑤沿革）は完走後の振り返り用に作ったもので、走っている最中に一番知りたい「**この調子だといつ終わるのか**」がどこにも無い。そして完走後に開いても、開く動機が生まれていない。

期限（`end_day`）は遠すぎて今日の行動を動かさない。動かせるのは「今日積んだぶんで完了予想日が何日手前へ来たか」で、これは**累積作業時間**と**残り想定時間**の2本の線が交わる日として出せる。累積作業時間は単調増加なので、1つもタスクが終わらなかった日でも線は必ず伸びる — 記録しつづける動機がここで初めて成立する。

さらに、完了予想日を手前へ動かす手が2系統になる:

- **積む**（傾きを立てる）＝ 今日頑張る
- **削る／速くなる**（スコープ線を下げる）＝ やらない判断をする・慣れて単価が下がる

「これやらなくていいじゃん」という判断が、だるい再見積もりではなく**線が下がって交点が左へ飛ぶ**という即時の報酬になる。

## What Changes

- **BREAKING**: capability `goal-report` を**丸ごと廃止**する。進行中・完走後のいずれからもレポート画面へ到達できなくなり、`GET /api/goals/:id/report` も無くなる。①③④⑤に相当する画面は用意しない。
- **BREAKING**: capability `goal-report-day-detail`（①のマスから開く日別詳細モーダル）を廃止する。入口が①だけであり、①ごと無くなるため到達手段が存在しない。
- **BREAKING**: capability `goal-chronicle`（⑤沿革）を廃止する。表示場所がレポート⑤だけであるため。**ルール操作の理由つき年表・凍結イベント・答え合わせは画面から読めなくなる**（レコードは削除せず DB に残す）。
- 目標の唯一のビューを **見通し（バーンアップ）** にする。目標カードの導線の文言は「レポートプレビュー」→「**見通し**」。**カードの導線の数は増やさない**（現状4つのまま）。
- 見通しは縦軸＝累積作業時間、横軸＝日付の1枚のグラフとし、次を描く:
  - **累積線**（実測・単調増加）
  - **スコープ線**（残り想定時間の合計。段差で動く）
  - **予測直線2本**（全体平均ペース／直近3日ペース）を切り替え、スコープ線との交点＝完了予想日
- 見通しは**完走後・終了後も開ける**。ただし完了予想日と予測直線は出さない（もう予想する先が無いため）。累積線・スコープ線・段差の注記は「こう走った」の記録として残す。
- **「続ける／終える」フォークを目標カードへ移す**。従来はレポート先頭にあったが、これは表示ではなく**永続ルールをゲートから外す唯一の手段**であり、落とすと未回答の目標のルールが永久にゲートへ残る。完走したカードは「レポートを開く」に代えて「続ける」を出し、既存の「終える」と並べる（導線の数は変わらない）。
- **凍結日を特別扱いしない**。凍結中の日も 0h の実績として暦どおり数える。谷が深いほど復帰後の直近3日ペースが跳ね、縮み幅が大きく見える（意図した効果）。
- 親タスク（根直下）に**想定時間**を、葉に**小数の進捗**を持たせる。どちらも変更の**理由と実行者が記録**として残り、グラフの段差から読める。
- **スコープ線が動く要因を3つ**規定する:
  1. **合議** — Gemini が想定時間を書き換える（POST）
  2. **増減** — タスクを消す・足す
  3. **単価の改善** — 走行中の枝で「葉1つあたりの実測時間」が下がると、その枝の残りが**自動で**下がる
- Gemini / Antigravity から叩ける**想定時間の登録・更新 API** を追加する。アプリは受け取った数字を検算せず、そのまま使う。
- 証拠写真の読み手を**大きい沿革（`goal-history`）に一本化**する。行から開く先はレポートではなく見通しになる。

## Capabilities

### New Capabilities

- `goal-burnup`: 目標の唯一のビュー「見通し」とバーンアップの算定。累積作業時間の解決（計測対象・凍結日の扱い）、全体平均／直近3日の2ペース、スコープ線との交点＝完了予想日、スコープが動いた記録の提示、完走後の扱い、対象や見積もりが無いときの空状態。
- `task-estimate`: 根直下ノードの想定時間・葉の小数進捗・その変更記録（理由と実行者）。走行中の枝で実測から単価を導き仮置きを上書きする規則、および外部エージェントから叩ける登録・更新 API。

### Modified Capabilities

- `goal-report`: **全要件を REMOVED**（capability 廃止）。
- `goal-report-day-detail`: **全要件を REMOVED**（capability 廃止）。
- `goal-chronicle`: **全要件を REMOVED**（capability 廃止）。
- `goal-lifecycle-fork`: 「完走で『続ける／終える』を問う」の**提示場所をレポート先頭から目標カードへ**移す。永続ルールがゲートに残る規則は変えない。
- `goal-history`: 行から開く先を**レポートから見通しへ**変える。証拠写真の解決規則を（`goal-report ③` を参照するのをやめて）**この capability 自身の定義**にする。
- `goal-challenge`: 証拠写真キャプションのグループ化キーの参照先を `goal-report ③` から大きい沿革へ付け替える。
- `goal-check-gate`: 写真ルールの提出画像の流入先の参照を `goal-report ③` から大きい沿革へ付け替える。

## Impact

**画面**

- `server/static/js/goals.js` — `renderReport()` と①〜⑤のブロック関数（`blockCalendar` / `blockTimeSeries` / `blockPhotoCompare` / `blockJournalStrip` / `blockChronicle` / `openDayDetailModal` 等）を削除。`goalCard()` の導線を差し替え、完走カードに「続ける」を出す。`goalHistorySection()` の行の遷移先を見通しへ
- 見通しのビューを新設（同ファイル内）
- `server/static/css/app.css` — 不要になった `.gr-cal` / `.gr-strip` / `.gr-chr` 等を削除し、見通し用を**1ルール1行**で追記
- `server/static/js/blueprint.js` — 想定時間と小数の進捗の表示

**サーバ**

- `server/src/api/goals.ts` — `GET /api/goals/:id/report` を削除し、`GET /api/goals/:id/burnup` を追加
- `server/src/services/goals.ts` — `getGoalReport()` とレポート専用の組み立てを削除。`accumulatedSecondsFor()` は再利用。`goalPace()` は**変更しない**（凍結日の扱いが意図的に食い違う。理由は design.md）
- `server/src/services/goal-chronicle.ts` — 削除
- `server/src/services/` に burnup 算定と task-estimate のサービスを追加（`*.test.ts` は実装と同居）
- `server/src/api/planning.ts` — 想定時間・進捗の登録ルート
- `server/src/api/demo.ts` — デモのレポート経路を見通しへ差し替え
- `server/src/db/migrations.ts` — `task` への列追加と変更記録テーブル。**既存 migration の SQL を書き換えず、新しいバージョンを足す**

**契約**

- `packages/contract/src/index.ts` — 想定時間 POST の zod スキーマ（外部エージェントが叩く口なので、ここで型を固定する）

**テスト**

- 削除: `e2e/goal-report-day-detail.spec.ts` / `e2e/goal-report-journal-strip.spec.ts`（レポート画面しか検証していない）
- 縮小: `e2e/goal-rule-gate-loop.spec.ts`（レポート経由の⑤沿革・①検証を落とす）、`e2e/goal-target-hours.spec.ts`（行→レポート遷移を落とす）
- `server/src/services/goals.test.ts` ほか、`getGoalReport` を呼ぶユニットからレポート依存を外す

**デモ**

- `server/src/services/demo-seed.ts` — 日数が関わる機能なので、固定 day_key のサンプルで交点と段差を再現する。`demo.test.ts` の期待値も併せて更新する

**残すもの（データは消さない）**

- `unlock_evaluation` / `goal_journal` / `goal_journal_image` / `rule_change` / `rule_answer` / `goal_freeze_change` — 読み手が消えるだけで、後から別の画面へ出せる
- `goal-target-hours` のペース表示・解錠ゲート（バーンアップは解錠に一切合流しない）
- `goal-freeze` の凍結そのもの（バーンアップ側が凍結を無視するだけ）
