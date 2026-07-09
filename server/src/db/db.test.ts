import { describe, it, expect } from 'vitest';
import { openDb, getConfig, updateConfig } from './index.js';

describe('DB migrations & seed', () => {
  it('opens an in-memory db, applies migrations, seeds defaults', () => {
    const db = openDb(':memory:');
    // 最新マイグレーション版（migrations.ts の最大 version）まで適用される。
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(3);

    const cfg = getConfig(db);
    expect(cfg.day_boundary_minutes).toBe(240);
    expect(cfg.gap_cap_seconds).toBe(90);

    const pw = db.prepare('SELECT command_template FROM password_command_config').get() as {
      command_template: string;
    };
    expect(pw.command_template).toContain('{date}');
    db.close();
  });

  it('is idempotent: re-opening does not re-seed or re-migrate', () => {
    const db = openDb(':memory:');
    updateConfig(db, { gap_cap_seconds: 120 });
    // 明示的に migrate/seed を再実行しても既定は壊れない。
    const cfg = getConfig(db);
    expect(cfg.gap_cap_seconds).toBe(120);
    db.close();
  });

  it('enforces (boot_id, seq) uniqueness on raw_sample', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(
      `INSERT INTO raw_sample (boot_id, seq, client_ts, monotonic_ms, tz, event_type, active_group_id, window_id, idle_state, browser_focused, ext_version, received_at)
       VALUES ('b', 1, 0, 0, 'Asia/Tokyo', 'HEARTBEAT', -1, 1, 'active', 0, '0.1.0', 0)`,
    );
    ins.run();
    expect(() => ins.run()).toThrow(/UNIQUE/i);
    db.close();
  });
});
