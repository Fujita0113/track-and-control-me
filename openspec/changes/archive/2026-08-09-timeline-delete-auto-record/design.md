## Context

タイムラインの AUTO ブロックは `session` テーブル由来だが、`session` は権威データではない。権威は `raw_sample` であり、`recompute()`（`server/src/services/recompute.ts:145-151`）は対象日の `session` / `daily_totals_snapshot` / `daily_excluded_snapshot` を毎回 DELETE してから `aggregateSamples()` の結果で作り直す。したがって「記録を消す」は行の削除ではなく、**再集計の入力に対する持続的な指示**として表現しなければならない。

既に類似の先例がある: `split_override`（task 6.7）は「この区間の按分比率を上書きする」という指示を別テーブルへ持ち、`recompute` が読み込んで `aggregateSamples(samples, cfg, overrides)` へ渡している。除外もこの形に揃える。

決定済みの前提（ユーザー確認済み）:
- 同時オープンだった一方を削除したら、残りへ **divide-by-N → N−1 で再按分**する。
- **確定済み（`is_final=1`）の過去日も削除できる**。対象日に限り確定を上書きして再集計・再評価する。

制約:
- `server/src/aggregation/` は DB を知らない純粋モジュール。identity 解決は DB 側にある（`loadIdentityResolver`）。
- `runPipeline()` は当日・前日しか再計算しない。過去日の訂正はこの経路に乗らない。
- 日次集計 `daily_totals_snapshot` は `categories.ts` → 総作業時間 → ルール評価 → 目標の達成日数／完走レポートへ波及する。

## Goals / Non-Goals

**Goals:**
- 閉じ忘れたタブグループの自動記録を、ユーザーが自分で取り消せるようにする。
- 取り消しが再集計をまたいで持続し、集計・評価・振り返りのすべてで一貫すること。
- 削除が単調減少（自分の実績を増やせない）であること。同時オープンの再按分は区間の総計上を増やさない。
- 取り消し（undo）が可能で、集計値が完全に元へ戻ること。

**Non-Goals:**
- AUTO ブロックの時間帯編集（開始・終了のドラッグ変更）。今回は削除のみ。
- AUTO ブロックの別グループへの付け替え（既存の `split_override` の領域）。
- 削除履歴の一覧画面・監査ログ UI。除外レコードはテーブルに残るが、閲覧 UI は作らない。
- 拡張機能側の変更。サーバ内で完結する。

## Decisions

### D1: 削除は `activity_exclusion` テーブルの除外レコードとして表す

新テーブル:

```sql
CREATE TABLE activity_exclusion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key TEXT NOT NULL,
  identity_key TEXT NOT NULL,   -- タイムラインの AUTO ブロックの identityKey と同一
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_exclusion_day ON activity_exclusion(day_key);
```

`split_override` と同じ「再集計への持続的指示」パターンに揃える。取り消しは行の物理削除でよい（除外レコード自体は権威データではなく、消せば `raw_sample` から元の記録が復元される）。

**なぜ `session.id` を消す方式ではないか**: `session` は再集計で ID ごと作り直されるため、ID を握っても次の `recompute` で意味を失う。

**なぜ `stable_group_id` ではなく `identity_key` か**: タイムラインが束ねる単位は identity（`timeline-run-view`）であり、ユーザーがクリックして消すのもその単位。改名をまたいだ区間や、同一 identity へ解決される複数 sid をまとめて扱える。

### D2: 除外は `aggregateSamples` の入口で「開いていなかった」ものとして適用する

`aggregateSamples(samples, config, overrides, exclusions?)` に除外を渡し、`resolveOpenKeys` の直後に区間ごとのフィルタを掛ける:

1. 区間 `[p.startMs, p.endMs)` の**中点**を含む除外レコードを引く（`overrideFor` と同じ中点判定に揃える。サンプル間隔は短く、部分重なりのために区間を割る価値がない）。
2. 該当する除外の `identityKey` に一致する open グループを `openKeys` から落とす。
3. 残りがあれば従来どおり `distribute` / `distributeWeighted`。分母が自然に N−1 になる ＝ **再按分**（ユーザー決定）。
4. 残りが 0 かつ元は実グループが 1 つ以上あった場合は、`ungrouped` へ落とさず**非計上**にする（D3）。

`stream` へ積む slab の `openKeys` もフィルタ後の集合にする。これにより `buildSessions` は削除された identity のレーンを開かず、残りのレーンの `n` も N−1、`coactiveGroupKeys` からも削除分が消える。セッション層と日次合計層が同じ規則で動き、二重実装にならない。

**なぜ集計後に引き算しないか**: 引き算方式だと `session.n` / `credited_ms` / `coactive_group_keys` を別ロジックで整合させる必要があり、再按分の定義が2箇所に分かれる。入口で落とせば定義は1つ。

### D3: 全除外区間は `ungrouped` ではなく非計上（新しい除外理由 `DELETED`）

`resolveOpenKeys` が空を返す既存の経路（そもそもタブグループを開いていない）は `ungrouped` へ計上され、既定設定（`exclude_ungrouped_from_total = 0`）では**総作業時間に含まれる**。ここへ合流させると、2時間のブロックを削除しても総作業時間が減らず「その他（未グループ）」へ名前が変わるだけになり、issue の目的を果たさない。

そこで「元は実グループが開いていたが、すべて除外された」区間を区別し、`ExcludeReason` に `DELETED` を追加して `daily_excluded_snapshot` へ計上、`stream` へは `{ kind: 'gap', reason: 'DELETED' }` を積む。`gapCloseReason` の `default` 経路により、進行中の他レーンは `SLEEP_GAP` で正しく close される。

結果、当該区間はどのグループの `daily_totals_snapshot` にも入らず、`getTimeline` の `computeGaps` では未カバー区間となり、閾値以上ならゴーストスロットとして再記録できる。

### D4: identity 解決はコールバックで注入し、`aggregation/` の純粋性を保つ

`recompute()` が `loadIdentityResolver(db)` を使って解決関数を作り、`aggregateSamples` へ渡す:

```ts
interface ExclusionInput {
  identityKey: string;
  startMs: number;
  endMs: number;
}
// aggregateSamples(samples, config, overrides, {
//   exclusions,
//   identityKeyOf: (g) => resolver.resolve(g.title, g.color, g.stableGroupId).key,
// })
```

`aggregation/` に DB 依存を持ち込まず、既存の `SplitOverride` と同じ「値で渡す」流儀を保つ。`identityKeyOf` は除外が 1 件も無いときは呼ばない（既存パスのコストを増やさない）。

### D5: 確定日の訂正は `recompute` / `evaluateDay` の `force` オプションで、対象日だけ行う

- `recompute(db, { onlyDays: [day], force: true })`: `persist()` の `target()` 判定で、`force` かつ `onlyDays` に含まれる日に限り `finalDays` / `finalEval` のガードを無視する。`onlyDays` を必須とすることで「全確定日を巻き戻す」事故を構造的に防ぐ。`daily_totals_snapshot` の DELETE も `is_final = 0` 条件を外す必要がある（`recompute.ts:149`）。再作成される行の `is_final` は 1 のまま維持し、確定済みという事実は失わない。
- `evaluateDay(db, day, nowMs, { force: true })`: `is_final === 1` の早期 return を飛ばす。既存の `ON CONFLICT DO UPDATE` は `is_final` を書き換えないので、確定フラグは保たれたまま値だけが更新される。

削除／取り消しの API はこの2つを対象日 1 日だけに対して呼ぶ。`runPipeline()` は経由しない（当日・前日へ範囲が固定されているため）。

**なぜ確定を上書きしてよいか**: 削除は計上を減らす方向にしか働かない（D2 の再按分も区間の総和を変えない）。確定の目的は「実績を後から盛れないこと」であり、減らす訂正はその保証を壊さない。

### D6: API は `split` と同じ「日付スコープ ＋ 即時再集計」の形に揃える

- `POST /api/timeline/:date/exclusions` — body `{ identityKey, startAt, endAt }` → `{ id }`。検証（`identityKey` 必須・`endAt > startAt`）に失敗したら 400。登録後、対象日を `force` 再集計・再評価してから応答する。
- `DELETE /api/timeline/exclusion/:id` — → `{ restored: boolean }`。行が無ければ `{ restored: false }`（冪等・エラーにしない）。取り消し前に `day_key` を読んで、同じ日を `force` 再集計・再評価する。

既存の `DELETE /api/timeline/entry/:id`（MANUAL エントリ）は変更しない。AUTO と MANUAL では削除の意味（除外レコード vs 行削除）が違うため、経路を分ける。

### D7: UI は詳細ポップオーバーの2段階確認

`runBreakdown()` 末尾の「自動記録ブロックは削除できません。」（`server/static/js/timeline.js:704`）を削除操作へ置き換える。押すと同じ場所が確認表示（対象時間帯 ＋ 実行／取り止め）へ切り替わる。MANUAL の削除（`tlc-pop-delete`）が確認なしなのに対し2段階にするのは、AUTO の削除が日次集計とルール評価を巻き込むため。

削除成功時のトーストから取り消せるようにする（`DELETE /api/timeline/exclusion/:id` を呼ぶ）。削除対象はクリックしたラン全体のスパン `[run.startAt, run.endAt)`。ラン結合は表示レイヤーの概念だが、ユーザーが「1つの記録」として見ているのはランなので、削除単位もランに合わせる。

## Risks / Trade-offs

- **[確定日の数字が後から動く]** 30日チャレンジの達成日数や完走レポートが、過去の削除で減りうる → 削除は減る方向のみと仕様で固定し、対象日 1 日にスコープを限定する。CLAUDE.md のルールに従い、デモモードで前後の達成日数を再現してユーザーへ提示する。
- **[再按分で追跡中カテゴリの時間が増えうる]** 同時オープンの一方を消すと残りが増える → 区間の総計上は不変であり、既存の `split_override`（PUT /api/timeline/:date/split）で同等の再帰属は元から可能。新しい抜け穴ではない。
- **[中点判定による境界のずれ]** 除外区間の端にまたがるサンプル区間は、中点がどちら側かで丸ごと含まれる／外れる → サンプル間隔ぶんの誤差に収まる。`overrideFor` と同じ規則なので挙動は既存と一貫する。
- **[削除の取り消し導線がトーストだけ]** トーストを見逃すと取り消せない（`activity_exclusion` の行を直接消す以外に手段がない） → 今回のスコープでは許容。復元 UI が必要になったら別 change で `GET /api/timeline/:date/exclusions` と一覧を足す。
- **[`ExcludeReason` の追加が診断表示へ波及]** `DELETED` を知らない表示側が理由名をそのまま出す可能性 → 除外理由は `daily_excluded_snapshot` の診断用途であり、表示している箇所を確認して必要なら日本語ラベルを足す。

## Open Questions

なし（同時オープン時の按分・確定日の扱いはユーザー確認済み）。
