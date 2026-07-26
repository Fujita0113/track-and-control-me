# 凍結: `size/XS` 自動実装パイプライン

2026-07-26 に凍結。**一度も動いていない**（未 push・API キー未取得・GitHub の権限設定も未実施）
ので、止めるために解除した設定は無い。ここに置いてあるだけで、何も起動しない。

## なぜ凍結したか

個人開発で、回す頻度もそこまで高くない。issue → GitHub Actions → opencode（2モデル）→ Draft PR
という経路は、その規模に対して重い。**worktree を切ってローカルで実装させる**ほうが、
往復が短く、途中で口を挟めて、月額課金も要らない。

凍結して失うのはコストと運用負荷だけで、品質のガードは失っていない
（`CLAUDE.md`「テストの凍結ライン」と、apply 時の red 証明はローカル手順としてそのまま生きている）。

## 中身

| | 説明 |
|---|---|
| `workflows/xs-auto.yml` | 本体。`size/XS` ラベル → 提案 → 実装 → テスト → sync → Draft PR |
| `workflows/opsx-archive.yml` | PR マージ後に OpenSpec の変更を archive へ移動（LLM 不使用） |
| `.opencode/` | opencode 用の opsx スキル・コマンド（OpenSpec CLI 1.4.1 で生成） |
| `AGENTS.md` | opencode 用プロジェクトルール（`CLAUDE.md` のミラーだった） |
| `SETUP-TODO.md` | 有効化に必要な4ステップ（API キー取得・Secret 登録・権限設定・push） |

`.github/workflows/ci.yml`（型検査・vitest・e2e を回すだけ／LLM 不使用）は**凍結していない**。
LLM を使わず無料で、レビュアーのいない個人開発では「main が壊れたら気づく」が効くため。

## 復活させるとき

1. `workflows/*.yml` を `.github/workflows/` へ戻す
2. `.opencode/` と `AGENTS.md` をリポジトリ直下へ戻す
3. `SETUP-TODO.md` の4ステップを実行する
4. **`AGENTS.md` を `CLAUDE.md` の現在の内容へ追従させる**（凍結中は同期していないので必ず古い）
5. `xs-auto.yml` のプロンプトが参照している `AGENTS.md`・凍結ラインの記述が
   現在の `CLAUDE.md` と食い違っていないか確認する

凍結時点で `xs-auto.yml` には「新規 E2E の red 証明」ステップ（`git stash` で実装だけ戻し、
spec が落ちることを1本ずつ機械的に確認する）が入っている。復活させるならここは残す価値がある。
