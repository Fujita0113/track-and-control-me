## Context

振り返りタブの「一日の配分」バー（`reflection-day-overview`）は `getDayAllocation`（`server/src/services/day-allocation.ts`）が返す `slices` を描画する。WORK スライスは `tl.auto`（`getTimeline` が `session` から生成）を **`stable_group_id`** で束ねている（`day-allocation.ts:44-53`）。

一方、今日タブのグループ別内訳（`today-group-breakdown`）は `snapshotGroups`（`server/src/services/summary.ts:26-41`）で、**記録時点スナップショットの「名前＋色」identity** で束ねる（design D1）。具体的には SQL 側で `stable_group_id = UNGROUPED_KEY ? UNGROUPED_KEY : (tab_group_name_snapshot || '\x1f' || COALESCE(group_color_snapshot,''))` を束ね単位とし、`SUM(credited_ms)` する。

Chrome はタブグループを閉じて開き直す／別ウィンドウで作り直すと**同名同色でも新しい `stable_group_id`** を割り当てる。この結果、今日タブは同一グループを1本へ合算するのに対し、配分バーは同一グループを `stable_group_id` ごとの小片へ粉砕する。issue #47 の「振り返り(紫)が大きいはずなのに配分バーに（大きく）表示されない」はこの不整合が原因。

インメモリ DB で再現済み（振り返り 30 分×6 回・別 id）:
- `daySummary`（今日タブ）: 振り返り(紫)=3.00h（1 行）、勉強(青)=2.00h
- `getDayAllocation`（配分バー）: 勉強=2.00h が先頭、振り返りは 0.50h×6 スライスへ分裂

加えて `demo-seed.ts` は `session` / `activity_log_entry` を seed しておらず、配分バーはデモで常に空。プロジェクトルール（日数機能はデモで成果明示）を満たすためデモ seed も追加する。

## Goals / Non-Goals

**Goals:**
- 配分バーの WORK スライスの束ね方を `today-group-breakdown` と同一の「名前＋色」identity へ揃え、`stable_group_id` の入れ替わりで同一グループが分裂しないようにする。
- 同じ日の配分バーの WORK 合計が今日タブ内訳の各グループ合計と一致することを、テストで担保する。
- デモモードに配分バー用のタイムライン記録 seed を追加し、このバグ（同名同色の作り直しグループが支配的な日）と配分バー機能をデモで再現・確認できるようにする。

**Non-Goals:**
- 右オーバーレイの縦帯タイムライン（`buildRibbon`）の束ね方は変更しない（時系列クラスタ表示であり本バグの対象外）。
- MANUAL スライス（`category_key` 束ね）の挙動は変更しない。
- 母数（端〜端）・未記録・持ち分（÷n）規則は変更しない。
- 過去の確定日（`is_final=1`）の再集計・データ移行は行わない（読み取り時の束ね方の変更のみ）。

## Decisions

### D1: WORK スライスを「名前＋色」snapshot identity で束ねる（`today-group-breakdown` と共有）
`getDayAllocation` の `workMap` のキーを `b.stableGroupId` から、`snapshotGroups` と同一の identity 関数へ変更する。identity は:
- `stableGroupId === UNGROUPED_KEY` のとき → `UNGROUPED_KEY`（名前・色に依らず単一スライスへ集約、表示名「その他（未グループ）」・色 null）
- それ以外 → `title + '\x1f' + (color ?? '')`

**共有方法**: identity の算出（と未グループ表示名）を `summary.ts` から小さなヘルパーとして切り出し（例 `snapshotIdentityKey(stableGroupId, name, color)` / `snapshotDisplayName`）、`snapshotGroups` と `getDayAllocation` の双方から使う。SQL 側（`snapshotGroups`）と TS 側（`getDayAllocation`）で同じ規則を **二重定義しない**ことで将来のドリフトを防ぐ。区切り文字 `SNAP_KEY_SEP` も共有する。

- 代替案: day-allocation 内に identity を再実装 → 却下（今回のバグそのものが二重定義ドリフト。共有すべき）。
- 代替案: `snapshotGroups` の結果（今日タブ内訳）を配分の WORK ソースに流用 → 却下。配分は `creditedMs` の持ち分・端〜端母数・MANUAL/未記録との合算という独自集計が必要で、`tl.auto` を保持しつつ束ねキーだけ揃えるのが最小変更。

ラベル・色は identity 内の「最新記録時点（`startAt` 最大）」スナップショットを採用（現行の `last` 選択ロジックを踏襲）。スライス `key` は `work:${identity}` とする。

### D2: デモ seed にタイムライン記録を追加（配分バーの再現）
`demo-seed.ts` に、少なくとも1日ぶん（既存の谷を壊さない固定 `day_key`）の `session` 行を焼き込む。**issue #47 を再現するため、同名同色（例: 振り返り・紫）を異なる `stable_group_id` で複数回**入れる。固定 `day_key` / 固定タイムスタンプ（`SEED_TS` 系）を用い `Date.now()` 非依存。

- `session` の必須列（`stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot, started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at`）を明示挿入。休憩などを見せたい場合は `activity_log_entry`(MANUAL) も足す。
- 既存の達成集計（`daily_totals_snapshot` / 評価 / 達成日数 24/30）を壊さない。配分 seed は `session` 中心で、達成に使う `daily_totals_snapshot` の既存値には手を入れない（配分表示の検証は別テーブル経路）。
- 確認は `PORT=<空きポート> DB_PATH=:memory: npm run server` → `POST /api/demo/reset` → `GET /api/demo/timeline/<seed日>/allocation` で本物の集計経路を通し、振り返りが1本の大きなスライスに合算されることを確認する。デモ DB は本番 db と分離しているため、本番ルート `/api/timeline/:date/allocation`（本番 db 参照）ではなく、追加したデモ用配分ルートで確認する。実測（Day15=2026-06-25）: 振り返り(紫)=3.00h・勉強=2.00h・制作=0.75h・休憩(MANUAL)=0.75h・未記録0、`/api/demo/today` の内訳と一致。
- デモ UI 配線: デモの振り返りタブ `showDemo` は配分バーを描画していなかったため、デモ用配分ルート `GET /api/demo/timeline/:date/allocation`（デモ DB＋仮想 now を参照）を `api/demo.ts` に追加し、`showDemo` が対象日の配分バーを本番と共有の `buildAllocCard` で読み取り専用描画するよう配線した。

### D3: テスト
- `day-allocation.test.ts` に「同名同色・別 `stable_group_id` の作業が1スライスへ合算される」ケースを追加。未グループ集約ケースも1つ足すと堅い。
- `demo.test.ts` の期待値を、追加した配分 seed に合わせて更新（配分エンドポイントのスライス構成 or 既存の達成集計が不変であることの確認）。

## Risks / Trade-offs

- [今日タブとの完全一致がテストで固定されていないと将来また乖離する] → identity ヘルパーを共有し、`day-allocation.test.ts` で「配分の WORK 合計＝`today-group-breakdown` の同グループ合計」を突き合わせるアサーションを入れる。
- [デモ seed 追加で既存の達成日数の筋書き（24/30・中盤の谷）が動く懸念] → 配分 seed は `session` 中心にし、評価が読む `daily_totals_snapshot` の既存焼き込みは変更しない。`demo.test.ts` の達成系期待値が不変であることを確認してからスライス期待値を追加する。
- [未グループ（`UNGROUPED_KEY`）の扱い差] → today 内訳と同じく単一スライス集約・表示名「その他（未グループ）」・色 null に揃える。API レスポンスの `key`/ラベルが変わるがフロント `renderAlloc` はスライスをそのまま描くため改修不要。
- [`GET /api/timeline/:date/allocation` の `key` 粒度変更（`work:<stableGroupId>` → `work:<identity>`）] → 破壊的だがこの key はフロントの描画キー用途のみで外部契約なし。影響なし。
