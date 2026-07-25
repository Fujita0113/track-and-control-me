import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

/**
 * v23（split-collapsed-shared-rules）の移行テスト（issue #64）。
 * v19 の畳み込みで独立した複数目標が同一 rule を共有してしまう状態を仕込み、v23 を流して
 * (a) 独立目標が別々の rule に分離される／(b) 沿革（rule_change）が複製先へコピーされ連動しなくなる／
 * (c) legacy_condition_key が引き継がれ凍結日の解決が保てる／(d) 継続チェインの共有は分割しない、を検証する。
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

function makeGoal(db: Database.Database, name: string, continuedGoalId: number | null = null): number {
  const id = db
    .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, '', '2026-07-01', '2026-07-30', 100).lastInsertRowid as number;
  if (continuedGoalId != null)
    db.prepare('UPDATE goal SET continued_goal_id = ? WHERE id = ?').run(continuedGoalId, id);
  return id;
}

/** legacy 由来（legacy_condition_key 付き）の GROUP ルールを1件作る。 */
function makeLegacyRule(db: Database.Database, legacyKey: string): number {
  return db
    .prepare(
      `INSERT INTO rule
         (target, comparator, threshold_seconds, label, signal_key, stable_group_id, group_identity_id,
          caption, question_text, start_day, end_day, status, legacy_condition_key, created_at)
       VALUES ('GROUP', 'GTE', 900, NULL, NULL, NULL, NULL, NULL, NULL, '2026-07-01', NULL, 'active', ?, 100)`,
    )
    .run(legacyKey).lastInsertRowid as number;
}

function link(db: Database.Database, goalId: number, ruleId: number): void {
  db.prepare('INSERT OR IGNORE INTO goal_rule (goal_id, rule_id) VALUES (?, ?)').run(goalId, ruleId);
}

function ruleIdsOfGoal(db: Database.Database, goalId: number): number[] {
  return (db.prepare('SELECT rule_id FROM goal_rule WHERE goal_id = ? ORDER BY rule_id').all(goalId) as {
    rule_id: number;
  }[]).map((r) => r.rule_id);
}

describe('v23 split-collapsed-shared-rules migration', () => {
  it('独立した2目標が共有していた legacy ルールを別々の rule に分離する', () => {
    const db = openAtVersion(22);
    const g1 = makeGoal(db, '設計理解をしたい');
    const g2 = makeGoal(db, '茶色取りたい');
    const shared = makeLegacyRule(db, 'group:70d5');
    link(db, g1, shared);
    link(db, g2, shared);

    applyMigration(db, 23);

    const r1 = ruleIdsOfGoal(db, g1);
    const r2 = ruleIdsOfGoal(db, g2);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r1[0]).not.toBe(r2[0]); // 別 identity に分かれた。
    // 片方は元ルールを保持（最小 goal id 側）、もう片方は複製。
    expect([r1[0], r2[0]]).toContain(shared);
    // 複製先も同じ中身（target・閾値・legacy キー）を引き継ぐ。
    const cloneId = r1[0] === shared ? r2[0]! : r1[0]!;
    const clone = db.prepare('SELECT * FROM rule WHERE id = ?').get(cloneId) as Record<string, unknown>;
    expect(clone.target).toBe('GROUP');
    expect(clone.threshold_seconds).toBe(900);
    expect(clone.legacy_condition_key).toBe('group:70d5'); // 凍結日の解決を保つ。
    db.close();
  });

  it('共有ルールの沿革（rule_change）が複製先へコピーされ、編集が連動しなくなる', () => {
    const db = openAtVersion(22);
    const g1 = makeGoal(db, 'A');
    const g2 = makeGoal(db, 'B');
    const shared = makeLegacyRule(db, 'group:xyz');
    link(db, g1, shared);
    link(db, g2, shared);
    db.prepare(
      `INSERT INTO rule_change (rule_id, day_key, op, before, after, reason, created_at)
       VALUES (?, '2026-07-10', 'update', ?, ?, '閾値を上げた', 200)`,
    ).run(shared, JSON.stringify({ thresholdSeconds: 600 }), JSON.stringify({ thresholdSeconds: 900 }));

    applyMigration(db, 23);

    const cloneId = ruleIdsOfGoal(db, g2)[0]!;
    // 両ルールが独立した沿革を1件ずつ持つ（合計2件）。
    const changesShared = db.prepare('SELECT * FROM rule_change WHERE rule_id = ?').all(shared) as { reason: string }[];
    const changesClone = db.prepare('SELECT * FROM rule_change WHERE rule_id = ?').all(cloneId) as { reason: string }[];
    expect(changesShared).toHaveLength(1);
    expect(changesClone).toHaveLength(1);
    expect(changesClone[0]!.reason).toBe('閾値を上げた');

    // 片方だけを編集しても、もう片方の沿革は増えない（identity が分離した証拠）。
    db.prepare(
      `INSERT INTO rule_change (rule_id, day_key, op, before, after, reason, created_at)
       VALUES (?, '2026-07-11', 'update', NULL, NULL, '片方だけの編集', 300)`,
    ).run(cloneId);
    expect(db.prepare('SELECT COUNT(*) c FROM rule_change WHERE rule_id = ?').get(shared)).toEqual({ c: 1 });
    db.close();
  });

  it('継続チェイン（continued_goal_id）で連結する目標群の共有は分割しない', () => {
    const db = openAtVersion(22);
    const g1 = makeGoal(db, '旧サイクル');
    const g2 = makeGoal(db, '新サイクル', g1); // g2 は g1 の継続
    const shared = makeLegacyRule(db, 'group:cont');
    link(db, g1, shared);
    link(db, g2, shared);

    applyMigration(db, 23);

    // 同一継続チェインなので共有のまま（正当な共有）。
    expect(ruleIdsOfGoal(db, g1)).toEqual([shared]);
    expect(ruleIdsOfGoal(db, g2)).toEqual([shared]);
    db.close();
  });

  it('non-legacy（新規作成）ルールの共有は分割対象にしない', () => {
    const db = openAtVersion(22);
    const g1 = makeGoal(db, 'A');
    const g2 = makeGoal(db, 'B');
    const rule = db
      .prepare(
        `INSERT INTO rule
           (target, comparator, threshold_seconds, start_day, end_day, status, legacy_condition_key, created_at)
         VALUES ('GROUP', 'GTE', 900, '2026-07-01', NULL, 'active', NULL, 100)`,
      )
      .run().lastInsertRowid as number;
    link(db, g1, rule);
    link(db, g2, rule);

    applyMigration(db, 23);

    // legacy_condition_key IS NULL は対象外（継続共有のみが non-legacy 共有を作りうる）。
    expect(ruleIdsOfGoal(db, g1)).toEqual([rule]);
    expect(ruleIdsOfGoal(db, g2)).toEqual([rule]);
    db.close();
  });
});
