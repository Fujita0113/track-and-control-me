## Context

本 change は、開発者本人の作業を「ゲームを報酬にしたコミットメントデバイス」で強制するローカルアプリの設計。
Edge のタブグループを活動単位として作業時間を自動計測し、あらかじめ決めた日次ルールを満たしたときだけ、
ゲームPCのパスワード（前日・当日の2候補）を**表示**する。動機・スコープは `proposal.md`、要件は `specs/` を参照。

**現状 / 制約**:
- グリーンフィールド（既存コードなし）。対象ユーザーは本人のみ、完全ローカル・オフライン。
- プラットフォームは Windows 11 / Edge(Chromium) / PowerShell。
- ゲームPCは**別マシン**で、パスワードは各PCのタスクスケジューラが毎日ローテーションする。本アプリは表示のみ。
- パスワード生成ロジックは既存の **PowerShell (.ps1)**。本 change では中身を作らず、差し替え可能なコマンドとして統合する。

**確定した設計判断**（`proposal.md` の Decisions と対応）:

| 論点 | 決定 |
|---|---|
| 構成/パスワード | 別PC・表示のみ（前日+当日の2候補） |
| PWロジック | PowerShell(.ps1) を subprocess 実行 |
| Edge検出 | Chromium 拡張(MV3) |
| スタック | Node.js + TypeScript（Fastify / better-sqlite3 / croner / zod） |
| 脱出弁 | 設けない（ロックアウトは受容） |
| 1日の区切り | 午前4時（day_boundary=04:00） |

本設計の技術的判断は、公式ドキュメントに基づく事前調査で裏付けている（各 Decision に引用URLを付す）。

## Goals / Non-Goals

**Goals:**
- タブグループ単位の**アクティブ時間**を、スリープ／アイドル／ロックを除外して計測する（近似で可）。
- **同時に開いているグループへは時間を均等分配（divide-by-N。合計＝実時間）**。Edge が最前面でなくても在席なら計上し、
  「開発」グループを開けば VS Code 等の作業も自動計上（VS Code は追跡しない）。
- 日次ルール（時間しきい値＋**手動チェック／翌日計画完了のブール条件**）を評価し、達成時のみパスワードを表示。**当日ルールは凍結／翌日以降は編集可**。
- **振り返り＋翌日タスク登録の儀式をゲートに統合**し、それを終えるまでパスワードを出さない（MVP はチェックボックス、最終形は内蔵カンバン）。
- パスワードは**前日・当日の2候補**を差し替え可能な .ps1 から生成。平文は永続化しない。
- **Google カレンダー1日ビュー風の行動記録**（グループ色ブロック・同時進行は分割・割合編集可）を自動生成し、PC外活動を手動追記、ギャップを可視化。
- 当日内訳の**円グラフ**＋日次推移の**棒グラフ**を表示。すべて**ローカル・オフライン**、単一言語(Node/TS)。

**Non-Goals:**
- パスワード生成ロジック自体の実装（外部 .ps1 に委譲）。
- ゲームPCのパスワード変更・リモート設定（本アプリは表示のみ）。
- 脱出弁（break-glass）／未達成時のバイパス手段。
- マルチユーザー／クラウド同期／複数デバイス合算（ただし将来に備えデータは device キーを持たせる）。
- ブラウザ外作業の自動計測（手動タイムライン入力で補う）。

## Decisions

### D1. Edge 検出 = MV3 拡張機能（chrome.* API）
「外部プロセスからアクティブタブの所属グループを確実に取得する」唯一の現実解が拡張機能。使用 API:
`chrome.tabGroups`（グループの title/color、`TAB_GROUP_ID_NONE === -1`）、`chrome.tabs`（active tab と `groupId`、
`onActivated`/`onUpdated`）、`chrome.windows`（`onFocusChanged`、`WINDOW_ID_NONE === -1` で全ウィンドウ非フォーカス）、
`chrome.idle`（`setDetectionInterval(15..)`、`onStateChanged` の `'active'|'idle'|'locked'`）、
`chrome.alarms`（SW停止をまたぐ起床）、`chrome.storage`（SW再生成をまたぐ状態保持）。Edge は chrome.* 名前空間が
コード互換で、tabGroups/idle/alarms/storage/nativeMessaging すべて対応。読み込みは `edge://extensions` の unpacked。
- 代替案: CDP(`--remote-debugging-port`) / OS レベル解析 → **却下**（起動オプション依存・脆弱・グループ所属が取れない）。
- 参照: https://developer.chrome.com/docs/extensions/reference/api/tabGroups ／ https://developer.chrome.com/docs/extensions/reference/api/tabs ／ https://developer.chrome.com/docs/extensions/reference/api/windows ／ https://developer.chrome.com/docs/extensions/reference/api/idle ／ https://learn.microsoft.com/microsoft-edge/extensions/developer-guide/api-support

### D2. 通信 = localhost WebSocket（拡張 → backend）
拡張の Service Worker が `ws://127.0.0.1:<port>` に接続し、トークンでハンドシェイクしてイベントを送る。
- 理由: 常駐アプリが**自分のライフサイクルを持てる**（Native Messaging のホストはブラウザに生殺与奪を握られ常駐不可）。
  さらに Chrome/Edge 116+ では **WebSocket の通信が SW の30秒アイドルタイマーをリセット**するため、20秒キープアライブが
  SW延命とハートビートを兼ねる。localhost への ws 接続は拡張の CSP に抵触せず、mixed-content の対象外。
- 代替案: Native Messaging（常駐不可・Edge のレジストリパスが Chrome と異なる・Windows は stdout をバイナリモードにしないと
  フレーミング破損）／localhost HTTP（サーバ→拡張の push 不可・SW を延命しない） → **却下**。
- セキュリティ: `127.0.0.1` バインド固定＋初回メッセージで共有トークン照合（同一マシンの他プロセスによる偽装防止）。
- 参照: https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets ／ https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle ／ https://learn.microsoft.com/microsoft-edge/extensions/developer-guide/native-messaging

### D3. イベントモデル = ハートビート主体＋遷移イベント（時間勘定は backend）
純粋な「開始/終了イベント」方式は、**OSスリープと MV3 SW 停止のいずれも「終了イベント」を出さない**ため破綻する
（8時間の作業と8時間のスリープを区別できない）。よって:
- **ハートビート**を `chrome.alarms`（周期 30s＝現行 Chromium の実質下限）で駆動し、SW が停止していても起床して現在状態を
  **能動的にクエリ**（`idle.queryState` / `windows.getLastFocused` / `tabs.query({active:true})` / `tabGroups.get`）してから送る。
  `setInterval` は SW 停止で死ぬため使わない。状態は毎回 `chrome.storage.local` に退避。
- **遷移イベント**（`tabs.onActivated` / `onUpdated(groupId)` / `tabGroups.onUpdated` / `windows.onFocusChanged` /
  `idle.onStateChanged`）を即時送信し、境界を正確化。
- **時間の勘定は backend 側**で行い、ブラウザの壁時計に依存しない。
- ペイロード（zod 共有スキーマ）: `clientTs, monotonicMs, bootId, seq, tz, groupId, stableGroupId, groupTitle, groupColor,
  windowId, tabId, idleState, browserFocused, openGroupKeys[], eventType, extVersion`。`openGroupKeys` は
  同時オープンの分配（divide-by-N）用の「現在開いているグループ集合」。`monotonicMs` で時計ジャンプ検出、`(bootId, seq)` で冪等化。
- 参照: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

### D4. 時間集計 = pure 関数（countable & gap-cap & 同時オープンは divide-by-N）
backend はサンプル列を `(bootId, seq)` でソート・重複排除し、連続ペア `[t_i, t_{i+1})` を区間化。各区間の状態は
**先頭サンプル** h_i から取る。
- `countable(h) := idleState=='active'`（在席。**Edge が前面か否かは不問**＝別アプリで作業中でも計上する）。`gap = t_{i+1} - t_i`、
  **CAP = 90s（＝30s ハートビートの3倍）**。`countable(h_i) かつ 0 < gap <= CAP` のときのみ計上、`gap > CAP` は 0
  （スリープ/Edge終了/離席）。負ギャップ（時計逆行）は 0＋フラグ。→ 大ギャップに `min(gap, CAP)` を使わない
  （1スリープ毎に90秒を誤計上しない。計測は意図的に過少側へバイアス）。
- **同時オープンの均等分配（divide-by-N）**: 区間の計上先は h_i の**開いている全グループ集合 A = openGroupKeys**。
  `gap` 秒を **A の各グループへ `gap/|A|` ずつ均等分配**する。`|A| = 1` なら全額そのグループへ。未グループのみの区間は `ungrouped`
  バケットへ（ノイズ回避のため未グループは既定で分母に含めない・設定可）。放置対策は「使い終わったグループは閉じる運用」＋
  **行動記録画面での手動再割当**に委ねる（＝直近使用の時間窓は設けない）。
  → **総和は常に実時間（Σ = gap）を保存**するので、二重計上ではなく"分配"。ゲートの総作業時間も円グラフも壊れない。
  例: AtCoder と 開発 が同時に開いた2時間 → 各1時間。**「開発」グループを開いておけば VS Code 等での作業も自動で「開発」に計上**（VS Code 自体は追跡しない）。
- 集計キーは volatile な chrome groupId ではなく **stableGroupId**（`chrome.storage` 永続 UUID、フォールバック title+color）。
- 区間は **day_boundary(04:00)** で分割してから日別に合算。非計上区間は理由別に「excluded 秒」として記録。
- 同一 pass から (a) 日×stableGroupId の**（分配後）**秒数（ダッシュボード/ルール用）と (b) セッション列
  `[start, end, group, coactiveGroups]`（カレンダー1日ビューの分割表示用）を生成し、両者が食い違わないようにする。
- **手動調整**: 行動記録画面（カレンダー1日ビュー）で任意の同時オープン区間の分配比率を変更（均等／比率／単一グループへ再割当・0 可）できる。
  再割当も区間内の総和を保存する（実時間を超えない）。
- 定数（`heartbeat=30s / idle detection=30s / CAP=90s / day_boundary=04:00`）は AppConfig で調整可能。

### D5. スタック = Node.js + TypeScript（1言語・型共有）
拡張が JS/TS 必須である以上、backend も TS にすると**システム全体が1言語**になり、**ハートビートのペイロード型を
zod スキーマ1つで拡張と backend が共有**できる（契約のドリフト防止＝ユーザーが最重視した点）。
- 構成: **Fastify**（HTTP+静的配信）＋ **@fastify/websocket**（受信）＋ **@fastify/static**（ダッシュボード配信）、
  **better-sqlite3**（同期・単一ユーザーに最適）、**croner**（日次ロールオーバー）、**zod**（検証＋型）。
- 代替案: Python + FastAPI（当初の既定案）→ パスワードが .ps1 に確定し「Python 親和性」の根拠が消滅、
  かつ型共有の利点で Node/TS を採用（ユーザー判断）。Django → 今回の規模には過大。

### D6. データモデル = 生 Session を source of truth、他は materialized view
すべてのタイムスタンプは **UTC 保存＋ IANA タイムゾーン記録**、日帰属は **day_boundary(04:00)** で導出（naive midnight は使わない）。
主要エンティティ（`specs/` の要件を満たす）:
- `AppConfig`（tz / day_boundary_local_time=04:00 / idle_close_seconds / concurrency_policy=EQUAL_SPLIT(divide-by-N; 開いている全グループで割る) /
  include_ungrouped_in_split（既定 false） / undefined_day_policy=LOCKED / reveal_yesterday=true）。
- `Category`（key / display_name / kind=WORK|AWAY|IDLE / counts_toward_total / soft-delete）。
- `TabGroup`（name / color / external_group_id[不安定なヒント]）、`GroupCategoryMapping`（effective_from/to で履歴保持）。
- `Session`（生・source of truth。tab_group_name_snapshot / category_key_snapshot / started_at,ended_at(UTC) /
  day_key / close_reason=NORMAL|IDLE_TIMEOUT|DAY_BOUNDARY_SPLIT|SLEEP_GAP）。
- `DailyRuleSet`（effective_date UNIQUE / combinator=ALL / status=DRAFT_FUTURE|FROZEN_ACTIVE|PAST / frozen_at /
  content_hash[改竄検知]）、`RuleCondition`（target=CATEGORY|TOTAL_WORK|**MANUAL_CHECK**|**PLANNING** /
  comparator / threshold_seconds[時間条件用] / label[MANUAL_CHECK のラベル] / signal_key[PLANNING の参照先]）。
- `DailyTotalsSnapshot`（date×category、TOTAL_WORK 行、is_final）、`UnlockEvaluation`（status / conditions_met /
  per_condition_results / first_met_at[latch]）。
- `RevealedPasswordLog`（revealed_at / target_date / role=TODAY|YESTERDAY / **password_sha256(salted)** /
  command_config_id / exit_code）。**平文は保存しない**。
- `PasswordCommandConfig`（command_template with `{date}` / working_dir / timeout_seconds / version）。
- `ActivityLogEntry`（date / start_at,end_at(UTC) / entry_type=AUTO_SESSION|MANUAL / source_session_id /
  title / edited / original_start_at,end_at）。ギャップは**保存せず計算**。
- `DailyCheck`（date / condition_key / checked:bool / checked_at）。MANUAL_CHECK 条件の当日チェック状態。
- `ReflectionEntry`（date UNIQUE / content(Markdown) / created_at / updated_at）。日次振り返り（既存の振り返りファイルを統合）。
- `Task`（id / title / description / status(列: Backlog|Today|Tomorrow|Done 等) / planned_for(date) / created_at / done_at）。カンバンのカード。
- `PlanningStatus`（date / reflection_done:bool / tomorrow_task_count:int / planning_done:bool[=振り返り済み＆翌日タスク>=1] / evaluated_at）。PLANNING シグナルの materialized 状態。

### D7. ルール意味論・凍結・latch
`TOTAL_WORK = counts_toward_total な Category に属する Session の合計（当日の [day_boundary, 翌 day_boundary) 窓内）`。
条件は `(target, comparator, threshold_seconds)` 等、既定 combinator=ALL(AND)。時間しきい値は**整数秒**（DST/日長変動に不変）。
- **ブール条件**: `MANUAL_CHECK`（当日 `DailyCheck.checked==true`。ラベルは事前入力）と `PLANNING`
  （`PlanningStatus.planning_done==true`＝振り返り済み＆翌日タスク>=1）も AND 条件に含められる。ルール（条件の存在）は
  当日凍結され、充足状態（チェック／計画）は当日の進捗として変化する（latch は全条件が揃った瞬間に成立）。
- 評価タイミング: セッション close 毎／作業中は約1分毎／日境界で finalize。
- 凍結: `effective_date` が未来の間だけ編集可(DRAFT_FUTURE)。日境界で FROZEN_ACTIVE に遷移し `frozen_at`+`content_hash` を刻む。
  FROZEN_ACTIVE/PAST への UPDATE/DELETE は **app 層と DB トリガの二重**で拒否。ルール未定義日は `undefined_day_policy=LOCKED`。
- latch: `conditions_met` が false→true になった瞬間 `first_met_at` を刻み、以後その日は UNLOCKED を維持
  （後の手動編集で総計が減っても遡って relock しない）。この LOCKED→UNLOCKED 遷移が reveal フローの唯一の自動トリガ。

### D8. パスワード統合（.ps1、前日+当日、平文非永続）
`PasswordCommandConfig.command_template` の `{date}` を対象日（`yyyy-MM-dd`）で埋め、`child_process.execFile` で **pwsh** を
`timeout_seconds` 付き実行、stdout を候補とする（決定的＝日付冪等の前提）。既存 `ref/gen_password.ps1` の実インタフェースは
`pwsh -NoProfile -File gen_password.ps1 -Date {date}` → stdout に 6 桁 hex（`SHA256(日付)` の先頭6桁）を返す。
- 達成時に **今日と昨日の両方**を生成し2候補として表示（ゲームPC側のローテーション失敗で実パスワードが前日値のことがあるため）。
- **平文は DB/ログ/一時ファイルに書かない**。UI に一時表示し速やかに破棄。監査は `salted sha256` と メタ데이タのみ。
  どうしてもキャッシュが要る場合は Windows DPAPI / 資格情報マネージャ。ログ出力ではマスク。
- 失敗（非ゼロ終了/タイムアウト/空出力）は明示エラー＋再試行。成功した側だけ出し、失敗側はフラグ。捏造・流用しない。

### D9. 脱出弁なし（受容するロックアウト）
アプリ内 override は実装しない。真の緊急時の唯一の逃げ道は「ユーザーが意図的に .ps1 を手実行する」手間のかかる行為のみ。
これは強制力の担保＝アプリの存在意義そのもの（ユーザー明示判断）。

### D10. チャート = Chart.js 4.5.1 を同梱（オフライン・厳格CSP）
CDN を使わず UMD ビルドを `static/` に vendor し `<script src="/static/js/chart.umd.min.js">` で同一オリジン参照。
CSP は `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:`。

### D11. バージョン固定（2026-07-05 npm 実測）
- ランタイム: Node.js `>=22`（導入済 22.12.0 / LTS "Jod"）。
- 実行時: `typescript ^6.0`(6.0.3, ビルド用) / `fastify ^5.9`(5.9.0) / `@fastify/websocket ^11.2`(11.2.0) /
  `@fastify/static ^9.1`(9.1.3) / `better-sqlite3 ^12.11`(12.11.1) / `croner ^10.0`(10.0.1) / `zod ^4.4`(4.4.3)。
- 開発時: `vitest ^4.1`(4.1.9) / `tsx ^4.23`(4.23.0) / `esbuild ^0.28`(0.28.1) / `@types/chrome ^0.2`(0.2.2) /
  `@types/better-sqlite3 ^7.6`(7.6.13)。同梱: `chart.js 4.5.1`。
- 固定方針: post-1.0 は次 major を cap、0.x は次 minor を cap。最終は `package-lock.json` で確定。

### D12. 振り返り＋タスクカンバンの統合（段階導入）
現行の「振り返り → 翌日タスク登録 → パスワード生成」という儀式をゲートに組み込む。
- **MVP**: ルールに `MANUAL_CHECK` 条件（ラベル付きチェックボックス。ラベルは事前入力テキスト）を追加。ユーザーが当日
  チェックするまでアンロックしない。実装が軽く、現行運用を即継続できる。
- **最終形**: 振り返りエディタ（`ReflectionEntry`）＋タスクカンバン（`Task`）をアプリ内蔵し、`PLANNING` シグナル
  （振り返り済み＆翌日タスク>=1）を**自動判定**してゲートにする（自己申告のチェックより客観的）。
- 自己申告性: MANUAL_CHECK は自己申告（脱出弁なしと同じ自己規律前提）。PLANNING は「翌日タスクを実際に登録した」という
  客観状態に近づける。カンバンの列構成・必要タスク数・振り返り必須かは設定で調整可能。

## Risks / Trade-offs

- **MV3 Service Worker が約30秒で停止し、in-memory タイマー/カウンタが消える** → `chrome.alarms` で起床、状態は
  `chrome.storage` に退避、時間勘定は backend 側で実施。`minimum_chrome_version: "116"` を設定し WS キープアライブ20秒で SW 延命。
- **OSスリープ/ハイバネートは一切イベントを出さない**（純粋な時間ギャップ） → gap>CAP(90s) 除外だけで、スリープ/停止/クラッシュを
  一律に扱う（専用スリープイベントに依存しない）。
- **`chrome.idle` の検出間隔は最小15秒**＝離席検知に最大15秒の遅延（末尾の過少除外＝わずかな過大計上） → 検出間隔を小さく保つ／
  必要なら idle 遷移直前を後トリミング。`'locked'` と focus で早期に補足。
- **localhost ws は同一マシンの任意プロセスから到達可能** → `127.0.0.1` 固定＋共有トークンハンドシェイク。
- **better-sqlite3 はネイティブモジュール** → Node22 の prebuilt を前提。無い環境ではビルドツール(VS Build Tools)が必要（tasks に明記）。
- **同時オープン時の時間配分** → 開いている全グループへ均等分配（divide-by-N。総和＝実時間を保存し、二重計上しない）。
  放置・誤オープンは「使い終わったら閉じる運用」＋**行動記録画面での割合編集（0 可）**で補正（直近使用の時間窓は設けない）。
  Edge が最前面でなくても在席なら計上する（`idle` / `locked` / gap>CAP のみ非計上）。
- **計測は Edge 内で開いているグループのみ（OS/VS Code は非追跡）** → ただし **「開発」グループを開いておく運用**で、
  VS Code 等での作業時間も自動的に「開発」へ計上できる（＝VS Code を追跡せず開発時間を捕捉）。注意点: Edge を閉じている間や、
  どのグループも開いていない在席時間は計上されない。将来 OS 前面計測（@paymoapp/active-window / real-idle・koffi は調査済み）を足す余地は残す。
- **パスワードは日付のみから決まる**（`SHA256(日付)[:6]`）ため理論上は自力計算可能＝ゲートは**自己規律前提**（脱出弁なしと同じ精神）。厳密な秘匿ではなくコミットメント装置として機能する。
- **volatile な chrome groupId が再起動で振り直される** → stableGroupId(UUID) / title+color フォールバックで同一性を担保。
- **脱出弁なしゆえ、条件未達＋真の緊急時にロックアウト** → **受容**。唯一の逃げ道は意図的な .ps1 手実行。
- **ゲームPC側タスクスケジューラの失敗**で実パスワードが前日値になる → **前日+当日の2候補**を出して吸収。
- **パスワード平文の漏洩** → DB/ログ/一時ファイルに書かない、salted hash のみ監査、必要時 DPAPI。
- **チュートリアル視聴（無操作）が idle 扱いで計上されない** → 既定はそのまま非計上。将来 audible-tab 例外を off 既定で検討。

## Migration / Deployment Plan

- グリーンフィールドのため既存システムのロールバックは不要。**唯一の永続状態は SQLite ファイル**（定期バックアップ）。
- デプロイ: (1) backend を Windows スタートアップ（pwsh タスク or スタートアップ）で常駐、(2) 拡張を `edge://extensions` の
  unpacked で読み込み、(3) 初回に共有トークンと `PasswordCommandConfig`（.ps1 のパスと `{date}` 引数）を設定。
- ロールバック: backend 停止＋拡張の無効化で計測を止められる。データは SQLite ファイル削除で初期化。
- 段階導入は `tasks.md` の F0→F6。コア(F1–F4) を先行、ダッシュボード/タイムライン(F5) は後追い可能。

## Open Questions

1. 実装の優先順位（コア F1–F4 を先、ダッシュボード/タイムライン F5 を後）で良いか（apply 時に確認）。
2. **audible-tab 例外**（動画/チュートリアル視聴を active 扱いにする）を将来入れるか（既定 off）。
3. **InPrivate（incognito）** の扱い（推奨: 計測しない）。
4. backend を単なるスタートアップ常駐にするか、Windows サービス化するか。
5. WS ポート番号と共有トークンの初期ブートストラップ UX（設定ファイル生成手順）。
6. 未グループタブは分配の分母に**含めない**（確定）。**Edge を閉じている間は計上対象外**（確定）。将来 OS 前面計測を足すかは保留。
7. カンバンの列構成／「翌日計画完了」の判定基準（必要タスク数・振り返り必須か）と、MVP チェックボックス→内蔵カンバンへの移行時期（apply 時に詰める）。
