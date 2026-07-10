import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

export type DB = Database.Database;

/**
 * DB を開き、PRAGMA 設定＋未適用マイグレーションを適用し、既定行を seed する。
 * path=':memory:' でテスト用のインメモリ DB を作れる。
 */
export function openDb(path: string, opts: { seed?: boolean } = {}): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  if (opts.seed !== false) seedDefaults(db);
  return db;
}

/** user_version を見て未適用の版だけをトランザクションで流す。 */
export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    run();
  }
}

/** 初回起動時に必要な既定行（AppConfig / 既定カテゴリ / 既定 PW コマンド）を入れる。 */
export function seedDefaults(db: DB): void {
  const now = Date.now();

  const hasConfig = db.prepare('SELECT 1 FROM app_config WHERE id = 1').get();
  if (!hasConfig) {
    db.prepare(
      `INSERT INTO app_config (id, updated_at) VALUES (1, ?)`,
    ).run(now);
  }

  // カテゴリ層は撤廃済み（eliminate-categories）。category テーブルは dormant のため seed しない。

  const pwCount = db.prepare('SELECT COUNT(*) AS c FROM password_command_config').get() as { c: number };
  if (pwCount.c === 0) {
    // 既定は ref/gen_password.ps1（pwsh -NoProfile -File ... -Date {date} → 6桁hex）。
    db.prepare(
      `INSERT INTO password_command_config (command_template, working_dir, timeout_seconds, version, is_active, created_at)
       VALUES (@t, @wd, @to, 1, 1, @now)`,
    ).run({
      t: 'pwsh -NoProfile -File ref/gen_password.ps1 -Date {date}',
      wd: null,
      to: 15,
      now,
    });
  }

  // salt が空なら乱数 salt を生成（平文ハッシュ用）。crypto は呼び出し側で。
}

// --- AppConfig 読み書き ----------------------------------------------------

export interface AppConfigRow {
  id: number;
  tz: string;
  day_boundary_minutes: number;
  heartbeat_seconds: number;
  idle_detection_seconds: number;
  gap_cap_seconds: number;
  concurrency_policy: string;
  include_ungrouped_in_split: number;
  undefined_day_policy: string;
  reveal_yesterday: number;
  ws_port: number;
  shared_token: string;
  session_coalesce_seconds: number;
  /** 「記録すべき離席」の最小秒数（timeline-revamp D2）。既定 600。 */
  away_min_seconds: number;
  planning_require_reflection: number;
  planning_min_tomorrow_tasks: number;
  password_hash_salt: string;
  updated_at: number;
}

export function getConfig(db: DB): AppConfigRow {
  const row = db.prepare('SELECT * FROM app_config WHERE id = 1').get() as AppConfigRow | undefined;
  if (!row) throw new Error('app_config が未初期化です');
  return row;
}

export function updateConfig(db: DB, patch: Partial<Omit<AppConfigRow, 'id'>>): AppConfigRow {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (keys.length > 0) {
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE app_config SET ${set}, updated_at = @updated_at WHERE id = 1`).run({
      ...patch,
      updated_at: Date.now(),
    });
  }
  return getConfig(db);
}

/** AppConfig を aggregation の設定へ写像する。 */
export function toAggregationConfig(cfg: AppConfigRow): {
  gapCapMs: number;
  dayBoundaryMinutes: number;
  tz: string;
  includeUngroupedInSplit: boolean;
  clockJumpToleranceMs: number;
} {
  return {
    gapCapMs: cfg.gap_cap_seconds * 1000,
    dayBoundaryMinutes: cfg.day_boundary_minutes,
    tz: cfg.tz,
    includeUngroupedInSplit: cfg.include_ungrouped_in_split === 1,
    clockJumpToleranceMs: 2_000,
  };
}
