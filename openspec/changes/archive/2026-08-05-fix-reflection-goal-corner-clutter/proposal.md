## Why

振り返りタブの目標コーナー（目標ごとの「ルール」「最近の変更」「日記」ブロック）が常時展開で同じ密度に詰め込まれていて見にくい（issue #86）。この調査の過程で、関連する2つの実装ギャップも見つかった: (1) 目標を「終える」で終了した後も、作成当日中なら `deleteGoal` がステータスを見ずに削除を許してしまい、`goal-lifecycle-fork` が要求する「終えた事実は消せない」を破れる、(2) 一時凍結の状態表示（月枠の空き状況＋「❄ 一時凍結する」ボタン）が目標カードごとに複製表示されている（アプリ全体で月1回のリソースなのに）。この3点をまとめて是正する。

## What Changes

- 振り返りタブの目標コーナーで、「ルール」一覧ブロックと「最近の変更」ブロックを**既定で折りたたみ**にする（開閉可能）。凍結中ルールブロックに既に使っている `<details class="gf-rules-collapse">` パターンを踏襲する。
- 折りたたみを開いたときの中身（ルール1行・変更履歴1行）の視覚的な階層（濃淡・余白）を整理し、ラベル／期間／操作ボタン、変更操作／理由が視覚的に区別しやすいようにする（純粋な CSS・レイアウト調整、挙動変更は無い）。
- `deleteGoal`（`server/src/services/goals.ts`）に status チェックを追加し、`status === 'ended'` または `status === 'completed'` の目標は、作成当日の削除可能ウィンドウ内であっても削除を拒否する。
- 振り返りサイドバーの一時凍結エントリーポイント（月枠の空き状況表示＋「❄ 一時凍結する」ボタン）を、目標コーナーごとの複製ではなく**サイドバーに1箇所だけ**表示する。凍結中／予約中の個別目標カード（解除・延長の導線）は引き続き各目標コーナーに残す。

## Capabilities

### New Capabilities

（無し）

### Modified Capabilities

- `editable-rule-registry`: 振り返りタブの目標コーナーにおける「ルール」「最近の変更」ブロックの既定表示状態（折りたたみ）についての要求を追加する。
- `goal-challenge`: 目標削除の許可条件に、目標の `status` が `ended`/`completed` でないことを追加する（作成当日ウィンドウ内であっても、終了・完走済みの目標は削除できない）。
- `goal-freeze`: 一時凍結の操作導線（月枠状況＋予約ボタン）を目標カードごとの複製ではなく振り返りサイドバーに1箇所だけ表示する要求へ変更する。凍結中・予約中の個別カード表示は変更しない。

## Impact

- `server/static/js/reflection.js` — 目標コーナー（`journalCorner`）の組み立て、一時凍結ブロックの配置
- `server/static/js/rule-form.js` — `buildGoalRulesBlock`（ルール一覧＋最近の変更の折りたたみ化）
- `server/static/js/goal-freeze.js` — 凍結エントリーポイントの1箇所化
- `server/static/css/app.css` — 折りたたみ後の視覚階層調整（既存の1ルール1行書式を保つ・全面整形はしない）
- `server/src/services/goals.ts` / `server/src/api/goals.ts` — `deleteGoal` の status ガード追加
- `server/src/services/goals.test.ts` — 削除ガードの vitest
- 影響しうる既存 e2e: 目標削除・目標終了・一時凍結・ルール編集のフロー（`e2e/**/*.spec.ts` を要確認）
