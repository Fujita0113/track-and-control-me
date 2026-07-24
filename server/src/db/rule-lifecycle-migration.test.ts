import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

/**
 * v19（goal-rule-lifecycle-registry）の移行テスト（tasks 1.8 / design.md Migration Plan 1）。
 * v18 まで適用した DB に旧 rule_condition / practice_threshold_change / goal_practice を仕込み、
 * v19 を流して: (a) 既存条件が1条件=1 rule 行に割り付く／(b) legacy_condition_key が保存される／
 * (c) 過去日評価（unlock_evaluation）は書き換えない／(d) goal_practice→goal_rule・
 * practice_threshold_change→rule_change が移送される／(e) 既に使われなくなった条件は
 * status='removed' で来歴だけ残る、を検証する。
 */

function openAtVersion(target: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const m of MIGRATIONS.filter((x) => x.version <= target).sort((a, b) => a.version - b.version)) {
    if (m.sql) db.exec(m.sql);
    if (m.run) m.run(db);
    db.pragma(`user_version = ${m.version}`);
  }
  return db;
}

function applyMigration(db: Database.Database, version: number): void {
  const m = MIGRATIONS.find((x) => x.version === version);
  if (!m) throw new Error(`migration ${version} not found`);
  const tx = db.transaction(() => {
    if (m.sql) db.exec(m.sql);
    if (m.run) m.run(db);
    db.pragma(`user_version = ${m.version}`);
  });
  tx();
}

/** 凍結ルールセットを1件作る（materialize 済みの FROZEN_ACTIVE として直接挿入）。 */
function seedRuleSet(
  db: Database.Database,
  effectiveDate: string,
  createdAt: number,
  conds: {
    target: string;
    label?: string | null;
    thresholdSeconds?: number | null;
    stableGroupId?: string | null;
    key: string;
    sort: number;
  }[],
): number {
  const info = db
    .prepare(
      `INSERT INTO daily_rule_set (effective_date, combinator, status, content_hash, created_at, updated_at)
       VALUES (?, 'ALL', 'DRAFT_FUTURE', 'h', ?, ?)`,
    )
    .run(effectiveDate, createdAt, createdAt);
  const id = info.lastInsertRowid as number;
  const ins = db.prepare(
    `INSERT INTO rule_condition (rule_set_id, target, comparator, threshold_seconds, label, stable_group_id, signal_key, condition_key, sort_order)
     VALUES (?, ?, 'GTE', ?, ?, ?, NULL, ?, ?)`,
  );
  for (const c of conds)
    ins.run(id, c.target, c.thresholdSeconds ?? null, c.label ?? null, c.stableGroupId ?? null, c.key, c.sort);
  db.prepare("UPDATE daily_rule_set SET status = 'FROZEN_ACTIVE', frozen_at = ? WHERE id = ?").run(createdAt, id);
  return id;
}

function ruleByLegacyKey(db: Database.Database, key: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM rule WHERE legacy_condition_key = ?').get(key) as
    | Record<string, unknown>
    | undefined;
}

describe('v19 goal-rule-lifecycle-registry migration', () => {
  it('既存条件が1条件=1 rule 行に割り付き、legacy_condition_key が保存される', () => {
    const db = openAtVersion(18);
    seedRuleSet(db, '2026-07-01', 100, [
      { target: 'TOTAL_WORK', key: 'total_work', thresholdSeconds: 14400, sort: 0 },
      { target: 'GROUP', key: 'group:broken-uuid', stableGroupId: 'broken-uuid', thresholdSeconds: 7200, sort: 1 },
      { target: 'MANUAL_CHECK', key: 'manual:筋トレ', label: '筋トレ', sort: 2 },
    ]);

    applyMigration(db, 19);

    const total = ruleByLegacyKey(db, 'total_work');
    expect(total).toBeDefined();
    expect(total!.target).toBe('TOTAL_WORK');
    expect(total!.threshold_seconds).toBe(14400);
    expect(total!.status).toBe('active');
    expect(total!.end_day).toBeNull();

    const group = ruleByLegacyKey(db, 'group:broken-uuid');
    expect(group).toBeDefined();
    expect(group!.stable_group_id).toBe('broken-uuid');
    expect(group!.group_identity_id).toBeNull();

    const manual = ruleByLegacyKey(db, 'manual:筋トレ');
    expect(manual).toBeDefined();
    expect(manual!.label).toBe('筋トレ');

    // 1条件=1行（重複生成なし）。
    const count = (db.prepare('SELECT COUNT(*) AS c FROM rule').get() as { c: number }).c;
    expect(count).toBe(3);
    db.close();
  });

  it('過去日の凍結済み評価（unlock_evaluation）は書き換えない', () => {
    const db = openAtVersion(18);
    seedRuleSet(db, '2026-07-01', 100, [{ target: 'TOTAL_WORK', key: 'total_work', thresholdSeconds: 14400, sort: 0 }]);
    const per = JSON.stringify([{ conditionKey: 'total_work', target: 'TOTAL_WORK', met: true, actualSeconds: 20000 }]);
    db.prepare(
      `INSERT INTO unlock_evaluation (day_key, status, conditions_met, per_condition_results, first_met_at, reveal_fired, is_final, updated_at)
       VALUES ('2026-07-01', 'UNLOCKED', 1, ?, 100, 0, 1, 100)`,
    ).run(per);

    applyMigration(db, 19);

    const row = db.prepare('SELECT per_condition_results FROM unlock_evaluation WHERE day_key = ?').get('2026-07-01') as {
      per_condition_results: string;
    };
    expect(row.per_condition_results).toBe(per);
    db.close();
  });

  it('goal_practice → goal_rule、practice_threshold_change → rule_change が移送される', () => {
    const db = openAtVersion(18);
    seedRuleSet(db, '2026-07-01', 100, [{ target: 'TOTAL_WORK', key: 'total_work', thresholdSeconds: 10800, sort: 0 }]);
    db.prepare(
      `INSERT INTO practice_threshold_change (condition_key, effective_date, old_seconds, new_seconds, reason, created_at)
       VALUES ('total_work', '2026-07-13', 14400, 10800, '課題週間。ゼロにはしない', 500)`,
    ).run();
    const goalId = db
      .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('目標', '', '2026-07-01', '2026-07-30', 100).lastInsertRowid as number;
    db.prepare(
      'INSERT INTO goal_practice (goal_id, condition_key, target, sort_order) VALUES (?, ?, ?, 0)',
    ).run(goalId, 'total_work', 'TOTAL_WORK');

    applyMigration(db, 19);

    const rule = ruleByLegacyKey(db, 'total_work')!;
    const link = db
      .prepare('SELECT 1 FROM goal_rule WHERE goal_id = ? AND rule_id = ?')
      .get(goalId, rule.id as number);
    expect(link).toBeDefined();

    const change = db.prepare('SELECT * FROM rule_change WHERE rule_id = ?').get(rule.id as number) as {
      op: string;
      day_key: string;
      before: string;
      after: string;
      reason: string;
    };
    expect(change.op).toBe('update');
    expect(change.day_key).toBe('2026-07-13');
    expect(JSON.parse(change.before)).toEqual({ thresholdSeconds: 14400 });
    expect(JSON.parse(change.after)).toEqual({ thresholdSeconds: 10800 });
    expect(change.reason).toBe('課題週間。ゼロにはしない');
    db.close();
  });

  it('最新ルールセットに無い（既に使われなくなった）条件は status=removed で来歴だけ残す', () => {
    const db = openAtVersion(18);
    // 07-01 にだけ存在し、07-05（最新）には無い条件。
    seedRuleSet(db, '2026-07-01', 100, [
      { target: 'TIMELINE', key: 'timeline:読書', label: '読書', thresholdSeconds: 600, sort: 0 },
      { target: 'TOTAL_WORK', key: 'total_work', thresholdSeconds: 14400, sort: 1 },
    ]);
    seedRuleSet(db, '2026-07-05', 400, [{ target: 'TOTAL_WORK', key: 'total_work', thresholdSeconds: 14400, sort: 0 }]);

    applyMigration(db, 19);

    const removed = ruleByLegacyKey(db, 'timeline:読書')!;
    expect(removed.status).toBe('removed');
    const active = ruleByLegacyKey(db, 'total_work')!;
    expect(active.status).toBe('active');
    db.close();
  });
});
