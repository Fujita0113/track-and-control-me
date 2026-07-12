/**
 * SQLite マイグレーション（design.md D6）。
 * user_version pragma を版管理に使い、未適用の版を昇順で流す。
 * すべてのタイムスタンプは INTEGER epoch ms(UTC)。day_key は TEXT 'YYYY-MM-DD'。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-schema',
    sql: /* sql */ `
-- 設定シングルトン（id=1 のみ）。
CREATE TABLE app_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tz TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  day_boundary_minutes INTEGER NOT NULL DEFAULT 240,     -- 04:00
  heartbeat_seconds INTEGER NOT NULL DEFAULT 30,
  idle_detection_seconds INTEGER NOT NULL DEFAULT 30,
  gap_cap_seconds INTEGER NOT NULL DEFAULT 90,
  concurrency_policy TEXT NOT NULL DEFAULT 'EQUAL_SPLIT', -- divide-by-N
  include_ungrouped_in_split INTEGER NOT NULL DEFAULT 0,
  undefined_day_policy TEXT NOT NULL DEFAULT 'LOCKED',
  reveal_yesterday INTEGER NOT NULL DEFAULT 1,
  ws_port INTEGER NOT NULL DEFAULT 47653,
  shared_token TEXT NOT NULL DEFAULT '',
  session_coalesce_seconds INTEGER NOT NULL DEFAULT 120,
  planning_require_reflection INTEGER NOT NULL DEFAULT 1,
  planning_min_tomorrow_tasks INTEGER NOT NULL DEFAULT 1,
  password_hash_salt TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- 活動カテゴリ。soft-delete（deleted_at）。
CREATE TABLE category (
  key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'WORK',              -- WORK|AWAY|IDLE
  counts_toward_total INTEGER NOT NULL DEFAULT 1,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- タブグループ（安定キーが主キー）。external_group_id は揮発ヒント。
CREATE TABLE tab_group (
  stable_group_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  external_group_id INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- グループ→カテゴリのマッピング（effective_from/to で履歴保持）。
CREATE TABLE group_category_mapping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stable_group_id TEXT NOT NULL,
  category_key TEXT NOT NULL REFERENCES category(key),
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,                            -- NULL = 現在有効
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_gcm_group ON group_category_mapping(stable_group_id, effective_from);

-- 受信生サンプル（冪等キー (boot_id, seq)）。
CREATE TABLE raw_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  boot_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  client_ts INTEGER NOT NULL,
  monotonic_ms REAL NOT NULL,
  tz TEXT NOT NULL,
  event_type TEXT NOT NULL,
  active_group_id INTEGER NOT NULL,
  active_stable_group_id TEXT,
  active_title TEXT,
  active_color TEXT,
  window_id INTEGER NOT NULL,
  tab_id INTEGER,
  idle_state TEXT NOT NULL,
  browser_focused INTEGER NOT NULL,
  open_group_keys TEXT NOT NULL DEFAULT '[]',       -- JSON GroupRef[]
  ext_version TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE (boot_id, seq)
);
CREATE INDEX idx_raw_sample_ts ON raw_sample(client_ts);

-- 生セッション（source of truth）。分配後 credited_ms を保持。
CREATE TABLE session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stable_group_id TEXT NOT NULL,
  tab_group_name_snapshot TEXT NOT NULL,
  group_color_snapshot TEXT,
  category_key_snapshot TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  coactive_group_keys TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  n INTEGER NOT NULL DEFAULT 1,
  credited_ms INTEGER NOT NULL,
  close_reason TEXT NOT NULL,                        -- NORMAL|IDLE_TIMEOUT|DAY_BOUNDARY_SPLIT|SLEEP_GAP
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_session_day ON session(day_key, stable_group_id);
CREATE INDEX idx_session_time ON session(started_at);

-- 日×グループ の分配後ミリ秒（生の per-group 層。再カテゴリ化で再計算可能）。
CREATE TABLE daily_totals_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key TEXT NOT NULL,
  stable_group_id TEXT NOT NULL,                    -- 実グループ or 'ungrouped'
  ms INTEGER NOT NULL,
  is_final INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE (day_key, stable_group_id)
);

-- 除外秒（理由別）。診断・タイムラインギャップ用。
CREATE TABLE daily_excluded_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key TEXT NOT NULL,
  reason TEXT NOT NULL,                             -- IDLE|LOCKED|GAP_EXCEEDED|NEGATIVE_GAP|CLOCK_JUMP
  ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (day_key, reason)
);

-- 日次ルールセット。当日凍結（FROZEN_ACTIVE）。content_hash で改竄検知。
CREATE TABLE daily_rule_set (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  effective_date TEXT NOT NULL UNIQUE,             -- day_key
  combinator TEXT NOT NULL DEFAULT 'ALL',
  status TEXT NOT NULL DEFAULT 'DRAFT_FUTURE',      -- DRAFT_FUTURE|FROZEN_ACTIVE|PAST
  frozen_at INTEGER,
  content_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ルール条件。target ごとに使うカラムが異なる。
CREATE TABLE rule_condition (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_set_id INTEGER NOT NULL REFERENCES daily_rule_set(id) ON DELETE CASCADE,
  target TEXT NOT NULL,                             -- CATEGORY|TOTAL_WORK|MANUAL_CHECK|PLANNING
  category_key TEXT,                                -- target=CATEGORY
  comparator TEXT NOT NULL DEFAULT 'GTE',
  threshold_seconds INTEGER,                        -- 時間条件（整数秒）
  label TEXT,                                       -- MANUAL_CHECK ラベル
  signal_key TEXT,                                  -- PLANNING 参照先
  condition_key TEXT NOT NULL,                      -- 安定キー（DailyCheck 参照）
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_rule_condition_set ON rule_condition(rule_set_id);

-- アンロック評価（latch）。first_met_at が刻まれたら以後 UNLOCKED を維持。
CREATE TABLE unlock_evaluation (
  day_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'LOCKED',            -- LOCKED|UNLOCKED
  conditions_met INTEGER NOT NULL DEFAULT 0,
  per_condition_results TEXT NOT NULL DEFAULT '[]', -- JSON
  first_met_at INTEGER,                             -- latch のタイムスタンプ
  reveal_fired INTEGER NOT NULL DEFAULT 0,          -- 自動 reveal を発火済みか
  is_final INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- MANUAL_CHECK の当日チェック状態。
CREATE TABLE daily_check (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key TEXT NOT NULL,
  condition_key TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER,
  UNIQUE (day_key, condition_key)
);

-- パスワード生成コマンド設定（差し替え可能）。
CREATE TABLE password_command_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_template TEXT NOT NULL,                  -- {date} を含む
  working_dir TEXT,
  timeout_seconds INTEGER NOT NULL DEFAULT 15,
  version INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- パスワード表示ログ（平文非保存＝salted sha256 のみ）。
CREATE TABLE revealed_password_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revealed_at INTEGER NOT NULL,
  target_date TEXT NOT NULL,
  role TEXT NOT NULL,                              -- TODAY|YESTERDAY
  password_sha256 TEXT,                            -- salted。失敗時 NULL
  command_config_id INTEGER,
  exit_code INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  auto_fired INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

-- 行動記録エントリ（タイムライン）。ギャップは保存せず計算。
CREATE TABLE activity_log_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  entry_type TEXT NOT NULL,                        -- AUTO_SESSION|MANUAL
  source_session_id INTEGER,
  stable_group_id TEXT,
  title TEXT NOT NULL,
  color TEXT,
  category_key TEXT,
  coactive_group_keys TEXT NOT NULL DEFAULT '[]',
  n INTEGER NOT NULL DEFAULT 1,
  edited INTEGER NOT NULL DEFAULT 0,
  original_start_at INTEGER,
  original_end_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_day ON activity_log_entry(day_key, start_at);
`,
  },
  {
    version: 2,
    name: 'freeze-triggers',
    sql: /* sql */ `
-- 凍結（design.md D7 / task 4.4）を DB トリガでも担保する。
-- DRAFT_FUTURE 以外のルールセットは「内容」の変更・削除を拒否する。
-- ただし status/frozen_at/content_hash 等の system 記帳（combinator 不変の UPDATE）は許可し、
-- freeze-on-read（DRAFT_FUTURE→FROZEN_ACTIVE）や rollover（FROZEN_ACTIVE→PAST）を通す。

CREATE TRIGGER trg_rule_set_no_content_edit_when_frozen
BEFORE UPDATE ON daily_rule_set
FOR EACH ROW
WHEN OLD.status <> 'DRAFT_FUTURE' AND NEW.combinator <> OLD.combinator
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: content edit rejected');
END;

CREATE TRIGGER trg_rule_set_no_delete_when_frozen
BEFORE DELETE ON daily_rule_set
FOR EACH ROW
WHEN OLD.status <> 'DRAFT_FUTURE'
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: delete rejected');
END;

CREATE TRIGGER trg_rule_cond_no_insert_when_frozen
BEFORE INSERT ON rule_condition
FOR EACH ROW
WHEN (SELECT status FROM daily_rule_set WHERE id = NEW.rule_set_id) <> 'DRAFT_FUTURE'
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: condition insert rejected');
END;

CREATE TRIGGER trg_rule_cond_no_update_when_frozen
BEFORE UPDATE ON rule_condition
FOR EACH ROW
WHEN (SELECT status FROM daily_rule_set WHERE id = OLD.rule_set_id) <> 'DRAFT_FUTURE'
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: condition update rejected');
END;

CREATE TRIGGER trg_rule_cond_no_delete_when_frozen
BEFORE DELETE ON rule_condition
FOR EACH ROW
WHEN (SELECT status FROM daily_rule_set WHERE id = OLD.rule_set_id) <> 'DRAFT_FUTURE'
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: condition delete rejected');
END;
`,
  },
  {
    version: 3,
    name: 'reflection-kanban-and-split',
    sql: /* sql */ `
-- 日次振り返り（date UNIQUE / Markdown）。既存の振り返りファイルをアプリ内統合。
CREATE TABLE reflection_entry (
  date TEXT PRIMARY KEY,          -- day_key
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- タスクカンバン。planned_for で翌日割当。
CREATE TABLE task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'BACKLOG',  -- BACKLOG|TODAY|TOMORROW|DONE 等
  planned_for TEXT,                        -- day_key（翌日割当）
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_task_planned ON task(planned_for, status);

-- PLANNING シグナルの materialized 状態（任意。planning.ts は動的計算も可）。
CREATE TABLE planning_status (
  date TEXT PRIMARY KEY,
  reflection_done INTEGER NOT NULL DEFAULT 0,
  tomorrow_task_count INTEGER NOT NULL DEFAULT 0,
  planning_done INTEGER NOT NULL DEFAULT 0,
  evaluated_at INTEGER NOT NULL
);

-- 同時進行区間の割合上書き（task 6.7）。区間へ再割当（総和は実時間を保存）。
CREATE TABLE split_override (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  ratios TEXT NOT NULL,           -- JSON { stableGroupId: ratio(0..1) }
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_split_override_day ON split_override(day_key, start_at);
`,
  },
  {
    version: 4,
    name: 'group-rule-conditions',
    sql: /* sql */ `
-- カテゴリ層の撤廃（spec: unlock-rule-conditions）。
-- rule_condition に stable_group_id を追加し、GROUP ターゲットで参照する。
-- 既存の CATEGORY 条件はカテゴリ→単一グループへ 1:1 写像できないため削除する。
-- 凍結トリガは DELETE を ABORT するため、いったん DROP → 掃除 → v2 と同一定義で再作成する。
ALTER TABLE rule_condition ADD COLUMN stable_group_id TEXT;

DROP TRIGGER trg_rule_cond_no_insert_when_frozen;
DROP TRIGGER trg_rule_cond_no_update_when_frozen;
DROP TRIGGER trg_rule_cond_no_delete_when_frozen;

DELETE FROM rule_condition WHERE target = 'CATEGORY';

CREATE TRIGGER trg_rule_cond_no_insert_when_frozen
BEFORE INSERT ON rule_condition
FOR EACH ROW
WHEN (SELECT status FROM daily_rule_set WHERE id = NEW.rule_set_id) <> 'DRAFT_FUTURE'
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: condition insert rejected');
END;

CREATE TRIGGER trg_rule_cond_no_update_when_frozen
BEFORE UPDATE ON rule_condition
FOR EACH ROW
WHEN (SELECT status FROM daily_rule_set WHERE id = OLD.rule_set_id) <> 'DRAFT_FUTURE'
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: condition update rejected');
END;

CREATE TRIGGER trg_rule_cond_no_delete_when_frozen
BEFORE DELETE ON rule_condition
FOR EACH ROW
WHEN (SELECT status FROM daily_rule_set WHERE id = OLD.rule_set_id) <> 'DRAFT_FUTURE'
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: condition delete rejected');
END;
`,
  },
  {
    version: 5,
    name: 'reflection-satisfaction-and-task-fields',
    sql: /* sql */ `
-- UI 刷新（spec: reflection-journal / kanban-board）。
-- 振り返りに満足度（1..5, 任意）、タスクに優先度・期限・Markdown ノートを追加する。
-- いずれも後方互換（既存行は NULL / デフォルト）。純関数集計・rollover には非影響。
ALTER TABLE reflection_entry ADD COLUMN satisfaction INTEGER;      -- 1..5, NULL=未評価

ALTER TABLE task ADD COLUMN priority TEXT NOT NULL DEFAULT 'low';  -- high|mid|low
ALTER TABLE task ADD COLUMN due TEXT;                              -- day_key 'YYYY-MM-DD', NULL=未設定
ALTER TABLE task ADD COLUMN notes TEXT;                            -- Markdown ノート
CREATE INDEX idx_task_due ON task(due, status);
`,
  },
  {
    version: 6,
    name: 'away-min-seconds-threshold',
    sql: /* sql */ `
-- 「記録すべき離席」の最小秒数（timeline-revamp D2 の一元化閾値）。
-- サーバーのギャップ抽出・クライアントのラン結合・拡張の復帰通知が共有する単一値。
-- 既定 600s（10分）。既存 DB は ALTER TABLE で追加（既定値が入る）。
ALTER TABLE app_config ADD COLUMN away_min_seconds INTEGER NOT NULL DEFAULT 600;
`,
  },
  {
    version: 7,
    name: 'task-due-locked',
    sql: /* sql */ `
-- 期日の手動指定ロック（kanban-rule-conditions D4）。
-- 1 = ユーザーが期限ピッカーで手動指定 → 自動 due エンジンの上書き対象から除外。
-- 既存行は既定 0（自動決定の対象）。
ALTER TABLE task ADD COLUMN due_locked INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 8,
    name: 'task-status-order-index',
    sql: /* sql */ `
-- 列内並べ替えの読み取り最適化（kanban-task-reorder D/Migration）。
-- listTasks の ORDER BY status, sort_order, id を後押しする（正しさには非依存の任意索引）。
CREATE INDEX IF NOT EXISTS idx_task_status_order ON task(status, sort_order);
`,
  },
  {
    version: 9,
    name: 'exclude-ungrouped-from-total',
    sql: /* sql */ `
-- 未グループ（'ungrouped' = @track/contract の UNGROUPED_KEY）時間を総作業時間から除外する設定
-- （spec: work-time-scope）。ON のとき日の総作業時間の合算から stable_group_id='ungrouped' 行を外す。
-- 既定 0（OFF）＝現行どおり未グループも算入（後方互換）。per-group 生データ
-- （daily_totals_snapshot）には非影響で、読み出し時にのみ除外する（design.md D1/D2/D4/D5）。
ALTER TABLE app_config ADD COLUMN exclude_ungrouped_from_total INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 10,
    name: 'manual-category-registry',
    sql: /* sql */ `
-- 手動記録カテゴリのレジストリ（spec: manual-category-registry / design.md D1）。
-- 離席／空き時間の記録ポップオーバーで使う表示ラベルを永続化し、直近使用順で提供する。
-- 旧 category テーブル（WORK/AWAY 層の遺物）とは別物の最小テーブル。集計・ルール・rollover には非接続。
-- name はそのまま表示名（trim 済み）。last_used_at=0 は未使用（末尾へ回る）。rowid=挿入順（既定語の並び保持）。
CREATE TABLE manual_category (
  name TEXT PRIMARY KEY,                    -- trim 済み表示名（そのままラベル）
  last_used_at INTEGER NOT NULL DEFAULT 0,  -- epoch ms。未使用は 0
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 既定7語を挿入順＝並び順でシード（INSERT OR IGNORE で冪等）。last_used_at=0 で未使用扱い。
INSERT OR IGNORE INTO manual_category (name, last_used_at, use_count, created_at) VALUES
  ('昼食', 0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('休憩', 0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('移動', 0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('仮眠', 0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('運動', 0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('雑務', 0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('その他', 0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
`,
  },
  {
    version: 11,
    name: 'goal-30day-challenge',
    sql: /* sql */ `
-- 30日チャレンジ（spec: goal-challenge / goal-journal / goal-report / design.md D1–D6）。
-- 既存の計測・評価・凍結機構は無改造。目標はその上に「採用(adopt)モデル」で乗る。
-- すべての day_key は TEXT 'YYYY-MM-DD'、タイムスタンプは INTEGER epoch ms。

-- 目標本体。状態カラムは持たず、today との day_key 比較で 開始前/進行中/完走 を導出する（D3）。
CREATE TABLE goal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',        -- 目的の一文
  start_day TEXT NOT NULL,                 -- 常に翌日（作成時に確定）
  end_day TEXT NOT NULL,                   -- start_day + 29（30日固定）
  created_at INTEGER NOT NULL              -- 作成当日限りの削除猶予の判定に使う
);
CREATE INDEX idx_goal_period ON goal(end_day);

-- 採用実践。既存ルール条件を condition_key 文字列で「参照」する（注入しない・D1）。
-- 表示用にターゲット種別とラベル等のスナップショットを持つ（グループ改名で表示が壊れないため）。
CREATE TABLE goal_practice (
  goal_id INTEGER NOT NULL REFERENCES goal(id) ON DELETE CASCADE,
  condition_key TEXT NOT NULL,             -- total_work | group:<id> | planning:<signal>
  target TEXT NOT NULL,                    -- TOTAL_WORK | GROUP | PLANNING（採用時点）
  label_snapshot TEXT,                     -- 表示用ラベル（グループ名/チェック名等）
  stable_group_id TEXT,                    -- GROUP のとき採用時点の対象グループ
  signal_key TEXT,                         -- PLANNING のとき
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (goal_id, condition_key)
);

-- 閾値変更ログ（理由必須・D2）。condition_key 単位（目標非依存）で1本記録する。
CREATE TABLE practice_threshold_change (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  condition_key TEXT NOT NULL,
  effective_date TEXT NOT NULL,            -- 変更が効く日（編集対象日）
  old_seconds INTEGER,
  new_seconds INTEGER,
  reason TEXT NOT NULL,                    -- 非空（「自分との交渉ログ」）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ptc_key ON practice_threshold_change(condition_key, effective_date);

-- 目標日記（D4）。reflection_entry には触れない＝ reflection_done シグナルを汚染しない。
CREATE TABLE goal_journal (
  goal_id INTEGER NOT NULL REFERENCES goal(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (goal_id, day_key)
);
`,
  },
  {
    version: 12,
    name: 'coactive-manual-record-group',
    sql: /* sql */ `
-- 複数カテゴリの均等割同時記録（spec: timeline-coactive-record / design.md D1・D2）。
-- 同一区間を N カテゴリで同時記録する各 MANUAL 行を、同一 co_record_group_id で束ねる。
-- 加算的移行（nullable, 既定 NULL）でバックフィル不要。既存の単独 MANUAL 記録は
-- co_record_group_id=NULL のまま、n=1（既存既定）で持ち分＝区間長そのまま＝後方互換。
-- n は AUTO 同時オープンと同じ「持ち分の分母」。同時記録の持ち分は (end_at - start_at) / n。
ALTER TABLE activity_log_entry ADD COLUMN co_record_group_id INTEGER;
`,
  },
  {
    version: 13,
    name: 'same-day-rule-additions-triggers',
    sql: /* sql */ `
-- 当日ルールへの新規条件の追加を許可する（spec: same-day-rule-additions / design.md D1）。
-- 凍結の DB トリガ backstop は残しつつ、「当日のみ可変」の新ステータス DRAFT_TODAY を
-- DRAFT_FUTURE と同じく可変扱いにする（可変判定を status IN ('DRAFT_FUTURE','DRAFT_TODAY') へ緩める）。
-- status は TEXT・CHECK 無しのため値追加にスキーマ変更は不要（既存行は無変更）。
-- 真に凍結された FROZEN_ACTIVE/PAST 行は従来どおりハードロックのまま。
-- v2/v4 と同一の 5 トリガを drop → 可変判定だけ緩めて再作成する。

DROP TRIGGER trg_rule_set_no_content_edit_when_frozen;
DROP TRIGGER trg_rule_set_no_delete_when_frozen;
DROP TRIGGER trg_rule_cond_no_insert_when_frozen;
DROP TRIGGER trg_rule_cond_no_update_when_frozen;
DROP TRIGGER trg_rule_cond_no_delete_when_frozen;

CREATE TRIGGER trg_rule_set_no_content_edit_when_frozen
BEFORE UPDATE ON daily_rule_set
FOR EACH ROW
WHEN OLD.status NOT IN ('DRAFT_FUTURE', 'DRAFT_TODAY') AND NEW.combinator <> OLD.combinator
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: content edit rejected');
END;

CREATE TRIGGER trg_rule_set_no_delete_when_frozen
BEFORE DELETE ON daily_rule_set
FOR EACH ROW
WHEN OLD.status NOT IN ('DRAFT_FUTURE', 'DRAFT_TODAY')
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: delete rejected');
END;

CREATE TRIGGER trg_rule_cond_no_insert_when_frozen
BEFORE INSERT ON rule_condition
FOR EACH ROW
WHEN (SELECT status FROM daily_rule_set WHERE id = NEW.rule_set_id) NOT IN ('DRAFT_FUTURE', 'DRAFT_TODAY')
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: condition insert rejected');
END;

CREATE TRIGGER trg_rule_cond_no_update_when_frozen
BEFORE UPDATE ON rule_condition
FOR EACH ROW
WHEN (SELECT status FROM daily_rule_set WHERE id = OLD.rule_set_id) NOT IN ('DRAFT_FUTURE', 'DRAFT_TODAY')
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: condition update rejected');
END;

CREATE TRIGGER trg_rule_cond_no_delete_when_frozen
BEFORE DELETE ON rule_condition
FOR EACH ROW
WHEN (SELECT status FROM daily_rule_set WHERE id = OLD.rule_set_id) NOT IN ('DRAFT_FUTURE', 'DRAFT_TODAY')
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: condition delete rejected');
END;
`,
  },
];
