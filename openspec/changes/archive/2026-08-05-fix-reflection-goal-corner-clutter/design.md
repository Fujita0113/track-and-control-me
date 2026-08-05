## Context

振り返りタブの目標コーナー（`journalCorner`, `server/static/js/reflection.js:410`）は、アクティブな長期目標ごとに「一時凍結ブロック」→「ルール一覧＋最近の変更」（`buildGoalRulesBlock`, `server/static/js/rule-form.js:373`）→「日記エディタ」→「画像ゾーン」を縦に並べる。すべて常時展開・同じ視覚の重みで並ぶため、目標が増えるほど日々触る日記入力（本体）が下に押し下げられる（issue #86）。

調査の過程で2つの実装ギャップも判明した:

1. `deleteGoal`（`server/src/services/goals.ts:681`）は `dayKeyOf(row.created_at) === today` のみで許可判定しており、目標が「終える」（`ended_day_key` セット、`server/src/services/goals.ts:852`）済みかどうかを見ていない。フロントの削除ボタンは `status !== 'ended'` の時だけ描画される（`server/static/js/goals.js:264`）が、これは UI 側だけのガードで、サーバ側は塞がれていない。`goal-lifecycle-fork` は「終えた事実・理由は大きい沿革に残り、消してはならない（MUST NOT）」と規定しており、作成当日中に「終える」→削除で記録ごと消せる抜け穴になる。
2. 一時凍結の未予約状態の表示（`unreservedView`, `server/static/js/goal-freeze.js:258`）は「アプリ全体で月1回」というグローバルなリソースの状態を示すが、`journalCorner` のループ内で目標ごとに `buildFreezeBlock` が呼ばれる（`reflection.js:436`）ため、アクティブな目標の数だけ同じ文言とボタンが複製される。

## Goals / Non-Goals

**Goals:**
- ルール一覧・最近の変更を既定で折りたたみ、開いたときの視覚階層を整理する
- `deleteGoal` に status ガードを追加し、終了済み目標の当日削除を防ぐ
- 一時凍結の未予約時エントリーポイントを振り返りサイドバーに1箇所へ集約する

**Non-Goals:**
- 一時凍結機能自体の再設計（「終える」への統合、「再開する」ボタンの追加）は将来課題として扱わない（別 issue）
- `app.css` 全体の書式統一・フォーマッタ適用は行わない（既存の1ルール1行書式を保ち、触った箇所だけ差分を出す）
- ルールの中身（種類・スケジュール等）の仕様変更は行わない

## Decisions

### D1. 折りたたみは `buildGoalRulesBlock` 自身が持つ（呼び出し側で分岐させない）

`buildGoalRulesBlock(goal, todayKey, onReload, { frozen = false, startOpen = false } = {})` に opts を追加し、関数内で返す要素を `host`（現行の `pc-block` div、中身は変更なし）から `<details class="pc-rules-collapse"><summary class="pc-rules-summary">...</summary>{host}</details>` に変える。

- `summary` のテキストは `reload()` の中で毎回更新する（`goal.rules.length` が変わっても件数表示が古くならないようにするため）: 通常時は `ルール（${N}件）`、`frozen: true` のときは既存の凍結中コピーのまま `ルール（凍結中は編集できません）`（件数は付けない・既存の文言を変えない）。
- 既定は**閉じた状態**（`startOpen: false` のとき `open` 属性なし）。過去にルール変更をしたばかりでも次回描画時は毎回閉じる（「今日のうちに確認済みかどうか」を状態として持たない・シンプルさ優先）。
- `最近の変更` は独立した2段目の `<details>` にはせず、`ルール` の `<details>` の中の1セクションとして残す（ユーザー合意「全部折りたたみでOK」＝外側1回開けば両方見える形で十分、二重折りたたみは操作が増えるだけ）。
- 「＋ 追加」ボタンはヘッダー（`summary`）ではなく `<details>` を開いた中に残す（開いてから操作する設計に揃える。`summary` に置くと折りたたみの意味が薄れる）。
- `reflection.js` の呼び出し側は次の2箇所を置き換える:
  - `journalCorner`（非凍結時）: 旧 `corner.appendChild(buildGoalRulesBlock(goal, date, null))` → `corner.appendChild(buildGoalRulesBlock(goal, date, null, { frozen: isFrozenNow(goal) }))`。凍結時に外側で `<details class="gf-rules-collapse">` を二重に被せていた分岐（`reflection.js:438-445`）は削除し、`buildGoalRulesBlock` 側の `frozen` オプション1つに統合する（二重の `<details>` を避ける）。
  - `showDemo`（デモのチュートリアル、`reflection.js:126`）: `{ startOpen: true }` を渡す。直前の説明文が「下の『＋ 追加』から…」と案内しているため、折りたたまれたままだと導線が迷子になる。
- 既存 CSS `.gf-rules-collapse`（`app.css:1254-1256`）は `.pc-rules-collapse` に統合し、旧セレクタは削除する。

**代替案**: 「ルール」と「最近の変更」を別々の `<details>` にする案は、開閉操作が2回に増える割に得るものが無いため採らない。呼び出し側（`reflection.js`）で `<details>` をその都度組み立てる案は、凍結時の二重折りたたみ・件数の再同期をすべて呼び出し側に持たせることになり複雑なので採らない。

### D2. 視覚階層は CSS のみで調整し、DOM構造の大改造はしない

`ruleRow`（`rule-form.js:322`）・`changeLine`（`rule-form.js:360`）が返す要素のクラス構成はほぼ維持し、`app.css` 側で以下を調整する:

- ルール1行: ラベル＋しきい値を主行、スケジュール（`pc-pending-when`）を明確に小さく・淡い色にして主従を分ける
- 最近の変更1行: 操作アイコン＋ラベルと理由（`pc-pending-note`）の間の余白・色コントラストを広げ、理由が長文でも折り返しで主張しすぎないようにする（`font-style: italic` は維持しつつ `opacity` や `font-size` で下げる）
- 変更はすべて既存セレクタへの追記／新規セレクタ追加に留め、ファイル全体の整形はしない（プロジェクトルール）

### D3. `deleteGoal` は `ended_day_key` を直接見る

`GoalRow.ended_day_key != null` を削除拒否の条件に使う（`toGoalView` が導出する `status` 文字列を経由しない）。理由:
- `ended_day_key` は「終える」操作（進行中の早期終了・完走フォークの終える、どちらも `server/src/services/goals.ts:852`）で必ずセットされる一次データであり、`status` の再導出より直接的
- `completed` かつ `lifecycle_choice` 未決の状態は、目標が作成当日に完走することはあり得ない（最短でも当日中に `end_day` を過ぎることはない）ため、`ended_day_key` チェックのみで実質的にカバーされる
- 既存の `GoalDeleteWindowError`（「目標を削除できるのは作成当日のみです」）とは別に、新しいエラークラス `GoalDeleteAfterEndError`（例: 「終了した目標は削除できません」）を投げ、フロント側でエラーメッセージを区別できるようにする

API 層（`server/src/api/goals.ts`）は既存の 409 エラーハンドリングにこの新エラーをマッピングするだけで済む（`GoalDeleteWindowError` と同様の扱い）。

### D4. 一時凍結の未予約エントリーポイントは `journalsHost` の先頭に1つ

`loadJournals`（`reflection.js:567`）内、`h2 目標の日記` の直後・目標ループの前に、**凍結中/予約中でないアクティブ目標が1件以上あれば**一時凍結の未予約ブロック（月枠状況＋「❄ 一時凍結する」ボタン、クリックで開く `openFreezeModal` は変更なし）を `id="rf-freeze-shared"` の要素として1回だけ描画する。中身は既存の `unreservedView(goal, quota, allGoals, onChanged)` をそのまま呼び出す（`goal` 引数はモーダルの初期選択に使われるだけなので、対象目標の先頭（または任意の1件）を渡してよい）。

- `journalCorner` 内では、その目標が `reserved`/`frozen` のときのみ（`reservedView`/`frozenView`）を出し続ける（解除・延長・取消の導線は個別目標に紐づく操作なので、これは複製ではなく必要な表示）。`buildFreezeBlock` の呼び出し自体を `journalCorner` から外し、`unreservedView` に分岐したときは何も描画しない（＝呼び出し元で reserved/frozen かどうかを見て、非該当なら `buildFreezeBlock` を呼ばない）よう `buildFreezeBlock` 側 or 呼び出し側で分岐する。
- `unreservedView`（未予約時の月枠状況＋ボタン）は目標コーナーから完全に取り除き、`#rf-freeze-shared` の1箇所だけに残す。
- 凍結対象の選択は従来通り `openFreezeModal` 内のチェックボックスで行う（変更なし）。
- 対象（凍結中/予約中でないアクティブ目標）が0件なら `#rf-freeze-shared` 自体を描画しない。

**代替案**: 目標タブへ移す案は today's 会話で検討したが、`editable-rule-registry` の「ルール変更は振り返りタブの目標コーナーに限る」という既存方針との対称性を優先し、振り返りタブ内へ留める。

## Risks / Trade-offs

- [ルール一覧が既定で閉じることで、日々の運用で「今守っているルールが何か」を見るのに1クリック増える] → 折りたたみの `summary` に件数を出し、存在自体は常に見える状態にする。今回は issue #86 の「詰め込まれて見にくい」を優先する合意済みトレードオフ。
- [`deleteGoal` のガード変更は既存 e2e（目標削除フロー）に影響しうる] → 既存 e2e を確認し、終了済み目標を同日削除するケースがあれば仕様に合わせて修正する（新規ケースがなければ影響なしと明記）。
- [一時凍結ブロックの1箇所化は、アクティブ目標が0件のときの表示（何も出さない）と、凍結中/予約中の目標が1件もない中で未予約ブロックだけ出るケースの分岐が増える] → `unreservedView` 自体の実装はそのまま流用し、呼び出し箇所を1回に減らすだけなので分岐の複雑さは増えない。
