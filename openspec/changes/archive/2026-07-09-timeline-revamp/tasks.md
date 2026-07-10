## 1. 契約（packages/contract）

- [x] 1.1 `DEFAULTS.AWAY_MIN_SECONDS: 600` を追加する
- [x] 1.2 WS `welcome` メッセージスキーマに `awayMinSeconds`（optional number）を追加し、後方互換であることを既存テストで担保する（`index.test.ts` 更新）

## 2. サーバー: 閾値の一元化（design D2）

- [x] 2.1 `server/src/db/migrations.ts` に `app_config.away_min_seconds INTEGER NOT NULL DEFAULT 600` を追加（既存 DB への ALTER TABLE を含む既存マイグレーション慣行に従う）
- [x] 2.2 `server/src/db/index.ts` の config 型・`getConfig` に `away_min_seconds` を追加する
- [x] 2.3 `server/src/services/timeline.ts` の `computeGaps` を 300s 固定から `cfg.away_min_seconds` 参照へ変更し、`getTimeline` から閾値を渡す
- [x] 2.4 `server/src/api/index.ts` の設定 API 許可キーに `away_min_seconds` を追加する
- [x] 2.5 `server/src/ingest/ws.ts` の `welcome` 送信に `awayMinSeconds`（現在の config 値）を含める
- [x] 2.6 タイムライン service のテストを更新・追加する（閾値未満のギャップが返らない／閾値変更が反映される）

## 3. フロント: ラン描画（design D1, D3–D6 / spec timeline-run-view）

- [x] 3.1 `timeline.js` にラン結合の純関数を実装する（同一 stableGroupId・間隔 < 閾値・間隙に他ブロック非重畳の両条件、`segments`/`innerGaps`/`creditedMs` 合計/`coactiveKeys` 和集合を持つラン構造体を返す）
- [x] 3.2 `boundaryMinutes()`・ガターの境界目盛りラベル・レーンの境界破線を削除し、ガターを正時ラベルのみにする
- [x] 3.3 ラン単位のブロック描画に置き換える（タイトル・`HH:MM – HH:MM` を1回表示、「・同時n」サフィックス削除）
- [x] 3.4 ラン内部の `innerGaps` をハッチスライスとして描画する（最低高さ 4px、高さ ≥16px でラベル「離席 n分」、未満は title ツールチップ）＋ `app.css` にハッチ様式を追加
- [x] 3.5 詳細ポップオーバーを拡張する（スパン、実働クレジット `fmtDur(creditedMs)`、同時オープングループ名一覧と均等割注記、離席内訳リスト）
- [x] 3.6 `layout()` に前回カラム優先の first-fit を実装する（stableGroupId → 直前クラスタのカラム index マップ、衝突時のみ first-fit）
- [x] 3.7 `gapContaining()` がラン全スパン（ハッチ含む）を占有として扱うことを確認・修正する

## 4. フロント: ゴーストスロットとディープリンク（design D8–D9 / spec timeline-gap-recording）

- [x] 4.1 `tl.gaps` を「＋ 未記録 HH:MM–HH:MM（n分）」のゴーストスロットとして描画する（破線アウトライン、`mousedown` は stopPropagation）＋ CSS 追加
- [x] 4.2 ゴーストクリックで `openDraft(start, end)` を区間プリフィルで開く（確定は既存 `addManual` のまま）
- [x] 4.3 `main.js` に最小限のハッシュ対応を追加する（`#timeline` で始まる場合に timeline タブを activate）
- [x] 4.4 `timeline.js` の `show()` で `from`/`to` パラメータを消費する（from から表示日を導出、記録ポップオーバーを自動オープン、`history.replaceState` でパラメータ除去）
- [x] 4.5 ヒント文言・凡例をゴースト前提に更新する（ドラッグは補助操作としての案内に変更）
- [x] 4.6 `settings.js` に閾値の設定項目を追加する（分単位で表示・編集、保存は秒）

## 5. 拡張: 復帰通知（design D7 / spec away-return-prompt）

- [x] 5.1 `extension/manifest.json` の `permissions` に `"notifications"` を追加する
- [x] 5.2 `ws-client.ts` で `welcome.awayMinSeconds` を受領して `chrome.storage.local` に保存し、取得ヘルパ（未受領時 `DEFAULTS.AWAY_MIN_SECONDS`）を追加する
- [x] 5.3 `state.ts` の `Snapshot` に `lastAwayNotifiedTs` を追加する
- [x] 5.4 `sw.ts` に復帰判定を実装する（`emitSample` 内で prev.idleState≠active → active 遷移、`now - prev.lastActiveTs ≥ 閾値` で通知。`lastAwayNotifiedTs` で同一区間の重複を抑止）
- [x] 5.5 `bootstrap()` / `onStartup` にスリープ・再起動復帰の同判定を追加する
- [x] 5.6 通知の生成とクリックハンドラを実装する（時間帯・分数の本文、クリックで `http://127.0.0.1:${wsPort}/#timeline?from=&to=` を `chrome.tabs.create`）

## 6. 検証

- [x] 6.1 `npm run typecheck` と `npm test` が全ワークスペースで通る
- [x] 6.2 手動確認: ラン結合（微小離席で結合／他グループ・MANUAL 挟みで非結合／閾値以上で非結合）、ハッチ表示と詳細ポップオーバーの内訳
  - スクショで確認: 面接 10:47–11:22 が1ランに結合＋ハッチ表示。閾値を300sへ下げると6分ギャップがラン結合対象から外れ独立ゴースト化（非結合）を API で確認。詳細ポップオーバー内訳は実装済み（クリックで表示）。
- [x] 6.3 スクリーンショット確認（headless Chrome + CDP、shot2.mjs 方式）: 実データ日のタイムラインを撮影し、spec の視覚要件（ガター正時のみ・ラン1タイトル・「・同時n」非表示・ハッチ視認・ゴースト表示・カラム位置の安定）を画像で検証する
  - headless Chrome で撮影し6要件すべて画像で確認済み。
- [x] 6.4 手動確認: ゴースト表示→ワンクリック記録→MANUAL ブロック化、空き領域ドラッグの存置、設定変更（閾値）の反映
  - ゴースト（昼食 12:42–13:05）を記録→グレー MANUAL ブロック＋自己申告バッジに置換をスクショで確認。閾値変更の反映を API で確認。ドラッグ経路はコード存置。
- [ ] 6.5 手動確認: 閾値以上の離席復帰で通知1回→クリックでプリフィル済みポップオーバー、閾値未満で通知なし、サーバー停止中の復帰→再開後にゴーストで回収
  - 自動検証済み: 通知クリック相当のディープリンク `#timeline?from=&to=` で記録ドラフトが区間プリフィルで自動オープン（スクショ確認）／サーバー停止中の未カバー区間はゴーストで回収可能（設計・スクショで確認）／拡張は typecheck・bundle 成功。
  - 要ユーザー手動確認: 実ブラウザに拡張をロードし、実際の idle→active 復帰で OS 通知が1回発火する／閾値未満で発火しないこと（OS 通知の発火は headless で自動化不可）。
