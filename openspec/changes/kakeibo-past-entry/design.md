## Context

記録カード（`server/static/js/kakeibo.js` の `renderEntryCard` / `submitEntry`）は `dayKey` を常に `appState.today`（デモ中は `DEMO_KAKEIBO_TODAY`）に固定して `POST /api/kakeibo/entries` へ送っている。バックエンドの `createEntry`（`server/src/services/kakeibo.ts`）は `dayKey` を素通しで受け取るだけで、範囲チェックを行っていない。

一方、「未記録期間の一括入力」（`kakeibo-history.js` の `openBulkEntryModal`、`POST /api/kakeibo/entries/bulk`）はすでに `<input type="date">` で期間を選ばせている。今回はこれと同じ UI 部品を、通常の記録カードにも1つ追加する。

解錠ゲート（spec: kakeibo-gate）は「家計簿に今日の記録がある」を評価対象日の作業日ごとに判定する。過去日の評価結果は既に確定済みで、家計簿の記録追加・修正では書き換えない、という制約が spec の Purpose に明記されている。

## Goals / Non-Goals

**Goals:**
- 記録カードで買った日を選べるようにする（既定＝当日、選択可能範囲＝当日以前）。
- 選んだ日で `dayKey` を送信し、履歴・分析にその日の記録として現れる。
- 未来日は選べない（UI 側で範囲制限、サーバ側でも拒否）。

**Non-Goals:**
- 保存済みレコードの買った日を後から修正する機能（今回は新規作成時のみ）。
- 「未記録期間の一括入力」の仕様変更（内訳の追加など）。
- 過去日に記録したことで解錠ゲートの過去日評価を再計算・書き換えること（spec: kakeibo-gate の凍結を維持。今回はゲート側のコードには触れない）。
- 選択可能な過去日の下限（何日前まで、何ヶ月前まで等）を設けること。当日以前であれば無制限に許可する。

## Decisions

### 買った日は `<input type="date">` を記録カードに1つ追加する

「未記録期間の一括入力」と同じ部品（ネイティブの日付ピッカー）を使う。新しい日付ピッカー UI を自作しない。既定値は当日の作業日（`appState.today` / デモ中は `DEMO_KAKEIBO_TODAY`）。

代替案として検討した「常に当日固定のまま、まとめ登録を拡張して内訳を持たせる」は、まとめ登録が「重要度を持たない」という凍結済みの spec（kakeibo-ledger の「まとめ登録に重要度を求めない」）と衝突するため採らない。役割を分けたまま、通常の記録に日付選択を足す方が既存仕様と整合する。

### 未来日の拒否はサーバ側でも行う（UI の `max` 属性だけに頼らない）

`<input type="date" max="...">` はブラウザの UI 制約に過ぎず、直接 POST すれば回避できる。`createEntry`（`server/src/services/kakeibo.ts`）に「`dayKey` は当日の作業日以前」の検証を追加し、`KakeiboError` で拒否する。判定基準の「当日」は `todayKey(db)` を使う（API 層 `server/src/api/kakeibo.ts` の `createEntry` 呼び出しに渡す）。

これにより `createEntry` は `db` から作業日を取れる必要がある。呼び出しは既に `db` を持っているため、シグネチャ変更は関数内部で `todayKey(db)` を呼ぶだけで済む。

### `createEntry` は `recordPlannedExpense`（kakeibo-budget）からも呼ばれるため、未来日チェックにオプトアウトを設ける

実装中に判明: `createEntry` は本変更の対象である記録カード（`POST /api/kakeibo/entries`）だけでなく、予定出費のチップ記録（`server/src/services/kakeibo-budget.ts` の `recordPlannedExpense` → `POST /api/kakeibo/planned-expenses/:id/record`）からも呼ばれている。既存の `kakeibo-budget.test.ts`（「記録すると実績が作られ、次回が周期ぶん進む」）は、予定出費の次回予定日（将来日でありうる）をそのまま `dayKey` として記録する既存の正しい挙動を検証しており、これは kakeibo-budget の仕様であって今回の変更対象（kakeibo-ledger の記録カード）ではない。

`createEntry` に第三引数 `opts: { allowFutureDay?: boolean }` を追加し、既定は未来日チェックを行う（記録カードの通常呼び出しはそのまま）。`recordPlannedExpense` だけ `{ allowFutureDay: true }` を渡してチェックを外す。これにより:
- kakeibo-ledger の凍結シナリオ（未来日は選べない）は `createEntry` 単体呼び出しで引き続き満たされる。
- kakeibo-budget の予定出費記録（将来日を許す既存仕様）は変更しない。

### バックエンドの `dayKey` 受け口・レスポンスは変更しない

`createEntry` は既に任意の `dayKey` 文字列を受け付けて保存する。追加するのは「未来日なら拒否」の1チェックのみで、フォーマットや月ナビゲーション・分析側の集計ロジックは変更しない（`listEntries` は `day_key LIKE monthKey%` で月単位に拾っており、過去月の日付を持つレコードもそのまま正しく拾える）。

### レシート・内訳・カテゴリ・重要度の入力欄は変更しない

日付以外の項目は今まで通り。買った日の入力欄は既存の `kb-field-row` の並びに1行追加するだけで、レイアウト上の他の変更はしない。

## Risks / Trade-offs

- [Risk] 過去日を選べるようになったことで、ユーザーが誤って別の日を選んで記録してしまう可能性がある → Mitigation: 既定値は当日のまま、明示的に日付欄を操作しない限り今まで通りの挙動になる。修正は既存の「後から修正できる」項目（金額・名称・カテゴリ・重要度・計算対象・内訳・レシート）で対応可能な範囲に留め、買った日の事後修正は本変更のスコープ外として明記する。
- [Risk] 過去日の記録追加が解錠ゲートの過去日評価を意図せず書き換える → Mitigation: ゲート側のコード・spec には一切触れない。`isKakeiboRecorded` は「その日にレコードが1件でもあるか」を都度評価するだけの関数で、過去日の確定済み評価結果を保存・参照する仕組みは別レイヤ（rules 評価エンジン側）にあるため、家計簿側の変更はそこに影響しない。念のため spec の Purpose 文の凍結記述はそのまま残し、変更しない。

## Open Questions

（無し）
