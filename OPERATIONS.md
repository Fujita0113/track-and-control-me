# 運用メモ

## 拡張機能の再ビルド・再読み込み手順

`packages/contract`（型・スキーマ）または `extension/src/**` を変更したときは、
ビルドし直してブラウザへ反映しないと**修正が反映されないまま動き続ける**（issue #59 の教訓）。

```powershell
npm run build:contract
npm run build:ext
```

その後、`edge://extensions`（Chrome なら `chrome://extensions`）を開き、
本拡張機能のカードにある「再読み込み」ボタンを押す。ブラウザの再起動は不要。

反映漏れは `manifest.json` の `version` とサーバーの最小要求版
（`server/src/services/ext-version.ts` の `MIN_EXTENSION_VERSION`）の差でダッシュボードが
警告バナーを出すので気づける（design.md D7-4）。バナーが出たら上記手順をやり直す。

## ポート・DB パスの変更

環境変数、または `server/config.local.json` で指定する。

```powershell
$env:PORT = "47653"
$env:DB_PATH = "C:\Users\yufuj\dev\track-and-control-me\server\data\track.sqlite"
npm run server
```

`server/config.local.json`（任意）:

```json
{ "port": 47653, "dbPath": "server/data/track.sqlite" }
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

### オンデマンド起動 vs 常駐

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
