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
