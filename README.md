# Track & Control Me

Edge のタブグループを「活動の単位」として作業時間を自動計測し、あらかじめ決めた
**日次ルール**（総作業時間・カテゴリ別時間・手動チェック／翌日計画完了）を満たしたときだけ、
ゲームPCのパスワード（前日・当日の2候補）を**表示**するローカル完結のコミットメントデバイス。

- 完全ローカル・オフライン（通信は `127.0.0.1` のみ）。対象は本人のみ。
- パスワードは差し替え可能な PowerShell スクリプトに委譲（本アプリは表示のみ・変更しない）。
- **脱出弁（break-glass）なし** — 条件未達では一切パスワードを出さない（強制力の担保）。

詳細な設計は `openspec/changes/edge-work-tracker/`（`proposal.md` / `design.md` / `specs/`）を参照。

## 構成

| パッケージ | 役割 |
|---|---|
| `packages/contract` | 拡張と server が共有する zod スキーマ／型（ハートビート・WS プロトコル） |
| `extension` | Edge/Chromium MV3 拡張。アクティブグループを検出し `ws://127.0.0.1` へ送信 |
| `server` | Fastify backend。WS 受信・時間集計・ルール評価・パスワード・ダッシュボード |

集計の中核（divide-by-N・gap-cap・日境界分割）は `server/src/aggregation/` の pure 関数。

## 必要環境

- **Node.js >= 22**（導入済み前提。`node -v` で確認）
- **PowerShell 7+（pwsh）**
- **Microsoft Edge（Chromium）**
- `better-sqlite3` はネイティブモジュール。Node 22 の prebuilt が使われるため通常はビルド不要。
  もし `npm install` でビルドが走り失敗する場合は **Visual Studio Build Tools（C++ workload）** が必要
  （トラブルシュート参照）。

## セットアップ

```powershell
# 依存インストール（ルートで。workspaces 一括）
npm install

# 拡張をビルド（esbuild で extension/dist/ を生成）
npm run build:ext
```

## backend の起動

```powershell
# 開発起動（tsx で直接実行）
npm run server
# → http://127.0.0.1:47653 で待受（既定ポート）。DB は server/data/track.sqlite に作成。
```

ポートや DB パスを変えたい場合は環境変数、または `server/config.local.json`：

```powershell
$env:PORT = "47653"
$env:DB_PATH = "C:\Users\yufuj\dev\track-and-control-me\server\data\track.sqlite"
npm run server
```

`server/config.local.json`（任意）:

```json
{ "port": 47653, "dbPath": "server/data/track.sqlite" }
```

ダッシュボードはブラウザで `http://127.0.0.1:47653/` を開く。

## 拡張の読み込み（Edge）

1. `edge://extensions` を開き、右下の「開発者モード」を ON。
2. 「展開して読み込み」→ `extension\dist`（`manifest.json` がある方）を選択。
3. ツールバーの拡張アイコン（ポップアップ）で **WS ポート**と**共有トークン**を設定し、
   接続状態が「接続済み」になることを確認。

## 初期設定（共有トークン・パスワードコマンド）

### 共有トークン（拡張 ↔ backend の照合）

ダッシュボードの「設定」タブ、または API で設定する。空文字のままだと dev モード（無認証）で接続を許可する。

```powershell
# ランダムトークンを生成して backend に設定
$token = -join ((48..57)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
Invoke-RestMethod -Method Patch -Uri "http://127.0.0.1:47653/api/config" `
  -ContentType "application/json" -Body (@{ shared_token = $token } | ConvertTo-Json)
Write-Host "拡張ポップアップに貼るトークン: $token"
```

同じトークンを拡張のポップアップに入力する。

### パスワードコマンド（既定 = `ref/gen_password.ps1`）

既定では `pwsh -NoProfile -File ref/gen_password.ps1 -Date {date}` を実行し、標準出力の6桁hex
（`SHA256(日付)` の先頭6桁）を候補とする。`{date}` は対象日（`yyyy-MM-dd`）に置換される。
別のコマンドに差し替える場合は `password_command_config` を更新する（内部実装は本アプリでは持たない）。

```powershell
# 動作確認（例）
pwsh -NoProfile -File ref\gen_password.ps1 -Date 2026-07-06   # → 6桁hex
```

## 常駐（Windows スタートアップ登録）

ログオン時に backend を非表示で常駐させる：

```powershell
pwsh -NoProfile -File scripts\install-startup.ps1        # 登録
Start-ScheduledTask -TaskName 'TrackAndControlMe-Backend' # 今すぐ起動
pwsh -NoProfile -File scripts\install-startup.ps1 -Uninstall  # 解除
```

日次ロールオーバー（前日確定・当日ルール凍結）は backend 内の croner が毎日 **04:00** に実行する
（day_boundary）。backend が常駐していれば追加設定は不要。

### オンデマンド起動 vs 常駐（運用メモ）

- **時間計測**は、Edge 拡張が起動中のみ 30 秒周期で計測し、backend 停止中は `chrome.storage.local`
  に最大 2000 件（約 **16 時間**分）退避 → 再接続時に集計される。したがって「見たいときだけ
  `npm run server`」でも概ね成立する（バッファ超過分は失われる）。
- **04:00 の日次ロールオーバー / ルール凍結**は backend 常駐が前提。オンデマンド起動のみの運用では、
  境界処理は次回起動時にまとめて実行されるため、凍結タイミングがずれる可能性がある。厳密な運用が必要な
  場合はスタートアップ登録で常駐させること。

## バックアップ

SQLite はオンラインバックアップ（WAL 対応）でコピーする：

```powershell
# 手動バックアップ → backups\track-YYYYMMDD-HHmmss.sqlite
node scripts\backup-db.mjs

# 毎日 04:10 に自動バックアップを登録
pwsh -NoProfile -File scripts\install-backup-task.ps1
pwsh -NoProfile -File scripts\install-backup-task.ps1 -Uninstall  # 解除
```

唯一の永続状態は SQLite ファイル。初期化したい場合は backend を停止して DB ファイルを削除する。

## テスト

```powershell
npm test            # vitest フルスイート（contract / aggregation / db / rules / password / rollover）
npm run typecheck   # 全パッケージの型チェック
```

## 日々の使い方（ゲートのループ）

1. Edge に「開発」「AtCoder」等のタブグループを開いて作業する
   （**Edge が最前面でなくても在席していれば計上**。「開発」を開いておけば VS Code の作業も開発へ計上）。
2. ダッシュボードで当日の作業時間・内訳（円グラフ）・タイムラインを確認。
   同時に開いていた区間は自動で **divide-by-N** 按分される（行動記録画面で割合を編集可・0 可）。
3. 「当日チェック」で振り返り／翌日タスク登録などの手動チェックを完了する
   （最終形ではカンバン＋振り返りで自動判定＝PLANNING）。
4. 全条件（AND）を満たした瞬間に latch され、パスワード（前日・当日の2候補）が表示可能になる。
   **未達成では表示されない。**
5. 明日以降のルールは「ルール編集」で変更可能。**当日のルールは凍結（変更不可）**。

## トラブルシュート

- **`better-sqlite3` のビルドが失敗する**
  Node 22 用 prebuilt が無い環境ではソースビルドになる。以下を導入して再インストール：
  ```powershell
  winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  npm rebuild better-sqlite3
  ```
  Node のメジャーを上げ下げした後も `npm rebuild better-sqlite3` が必要。

- **拡張が backend に接続できない**
  - backend が起動しているか（`http://127.0.0.1:<port>/api/config` が返るか）。
  - ポップアップのポートが backend のポート（既定 47653）と一致しているか。
  - 共有トークンを設定した場合、拡張側のトークンが一致しているか（不一致だと `bad token` で切断）。
  - Edge を再起動しても Service Worker が起きない場合、`edge://extensions` で拡張を再読み込み。

- **ポートが使用中**
  `PORT` を変えて起動し、拡張ポップアップのポートも合わせる。使用中プロセスの確認：
  ```powershell
  Get-NetTCPConnection -LocalPort 47653 -State Listen | Select-Object OwningProcess
  ```

- **作業時間が計上されない**
  - `chrome.idle` が `idle`/`locked`、または PC スリープ中は計上されない（仕様）。
  - どのタブグループも開いていない在席時間は計上されない（グループを1つ開いておく）。
  - チュートリアル視聴など無操作は idle 扱いになり計上されない（既定）。

- **パスワードが表示されない**
  未達成なら仕様通り表示されない。ダッシュボードのゲート画面で不足条件を確認する。
  達成済みでコマンドが失敗する場合は、`ref/gen_password.ps1` が単体で動くか、pwsh が PATH にあるかを確認。
