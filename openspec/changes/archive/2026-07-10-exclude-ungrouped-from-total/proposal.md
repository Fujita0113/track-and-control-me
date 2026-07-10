## Why

娯楽で PC を使うとき、ユーザーはタブグループを作らず「グループ無し」のまま使う（GitHub issue #4）。現状この「未グループ（`ungrouped`）」時間は日の総作業時間へ合算され、パスワードゲートの総作業時間条件も満たしてしまうため、娯楽が“作業”として計上されコミットメントデバイスの強制力を弱める。ユーザーは未グループ時間を総作業時間から外す設定を求めている。

## What Changes

- 設定 `exclude_ungrouped_from_total`（真偽・既定 OFF）を追加する。ON のとき、日の総作業時間の集計から `ungrouped` バケットを除外する。
- 総作業時間を返す集計（`totalWorkMsForDay` / `totalWorkSecondsForDay` とサマリ range 集計）が本設定を尊重する。これによりパスワードゲートの「総作業時間」条件とダッシュボード総作業時間表示の両方へ一貫して波及する。
- グループ内訳では未グループ行を引き続き表示するが、ON のときは「総作業時間に非計上」であることが分かる表示にする（行は消さない・時間は見える）。
- 設定画面（`設定` タブ）に本トグルを追加し、`PATCH /api/config` の許可フィールドへ加える。
- 既定は OFF（現行挙動＝未グループも計上）を維持し、後方互換を保つ。ユーザーが明示的に ON にして娯楽を除外する。

補足（非対象）: シークレット/InPrivateタブはMV3拡張が既定で計測しない（`manifest.json` に `incognito` 宣言なし＝サンプル送信されない）ため、本設定の対象外で既に総作業時間に含まれない。本設定が扱うのは通常ウィンドウの「グループ無し」タブ時間（`ungrouped`）である。

## Capabilities

### New Capabilities
- `work-time-scope`: 日の総作業時間に未グループ（`ungrouped`）時間を含めるかを制御する設定と、その集計・表示・パスワードゲート評価への波及ルール。

### Modified Capabilities
（なし。総作業時間の集計スコープを規定する現行アクティブ spec は存在しないため、新規 capability として定義する。）

## Impact

- **DB**: `app_config` に `exclude_ungrouped_from_total INTEGER NOT NULL DEFAULT 0` 列を追加する新マイグレーション。
- **集計/サービス**: `server/src/services/categories.ts`（`totalWorkMsForDay`）、`server/src/services/summary.ts`（range 集計の inline 合算）。
- **API**: `server/src/api/index.ts` の `PATCH /api/config` 許可フィールド、`publicConfig`。
- **UI**: `server/static/js/settings.js`（トグル追加）、`server/static/js/today.js`（未グループ非計上の表示ヒント）。
- **ルール評価**: `server/src/rules/evaluate.ts` は `totalWorkSecondsForDay` 経由のため自動で波及（直接改修不要）。
- 破壊的変更なし（既定 OFF で現行挙動を維持）。
