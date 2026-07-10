## Context

離席／空き時間の記録ポップオーバー（`server/static/js/timeline.js` の `openDraft`, 562–618行）は、カテゴリチップを `const CATEGORIES = ['昼食','休憩','移動','仮眠','運動','雑務','その他']`（16行）でハードコードしている。選択したチップ、または自由メモがそのままブロックのタイトルになり、`api.addManual` は `title` と `color:'grey'` のみを送る（`categoryKey` は未送信＝サーバー側で `'uncategorized'` 既定）。

- カテゴリは `eliminate-categories` で集計層から切り離され、現在は**表示ラベルにすぎない**（`services/categories.ts` は総作業時間のみ）。
- v1 の `category` テーブル（`key/display_name/kind/counts_toward_total/...`）は旧 WORK/AWAY 層の遺物で、現在は実質非活性。
- 単一ユーザーのローカル SQLite。API は同一オリジン fetch のみ（CSP `connect-src 'self'`）。

## Goals / Non-Goals

**Goals:**
- 一度使ったカテゴリ（既定語・自由入力を問わず）をサーバーに永続化し、**直近使用順**で記録ポップオーバーのチップに出す。
- 新規カテゴリ名の入力→記録で、その語を登録し翌日以降も再利用できる（issue #2 ①の「自分で追加」「直近使用の自動登録」を同一導線で満たす）。
- 集計・ルール・rollover・パスワードへの非影響を厳守する。

**Non-Goals:**
- カテゴリの明示的な削除／リネーム／並べ替え UI（将来課題）。
- カテゴリを時間集計や円グラフ・ルール条件に再接続すること（`eliminate-categories` の方針を維持）。
- 旧 `category` テーブルの再活性化・移行。
- Enter キーでの確定（issue #8 で横断対応）。

## Decisions

### D1. 新規テーブル `manual_category`（v8）を追加し、旧 `category` は触らない
旧 `category` テーブルは `kind`/`counts_toward_total` など集計前提のカラムを持ち、意味論が異なる。手動記録ラベル専用の最小テーブルを新設する。
- 代替案: 旧 `category` を流用 → 却下（非活性テーブルへ新意味を載せると混乱、`deleted_at` 等の不要カラムを引き継ぐ）。
- 代替案: 履歴（`activity_log_entry.category_key`）から `DISTINCT` 導出 → 却下（自由メモとカテゴリが混在し得る／既定語のシード・並び順制御ができない）。

```sql
CREATE TABLE manual_category (
  name TEXT PRIMARY KEY,                    -- trim 済み表示名（そのままラベル）
  last_used_at INTEGER NOT NULL DEFAULT 0,  -- epoch ms。未使用は 0
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```
シードは `INSERT OR IGNORE` で既定7語を投入（冪等）。`created_at` は固定基準時刻でよい。

### D2. 並び順は「最終使用の新しい順 → シード順」
取得クエリは `ORDER BY last_used_at DESC, rowid ASC`。未使用（`last_used_at = 0`）は末尾に集まり、`rowid`（＝シード挿入順）で既定語の並び（昼食→…→その他）を安定保持する。頻度ではなく**直近使用**を採用（issue #2 Q1=a）。`use_count` は保持のみ（将来の切替余地）。

### D3. 使用登録は記録 POST の内部で atomic に upsert
クライアントに別 API 往復を強いず、`POST /api/timeline/:date/manual` の body に任意の `category`（名前）を追加。`addManualEntry` 内で—
1. `category` を trim。空なら登録もラベル付与もしない。
2. `INSERT INTO manual_category(name, last_used_at, use_count, created_at) VALUES(?, ?, 1, ?) ON CONFLICT(name) DO UPDATE SET last_used_at=excluded.last_used_at, use_count=use_count+1`。
3. エントリの `category_key` に trim 後の名前を格納（従来の `'uncategorized'` 既定は `category` 未指定時のみ）。
- `GET /api/categories` は `services` の純関数から `[{ name, lastUsedAt, useCount }]` を返す。
- `promoteGapToAway`（`/gap-to-away`）は新 UI 未使用のため変更しない。

### D4. カテゴリ入力は1欄に統合（実装時にメモ分離案を撤回）
当初はブロック表示タイトルを `memo.trim() || category` とし、カテゴリ欄とメモ欄を分離する案だった（自由メモが語彙を汚さないため）。しかし実装レビューでテキスト入力欄が2つ並び **違いが直感的に伝わらない** ことが判明したため、ユーザー選好により **カテゴリ1欄へ統合** した。
- 記録ポップオーバーは「チップ（直近使用順）」＋「新しいカテゴリ名の入力欄」の1系統のみ。メモ欄は廃止。
- 入力／選択した語が **カテゴリ＝ブロック表示名＝レジストリ登録名** を兼ねる（`title = category`）。
- 送信: `category = 入力値.trim() || 選択チップ`。空なら記録を弾く（toast）。
- **Enter 確定** をこのポップオーバーに限り配線（新規カテゴリ名欄）。IME 変換確定の Enter は `isComposing` で無視する。全画面横断の Enter 対応（issue #8）は別途。

### D5. クライアント（`timeline.js` / `api.js` / `state.js`）
- `api.js`: `getCategories: () => req('GET','/api/categories')` を追加。
- `state.js` または `timeline.js`: 初回 `show()` 時（もしくは `openDraft` 直前）にカテゴリを取得してメモリキャッシュ。記録成功後に再取得してキャッシュ更新（次に開くと反映）。
- `openDraft`: `CATEGORIES` 定数をフォールバック既定（`DEFAULT_CATEGORIES`）に格下げし、チップはキャッシュ配列（空／失敗時はフォールバック）から生成。表示チップは**上限（`MAX_CHIPS=12`）**で切り、あふれは新規カテゴリ名入力で対応。
- 送信: `api.addManual(date, { startAt, endAt, title: category, color:'grey', category })`。

## Risks / Trade-offs

- **タイポ・表記ゆれでレジストリが肥大**（「買い物」「かいもの」等） → 現状は trim＋完全一致 dedupe のみ。表示上限（D5）で最悪でも UI は破綻しない。削除 UI は Non-Goal（将来対応）。
- **削除手段がない** → 単一ユーザー・低頻度前提で許容。必要になれば別変更で `DELETE /api/categories/:name` を追加。
- **並び順が頻度でなく直近** → ユーザー選好（Q1=a）に合わせた明示的判断。`use_count` を残し切替可能にしておく。
- **旧 `category` テーブルとの混同** → コメントとテーブル名（`manual_category`）で明確化。集計コードは触れない。

## Migration Plan

- v8 は**加算的**（新テーブル＋シードのみ）。既存 DB は次回起動で自動適用、バックフィル不要。既存 `activity_log_entry` は不変。
- ロールバック: `manual_category` を DROP するだけ（失うのはカテゴリ候補の学習のみ。記録済みエントリの `category_key` はただのラベルなので影響なし）。
- 既定カテゴリのシードは `INSERT OR IGNORE` で冪等。

## Open Questions

- 表示チップ上限は 12 で十分か（多用ユーザーなら要調整）。→ 実装時は定数化して後から変更可能に。
- 将来、カテゴリを円グラフ内訳へ再接続する需要が出た場合の設計は本変更のスコープ外。
