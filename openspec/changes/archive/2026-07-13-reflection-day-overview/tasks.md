## 1. サーバ: 一日の配分集計

- [x] 1.1 `server/src/services/` に `getDayAllocation(db, dayKey, nowMs?)` を新設。`session` を `stable_group_id` 別に `credited_ms` 合算（WORK スライス、記録時点の色・名を採用）、`activity_log_entry`(MANUAL) を `category_key` 別に `span/n` 合算（MANUAL スライス）。`timeline.js` サービスの既存ロジックを再利用する。
- [x] 1.2 端〜端を算出：`extentStart = min(全記録の開始)`、`extentEnd = max(全記録の終了, 対象日=当日なら now)`。記録ゼロなら `totalSeconds=0`・スライス空を返す。
- [x] 1.3 端〜端の内側で `computeGaps` 相当により未記録秒 `untrackedSeconds` を算出。`Σスライス秒 + untrackedSeconds == totalSeconds` を保証（丸め方針を単位秒で統一）。
- [x] 1.4 返却整形：`{ dayKey, extentStart, extentEnd, totalSeconds, slices:[{key,label,color,kind,seconds}](秒降順), untrackedSeconds }`。
- [x] 1.5 `GET /api/timeline/:date/allocation` を `server/src/api/timeline.ts` に追加（対象日パラメタ、当日 now 上限）。
- [x] 1.6 ユニットテスト：(a) 2グループ同時2h→各1h・合計2h、(b) 端〜端9hで持ち分7h＋未記録2hが母数9hに一致、(c) 先頭末尾の境界空白が母数外、(d) 記録ゼロで母数0・空スライス。

## 2. クライアント: API 配線

- [x] 2.1 `server/static/js/api.js` に `getAllocation: (date) => req('GET', ` /api/timeline/${date}/allocation `)` を追加。

## 3. 振り返りタブ: 配分ドーナツ（エディタ上部・常設）

- [x] 3.1 `reflection.js` の本文エディタカード（`rf-card`）の直上（気分ピルの下）に `rf-alloc` ドーナツ領域を追加。Chart.js（`window.Chart`）でスライス（作業＝グループ色／自己申告＝色／未記録＝中立色）を持ち分秒で描画。ツールチップは時間（h/m）表示。
- [x] 3.2 既存 `today-group-breakdown` ドーナツと役割が違うことをラベルで明示（例：「一日の配分（覚醒時間中）」）。母数0の日は円を描かず空状態メッセージ。
- [x] 3.3 Chart インスタンスを ctx に保持し、日付切替・タブ離脱で `destroy()`（多重生成・リーク防止）。

## 4. 振り返りタブ: 右オーバーレイ テキストタイムライン（トグル）

- [x] 4.1 トグルボタン `rf-tl-toggle` と `position: fixed` の右オーバーレイパネル `rf-tlpanel` を追加（`translateX` で出し入れ、既定は閉、開いても本文エディタ幅を恒久圧迫しない）。
- [x] 4.2 `GET /api/timeline/:date` の `auto/manual/gaps` を開始時刻でマージソートし、`HH:MM–HH:MM ラベル` の行リストへ整形描画。作業＝グループ名（色ドット）／自己申告＝タイトル・カテゴリ／gap＝`（未記録）`（中立色）。
- [x] 4.3 同時記録（co-active / co_record）の重なりを検出し、主ラベルへ `＋◯◯` と行内併記する。
- [x] 4.4 読み取り専用（記録・編集・削除の動線を一切持たない）。記録ゼロの日はパネルを空状態表示にする。
- [x] 4.5 パネルは開いた時のみ対象日の timeline を取得（トグルが閉じている間はフェッチしない）。

## 6. 対象日追従・破棄・スタイル

- [x] 6.1 `loadEditorForDate(date)` の末尾に `renderDayOverview(date)`（配分ドーナツの再描画＋パネルが開いていればテキストタイムライン再構築）を接続。日付入力変更・過去選択の既存動線に乗る。本文ロードとは独立に失敗を握り（`catch`）、本文編集を妨げない。
- [x] 6.2 `reflection.js` の `hide()` で Chart 破棄・パネル破棄を行う。
- [x] 6.3 `app.css` に `rf-alloc` / `rf-tl-toggle` / `rf-tlpanel` 等の `rf-*` スタイルを追加（CSSOM・インライン style 属性なし＝CSP 準拠）。ライト/ダーク・レスポンシブに配慮。

## 7. 検証

- [x] 7.1 `/verify`（またはアプリ起動）で実データの振り返りタブを開き、配分ドーナツが端〜端で閉じること・テキストタイムラインがトグルで開閉し時刻＋ラベル＋未記録行＋並行併記が読めること・日付切替で同期することを目視確認。
- [x] 7.2 タイムラインタブの記録・編集が従来どおり動く（`timeline.js` 無改修で退行なし）ことを確認。
- [x] 7.3 スクショで参照検証（[[reference-impl-in-ref-dir]] 方針）。

## 8. UI リデザイン（ユーザーフィードバック反映・design D4/D5/D6 改定）

- [x] 8.1 配分ドーナツ（Chart.js）を **横棒リスト**（純 DOM/CSS）へ変更。未記録以外は時間降順、未記録は最下部固定・中立色。`window.Chart` 依存を撤去。
- [x] 8.2 テキストタイムラインを **グラフィカル縦帯**（既存の短縮版）へ変更。左＝持続時間比例の色帯／右＝時刻＋ラベル。同時作業は斜め縞（青×紫）1本、未記録は中立帯。`buildRibbon` を新規実装（`timeline.js` は無改修）。
- [x] 8.3 連続する同一構成の細切れブロックを1つに結合（閾値未満ギャップの橋渡し）してコンパクト化。
- [x] 8.4 `app.css` の `rf-alloc-chart`/`rf-tlrow*` を `rf-bars`/`rf-seg*`（縦帯・縞）へ差し替え。
- [x] 8.5 実データで目視＋スクショ検証（バー降順・未記録最下部・縦帯の縞と結合・日付同期・退行なし・コンソールエラーなし）。

## 9. タイムラインの発見性向上（issue #17 追加フィードバック）

- [x] 9.1 トグル `rf-tl-toggle` を目立つアクセント色＋アイコン(▤)＋シェブロン(❯)へ変更（閉時=鮮やかな青CTA／開時=グレーで「閉じる」、シェブロン回転）。
- [x] 9.2 パネルを **既定オープン** にする（`panelOpen: true`＋初期 `.open`／`.on`）。閉じるのは従来どおりトグル・× で可能。
- [x] 9.3 パネルは前面に重なる **オーバーレイ** を維持（本文レイアウト不変・第3カラム化しない）。当初 9.3 で入れた本文左寄せ（`.content` margin-right ＋ `body.rf-tlpanel-open`）は「3列に見える」フィードバックで撤回し、オーバーレイに戻した（issue #17）。
- [x] 9.4 スクショ検証（既定オープン・オーバーレイ（前面重なり・非3列）・トグル開閉と配色・エラーなし）。
