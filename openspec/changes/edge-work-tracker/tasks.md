## 1. リポジトリ雛形 & 共有スキーマ (F0)

- [x] 1.1 npm workspaces を作成（`packages/contract/` `extension/` `server/`）。ルート `package.json` に `engines.node: ">=22"` を設定
- [x] 1.2 TypeScript 設定（`tsconfig.base.json` + 各パッケージの `tsconfig.json`、strict 有効）。実行は `tsx`、拡張バンドルは `esbuild`
- [x] 1.3 依存を design.md D11 の固定版でインストール（fastify/@fastify/websocket/@fastify/static/better-sqlite3/croner/zod、dev: vitest/tsx/esbuild/@types/chrome/@types/better-sqlite3）。`package-lock.json` をコミット
- [x] 1.4 `packages/contract`：ハートビート/イベントのペイロードを **zod スキーマ**で定義（clientTs, monotonicMs, bootId, seq, tz, groupId, stableGroupId, groupTitle, groupColor, windowId, tabId, idleState, browserFocused, openGroupKeys[], eventType, extVersion）。型を export し拡張・server 双方から参照
- [x] 1.5 `vitest` セットアップ（`packages/contract` の schema parse/reject テストを最小1本）。lint/format（任意）

## 2. Edge 拡張機能 MV3 (F1) — spec: edge-activity-tracking

- [x] 2.1 `manifest.json`（MV3、`minimum_chrome_version: "116"`、permissions: `tabs,tabGroups,idle,alarms,storage`）を作成し `edge://extensions` の unpacked で読み込み確認
- [x] 2.2 アクティブグループ算出＋**開いている全グループ集合**取得：`tabs.query({active:true,lastFocusedWindow:true})` → `groupId`（`-1`=ungrouped）→ `tabGroups.get` で title/color。加えて `tabGroups.query({})` で openGroupKeys（開いている全グループ）を取得。**計上は Edge のフォーカス有無に依らない**（focus は計上停止条件にしない）
- [x] 2.3 遷移イベント購読：`tabs.onActivated` / `tabs.onUpdated(changeInfo.groupId)` / `tabGroups.onUpdated`/`onRemoved` / `windows.onFocusChanged` / `idle.onStateChanged`。`idle.setDetectionInterval(30)`
- [x] 2.4 ハートビート：`chrome.alarms`（30s）で起床し、状態（idle/active・activeGroup・**openGroupKeys**）を**能動クエリ**してから送信。**Edge が背面でも SW が生きていれば送る**。`chrome.storage.local` に `{activeGroupId, openGroupKeys, stableGroupId, title, color, lastActiveTs, lastHeartbeatTs, bootId, seq}` を退避（グローバル変数に依存しない）
- [x] 2.5 stableGroupId 管理：groupId→UUID を `chrome.storage` に永続化（フォールバック title+color）、tabGroups イベントで更新
- [x] 2.6 WS クライアント：`ws://127.0.0.1:<port>` 接続、初回に共有トークン送信、20秒キープアライブ、切断時は指数バックオフ再接続。未送信は `chrome.storage` にキュー→復帰時フラッシュ（自己タイムスタンプ済みなので順不同/遅延に耐える）
- [x] 2.7 esbuild で SW/コンテンツをバンドルするビルドスクリプト。手動確認：グループ開閉・別アプリfocus（計上は継続）・放置(idle 停止)・ロック・複数グループ同時オープンで イベント/openGroupKeys が期待通り出る

## 3. backend 受信 & 時間集計 (F2) — spec: edge-activity-tracking

- [x] 3.1 Fastify 起動（`127.0.0.1` バインド）＋ `@fastify/websocket` で `/ingest` を実装。トークン照合ハンドシェイク
- [x] 3.2 冪等 ingest：受信サンプルを zod で検証し raw 保存。`(bootId, seq)` で重複排除、順不同は保存時に許容
- [x] 3.3 SQLite スキーマ（better-sqlite3）とマイグレーション：`AppConfig, Category, TabGroup, GroupCategoryMapping, Session, DailyRuleSet, RuleCondition, DailyTotalsSnapshot, UnlockEvaluation, RevealedPasswordLog, PasswordCommandConfig, ActivityLogEntry`（design.md D6）
- [x] 3.4 **集計 pure 関数**：サンプル列→区間化。`countable = idle=='active'`（focus 不問）かつ `0<gap<=CAP(90s)` のみ計上、`gap>CAP` は0、負ギャップは0+フラグ。**同時オープンは openGroupKeys の全グループへ `gap/N` 均等分配（divide-by-N）**、`N=1` は全額、未グループは既定で分母除外。stableGroupId で集計、excluded 秒を理由別に記録
- [x] 3.5 day_boundary(04:00) で区間分割し、日×stableGroupId の**分配後**秒数（`DailyTotalsSnapshot`）と セッション列 `Session[start,end,group,coactiveGroups]` を**同一 pass**で生成
- [x] 3.6 vitest：CAP境界(89/90/91s)、深夜03:30→05:00の日跨ぎ分割、**divide-by-N（2グループ→各1/2・合計=実時間）**、Edge背面でも在席なら計上、未グループ分母除外、idle/locked/gap除外、重複/順不同/clock jump のエッジケースを検証

## 4. カテゴリ & ルールエンジン (F3) — spec: activity-categorization, work-rules-engine

- [x] 4.1 `Category`（kind=WORK|AWAY|IDLE, counts_toward_total, soft-delete）と `GroupCategoryMapping`（effective_from/to）の CRUD。未マップは既定 `uncategorized`
- [x] 4.2 カテゴリ別ロールアップ＆**総作業時間**＝counts_toward_total な Session 秒数の合計（当日窓内）。生の per-group 層は保持し再カテゴリ化で再計算可能に
- [x] 4.3 `DailyRuleSet` + `RuleCondition`（target=CATEGORY|TOTAL_WORK|**MANUAL_CHECK**|**PLANNING**, comparator, threshold_seconds[時間], label[MANUAL_CHECK], signal_key[PLANNING], combinator=ALL）。時間しきい値は整数秒
- [x] 4.4 凍結：日境界(04:00)で対象日を FROZEN_ACTIVE 化し `frozen_at`+`content_hash` を刻む。FROZEN/PAST への編集を **app 層＋DBトリガ**で拒否。未来日のみ編集可。未定義日は `undefined_day_policy=LOCKED`
- [x] 4.5 評価＆latch：セッションclose毎/約1分毎/日境界finalize で `UnlockEvaluation` を更新。false→true で `first_met_at` を刻み以後 UNLOCKED 維持（手動減でも relock しない）
- [x] 4.6 vitest：AND評価、当日編集拒否/翌日編集可、23:59の翌日編集と日境界freezeの競合（トランザクションでfreeze勝ち）、latch維持、undefined_day_policy
- [x] 4.7 **MANUAL_CHECK（MVP）**: `DailyCheck`（date/condition_key/checked）＋当日チェック UI（ラベルは事前入力）。全ブール条件を AND 評価に組み込み、未チェックなら未達成。vitest で「時間OKでもチェック未了は未達成」を検証

## 5. パスワードゲート (F4) — spec: password-gate

- [x] 5.1 `PasswordCommandConfig`（command_template with `{date}`, working_dir, timeout_seconds, version）。`child_process.execFile` で **pwsh** を timeout 付き実行し stdout を候補取得。既定は `ref/gen_password.ps1`（`-Date yyyy-MM-dd` → 6桁hex）
- [x] 5.2 reveal フロー：LOCKED→UNLOCKED の瞬間に**一度だけ自動発火**し、**前日+当日**を生成。`RevealedPasswordLog` に role=TODAY/YESTERDAY で記録（**平文非保存＝salted sha256 のみ**）
- [x] 5.3 失敗ハンドリング：非ゼロ終了/タイムアウト/空出力はエラー＋再試行。片方成功時は成功側のみ表示し欠落をフラグ。捏造・流用しない
- [x] 5.4 未達成バイパス不可＝**脱出弁を実装しない**ことをテストで担保（未達成では reveal API がパスワードを返さない）
- [x] 5.5 vitest：ダミー .ps1 でtoday/yesterday生成、失敗系、平文がDB/ログに出ないこと、未達成での非表示

## 6. ダッシュボード & タイムライン (F5) — spec: work-stats-dashboard, activity-timeline

- [x] 6.1 集計 API（期間指定で 日×カテゴリ秒数＋当日達成状態）と `@fastify/static` 配信。**厳格CSP** ヘッダ設定
- [x] 6.2 Chart.js 4.5.1 UMD を `server/static/js/` に vendor（CDN不使用）、`<canvas>` で当日内訳の**円グラフ**＋日ごと推移の**棒グラフ**を描画（同時進行は divide-by-N 後の値・合計=実時間。オフライン動作確認）
- [x] 6.3 自動タイムライン（**Google カレンダー1日ビュー風・縦時刻軸**）：閉じた Session から AUTO_SESSION エントリを**Edge グループ色のブロック**で生成（近接同一グループは結合しきい値で coalesce）。day_boundary で分割済み
- [x] 6.4 手動追記：MANUAL(AWAY) エントリの追加/編集/削除（昼食・昼寝等）。AUTO編集時は `edited`+`original_*` で来歴保持
- [x] 6.5 ギャップ可視化：未カバー区間を計算表示し、1クリックで MANUAL AWAY に昇格
- [x] 6.6 ルール編集 UI：翌日以降は編集可、当日は読み取り専用（凍結を UI でも反映）
- [x] 6.7 **同時進行の分割表示＋割合編集**：同一時間帯の複数グループを分割表示。ブロッククリックで各グループの割合（既定 1/N を任意に・0 可）を変更→当該区間を再割当（総和は実時間を保存）→集計・円グラフに反映

## 7. 常駐 & 運用 (F6)

- [x] 7.1 croner で毎日 04:00 のロールオーバー：前日を不変スナップショット化し `is_final` を刻む。遅延サンプルは anomaly ログへ
- [x] 7.2 Windows スタートアップ登録手順（pwsh 構文）で backend を常駐化。WS ポート/共有トークン/PasswordCommandConfig の初期設定手順
- [x] 7.3 SQLite の定期バックアップと、初回セットアップ/トラブルシュート（native module ビルド要件含む）を README に pwsh 構文で記載

## 8. 統合 & E2E 検証

- [ ] 8.1 拡張 unpacked ロード → backend 起動 → WS 接続確立をログで確認
- [ ] 8.2 実操作 E2E：2グループ同時オープン→別アプリ(VS Code)で作業→放置→スリープ→深夜跨ぎ で Session/日次合計が「**divide-by-N**・Edge背面でも在席なら計上・sleep/idle除外・04:00分割」になることを確認（「開発」グループを開けば VS Code 時間が開発へ計上）
- [x] 8.3 ルール達成 E2E：条件（総作業4h＆競プロ15分＋**振り返り/タスク登録の手動チェック**）到達→達成latch→**前日/当日2候補表示**、`RevealedPasswordLog` に平文が残らない、未達成（時間OKでもチェック未了）では非表示、を確認
- [ ] 8.4 凍結/編集 E2E：当日ルール編集拒否・翌日ルール編集可、円グラフ/棒グラフ・カレンダー1日ビュー・同時進行の分割と割合編集・ギャップ表示を確認
- [x] 8.5 `vitest` フルスイート green を確認し、`package-lock.json` で再現可能な状態を最終化

## 9. 振り返り＋タスクカンバン統合 (F7・最終形) — spec: reflection-and-planning

- [x] 9.1 `ReflectionEntry`（date UNIQUE / Markdown content）と、日次振り返りの記録・編集 UI（既存の振り返りファイルを統合）
- [x] 9.2 `Task` カンバン：列（Backlog/Today/Tomorrow/Done 等）とカードの追加/編集/移動/削除、`planned_for` で翌日割当
- [x] 9.3 `PlanningStatus` 評価：当日振り返り済み＆翌日タスク>=1 で `planning_done=true`（判定基準は設定可）。`PLANNING` シグナルとして提供
- [x] 9.4 ルールエンジンの `PLANNING` 条件を `PlanningStatus` に接続し、MANUAL_CHECK（MVP）から自動判定へ移行できるように
- [x] 9.5 E2E：作業条件達成でも**翌日タスクをカンバンに登録＋振り返り記録するまでパスワードが出ない**、登録後に reveal されることを確認
