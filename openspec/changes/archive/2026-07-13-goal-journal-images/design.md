## Context

30日チャレンジ（`goal-challenge` / `goal-journal` / `goal-report`）は実装済み・アーカイブ済み。関連する既存事実：

- **日記**は `goal_journal(goal_id, day_key, content, …)`（PK＝`goal_id,day_key`・1日1行のテキスト）。書込は `saveJournal()` が「進行中の日のみ」を強制（`deriveStatus` が active 以外を拒否・期間外も拒否）。`goal` 削除で CASCADE。
- **日記コーナー**は `reflection.js` の `journalCorner(goal, content)`。進行中の目標ごとに見出し＋ライブ Markdown エディタ（`createMarkdownEditor`）を出し、保存は振り返り本文と同じ動線（保存ボタン・日付切替/離脱フラッシュ）に相乗り。`renderGoalJournals(date)` が対象日で（再）構築。
- **レポート ③④** は `goals.js` の `blockBeforeAfter(rep)`（`rep.days[0]`＝Day1／`rep.days[last]`＝Day30 の `{text, source}` を左右並置）と日記リーダー（日付セレクタ＋①カレンダー連動で `rep.days[n]` を1件表示）。集計は `buildReport()`（`server/src/services/goals.ts`）が `days: ReportDayText[]`（`goal_journal → reflection_entry` の日単位フォールバック）を返す。
- **API** は全て JSON（`api.js` の `req()`）。multipart は未使用。CSP は `img-src 'self' data:`（自己配信バイナリと `data:` プレビューの両方が可）。マイグレーションは現在 v13、次は **v14**。better-sqlite3・WAL。

issue #22 のユーザー意図：完走レポート ③ の Day1/Day30 を写真で見比べたい。被写体は複数あり得る（掃除の「台所／机／床」）ので**複数枚**、各画像に**任意キャプション**を付け、③はキャプション一致でペア並置。追加は**ファイル選択・貼り付け・D&D**の3方式。ローカル完結。

## Goals / Non-Goals

**Goals:**
- 目標に画像を複数枚添付できる（3方式・任意キャプション）。導線は **作成フォーム（Before）** と **振り返り日記コーナー**。書込は**いつでも可**（作成前/進行中/完走後）。
- 完走レポート ③ に **2モード**（キャプション別 最古/最新の Before/After ／ キャプション別 全枚数の時系列並び）と **最終日写真の追加CTA** を設け、④ に選択日の画像表示を足す。
- デモモードでも ③④ に画像が出る（`demo-seed` にサンプル画像）。
- ローカル完結（外部送信ゼロ）・肥大抑制（クライアント縮小）・目標削除で画像も CASCADE。
- 既存の日記本文の保存動線・`reflection_done` 非汚染・レポート4ブロック構成を壊さない。

**Non-Goals:**
- 画像の並べ替え UI・回転・トリミング・被写体「枠」の明示管理。グループ化はキャプション一致で足りる。
- 目標日記以外（振り返り本文・カンバン等）への画像添付。汎用添付基盤化は将来。
- 画像の遅延読み込み/ページングなどの最適化（枚数は個人・少数の想定）。
- 画像の書込に対する担保・改竄防止（ローカル単独・正直さは自己管理）。

## Decisions

### D1: 保存は SQLite BLOB（新テーブル `goal_journal_image`）
画像は**同じ DB に BLOB** で持つ。理由：目標削除で CASCADE 自動消去・バックアップは DB 1ファイル・**孤児ファイル無し**・書込がトランザクション的。個人ローカル・少数枚・クライアント縮小前提なら DB 肥大は実害小。ファイル保存＋パス参照は「削除時の掃除・孤児対策・バックアップ二重管理」を招くため採らない（issue の論点に対する結論）。

マイグレーション v14：
```sql
CREATE TABLE goal_journal_image (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goal(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',      -- 任意（空可）。③のペア化キー
  mime TEXT NOT NULL,                    -- image/jpeg | image/png | image/webp
  bytes BLOB NOT NULL,                   -- 縮小・再エンコード後の画像
  width INTEGER, height INTEGER,         -- 表示レイアウト用（任意）
  sort_order INTEGER NOT NULL DEFAULT 0, -- 同一日内の添付順（決定的な並び）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_gji ON goal_journal_image(goal_id, day_key);
```
`goal_journal` へは FK しない（**本文行が無い日でも画像を持てる**ように `goal` へ直接 FK）。加算的移行でバックフィル不要・既存挙動不変。

### D2: 転送は base64 を既存 JSON 経路で（multipart 依存を足さない）
クライアントは縮小後の画像を **data URL（base64）** にして JSON で POST。サーバは base64 をデコードして BLOB 保存。取得は**バイナリを返す専用エンドポイント**（`Content-Type: <mime>`）で、`<img src="/api/…/image">`（CSP `'self'`）で表示。理由：`@fastify/multipart` 等の新依存を避け、既存 `req()` 経路に乗る。少数・縮小済みなら base64 の ~33% オーバーヘッドは許容。プレビュー（保存前）は `data:` URL をそのまま `<img>` に使う（CSP `data:` 許可済み）。

サイズ上限：デコード後バイト数に上限（例 5MB）を設けて超過を 413/400 で拒否。`mime` は許可リスト（jpeg/png/webp）で検証。

### D3: クライアント側で縮小・再エンコード
3方式（`<input type=file>` / `paste` の `clipboardData.items` / `drop` の `dataTransfer.files`）いずれも `File`/`Blob` を得て、共通関数で **canvas に描画して長辺 ≤ 1600px に縮小し JPEG（q≈0.85）へ再エンコード** → data URL 化して送る。PNG 透過を保ちたいスクショ等で、かつ十分小さい場合は PNG のまま送る余地を残す（細部は実装時判断）。これで保存サイズと DB 肥大を抑える。EXIF 回転は canvas 描画時に必要なら補正（最小対応でよい）。

### D4: API（`goals.ts` へ追加・全て `goal_id`/`day_key` スコープ）
- `GET  /api/goals/:id/journal/:date/images` → メタデータ一覧 `[{ imageId, caption, mime, width, height, sortOrder }]`（**バイトは含めない**）。
- `POST /api/goals/:id/journal/:date/images` （JSON `{ dataUrl, caption? }`）→ 縮小済み画像を保存し新規メタデータを返す。
- `GET  /api/goals/:id/journal/images/:imageId` → **バイナリ**（`Content-Type`＝`mime`・`Cache-Control` 適宜）。
- `PATCH /api/goals/:id/journal/images/:imageId` （JSON `{ caption }`）→ キャプション更新。
- `DELETE /api/goals/:id/journal/images/:imageId` → 削除。
サービス層 `goals.ts` に `listJournalImages` / `addJournalImage` / `getJournalImageBytes` / `updateJournalImageCaption` / `deleteJournalImage`。`imageId` は `goal_id` 所有を検証（他目標の画像を触れない）。

### D4b: 書込ガードは「いつでも可」（`active` 限定を撤廃・**決定変更**）
画像の追加・キャプション編集・削除は **目標が存在する間いつでも**許可する。理由：追加導線が **作成フォーム（開始前 upcoming の目標もあり得る）** と **レポートの最終日CTA（完走後 completed）** の両方に必要で、`active` 限定だと成立しない。日記本文（`saveJournal`）の「進行中のみ」は `reflection_done` の意味を守るための規則で、画像はそれと独立。
- `addJournalImage`：`day_key ∈ [start_day, end_day]` のみ検証（どの日の記録かの整合）。**status は問わない**。mime 許可リスト・サイズ上限は従来どおり。
- `updateJournalImageCaption` / `deleteJournalImage`：**所有検証のみ**（status 不問）。
- `JournalNotWritableError` の画像経路での使用は撤廃。期間外 `day_key` は `JournalImageError`（400）で拒否。
ローカル単独アプリなので「初日 Before を後から捏造」等の正直さは自己管理（担保より柔軟性を採る）。

### D5: レポート集計に画像を載せる（`buildReport`・**モード対応で拡張**）
③の2モードはいずれも **キャプション単位** で最古/最新・全枚数を扱うため、`days[i].images` だけでは不足（キャプション横断・日跨ぎの並びが要る）。返却に **全画像の平坦リスト** を足す：
```
reportImages: [{ imageId, caption, dayKey, dayNumber, sortOrder }]  // (caption, dayNumber, sortOrder) 昇順
```
④用の `days[i].images`（その日の `{imageId,caption}`）は従来どおり維持。バイトは別取得なので JSON は軽いまま。

### D6: ③ の2モード（クライアント `goals.js`）
`blockBeforeAfter(rep)` を **モード切替つき**に作り替える。`reportImages` を **trim 済みキャプションでグループ化**（空キャプションは各画像を単独グループ扱い）し、各グループ内を `dayNumber→sortOrder` 昇順に整列する。
- **デフォルト（Before/After）**：各グループの **最古（先頭）＝Before／最新（末尾）＝After** の2枚を左右並置。グループが1枚なら単独表示。ヘッダは Day 番号（例 Day 1 / Day 30）。既存の文面並置（`baCol`）は残し、その下に画像領域。
- **全比較**：各グループを1行にし、**古い→新しい順に全枚数を横スクロールで並べる**（各画像に Day 番号＋キャプション）。
- モード切替は ③ 見出し脇のトグル（2ボタン）。並びは決定的、演出・スコア語は足さない（4ブロック不変）。

### D6b: 最終日写真の追加CTA（`goals.js` レポート）
③ の目立つ位置に **「最終日（Day30）の写真を追加」** のアップロード枠（ファイル選択＋貼り付け＋ドロップ）を出す。取得した画像を D3 で縮小 → `POST …/journal/:end_day/images` → ③（と④のDay30）を再描画。**完走後でも D4b により保存できる**。CTA は常時表示（＝いつでも撮り足せる）だが、After 側が既に十分あるときは控えめ表示でもよい（実装時判断）。デモモードは閲覧専用なので CTA を出さない。

### D7: 画像の追加導線は2か所（作成フォーム＋日記コーナー）
- **作成フォーム（`goals.js` `openCreateForm`）**：目標未作成で `goalId` が無いため、選んだ画像を **クライアントにステージ**（`{ dataUrl, caption }` の配列・プレビューは `data:`）。作成成功後、`start_day`（Day1）へ各画像を順に `POST` する。キャプションは作成前に編集可。1枚も無くても作成できる（任意）。
- **日記コーナー（`reflection.js` `journalCorner`）**：従来どおり対象日へ即時 `POST/PATCH/DELETE`。**進行中の対象日**に出す（コーナー自体が active 目標×対象日で構築されるため）。本文の dirty/flush とは独立（`reflection_done` 非汚染）。
- どちらの導線も共通の縮小（D3）と `attachImages` を使う。バイナリ表示はエンドポイント URL（後始末不要）。

### D8: デモモードにも画像を載せる（`demo-seed` / `demo.ts`）
デモの読み取り専用ツアーで ③④ の画像が見えるよう、`demo-seed` の完走目標に **サンプル画像 BLOB**（キャプション別・初日/中間/最終日）を投入する。デモ report にも `reportImages`／`days[i].images` を載せ、`GET /api/demo/goals/:id/journal/images/:imageId` でバイナリを返す。これで実機確認をデモで完結できる（[[verify-goal-features-via-demo-mode]]）。書込導線・CTA はデモでは出さない（閲覧専用）。

### D9: `api.js` 追加
`listGoalJournalImages(id,date)` / `addGoalJournalImage(id,date,{dataUrl,caption})` / `updateGoalJournalImageCaption(id,imageId,caption)` / `deleteGoalJournalImage(id,imageId)`。バイナリ表示は URL 直指定（`/api/goals/${id}/journal/images/${imageId}`）で `req()` は通さない。**実装済み**。

## Risks / Trade-offs

- **DB 肥大**：画像を BLOB で持つため DB が育つ。→ D3 のクライアント縮小（長辺1600/JPEG）＋ D2 のサイズ上限で抑制。個人・少数枚では実害小。将来大量化すればファイル外出しへ移行可能（テーブルにパス列を足す加算的移行で対応でき、今 BLOB を選んでも詰まない）。
- **base64 オーバーヘッド**：転送・メモリで ~33% 増。少数・縮小済みなら許容。取得はバイナリ経路なので表示は等倍。
- **キャプション一致グループ化の取りこぼし**：表記ゆれ（「台所」「キッチン」）は別グループになり最古/最新が分かれる。→ 仕様どおり正直に出す（誤グループより安全）。キャプション・サジェストは将来拡張。
- **いつでも書込＝正直さは自己管理**：完走後にも画像を足せる（Day30 の After を後から撮れる利便を優先）。ローカル単独アプリなので担保は設けない。画像＝レポートの証拠づくり／本文＝当日の記録、と役割が違うため、日記本文の「進行中のみ」とは規則を分ける。
- **回転・色**：スマホ写真の EXIF 回転は canvas で最小対応。厳密な色再現・HEIC 対応は非対象（ブラウザが読める形式に限る）。

## Open Questions

- **CTA の出し分け**：最終日写真の追加CTAを常時目立たせるか、After 側が十分あるときは控えめにするか（実装時に見え方で調整）。
- **キャプション・サジェスト**：新規画像のキャプション入力に、その目標の既存キャプションを候補表示してグループ成立率を上げるか（将来 UX 拡張）。
- **サイズ上限・縮小値の具体**：長辺1600/JPEG q0.85/上限5MB は初期値。実機の見え方・容量で微調整（design の値は目安、細部は実装時に確定）。
