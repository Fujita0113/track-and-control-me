## 1. サーバ: 未来日の拒否

- [x] 1.1 `server/src/services/kakeibo.ts` の `createEntry` に、`dayKey` が `todayKey(db)` より未来なら `KakeiboError` で拒否するチェックを追加する。
- [x] 1.2 `server/src/services/kakeibo.test.ts` に、未来日の `dayKey` で `createEntry` を呼ぶと拒否されることを確認する vitest を追加する（赤で置く）。
- [x] 1.3 同ファイルに、当日以前の任意の過去日で `createEntry` を呼ぶと成功し、その `day_key` で保存されることを確認する vitest を追加する（既存挙動の維持を明文化。既に通る可能性が高いが、仕様として固定するために書く）。

## 2. フロント: 記録カードに買った日の入力欄を追加

- [x] 2.1 `server/static/js/kakeibo.js` の `renderEntryCard` の `form` に `dayKey`（既定値＝`isDemo() ? DEMO_KAKEIBO_TODAY : appState.today`）を追加する。
- [x] 2.2 記録カードに `<input type="date">` の「買った日」欄を1行追加する（`kb-field-row` の並びに合わせる。位置はカテゴリ欄の上、または内訳欄の近くなど記録カードの流れに合わせて実装時に決める）。`max` 属性に当日の作業日を設定し、未来日を選べないようにする。
- [x] 2.3 `submitEntry` の送信データを `dayKey: isDemo() ? DEMO_KAKEIBO_TODAY : appState.today` 固定から、`form.dayKey`（未入力時は当日にフォールバック）を使うよう変更する。予定出費の記録（`form._plannedExpenseId` がある場合の `recordPlannedExpense`）も同じ `dayKey` を使う。
- [x] 2.4 サーバが未来日を拒否したときのエラーメッセージがトーストに表示されることを確認する（既存の `KakeiboError` → トースト表示の経路を流用、コード変更不要なら確認のみ）。実装調査の結果、記録カードの保存ハンドラには元々 catch が無く、サーバ拒否時にトーストが出ない欠落があったため、`saveBtn` のクリックハンドラに try/catch とトースト表示を追加した（bulk entry モーダルと同じパターン）。

## 3. デモモードでの確認（プロジェクトルール: 日数が関わる機能はデモモードで成果を明示）

- [x] 3.1 `PORT=<空きポート> DB_PATH=:memory: npm run server` を起動し、`POST /api/demo/reset` 後、記録カードで過去日（デモの当日より前の日）を選んで記録 → `GET /api/kakeibo/history?month=...` でその日付のレコードとして現れることを確認する。実施: デモ当日 2026-08-13 に対し 2026-08-03 で `POST /api/kakeibo/entries` → 履歴にその日付で出現を確認。
- [x] 3.2 デモの当日より未来の日付を指定して `POST /api/kakeibo/entries` を直接叩き、拒否されることを確認する。実施: 2099-12-31 を指定 → 400 `{"error":"未来の日付には記録できません"}`。あわせて `recordPlannedExpense` 経由（予定出費の将来の次回日 2026-08-25）は引き続き成功することも確認（allowFutureDay の意図どおり）。

## 4. E2E

- [x] 4.1 既存 e2e への影響: `e2e/kakeibo-tab.spec.ts` の「記録する → ホームの1日平均・月末予想・折れ線がその場で新しい値になる」ほか、記録フォームを操作するテストは日付欄を触らないため、既定値（当日）のままで従来どおり通ることを確認する（変更不要。触るの禁止なので実際に触らない）。実施: 変更前の7件を `CI=1 npx playwright test e2e/kakeibo-tab.spec.ts` で実行し全件緑を確認。既存 e2e ファイルへの diff は今回追加した新規テスト以外に無い。
- [x] 4.2 新規 e2e: 「記録カードで買った日を過去日に変えて記録する → 履歴のその日の位置に現れ、当月の合計に反映される」を `e2e/kakeibo-tab.spec.ts` に追加（issue #102）。`git stash push -- server/ extension/ packages/` で実装を退避した状態で `CI=1 npx playwright test` を実行し `input[aria-label="買った日"]` が見つからずタイムアウトで赤落ちすることを確認 → stash を戻して緑になることを確認（red-proof 完了）。8件全体も再実行し全件緑。

## 5. Spec 同期

- [x] 5.1 実装・テストが緑になったら `/opsx:archive` で `openspec/specs/kakeibo-ledger/spec.md` に delta を sync し、アーカイブする。
