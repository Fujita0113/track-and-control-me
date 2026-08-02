# track-and-control-me プロジェクトルール (Gemini Agent)

## ルールファイルは3つある。足したら必ず3つとも直す（必須）

このプロジェクトは **Claude Code と Gemini（Antigravity / Gemini CLI）が同じリポジトリを触る**。
プロジェクトルールは読み手ごとに3ファイルへ置かれているが、**中身は同一**でなければならない:

| ファイル | 読み手 |
|---|---|
| `CLAUDE.md` | Claude Code |
| `GEMINI.md` | Gemini CLI |
| `.agents/AGENTS.md` | Antigravity / Gemini Agent（`.gemini/config.json` の `customizationRoot: ".agents"` 経由） |

- ルールを追加・変更・削除したら、**3ファイルすべてを同じコミットで**直す。1つだけ直してはならない。
- 許される差異は**1行目のタイトル行だけ**。同期の確認（出力が空＝同期済み）:
  ```pwsh
  Compare-Object (Get-Content CLAUDE.md | Select-Object -Skip 1) (Get-Content GEMINI.md | Select-Object -Skip 1)
  Compare-Object (Get-Content CLAUDE.md | Select-Object -Skip 1) (Get-Content .agents\AGENTS.md | Select-Object -Skip 1)
  ```
- スキルも同じ理由で対になっている（`.claude/skills/` ⇔ `.agents/skills/`）。片方だけに足さない。
- ユーザー個人のグローバル設定（`~/.claude/CLAUDE.md` 等）はリポジトリ外なので同期対象ではない。
  片方のエージェントしか知らない前提は、ここへ書き写して初めて両者の共有物になる。

## 日数が関わる機能はデモモードで成果を明示する（必須）

日付・日数が絡む機能（30日チャレンジ／完走レポート／タイムライン／振り返り等）を作る・変えるときは、
実装後に**デモモード**（`server/src/services/demo-seed.ts` の固定 day_key サンプル）で成果を再現し、
ユーザーに明示すること。使い捨ての本番 DB ではなくデモモードを使う。

- 見せたい機能がデモのサンプルに無い場合は、`demo-seed.ts` にサンプルデータを足してから見せる
  （集計が読むテーブルへ直接焼き込む方式。`Date.now()` 非依存の固定 day_key／固定タイムスタンプを守る）。
- サンプルを足したら `server/src/services/demo.test.ts` の期待値（実践数・達成日数など）も併せて更新する。
- 確認は `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動し、
  `POST /api/demo/reset` → `GET /api/demo/goals/:id/report?now=<完走後の day_key>` で本物の集計経路を通す。
  達成日数など既存の筋書き（達成 24/30・中盤の谷）を壊さないよう、サンプル追加は既存の谷日に寄せる。

## テストの凍結ライン（必須）

実装者がゴールポストを動かせないようにするためのルール。ただし
**propose の時点で決まっているものだけを凍結する**（DOM は決まっていないので凍結しない）。

| | propose が書く＝以降**凍結** | apply が書く |
|---|---|---|
| シナリオ（delta spec） | ✅ | 触るの禁止 |
| vitest（サービス・API 層） | ✅ 赤で置く | 触るの禁止 |
| **既存** e2e | 影響分をここで直す | **触るの禁止**（← 投げ返しはここだけ） |
| **新規** e2e | ❌ 書かない | ✅ DOM ができてから最後に書く |

**新規 e2e を propose に書かせない理由**: `.cond-check` のようなセレクタ・ラベル・DOM 構造は
実装中に発明されるもので、propose には当てようがない。当てずっぽうを書くと、
apply がセレクタの綴りミスのたびに停止してユーザーへ確認する羽目になり、
「1回だけの投げ返し」枠が設計の食い違いではなく些末事で消費される。

**既存 e2e の凍結は残す理由**: そこは推測要素ゼロ（DOM は既に存在する）で、赤くなったら
本物の回帰シグナル。`git diff -- e2e/` で決定論的に検出でき、追加コストは 0。

### 新規 e2e が骨抜きでないことは、質問ではなく機械で証明する

apply が自分で後から書いた spec は、**実装抜きで落ちること**を示すまで何も証明していない。

```pwsh
git stash push -- server/ extension/ packages/
$env:CI="1"; npx playwright test e2e/<new-spec>.spec.ts   # 落ちること
git stash pop
npx playwright test e2e/<new-spec>.spec.ts                # 通ること
```

**`CI=1` は必須。** これが無いと `playwright.config.ts` の `reuseExistingServer` が
起動済みサーバを使い回し、stash したのに新しいコードで走って**偽の緑**になる（実測で確認済み）。
stash 側が通ってしまったら、その spec は今回の変更について何も主張していないので書き直す。

### 凍結側の誤りが見つかったときの例外（1回だけ投げ返す）

実装を直しても通らず、**凍結側が間違っている**と判断した場合に限り、
自分で直さず**その場で停止**し、AskUserQuestion で1回だけユーザーに確認する:

> propose で作られたテストに誤りが見つかり通りません。変更しても良いでしょうか。
> （どのファイル・どの assertion が、なぜ実装ではなくテストの誤りなのか／直したら何が変わるかを添える）

- ユーザーが承認したら修正して通してよい。修正内容はコミットメッセージにも残す。
- 承認が無ければ触れず、実装側の修正か、タスクを保留にして報告する。
- 「時間がかかる」「実装のほうが自然」は理由にならない。**事実と食い違っている**ときだけ投げ返す。
- 投げ返しは1タスクにつき1回。2回目が必要になったら、
  そもそも提案（spec/design）がずれている疑いとして報告する。

判断がつかないときの答えは**「変更しない」**。赤いまま残して見せるほうが、
書き換えて緑にするより安全。

## opsx:archive では必ず delta spec を sync し、git commit も行う（必須・確認不要）

`/opsx:archive`（OpenSpec 変更のアーカイブ）を行うときは:
1. delta spec が存在すれば**常にメインスペック（`openspec/specs/<capability>/spec.md`）へ sync してからアーカイブする**こと。
2. アーカイブ完了後、変更分（メインスペックの更新およびアーカイブディレクトリへの移動）を **git commit（メッセージ例: `docs: archive <change-name> change and sync specs`）までセットで行う**こと。

sync や commit を行うかどうかをユーザーに質問してはならない（デフォルト＝必ず実行）。

## 既存ファイルの書式に合わせる（必須）

コードを編集するとき、**触っていない行の書式を変えてはならない**。
とくに `server/static/css/app.css` は「1ルール1行」のコンパクト書式で書かれている。
prettier 等のフォーマッタを一括でかけると全面差分になり、変更の中身がレビューできなくなる
（実測: 1行の修正のつもりが 5,700 行差分になり、別エージェントのコミットと混ざった）。

- フォーマッタをファイル全体にかけない（このリポジトリに整形設定は意図的に置いていない）
- 書式の一括変更が必要なときは、機能変更と混ぜず単独のコミットにする
- 編集後に `git diff --stat` を見て、想定より桁が大きければ整形が混入したと考える

## ショートカット操作の追加時はホバーヒント（attachTooltip）を併記する（必須）

キーボードショートカット（Ctrl+Enter・Esc・数字キーなど）に対応するボタンや UI 要素を追加・変更するときは、ユーザーがショートカットの存在に気づけるよう、必ず `attachTooltip(el, { label: '...', keys: [...] })` でホバーヒント（ツールチップ＋`aria-keyshortcuts`）を同時に設定すること。
`ctrlEnterToSave(root, saveBtn, 'ラベル')` のように第3引数へラベルを渡すと自動で付与される。

