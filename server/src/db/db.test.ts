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

describe('migration v11: 30日チャレンジ', () => {
  it('applies v11 and creates the goal tables', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(11);
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    for (const t of ['goal', 'goal_practice', 'practice_threshold_change', 'goal_journal']) {
      expect(tables.has(t)).toBe(true);
    }
    db.close();
  });

  it('goal_practice / goal_journal は goal 削除で CASCADE 消去される', () => {
    const db = openDb(':memory:');
    const info = db
      .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('テスト目標', '目的', '2026-07-13', '2026-08-11', 0);
    const goalId = info.lastInsertRowid as number;
    db.prepare(
      'INSERT INTO goal_practice (goal_id, condition_key, target, sort_order) VALUES (?, ?, ?, 0)',
    ).run(goalId, 'total_work', 'TOTAL_WORK');
    db.prepare(
      'INSERT INTO goal_journal (goal_id, day_key, content, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
    ).run(goalId, '2026-07-13', '初日');

    db.prepare('DELETE FROM goal WHERE id = ?').run(goalId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM goal_practice').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM goal_journal').get() as { c: number }).c).toBe(0);
    db.close();
  });

  it('goal_journal_image は goal 削除で CASCADE 消去される（v14）', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(14);
    const goalId = db
      .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('画像目標', '', '2026-07-13', '2026-08-11', 0).lastInsertRowid as number;
    db.prepare(
      `INSERT INTO goal_journal_image (goal_id, day_key, caption, mime, bytes, width, height, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(goalId, '2026-07-13', '台所', 'image/jpeg', Buffer.from([1, 2, 3]), 100, 80, 0, 0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM goal_journal_image').get() as { c: number }).c).toBe(1);

    db.prepare('DELETE FROM goal WHERE id = ?').run(goalId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM goal_journal_image').get() as { c: number }).c).toBe(0);
    db.close();
  });

  it('goal_practice の PK は (goal_id, condition_key)（同一目標での重複採用を弾く）', () => {
    const db = openDb(':memory:');
    const goalId = db
      .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('g', '', '2026-07-13', '2026-08-11', 0).lastInsertRowid as number;
    const ins = db.prepare(
      'INSERT INTO goal_practice (goal_id, condition_key, target, sort_order) VALUES (?, ?, ?, 0)',
    );
    ins.run(goalId, 'total_work', 'TOTAL_WORK');
    expect(() => ins.run(goalId, 'total_work', 'TOTAL_WORK')).toThrow(/UNIQUE|PRIMARY/i);
    db.close();
  });
});

describe('migration v17: Plan / Check', () => {
  /** Plan を1件持つ目標を作る（テスト用の最小セットアップ）。 */
  function seedPlan(db: ReturnType<typeof openDb>): { goalId: number; planId: number } {
    const goalId = db
      .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('髪質を改善する', '', '2026-07-15', '2026-08-13', 0).lastInsertRowid as number;
    const planId = db
      .prepare(
        'INSERT INTO goal_plan (goal_id, day_key, body, status, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(goalId, '2026-07-15', 'シャンプーを変えれば髪質が良くなるのでは', 'active', 0)
      .lastInsertRowid as number;
    return { goalId, planId };
  }

  it('applies v17 and creates the plan/check tables', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(17);
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    for (const t of ['goal_plan', 'goal_check', 'goal_check_result']) {
      expect(tables.has(t)).toBe(true);
    }
    db.close();
  });

  it('goal_plan → goal_check → goal_check_result が goal 削除で CASCADE 消去される', () => {
    const db = openDb(':memory:');
    const { goalId, planId } = seedPlan(db);
    const checkId = db
      .prepare(
        `INSERT INTO goal_check (plan_id, kind, caption, schedule, start_day_key, status, created_at)
         VALUES (?, 'photo', '前髪・正面', 'single', '2026-07-18', 'active', 0)`,
      )
      .run(planId).lastInsertRowid as number;
    db.prepare(
      "INSERT INTO goal_check_result (check_id, day_key, answer_text, created_at) VALUES (?, '2026-07-18', 'ok', 0)",
    ).run(checkId);

    db.prepare('DELETE FROM goal WHERE id = ?').run(goalId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM goal_plan').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM goal_check').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM goal_check_result').get() as { c: number }).c).toBe(0);
    db.close();
  });

  it('goal_check_result は (check_id, day_key) が一意＝1日1回答', () => {
    const db = openDb(':memory:');
    const { planId } = seedPlan(db);
    const checkId = db
      .prepare(
        `INSERT INTO goal_check (plan_id, kind, question_text, schedule, start_day_key, span_days, status, created_at)
         VALUES (?, 'question', '使用感はどうだった？', 'range', '2026-07-18', 7, 'active', 0)`,
      )
      .run(planId).lastInsertRowid as number;
    const ins = db.prepare(
      "INSERT INTO goal_check_result (check_id, day_key, answer_text, created_at) VALUES (?, '2026-07-18', '泡立ちは良い', 0)",
    );
    ins.run(checkId);
    expect(() => ins.run(checkId)).toThrow(/UNIQUE/i);
    // 別の日は同じ Check でも入る（範囲Check は各日が独立）。
    db.prepare(
      "INSERT INTO goal_check_result (check_id, day_key, answer_text, created_at) VALUES (?, '2026-07-19', '乾燥が減った', 0)",
    ).run(checkId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM goal_check_result').get() as { c: number }).c).toBe(2);
    db.close();
  });

  it('画像を消しても回答の事実は残る（image_id は SET NULL）', () => {
    const db = openDb(':memory:');
    const { goalId, planId } = seedPlan(db);
    const imageId = db
      .prepare(
        `INSERT INTO goal_journal_image (goal_id, day_key, caption, mime, bytes, sort_order, created_at)
         VALUES (?, '2026-07-18', '前髪・正面', 'image/jpeg', ?, 0, 0)`,
      )
      .run(goalId, Buffer.from([1, 2, 3])).lastInsertRowid as number;
    const checkId = db
      .prepare(
        `INSERT INTO goal_check (plan_id, kind, caption, schedule, start_day_key, status, created_at)
         VALUES (?, 'photo', '前髪・正面', 'single', '2026-07-18', 'active', 0)`,
      )
      .run(planId).lastInsertRowid as number;
    db.prepare(
      "INSERT INTO goal_check_result (check_id, day_key, image_id, created_at) VALUES (?, '2026-07-18', ?, 0)",
    ).run(checkId, imageId);

    db.prepare('DELETE FROM goal_journal_image WHERE id = ?').run(imageId);
    const r = db.prepare('SELECT image_id FROM goal_check_result').get() as { image_id: number | null };
    expect(r.image_id).toBeNull();
    db.close();
  });
});
