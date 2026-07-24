/**
 * SQLite マイグレーション（design.md D6）。
 * user_version pragma を版管理に使い、未適用の版を昇順で流す。
 * すべてのタイムスタンプは INTEGER epoch ms(UTC)。day_key は TEXT 'YYYY-MM-DD'。
 */

import type Database from 'better-sqlite3';
import { UNGROUPED_KEY } from '@track/contract';

export interface Migration {
  version: number;
  name: string;
  /** 純 SQL の移行（DDL・単純 DML）。手続き的移行が要るときは `run` を使う。 */
  sql?: string;
  /**
   * 手続き的な移行（読み取り→加工→書き戻し）。`sql` と併用可（sql を先に流す）。
   * migrate() が既に開いたトランザクション内で呼ばれる（呼び出し側で tx を張らないこと）。
   */
  run?: (db: Database.Database) => void;
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
  {
    version: 14,
    name: 'goal-journal-image',
    sql: /* sql */ `
-- 目標日記の画像添付（spec: goal-journal / goal-report / design.md D1）。
-- 画像は同じ DB に BLOB で持ち、goal 削除で CASCADE 自動消去する（孤児ファイル無し・バックアップは DB 1ファイル）。
-- goal_journal へは FK せず goal へ直接 FK する＝本文行が無い日でも画像だけを持てる。
-- caption は任意（空可）。③のペア化キー。sort_order は同一日内の決定的な並び。
CREATE TABLE goal_journal_image (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goal(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',      -- 任意（空可）。③のペア化キー
  mime TEXT NOT NULL,                    -- image/jpeg | image/png | image/webp
  bytes BLOB NOT NULL,                   -- 縮小・再エンコード後の画像
  width INTEGER, height INTEGER,         -- 表示レイアウト用（任意）
  sort_order INTEGER NOT NULL DEFAULT 0, -- 同一日内の添付順（決定的な並び）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_gji ON goal_journal_image(goal_id, day_key);
`,
  },
  {
    version: 15,
    name: 'manual-check-stable-key',
    // MANUAL_CHECK の condition_key を並び順依存の manual:<index> から
    // ラベル由来の安定キー manual:<ラベル> へ移行する（spec: manual-check-stable-key / design D4・D5）。
    // - rule_condition は label 列を持つため、ラベルから直接新キーを作る。
    // - daily_check は index で保存されているので、その日に実効なルールセットを解決し、
    //   (sort_order, id) 順の 0 始まり順位＝旧 index からラベルを引いて振り替える。
    // - 空ラベル／同一ルールセット内の重複ラベル／対応ラベル無し（孤児）は skip＋ログし旧キー据え置き。
    // - 履歴 JSON（unlock_evaluation.per_condition_results）は移行しない（従来 MANUAL_CHECK は採用不可のため参照無し）。
    run: (db) => {
      // 凍結トリガは frozen な rule_condition の UPDATE を ABORT するため、移行中だけ外して張り直す。
      db.exec('DROP TRIGGER IF EXISTS trg_rule_cond_no_update_when_frozen');
      try {
        interface Mapped {
          label: string;
          key: string;
          condId: number;
        }
        // rule_set_id -> Map(旧index -> Mapped | null=衝突で skip)
        const perSet = new Map<number, Map<number, Mapped | null>>();
        const ruleSets = db.prepare('SELECT id FROM daily_rule_set').all() as { id: number }[];
        for (const rs of ruleSets) {
          const conds = db
            .prepare('SELECT id, target, label FROM rule_condition WHERE rule_set_id = ? ORDER BY sort_order, id')
            .all(rs.id) as { id: number; target: string; label: string | null }[];
          const idxMap = new Map<number, Mapped | null>();
          const labelCount = new Map<string, number>();
          // (sort_order, id) 順の 0 始まり順位＝旧 index（design D5）。
          conds.forEach((c, index) => {
            if (c.target !== 'MANUAL_CHECK') return;
            const label = (c.label ?? '').trim();
            idxMap.set(index, label ? { label, key: `manual:${label}`, condId: c.id } : null);
            if (label) labelCount.set(label, (labelCount.get(label) ?? 0) + 1);
          });
          // ルールセット内で重複するラベルは衝突として全て skip（旧キー据え置き）。
          for (const [index, v] of idxMap) {
            if (v && (labelCount.get(v.label) ?? 0) > 1) {
              console.warn(
                `[migration 15] duplicate MANUAL_CHECK label "${v.label}" in rule_set ${rs.id}; skipping`,
              );
              idxMap.set(index, null);
            }
          }
          perSet.set(rs.id, idxMap);
        }

        // (3.2) rule_condition.condition_key を新キーへ更新（衝突・空ラベルは据え置き）。
        const updCond = db.prepare('UPDATE rule_condition SET condition_key = ? WHERE id = ?');
        for (const [, idxMap] of perSet) {
          for (const [, v] of idxMap) {
            if (v) updCond.run(v.key, v.condId);
          }
        }

        // (3.3) daily_check: 旧 manual:<index> を、その日に実効なルールセットの index→ラベルで振り替える。
        const dcRows = db
          .prepare("SELECT id, day_key, condition_key FROM daily_check WHERE condition_key LIKE 'manual:%'")
          .all() as { id: number; day_key: string; condition_key: string }[];
        const effStmt = db.prepare(
          'SELECT id FROM daily_rule_set WHERE effective_date <= ? ORDER BY effective_date DESC LIMIT 1',
        );
        const clashStmt = db.prepare(
          'SELECT 1 FROM daily_check WHERE day_key = ? AND condition_key = ? AND id <> ?',
        );
        const updCheck = db.prepare('UPDATE daily_check SET condition_key = ? WHERE id = ?');
        for (const r of dcRows) {
          const rest = r.condition_key.slice('manual:'.length);
          const index = Number(rest);
          // 既に manual:<ラベル> 形式（非整数サフィックス）は対象外。
          if (!Number.isInteger(index) || String(index) !== rest) continue;
          const eff = effStmt.get(r.day_key) as { id: number } | undefined;
          const mapped = eff ? perSet.get(eff.id)?.get(index) : undefined;
          if (!mapped) {
            console.warn(
              `[migration 15] no MANUAL_CHECK label for ${r.condition_key} on ${r.day_key}; leaving as-is`,
            );
            continue; // 孤児キー・衝突は据え置き（削除しない）。
          }
          // 振替先キーが同日に既存なら UNIQUE(day_key, condition_key) 衝突を避けて据え置き。
          if (clashStmt.get(r.day_key, mapped.key, r.id)) {
            console.warn(
              `[migration 15] target key ${mapped.key} already exists on ${r.day_key}; leaving ${r.condition_key} as-is`,
            );
            continue;
          }
          updCheck.run(mapped.key, r.id);
        }
      } finally {
        // 外したトリガを v13 と同一定義で張り直す。
        db.exec(`
CREATE TRIGGER trg_rule_cond_no_update_when_frozen
BEFORE UPDATE ON rule_condition
FOR EACH ROW
WHEN (SELECT status FROM daily_rule_set WHERE id = OLD.rule_set_id) NOT IN ('DRAFT_FUTURE', 'DRAFT_TODAY')
BEGIN
  SELECT RAISE(ABORT, 'frozen rule set: condition update rejected');
END;`);
      }
    },
  },
  {
    version: 16,
    name: 'task-category',
    sql: /* sql */ `
-- かんばんタスクのカテゴリ（spec: kanban-task-category / design.md D1・D2）。
-- タブグループ由来のカテゴリを「UUID照合＋名前色スナップショット」の両持ちで焼き込む
-- （session の stable_group_id + tab_group_name_snapshot + group_color_snapshot と同型）。
-- 加算的移行（すべて NULL 許容）で既存タスクはカテゴリ無し＝従来挙動。集計・評価・rollover・
-- 解錠・目標追跡には非接続（表示・保存のみ）。
--   category_group_id … 照合キー＝タブグループの stable_group_id（UUID）。自由入力/その他は NULL。
--   category_name      … 表示スナップショット（グループ名 or 手入力 or「その他」）。
--   category_color     … 表示スナップショット。制約なし TEXT（enum/CHECK で縛らない・D2）。
ALTER TABLE task ADD COLUMN category_group_id TEXT;
ALTER TABLE task ADD COLUMN category_name TEXT;
ALTER TABLE task ADD COLUMN category_color TEXT;
`,
  },
  {
    version: 17,
    name: 'goal-plan-check',
    sql: /* sql */ `
-- Plan（賭け）と Check（答え合わせ）（spec: goal-plan-check / goal-check-gate / goal-chronicle /
-- design.md D1・D2・D9）。日次ルールセット（rule_condition）からは独立させる＝継承・凍結
-- ロジックと衝突させない。評価時に合成条件 'check:<id>' として注入する（D4）。
--
-- 達成状態は永続化しない（D2）。goal_check.status に持つのは終端の 'cancelled' のみで、
-- 「有効か／met か」は (check, dayKey) から遅延導出する＝日次 cron に依存せずオンデマンド起動でも正しい。

-- Plan: 短文の賭け。種別カラムは持たない（本文を読めば分かる・spec: 種別選択を設けてはならない）。
CREATE TABLE goal_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goal(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,                    -- 記録が属する固定 day_key
  body TEXT NOT NULL,                       -- 非空（サービス層で検証）
  status TEXT NOT NULL DEFAULT 'active',    -- active|withdrawn（withdrawn は終端・D9）
  withdraw_reason TEXT,                     -- withdrawn のとき非空（沿革に残す）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_goal_plan_goal ON goal_plan(goal_id, day_key, id);

-- Check: 種類（kind）と いつ（schedule）の独立した2軸（spec）。全4通りが作れる。
--   kind=photo    … caption 非空（先指定・後から変更不可）。提出画像の保存キャプションになる（D5）。
--   kind=question … question_text 非空。
--   schedule=single … start_day_key のみ。達成するまで繰り越す（D3）。
--   schedule=range  … [start_day_key, +span_days)。その日限り・繰り越さない（D3）。
-- place_note / time_note は説明メタデータのみで判定に一切使わない（D8）。
CREATE TABLE goal_check (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES goal_plan(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- photo|question
  caption TEXT NOT NULL DEFAULT '',         -- kind=photo のとき非空
  question_text TEXT NOT NULL DEFAULT '',   -- kind=question のとき非空
  schedule TEXT NOT NULL,                   -- single|range
  start_day_key TEXT NOT NULL,              -- 相対・絶対どちらの入力も固定 day_key へ解決済み
  span_days INTEGER,                        -- schedule=range のとき >= 2。single は NULL
  place_note TEXT,                          -- 判定に使わない（D8）
  time_note TEXT,                           -- 判定に使わない（D8）
  status TEXT NOT NULL DEFAULT 'active',    -- active|cancelled（cancelled のみ永続・D2/D9）
  cancel_reason TEXT,                       -- cancelled のとき非空（沿革に残す）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_goal_check_plan ON goal_check(plan_id, id);
CREATE INDEX idx_goal_check_start ON goal_check(start_day_key);

-- Check への回答。(check_id, day_key) 一意＝1日1回答。
--   写真Check … image_id（goal_journal_image へ先指定キャプションで保存した1枚・D5）
--   質問Check … answer_text（非空）
-- 画像行が消えても回答の事実は残す（ON DELETE SET NULL）。
CREATE TABLE goal_check_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id INTEGER NOT NULL REFERENCES goal_check(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  image_id INTEGER REFERENCES goal_journal_image(id) ON DELETE SET NULL,
  answer_text TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (check_id, day_key)
);
CREATE INDEX idx_goal_check_result_check ON goal_check_result(check_id, day_key);
`,
  },
  {
    version: 18,
    name: 'group-rule-snapshot-identity',
    // グループ identity レジストリ（spec: group-identity-registry / design.md D1）。
    // 記録時点スナップショット (tab_group_name_snapshot, group_color_snapshot) を安定した内部 identity
    // へ解決する。拡張機能が採番する stable_group_id には依存しない（そちらは壊れている・proposal.md）。
    // color は別名表の複合主キーに使うため NOT NULL DEFAULT ''（NULL は UNIQUE/PK 判定で常に非一致になる
    // SQLite の性質を避けるため、summary.ts の COALESCE(color,'') 規約とキーを揃える）。
    sql: /* sql */ `
CREATE TABLE group_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE group_identity_alias (
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  identity_id INTEGER NOT NULL REFERENCES group_identity(id) ON DELETE CASCADE,
  since INTEGER NOT NULL,
  PRIMARY KEY (name, color)
);
CREATE INDEX idx_group_identity_alias_identity ON group_identity_alias(identity_id);

-- 解錠ルール条件の identity 参照（spec: group-rule-identity）。既存 stable_group_id 列は後方互換で残す。
ALTER TABLE rule_condition ADD COLUMN group_identity_id INTEGER;
`,
    // 既存 session の distinct (tab_group_name_snapshot, group_color_snapshot)（空名・未グループを除く）から
    // identity と別名を初期構築する（design.md Migration Plan 2）。既存 session / daily_totals_snapshot /
    // unlock_evaluation の行は一切書き換えない。改名履歴は推測できないため、初期構築時の別名は
    // identity ごとに1組（(name,color) そのもの）とする。
    run: (db) => {
      const rows = db
        .prepare(
          `SELECT tab_group_name_snapshot AS name, COALESCE(group_color_snapshot, '') AS color,
                  MIN(started_at) AS first_seen, MAX(started_at) AS last_seen
             FROM session
            WHERE stable_group_id <> ? AND tab_group_name_snapshot <> ''
            GROUP BY tab_group_name_snapshot, COALESCE(group_color_snapshot, '')`,
        )
        .all(UNGROUPED_KEY) as { name: string; color: string; first_seen: number; last_seen: number }[];

      const insIdentity = db.prepare(
        'INSERT INTO group_identity (name, color, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
      );
      const insAlias = db.prepare(
        'INSERT INTO group_identity_alias (name, color, identity_id, since) VALUES (?, ?, ?, ?)',
      );
      for (const r of rows) {
        const info = insIdentity.run(r.name, r.color || null, r.first_seen, r.last_seen);
        insAlias.run(r.name, r.color, info.lastInsertRowid as number, r.first_seen);
      }
    },
  },
];
