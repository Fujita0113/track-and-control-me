## 0. 凍結ラインの申し送り

**この change は5巡目で作り直した**。issue #94 のコメント（「複雑なロジック組みすぎた」）を受けて
日数モデルを全部落とし、予想は「日々の出費 ÷ 経過日数 × 月の日数」の一本になった。
4巡目までの実装（作業ツリーに残っている）は**大半が削除対象**である。

**propose が凍結したもの（apply は触るの禁止）**:

- delta spec 7本（`kakeibo-ledger` / `kakeibo-forecast` / `kakeibo-budget` / `kakeibo-analysis` /
  `kakeibo-gate` / `kanban-rule-conditions` / `demo-mode`）。`kakeibo-day-rate` は**廃止**した
- **vitest 4本**（赤で置き直した）:
  `kakeibo.test.ts` / `kakeibo-forecast.test.ts` / `kakeibo-budget.test.ts` / `kakeibo-analysis.test.ts`

**現状**: `kakeibo.test.ts` / `kakeibo-forecast.test.ts` / `kakeibo-analysis.test.ts` が赤、
`kakeibo-budget.test.ts` は緑（予算は日数モデルに依存していなかった）。
**この4本が緑になることが実装完了の最低条件**。

このテストが固定している契約（design の関数名と一致させること）:

| 関数 | 置き場所 | 何を固定したか |
|---|---|---|
| `createEntry(db, input)` | `kakeibo.ts` | 金額は正の整数 / 未知 enum は `KakeiboError` / `detail` と `isSpecial` は任意・既定は NULL と 0 / **日数の列を持たない** |
| `listEntries(db, monthKey)` | `kakeibo.ts` | その月だけ・買った日の降順 |
| `suggestNames(db, prefix)` | `kakeibo.ts` | 直近使用順・部分一致・空名称は出さない |
| `updateEntry(db, id, patch)` | `kakeibo.ts` | 金額・名称・カテゴリ・重要度・`isSpecial`・`detail`・レシートの後追い修正 |
| `createBulkEntry(db, {from,to,amount})` | `kakeibo.ts` | `name=''` / `importance=null` / `category='NONE'` / `day_key = from` / 逆転期間は拒否 |
| `isSpecialEntry(entry)` | `kakeibo.ts`（純関数） | `category==='SUDDEN' \|\| is_special===1`。**自動判定は保存しない**（カテゴリを直すと追随する） |
| `isKakeiboRecorded` / `declareZeroDay` | `kakeibo.ts` | 記録1件以上 OR 0円宣言。宣言は台帳に出ない・重複しない |
| `forecastMonth(db, month, today, overrides?)` | `kakeibo-forecast.ts` | `fixedYen`/`variableActualYen`/`actualYen`/`specialYen`/`dailyPoolYen`/`elapsedDays`/`remainingDays`/`dailyAverageYen`/`forecastYen`/`plannedYen`/`landingYen`/`capYen`/`overYen`/`crossDayKey`/`series`。`overrides` は名称→特別費の**保存しない**上書き |
| `listAdjustRows(db, month, today)` | `kakeibo-forecast.ts` | 名称ごとに `amountYen`・`count`・`isSpecial`・`auto`。金額の降順 |
| `weeklyRemaining(db, dayKey)` | `kakeibo-forecast.ts` | 月曜始まり・残り日数は今日を含む・`perDayYen` は `floor10` |
| `wasteSummary(db, month)` | `kakeibo-forecast.ts` | `totalYen`/`capYen`/`overYen`/`ratioPct`（**四捨五入**）/`rows`（名称ごと・降順・`count`） |
| `wasteReductionEffect(db, month, today)` | `kakeibo-forecast.ts` | `reducibleYen`/`overNowYen`/`overAfterYen`。上限内なら `reducibleYen=0` |
| `getBudget` / `setBudget` / `budgetDerived` | `kakeibo-budget.ts` | 変更なし（緑のまま保つこと） |
| `listFixedCosts` / `upsertFixedCost` / `deleteFixedCost` / `importFixedCostsFromPrevMonth` | `kakeibo-budget.ts` | 変更なし |
| `listPlannedExpenses` / `upsertPlannedExpense` / `recordPlannedExpense` | `kakeibo-budget.ts` | 変更なし |
| `importanceBreakdown(db, month)` | `kakeibo-analysis.ts` | `must`/`semi`/`waste`/`noDetail`。**特別費も帯には入る** |
| `categoryTree(db, month)` | `kakeibo-analysis.ts` | 明細は `has_detail` と `has_receipt` の両方を持つ（押下可否の判定に使う） |
| `resolvePlanningSignal(db, day, 'kakeibo_recorded')` | `planning.ts`（既存を拡張） | 新シグナル |

**削除された契約**（4巡目の実装に残っているので落とすこと）:
`pendingConfirmation` / `confirmActualDays` / `entryState` / `monthCoverage` / `dayRateFor` /
`getForecastBasis` / `setForecastBasis` / `listForecastSources` / `kakeibo_forecast_basis` テーブル /
`kakeibo_entry` の `planned_days`・`actual_days`・`covers_from`。

**変更した既存 e2e（2本・apply は触るの禁止）**:

- `e2e/shortcut-hints.spec.ts` … タブが6本になり `5`→家計簿 / `6`→設定 になる。
  **現在このテストは赤**（`#screen-kakeibo` が無い）。実装したら緑になること。
- `e2e/screenshots.spec.ts` … `TABS` に `kakeibo` を足した。アサーション無しなので今も緑。

4巡目の apply が書いた `e2e/kakeibo-tab.spec.ts` は**削除した**（確定1問・基準切替という消えたフローを
検査していたため）。新規 e2e は apply が DOM を作ってから書き直す。

**apply が最後に書く新規 e2e が覆うべきフロー**（セレクタではなくフローで指定する）:

1. 「記録する → ホームの1日平均・月末予想・折れ線がその場で新しい値になる」
2. 「履歴の行で『特別費（除外）』を選ぶ → 1日平均が下がり、月末予想と上限超過日が変わる」
3. 「ホームの『予想の計算内訳・調整』で切り替える → 4つの数字が同時に出し直され、`キャンセル` では保存されていない」
4. 「内訳だけ書いて記録する → 履歴の行からも分析の明細からも同じ明細が開いて内訳が読め、内訳もレシートも無い行は押せない」
5. 「未記録期間を一括入力する → 履歴に `内訳未入力` で並び、分析の重要度の帯にその区画が出る」
6. 「今日タブの家計簿の条件で『0円だった』を押す → 条件が達成に変わり、履歴には何も増えていない」
7. 「予算で月の上限を変える → ホームの上限線・週の目標・上限超過日が追随する」

---

## 1. 4巡目の実装を落とす

- [ ] 1.1 `kakeibo.ts` から `pendingConfirmation` / `confirmActualDays` / `entryState` /
      `monthCoverage` と、`createEntry` の `confirm` 同梱経路を削除する
- [ ] 1.2 `kakeibo-forecast.ts` から `dayRateFor` / `getForecastBasis` / `setForecastBasis` /
      `listForecastSources` と4種の source 分岐を削除する
- [ ] 1.3 `api/kakeibo.ts` から `GET /entries/pending` / `PUT /basis/:name` /
      `GET /basis/:name/preview` / `GET /day-edit` を削除する
- [ ] 1.4 フロントから確定1問モーダル・基準モーダル・もつ日数の入力（`kakeibo.js`）、
      カバー期間の帯・日数の一括編集ビュー・3状態バッジ（`kakeibo-history.js`）を削除する
- [ ] 1.5 `app.css` から使われなくなった `kb-` 部品を落とす。**1ルール1行の書式を守り、
      フォーマッタをファイル全体にかけない**（プロジェクトルール）。`git diff --stat` の桁を確認する

## 2. スキーマ（v30 を最終形に書き換える）

- [ ] 2.1 マイグレーション v30 を**6本**に直す。`kakeibo_entry` から `planned_days` /
      `actual_days` / `covers_from` を外し、`is_special INTEGER NOT NULL DEFAULT 0` と
      `detail TEXT` を足す。`kakeibo_forecast_basis` テーブルを削除する（design D1）
- [ ] 2.2 既存テーブルへの `ALTER` を**1つも書かない**ことを確認する
- [ ] 2.3 **旧 v30 を適用済みのローカル開発 DB を作り直す**（`user_version` は昇順でしか
      流れないので同じ v30 の書き換えは再実行されない・design Migration Plan）
- [ ] 2.4 `packages/contract` の家計簿スキーマを直す。基準4値の enum を落とし、
      `detail` と `isSpecial` を足す。`npm run build -w @track/contract` 相当が通ること

## 3. 台帳（`kakeibo.ts`）

- [ ] 3.1 `createEntry` / `updateEntry` を `detail`・`isSpecial` 対応にする
- [ ] 3.2 `isSpecialEntry(entry)` を純関数で書く。**自動判定は保存しない**（design D3）
- [ ] 3.3 `createBulkEntry` の `day_key` を `bulk_from` に合わせる（テストが固定）
- [ ] 3.4 `npx vitest run server/src/services/kakeibo.test.ts` が緑になるまで実装する。
      **テストは1行も変えない**

## 4. 予想（`kakeibo-forecast.ts`）

- [ ] 4.1 `forecastMonth` を単純按分へ書き換える。`dailyPoolYen` は `isSpecialEntry` が偽の
      レコードの合計、`dailyAverageYen = floor(pool ÷ 経過日数)`（design D2）
- [ ] 4.2 **先に切り捨ててから残り日数を掛ける**（design D6）。`series` は残り日を1日ずつ
      歩いて積む（閉じた式にしない・design D5）。`crossDayKey` は初めて上限を超える日
- [ ] 4.3 `overrides`（名称→特別費）で**保存せずに**出し直せるようにする（design D3・D14）
- [ ] 4.4 `listAdjustRows` を書く（名称ごと・金額降順・`auto` は `category==='SUDDEN'`）
- [ ] 4.5 `wasteReductionEffect` を書く（上限ぶんを抑えたときの月末超過の変化）
- [ ] 4.6 `weeklyRemaining` / `wasteSummary` は既存を活かす（`ratioPct` は四捨五入）
- [ ] 4.7 `npx vitest run server/src/services/kakeibo-forecast.test.ts` が緑になるまで実装する。
      **モックの数字（40,030 / 19,350 / 1,759 / 77,010 / 8/23 / 70,670 / 8/25）が1円も狂わないこと**

## 5. 分析（`kakeibo-analysis.ts`）

- [ ] 5.1 明細に `has_detail` を足す（`has_receipt` と並べて押下可否の判定に使う）
- [ ] 5.2 `npx vitest run server/src/services/kakeibo-analysis.test.ts` が緑になるまで実装する

## 6. API（`server/src/api/kakeibo.ts`）

- [ ] 6.1 `GET /home` の返りを `{ series, landing, summary, week, waste, plannedChips }` に直す
      （`summary` は 1日平均・特別費・予定出費・固定費の4成分）
- [ ] 6.2 `GET /forecast-adjust` と `POST /forecast-adjust/preview`（**保存しない**再計算）を足す
- [ ] 6.3 `PATCH /entries/:id` を `isSpecial`・`detail` 対応にする（履歴の二択はこれを直接叩く）
- [ ] 6.4 `GET /history` から `coverage` を落とす
- [ ] 6.5 `api.js` のクライアント関数を追随させる

## 7. ホーム

- [ ] 7.1 折れ線を全幅にする。`viewBox` は `700×300`、SVG 内の文字は 7.5–8.5
      （2カラム時代の縦長のままだと間延びする・design-notes）
- [ ] 7.2 折れ線の直下に4成分の1行サマリと `予想の計算内訳・調整 ›` ボタンを置く。
      **ここに途中式を出さない**（spec）
- [ ] 7.3 調整モーダル: 名称ごとの二択・切り替えるたびに4つの数字を出し直す
      （`preview` を叩き、`これで予想する` まで保存しない）
- [ ] 7.4 「今週の残り予算」と「今月の『無駄遣い』」のカード（抑えたときの効果を併記）
- [ ] 7.5 記録カード: 金額・名称（サジェスト）・カテゴリ・重要度・**計算対象**・**内訳**・レシート・
      予定出費チップ。もつ日数の欄は消す
- [ ] 7.6 カテゴリで「急な出費」を選んだら計算対象のトグルを自動 on ＋ 操作不可にする（design D3）
- [ ] 7.7 ショートカット `1`–`4`・`Q W E`・**`X`（特別費にする）**・`Ctrl+Enter` に
      **`attachTooltip` でホバーヒントを併記する**（プロジェクトルール）

## 8. 履歴

- [ ] 8.1 グラフを置かない（帯も日別の棒も無し・spec）
- [ ] 8.2 行を「左＝明細を開くボタン / 右＝二択」の2領域にする。**二択をボタンの内側に入れない**
      （button の入れ子は不正で押し分けが壊れる・design D16）
- [ ] 8.3 内訳もレシートも無い行は押せないようにする。**`[disabled]` の既定の減光を打ち消す**
      （記録が無効に見えるため・design D10）
- [ ] 8.4 急な出費の行は二択を `特別費（自動）` で選択済み＋操作不可にする
- [ ] 8.5 「未記録期間を一括入力」（`Ctrl+M`）。**重要度の欄を置かない**（spec）＋ `attachTooltip`

## 9. 明細（内訳＋レシート）

- [ ] 9.1 明細モーダルを内訳とレシートの**2面**にする。片方しか無いときは無いほうを明示する
- [ ] 9.2 履歴の行と分析の明細から**同じモーダル**が開くようにする（開くレコードのデータを差し込む）
- [ ] 9.3 内訳の修正とレシートの差し替えをここから行えるようにする

## 10. 分析と予算

- [ ] 10.1 明細の押下可否を `has_receipt` から **`has_receipt || has_detail`** へ変える
- [ ] 10.2 明細行に `内訳` / `レシート` の印を出し、内訳の先頭を薄字で1行添える
- [ ] 10.3 語彙を直す（`いらない`→`無駄遣い` / `内訳なし`→`内訳未入力` / `着地予想`→`月末予想` /
      `今週使える残り`→`今週の残り予算`）。予算タブの「無駄遣いの上限」も同じ

## 11. デモモードで成果を出す（プロジェクトルール）

- [ ] 11.1 `demo-seed.ts` の家計簿サンプルを新モデルへ直す（日数の列を焼かない・
      `detail` と `is_special` を入れる）。**固定 day_key・固定タイムスタンプ**を守る
- [ ] 11.2 サンプルは spec: demo-mode の条件を満たすこと ―
      上限超過が見えている / 急な出費が1件以上 / 内訳だけの行が1件以上 /
      内訳もレシートも無い行が1件以上 / 重要度の帯に内訳未入力の区画が出る
- [ ] 11.3 `demo.test.ts` の期待値を更新する。**既存の筋書き（達成 24/30・中盤の谷）を壊さない**
- [ ] 11.4 `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動 → `POST /api/demo/reset` →
      家計簿タブを開き、**折れ線・上限超過日・特別費の切替で動く4つの数字を目視で確認**して
      ユーザーに明示する（プロジェクトルール）

## 12. 既存 e2e の回帰確認（実装直後・ここで止める）

- [ ] 12.1 `$env:CI="1"; npx playwright test` が全部緑になることを確認する。
      とくに `shortcut-hints.spec.ts`（propose で赤にしてある）が緑へ変わること
- [ ] 12.2 `git diff -- e2e/` が **propose の2ファイル以外に差分を持たない**ことを確認する。
      落ちた既存 e2e を書き換えてはならない。**落ちた場合は停止**し、凍結ラインの
      投げ返し（1タスクにつき1回だけ）としてユーザーへ確認する

## 13. 新規 e2e（DOM ができた後に書く）

- [ ] 13.1 §0 に挙げた7フローの e2e を書く。セレクタは実装した DOM から採る
- [ ] 13.2 `git stash push -- server/ packages/` → `$env:CI="1"; npx playwright test e2e/<new-spec>.spec.ts`
      で**落ちること**を確認 → `git stash pop` → 通ることを確認する。**`CI=1` は必須**
      （無いと `reuseExistingServer` が起動済みサーバを使い回して偽の緑になる）
- [ ] 13.3 `git diff -- e2e/` に新規ファイルの追加と propose の2ファイル以外の差分が無いことを確認する

## 14. 仕上げ

- [ ] 14.1 `npm test` 全体が緑であることを確認する
- [ ] 14.2 `tsc -p server/tsconfig.json` が通ることを確認する
- [ ] 14.3 `git diff --stat` を見て、`app.css` の差分が想定より桁違いに大きくないことを確認する
      （大きければ整形が混入している・プロジェクトルール）
- [ ] 14.4 モックとの突き合わせ: `ref/kakeibo/*.png`（10枚）と実装画面を並べて、
      数字・語彙・状態表示が食い違っていないことを確認する（[[reference-impl-in-ref-dir]]）
