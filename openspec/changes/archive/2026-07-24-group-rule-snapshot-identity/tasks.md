## 1. identity レジストリ（DB とサービス）

- [x] 1.1 `migrations.ts` に新版を追加: `group_identity`（id / name / color / created_at / last_seen_at）と `group_identity_alias`（name / color / identity_id / since、`(name,color)` UNIQUE）を作成する
- [x] 1.2 同マイグレーションで、既存 `session` の distinct `(tab_group_name_snapshot, group_color_snapshot)`（空名・`ungrouped` を除く）から identity と別名を初期構築する（既存行は書き換えない）
- [x] 1.3 `rule_condition` に `group_identity_id INTEGER` を追加する（既存 `stable_group_id` 列は残す）
- [x] 1.4 `services/group-identity.ts` を新規作成: `resolveIdentity(db, name, color)`（未知なら作成）・`listAliases(db, identityId)`・`getIdentity(db, id)`・`renameIdentity(db, from, to)`（統合を含む）
- [x] 1.5 `resolveIdentity` の単体テスト: 同名同色は同一 identity／別名色は別 identity／空名と `ungrouped` は identity を作らない
- [x] 1.6 ingest 経路（`ingest.ts` / `recompute.ts`）でセッション確定時に identity を解決・`last_seen_at` を更新する
- [x] 1.7 `listRecentGroupIdentities(db, days=30)` を実装（合計時間降順・60秒未満を除外）し、`GET /api/groups/recent` を追加する

## 2. GROUP ルール条件の identity 化

- [x] 2.1 `rules/rules.ts` の条件の保存・読み出しを `group_identity_id` 対応にし、`condition_key='group:<identityId>'` を生成する
- [x] 2.2 `rules/evaluate.ts` の `GROUP` 分岐を、identity の別名すべてに一致する `session.credited_ms` 合算へ変更する
- [x] 2.3 `group_identity_id` を持たない旧条件は従来の `daily_totals_snapshot` 合算のまま評価する後方互換分岐を残す
- [x] 2.4 `evaluate` のテスト: 内訳の秒数と `GROUP` 条件の実績秒が一致する／別名（改名前）区間が合算される／別グループの時間では解錠されない／旧 `group:<uuid>` 条件の判定が移行前後で不変
- [x] 2.5 `ConditionResult` に `groupName` / `groupColor`（identity の現在値）を載せ、UI が UUID を触らずに描画できるようにする
- [x] 2.6 `services/goals.ts` の実践採用・レポートを identity 参照に対応させる（`group:<identityId>`・ラベルスナップショット保存）

## 3. 表示（内訳・タイムライン・ゲート）

- [x] 3.1 `summary.ts` の `snapshotIdentityKey` を identity 解決へ置き換え、内訳のキー・ラベル・色を identity の現在値にする（未グループは従来どおり単一キー）
- [x] 3.2 `rangeSummary`（直近7日）も identity 単位・現在名にする
- [x] 3.3 `timeline.ts` の AUTO ブロック束ね・ラン結合・`coactive` 解決を identity 単位へ変更する
- [x] 3.4 `day-allocation.ts`（配分バー）の identity キーを揃える
- [x] 3.5 `static/js/today.js`: `GROUP` 条件を「グループ: <現在名>」＋色チップで表示する（UUID を出さない）。旧条件は「（要再設定）」を添える
- [x] 3.6 `static/js/today.js`: `TIMELINE` 条件を「<カテゴリ> ◯分以上」＋「実績 / 閾値」で表示する
- [x] 3.7 `static/js/rules.js`: 条件テキストの `GROUP` 表示を現在名にし、グループピッカーを `/api/groups/recent` 由来へ差し替える
- [x] 3.8 `static/js/goals.js`: 実践ラベルの `GROUP` 表示を現在名にする（インライン作成のグループ選択も `/api/groups/recent`）
- [x] 3.9 既存テスト（`today-group-breakdown` / `timeline` / `day-allocation` 系）を identity 単位の期待値へ更新する

## 4. 改名検出（拡張機能）

- [x] 4.1 `packages/contract`: `GROUP_RENAMED` を `EventTypeSchema` に追加し、`GroupRenameMessage`（`{type:'groupRename', from:{name,color}, to:{name,color}, at}`）を `ClientMessage` へ追加する
- [x] 4.2 `extension/src/groups.ts`: `byGroupId` の値を `{stableId, title, color}` に拡張し、`onGroupUpserted` で直前値と比較して改名候補を検出する（直前 title が空なら改名としない）
- [x] 4.3 改名候補を `chrome.storage` に保留し、静止5秒のデバウンス後に送出する。SW 停止をまたぐ場合は次回ウェイク（`bootstrap`）でフラッシュする
- [x] 4.4 `ws-client.ts` に `sendGroupRename` を追加し、`sw.ts` で配線する
- [x] 4.5 拡張側テスト: 入力途中の連続更新から改名イベントが1件だけ出る／新規命名では出ない／保留がウェイク時にフラッシュされる（`extension/src/groups.test.ts` を新設・vitest include に `extension/src/**/*.test.ts` を追加）

## 5. 改名の適用（サーバー）

- [x] 5.1 WS ハンドラで `groupRename` を受け、`renameIdentity` を 1 トランザクションで実行する（現在名更新・旧名を別名として保持・新名を別名登録・必要なら統合）
- [x] 5.2 統合時に `rule_condition.group_identity_id` と `goal_practice` の参照を残す側へ付け替える
- [x] 5.3 `goal_practice.label_snapshot` を新名へ更新する
- [x] 5.4 テスト: 改名当日の旧名区間が `GROUP` 条件に合算され進捗が巻き戻らない／凍結済みルールの条件集合・閾値・`condition_key` が変わらない／既存名への改名で統合される

## 6. 拡張機能の採番を固める

- [x] 6.1 `groups.ts`: 空タイトル時に identity フォールバックを引かない・書かない挙動をテストで固定する（既存の `hasMeaningfulTitle` ガードを維持しつつ回帰テストを追加）
- [x] 6.2 `gatherState` に「同一解決パス内で `stableGroupId` が重複しない」不変条件を実装する（重複時は `groupId` が大きい方を再採番）
- [x] 6.3 `GROUP_MAP_SCHEMA_VERSION` を 3 へ上げ、汚染済みマップを強制クリアする
- [x] 6.4 単体テスト: 無題グループ2つが別 ID になる／重複解決が再採番で解消される／版数 2 のマップが消去される
- [x] 6.5 `manifest.json` の version を上げ、サーバーに最小要求版の定数を追加し、古い `extVersion` を受けたらダッシュボードへ警告バナーを出す
- [x] 6.6 `npm run build:contract && npm run build:ext` を実行し、`edge://extensions` で拡張を再読み込みする手順を README（またはトップレベルの運用メモ）へ記載する（`OPERATIONS.md` を新設）

## 7. デモモードと検証

- [x] 7.1 `demo-seed.ts` に identity 行・別名行を焼き込み、`GROUP` 実践を identity 参照へ更新する（デモに既存の GROUP 実践は無いため、配分バー/タイムライン seed 全セッションを `resolveIdentity` 経由に統一）
- [x] 7.2 改名の筋書き（既存の谷日に寄せる）をデモへ追加し、「改名しても進捗が続く」ことを再現できるようにする（`DEMO_ALLOC_DAY` 17:00-18:00「英会話→英語」の登録済み改名）
- [x] 7.3 `demo.test.ts` の期待値（実践数・達成日数など）を更新する
- [x] 7.4 `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動し、`POST /api/demo/reset` → `GET /api/demo/goals/:id/report?now=<完走後の day_key>` で集計経路を通して確認する（達成 24/30 維持・`/api/demo/timeline/:date/allocation` と `/api/demo/today` で「英語」60分合算・「執筆/調査」分離を実サーバー経由で確認）
- [ ] 7.5 実 DB（`server/data/track.sqlite`）に対してマイグレーションを適用し、既存の内訳・タイムラインが壊れていないこと、旧 `group:<uuid>` 条件が「要再設定」で表示されることを確認する
- [ ] 7.6 拡張を再読み込みしたうえで新規タブグループを2つ作り、`openGroupKeys` の `stableGroupId` が別々になることを実データで確認する
- [ ] 7.7 実グループを改名し、ゲート画面の条件名が新名になり進捗が維持されること、過去日の内訳も新名で表示されることを確認する
- [x] 7.8 `npm run typecheck && npm test` を通す（全ワークスペース: typecheck OK・381 tests passed）
