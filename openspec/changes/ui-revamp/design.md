## Context

SPA は `index.html` のフラットなタブバーを `main.js` の `activate()` が切り替える構成（`.active` を `<section>` に付け替え）。各画面は vanilla JS モジュール（`h()` ヘルパで DOM 生成）。バックエンドは Fastify + better-sqlite3、集計は `server/src/aggregation/` の pure 関数。参照実装は `ref/timeline/TabTimeline.dc.html` と `dev/kanban v4/kanban v4/Cadence Board.dc.html`（いずれも React + 独自 `support.js` の "DC" プロトタイプ）で、**設計・挙動の仕様**として扱い、コードは vanilla へ移植する。

既存 API（維持）: `/api/summary`・`/api/summary/range`・`/api/unlock/{date}`・`/api/rules*`・`/api/checks/{date}*`・`/api/password/reveal`・`/api/timeline/{date}*`（`addManual`/`gapToAway`/`putSplit`/`patchEntry`/`deleteEntry`）・`/api/reflection/{date}`・`/api/tasks*`・`/api/planning/{date}`。この change は原則フロント合成＋振り返り/タスクの小規模スキーマ拡張。ゲートの latch/評価ロジックには手を入れない。

## Goals / Non-Goals

**Goals:**
- 6→5 タブへ集約し、ゲート条件・当日チェック・PLANNING の重複表示を解消。
- タイムラインを Google カレンダー風に作り直し、離席記録をドラッグ操作＋吸着に置換。
- カンバンを Cadence Board の見た目・主要操作に刷新。振り返りを満足度＋Markdown ライブプレビュー＋履歴に刷新し、タブを分離。
- ゲートの PLANNING / MANUAL_CHECK 契約を壊さない。

**Non-Goals:**
- ゲートの latch・パスワード・ルール凍結・集計（divide-by-N / gap-cap）ロジックの変更。
- Cadence Board の重量級機能の完全移植（ネスト子カンバン、ガントチャート、期限超過の自動「救済リスト」機構）は本 change の対象外（将来拡張。UI 骨格だけ壊さない範囲で置く）。
- Edge 拡張側の計測ロジック変更（今回は運用メモの明記のみ）。
- リアルタイム同期の作り込み（従来通りポーリング/再描画）。

## Decisions

### D1. タブ集約：「今日」ハブへ dashboard+gate+checks を統合
`today.js` を新設し、上から (1) 総作業サマリ＋グループ別ドーナツ＋7日棒（旧 dashboard、除外内訳カードは削除）、(2) 解錠状態ヒーロー＋条件進捗（旧 gate）、(3) パスワード解錠、を縦に並べる。MANUAL_CHECK 条件は進捗リストの行内にチェックボックスを埋め込み `putCheck` を叩く（旧 `checks.js` を吸収）。翌日ルール編集セクションは現行どおり `rules.js` を再利用して同居。30秒リフレッシュはヒーロー/進捗領域のみに限定し、開いているモーダルは破棄しない（`merge-gate-rules` の方針を踏襲）。
- *代替*: ダッシュボードを独立タブのまま残す（中間案）→ 重複解消が弱く却下。

### D2. タイムライン再構築（`ref/timeline/` 移植、vanilla 化）
縦型単一カラム。定数: 表示レンジは当日の記録範囲に応じて動的算出（参照は 08:00–22:00 固定だが、本アプリは既存の window 計算を流用）、PXM=1.2（72px/時）。要素: 時刻ガター（時ラベル＋ブロック境界の目盛り）、時間ライン、現在時刻ライン（赤）、重なりは Google カレンダー式の**列分割**（貪欲割当、クラスタ内で列数共有）。ブロックは AUTO=グループ色＋白文字、MANUAL/離席=グレー破線＋「自己申告」バッジ。`white-space:nowrap; overflow:hidden; text-overflow:ellipsis` で文字切れを解消し、順序は `start→end` 安定ソートで固定（入替バグを解消）。
- *代替*: 同時作業を 1 ブロック内併記（レーン廃止）→ 参照実装が列分割を採用しており見た目が整うため列分割を採用。

### D3. 離席記録＝ドラッグ操作＋吸着
`onMouseDown` を空きギャップ内でのみ発火（占有ブロック上は無視）。`yToMin` で座標→分に変換し、既存ブロックとの近接時は端に吸着、そうでなければ 30 分グリッドへスナップ（ユーザー要望「8:42→8:30 / 8:46→9:00」＝`round(m/30)*30`）。ドラッグ中はゴースト帯＋時刻ラベルを表示、`mouseup` で開始/終了 `type=time` 入力・カテゴリチップ（昼食/休憩/移動/仮眠/運動/雑務/その他）・自由メモのポップオーバーを出し、確定で `api.addManual(date, {startAt, endAt, title, color:'grey'})`。既存ブロッククリックは詳細ポップオーバー（時間・種別・削除）。ドラッグとクリックは移動量閾値（<10分＝クリック扱い）で分岐。
- *スナップ粒度*: 参照は 5 分。ユーザー要望の 30 分吸着を既定にし、ポップオーバーの時刻入力で微調整可能とする（両立）。

### D4. カンバン刷新（Cadence Board 移植、スキーマ最小拡張）
列を **保留(hold) / 未着手(todo) / 進行中(doing) / 完了(done)** に再定義。タスクに `priority`(high/mid/low)・`due`(date, nullable)・`notes`(markdown, text) を追加。カード=優先度バッジ＋期限ラベル＋タイトル、D&D で列移動（HTML5 draggable）、完了列ドロップで演出（軽量 confetti + 任意サウンド）→ 一定時間後に done_at 設定＆アーカイブ扱い。右サイドに当日進捗ドーナツ（完了/総数）とアクティビティログ（当日完了）。
- **PLANNING 整合（重要）**: 現行 PLANNING は「翌日 `planned_for` のタスク数」で評価。Cadence は列に TOMORROW を持たず期限で管理するため、`due = 翌日` のタスク数、または列 `todo` で `planned_for=翌日` を PLANNING の対象とする。**サーバーの `planning.ts` の `tomorrowTaskCount` 判定を `due`/`planned_for` の翌日一致で継続**させ、契約を保つ。
- *代替*: 現行 4 列(BACKLOG/TODAY/TOMORROW/DONE)維持で見た目だけ変更 → TOMORROW 列で PLANNING を満たせる利点はあるが、参照の列(保留/未着手/進行中/完了)と乖離。参照準拠＋期限ベース PLANNING を採用。
- *スコープ*: ネスト子カンバン・ガント・救済リスト自動化は非対象（UI の骨格のみ壊さない）。

### D5. 振り返り刷新（満足度＋ライブプレビュー＋履歴）
`reflection.js` を新設しカンバンから分離。上部に満足度 5 段階（1–5、クリック選択）、下部に Markdown ライブプレビュー（入力とプレビューを同一画面）。保存は `putReflection(date, {content, satisfaction})`。過去参照は日付一覧（`GET /api/reflections`）→選択で該当日の内容表示。バックエンド: `reflections` に `satisfaction INTEGER NULL` 追加、一覧エンドポイント追加。Markdown レンダリングは軽量な自前パーサ（Cadence の live editor と同様、依存追加なし。CSP `connect-src 'self'` を満たすためCDN不可）。
- *代替*: 満足度を条件(gate)にも連動 → 今回は表示のみ、ゲート評価には非連動（Non-Goal）。

### D6. 初回オンボーディング（＋当日ルールのブートストラップ例外）
起動時 `loadState` 後に「当日ルール無し(`unlock.hasRuleSet=false`)かつ未来ルール無し(`getRules()` が空)」を検出したらモーダルを表示し、**当日（本日）ルール作成**（`openRuleEditor(state.today, …)`）へ誘導する。以後は未来ルールが 1 つでもあれば出さない。

**凍結ポリシーのブートストラップ例外（改訂）**: 凍結の目的は「既存の解錠条件を当日に骨抜きするゲーミング」の抑制である。実効ルールが 1 つも無い真の初期状態では抑制すべき既存条件が存在しないため、当日ルールの当日作成を許可し、**同日中は何度でも編集・削除可**（タイポ/達成不能のやり直し）とする。翌日以降は通常どおり凍結（`ensureFrozenIfDue` は「当日作成の当日ルール」を同日中は凍結せず、rollover と翌日以降の read で確実に凍結する）。実効ルール（継承元含む）が既に存在する日は当日作成を拒否し、導線は翌日ルールに限定する。
- 実装: `rules.ts` の `canWriteTodayRule`（当日作成・未凍結のブートストラップ、または実効ルール皆無のみ許可）、`ensureFrozenIfDue` の当日ブートストラップ・スキップ、`upsertFutureRuleSet` の記帳を `nowMs` に統一、`runRollover` で残存 DRAFT を凍結→PAST。テストは `rules.test.ts`「初期ブートストラップ」節。
- *代替1*: 当日ルールを自動生成 → 内容はユーザーが決めるべきなので却下（作成は明示操作）。
- *代替2*: 初期状態でも翌日のみ許可（旧方針）→ 初日にゲートが素通りになり本末転倒のため却下。

### D7. スキーマ変更とマイグレーション
`server/src/db/migrations.ts` に追記: `reflections.satisfaction`、`tasks.priority`/`tasks.due`/`tasks.notes`。既存行は NULL/デフォルト（priority='low' 等）。純関数集計・rollover には非影響。既存テスト（rules/aggregation/rollover）を壊さないこと。

## Risks / Trade-offs

- **PLANNING とカンバン列の不整合** → `planning.ts` の翌日タスク判定を `due`/`planned_for` の翌日一致で維持し、テストで担保。ゲート評価ロジック自体は不変更。
- **ドラッグ操作の競合（スクロール/クリック/占有ブロック）** → ギャップ内限定発火＋移動量閾値でクリック分岐、`mousedown` で `stopPropagation`。`user-select:none` を lane に付与。
- **タスクスキーマ変更のマイグレーション失敗** → 追加カラムは nullable/デフォルト付きで後方互換。ロールバックはカラム参照を外すだけ（データ非破壊）。
- **Markdown 自前レンダラの脆弱性/工数** → 最小サブセット（見出し/箇条書き/番号/引用/チェックボックス/強調/コード）に限定し、HTML はエスケープして XSS を回避。
- **CSP 制約** → フォント/スクリプトの外部取得不可。参照の Google Fonts はローカルフォールバック（system-ui）に置換。
- **画面統合による回帰** → `today.js` はヒーロー領域のみ定期再描画し、モーダル/未保存入力を保持（既存方針踏襲）。

## Migration Plan

1. バックエンド: マイグレーション追加（`reflections.satisfaction`, `tasks.priority/due/notes`）、`GET /api/reflections`、`reflection`/`tasks` の payload 拡張。既存テストを green に保つ。
2. `today.js` を作り dashboard+gate+checks を統合、`index.html`/`main.js` のタブを 5 つへ再編（除外内訳削除、当日チェックタブ削除）。
3. `timeline.js` を `ref/timeline/` 準拠で全面書き換え（列分割・現在時刻ライン・ドラッグ記録・ポップオーバー）。
4. `kanban.js`（planning から分離・Cadence 準拠）と `reflection.js`（満足度＋ライブプレビュー＋履歴）を実装。PLANNING 判定の整合を確認。
5. オンボーディングダイアログ配線。
6. 手動 E2E（tasks.md のチェックリスト）＋ `npm test` / `npm run typecheck`。
7. ロールバック: 旧 `dashboard.js`/`gate.js`/`checks.js`/`planning.js` と旧 `index.html`/`main.js` を復元、追加カラムは無視（データ非破壊）。

## Open Questions

- カンバンの祝福演出・サウンドの既定 ON/OFF（設定トグルで既定 OFF を想定）。
- タイムライン離席のカテゴリチップ集合を固定（参照の7種）にするか、グループ由来に寄せるか（初期は固定7種で実装）。
- 満足度の保存単位（当日のみか、任意日編集可か）。初期は当日および過去日閲覧、編集は当日中心とする。
