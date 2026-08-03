## Context

`recompute(db, { onlyDays })` は次の3段で動く:

1. `loadRawSamples(db)` — `raw_sample` 全件を `client_ts` 順に読み、JSにマップ（issue #82の実測: 49,111件で約580ms）
2. `aggregateSamples(samples, cfg, overrides)` — 隣接サンプル対 `sorted[i], sorted[i+1]` のgapを順に処理し、`dailyTotals` / `sessions` / `excluded` を全期間ぶん生成する純関数（同実測で `recompute()` 全体が約4.9秒）
3. `persist()` — `touched`（生成された日）のうち `onlyDays` に含まれ、かつ `is_final` でない日だけ `session` / `daily_totals_snapshot` / `daily_excluded_snapshot` を書き戻す

つまり (1)(2) のコストは `raw_sample` の総件数に比例して増え続けるのに、(3) の実際の書き込みは高々2日分（`main.ts` の ingest デバウンス経路: `runPipeline` → `recompute(db, { onlyDays: [today, yesterday] })`）にしか反映されない。better-sqlite3は同期API・Node/Fastifyはシングルスレッドのため、ingestのたびに3秒デバウンスで走るこの重い同期処理が、`/api/goals` を含む他の全リクエストをイベントループ上でブロックする（issue #82のスクリーンショットで、同じ `/api/goals` が13msで返る一方、別の1件が2.47秒かかっていたのはこのため）。

呼び出し経路を洗った結果、本番コードで `recompute()` に `onlyDays` を渡さない（＝全期間書き込みを意図する）呼び出しは無い。`runRollover`（`rollover.ts`）も内部で `runPipeline(db, nowMs)` を呼ぶだけで、これも `onlyDays: [today, yesterday]` 経由。`onlyDays` 省略は `rollover.test.ts` 等のテストのみで使われている。

`aggregateSamples` はサンプル列の隣接ペアでgapを判定する純関数で、**先頭サンプルの直前のペアは計算されない**（`sorted[0]` 単体では区間が作れない）。そのため対象日レンジの先頭を単純にスライスすると、レンジ最初の区間が欠落する。

## Goals / Non-Goals

**Goals:**
- `onlyDays` が指定されたとき、`loadRawSamples` が読み込む `raw_sample` の範囲を対象日＋境界計算に必要な前方バッファに絞り、読み込み・集計コストを `raw_sample` の総件数ではなく対象範囲のサイズに比例させる。
- 通常の ingest デバウンス経路（`main.ts` の3秒タイマー経由 `runPipeline`）が、この絞り込みを自動的に享受する。
- 絞り込み後も、対象日の `dailyTotals` / `sessions` / `excluded` の値が絞り込み前と完全に一致する（先頭区間の欠落を起こさない）。
- `onlyDays` 省略時（全期間再計算）は従来どおり全件を対象にする（テスト・将来のバックフィル用途を壊さない）。

**Non-Goals:**
- `raw_sample` テーブル自体の間引き・アーカイブ（別issueとして切り出す。今回は「毎回全件読む」構造だけを直す）。
- `loadAllSplitOverrides`（`split_override` 全件読み込み）の絞り込み。現状 `split_override` は0件〜小規模で今回のボトルネックではないため対象外。
- `aggregateSamples` 自体のアルゴリズム変更（純関数のインターフェースは変えない。入力サンプル列を絞るだけ）。
- ingest デバウンス間隔（3秒）やデバウンス機構自体の変更。

## Decisions

### D1: 絞り込みは `loadRawSamples` に日付範囲パラメータを追加する形で行う

`loadRawSamples(db, opts?: { sinceMs?: number })` のように、`client_ts >= ?` の下限フィルタをSQL側（`WHERE client_ts >= @sinceMs`）で追加する。上限は付けない（「今」までの最新サンプルは常に必要）。

`recompute()` 側で `onlyDays` が指定されている場合、対象日の最小値 `minDay = min(onlyDays)` から1日分前倒しした `prevDayKey(minDay)` の `boundaryStartOfDay(...)` を `sinceMs` として渡す。1日分の前倒しバッファを取るのは、`aggregateSamples` が隣接ペアでgapを計算するため、対象範囲の最初の区間を正しく計算するには「対象範囲開始直前の1サンプル」が最低限必要であり、サンプリング間隔（数秒〜数十秒間隔が前提）に対して1日は十分すぎる安全マージンだから。

代替案として「対象範囲開始直前のサンプルを1件だけ個別クエリで取得し先頭に連結する」方式も検討したが、`raw_sample` の日境界（`day_boundary_minutes`、既定04:00）は暦日と一致しないため「直前1件」の判定がやや複雑になる。1日バッファを丸ごと読む方がシンプルで、コストも対象日数+1日ぶんで十分小さい。

### D2: `persist()` の書き込みフィルタ（`target()`）はそのまま維持する

絞り込みは読み込み・集計の入力側だけに効かせ、書き込み対象の判定（`onlyDays` に含まれるか・`is_final` でないか）は現行の `target()` をそのまま使う。バッファ日（`prevDayKey(minDay)`）が誤って書き戻されることはない。

### D3: `onlyDays` 省略時は従来どおり全件

`onlyDays` が未指定のときは `sinceMs` を渡さず、現行どおり全件ロードする。本番の自動実行経路では常に `onlyDays` が渡るため実質影響なし。テストやツールから明示的に全期間再計算したいケース（将来のバックフィル等）の後方互換を保つ。

## Risks / Trade-offs

- [Risk] バッファが1日では足りないケース（サンプリングが1日以上途切れる: PC長期シャットダウン等）→ その場合でも `classifyInterval` は `gapCapMs`（既定90秒）を超えるgapを `GAP_EXCEEDED` として0扱いにするため、直前サンプルが見つからなくても実害（工数の過大/過小計上）は生じない。単にその区間が「集計対象なし」になるだけで、これは現行の全件読み込み時と同じ挙動。
- [Risk] `boundaryStartOfDay` の計算を誤ると対象日の先頭が欠ける → D1の1日バッファはこの誤差を吸収するマージンとして機能する。加えて既存の `recompute()` を対象にした vitest（絞り込みあり/なしで同一結果になることを検証するシナリオ）で担保する。
- [Trade-off] `raw_sample` が今後も無限に増え続ける限り、絞り込み後も「対象日数+1日」ぶんのコストは残る（ゼロコストにはならない）。ただし対象日数は常に高々2日（today/yesterday）で頭打ちなので、`raw_sample` 総件数に比例して劣化する現状の構造は解消される。テーブル自体の間引きは別issue。
