# Track & Control Me

Edge のタブグループを「活動の単位」として作業時間を自動計測し、あらかじめ決めた
**日次ルール**（総作業時間・カテゴリ別時間・手動チェック／翌日計画完了）を満たしたときだけ、
ゲームPCのパスワード（前日・当日の2候補）を**表示**する、ローカル完結のコミットメントデバイスです。

「サボりたい自分」に対して、達成条件を満たすまで娯楽（ゲームPC）へのアクセスを
自分自身でブロックする、個人の習慣強制ツールとして作っています。

![今日のダッシュボード：総作業時間・グループ別内訳・達成条件の進捗・パスワード表示欄](docs/screenshots/today-dashboard.png)

> 上：デモモードでの「今日」タブ。総作業時間と円グラフの内訳、条件ごとの進捗チェック、
> 未達成時にロックされたパスワード欄が一目で分かる。

> **⚠️ 個人利用専用のツールです。**
> 特定1名（開発者本人）が単独端末で使うこと前提に設計されており、複数ユーザー対応や
> 他者への配布・共有は想定していません。認証もローカル用の簡易共有トークンのみです。

## 特徴

- **完全ローカル・オフライン動作** — 通信は `127.0.0.1` のみ。外部サーバーへのデータ送信は一切ない。
- **脱出弁（break-glass）なし** — 条件未達成のときは一切パスワードを表示しない。これが強制力の担保。
- **パスワード生成は差し替え可能** — 本体は表示のみを担当し、実際の生成ロジックは外部 PowerShell
  スクリプトに委譲（既定は `ref/gen_password.ps1`）。
- **Edge のタブグループ単位で自動計測** — Edge を最前面にしていなくても、在席していれば計上される。
  同時に開いていたタブグループがある場合は自動で按分（divide-by-N）される。

## 仕組み（構成）

| パッケージ | 役割 |
|---|---|
| `packages/contract` | 拡張と server が共有する zod スキーマ／型（ハートビート・WS プロトコル） |
| `extension` | Edge/Chromium MV3 拡張。アクティブなタブグループを検出し `ws://127.0.0.1` へ送信 |
| `server` | Fastify backend。WS 受信・時間集計・ルール評価・パスワード表示・ダッシュボード |

集計の中核（divide-by-N・gap-cap・日境界分割）は `server/src/aggregation/` の pure 関数。
詳細設計は `openspec/changes/edge-work-tracker/`（`proposal.md` / `design.md` / `specs/`）を参照。

## 必要環境

- **Node.js >= 22**
- **PowerShell 7+（pwsh）**
- **Microsoft Edge（Chromium）**
- `better-sqlite3` はネイティブモジュール。Node 22 の prebuilt が使われるため通常はビルド不要
  （失敗する場合は [OPERATIONS.md](OPERATIONS.md) のトラブルシュートを参照）。

## セットアップ

```powershell
# 1. 依存インストール（ルートで。workspaces 一括）
npm install

# 2. 拡張をビルド（esbuild で extension/dist/ を生成）
npm run build:ext

# 3. backend を起動（開発起動・tsx で直接実行）
npm run server
# → http://127.0.0.1:47653 で待受（既定ポート）。DB は server/data/track.sqlite に作成される。
```

ダッシュボードはブラウザで `http://127.0.0.1:47653/` を開く。

### 拡張の読み込み（Edge）

1. `edge://extensions` を開き、右下の「開発者モード」を ON。
2. 「展開して読み込み」→ `extension\dist`（`manifest.json` がある方）を選択。
3. ツールバーの拡張アイコン（ポップアップ）で **WS ポート**と**共有トークン**を設定し、
   接続状態が「接続済み」になることを確認。

### 初期設定（共有トークン・パスワードコマンド）

ダッシュボードの「設定」タブ、または API で共有トークンを設定する
（空文字のままだと dev モード＝無認証で接続を許可する）。

```powershell
# ランダムトークンを生成して backend に設定
$token = -join ((48..57)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
Invoke-RestMethod -Method Patch -Uri "http://127.0.0.1:47653/api/config" `
  -ContentType "application/json" -Body (@{ shared_token = $token } | ConvertTo-Json)
Write-Host "拡張ポップアップに貼るトークン: $token"
```

同じトークンを拡張のポップアップに入力する。

パスワードは既定で `pwsh -NoProfile -File ref/gen_password.ps1 -Date {date}` を実行し、
標準出力の6桁hex（`SHA256(日付)` の先頭6桁）を候補とする。別のコマンドに差し替えたい場合は
`password_command_config` を更新する（生成ロジック自体は本アプリに含まれない）。

## 日々の使い方（ゲートのループ）

1. Edge に「開発」「AtCoder」等のタブグループを開いて作業する
   （Edge が最前面でなくても在席していれば計上。「開発」を開いておけば VS Code の作業も開発へ計上）。
2. ダッシュボードで当日の作業時間・内訳（円グラフ）・タイムラインを確認する。
3. 「当日チェック」で振り返り／翌日タスク登録などの手動チェックを完了する。
4. 全条件（AND）を満たした瞬間にラッチされ、パスワード（前日・当日の2候補）が表示可能になる。
   **未達成では一切表示されない。**
5. 明日以降のルールは「ルール編集」で変更可能。**当日のルールは凍結**され変更できない。

<table>
<tr>
<td width="50%">

**振り返り**（1日の配分・その日の日記・ルール一覧）

![振り返りタブ：1日の時間配分バーとルール一覧](docs/screenshots/reflection.png)

</td>
<td width="50%">

**目標**（30日チャレンジの進行状況・完走レポート）

![目標タブ：進行中と完走済みの30日チャレンジ一覧](docs/screenshots/goals.png)

</td>
</tr>
</table>

いずれもデモモード（`server/src/services/demo-seed.ts` の固定サンプル）で撮影したもの。
実データではなく、Day 15/30・作業時間2h10mなどはすべてサンプル値。

## テスト

```powershell
npm test            # vitest フルスイート
npm run typecheck   # 全パッケージの型チェック
```

## 常駐・バックアップ・トラブルシュート

ログオン時の常駐起動、日次バックアップ、接続不良などのトラブルシュートは
[OPERATIONS.md](OPERATIONS.md) にまとめている。

## 技術スタック（おまけ）

- **言語**: TypeScript（backend / 拡張 / 共有スキーマ）、Vanilla JS（フロント。フレームワーク非使用）
- **backend**: Fastify 5 / `@fastify/websocket` / better-sqlite3 / croner（日次ロールオーバー） / Zod（拡張と共有するスキーマ検証）
- **拡張**: Chrome/Edge MV3、esbuild でバンドル
- **フロント**: Vanilla JS + Chart.js（円グラフ・棒グラフ）
- **モノレポ**: npm workspaces（`packages/contract` を拡張と backend が共有）
- **テスト**: Vitest（集計ロジック・ルール評価・DBを含むユニット/結合）、Playwright（e2e・スクリーンショット撮影）
