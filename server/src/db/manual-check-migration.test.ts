import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

/**
 * v15（manual-check-stable-key）の移行テスト（tasks 3.5 / spec: manual-check-stable-key）。
 * v14 まで適用した DB に旧 manual:<index> の rule_condition・daily_check を仕込み、
 * v15 を流して: (a) rule_condition のキーが manual:<ラベル> になる／(b) daily_check の
 * チェック状態が保持されつつキーが振り替わる／(c) 孤児・重複は据え置き、を検証する。
 */

/** MIGRATIONS を target まで適用した in-memory DB を返す。 */
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

/** 指定 version の1マイグレーションだけを（migrate() と同じ形で）トランザクション適用する。 */
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

/**
 * 凍結ルールセットを1件作る（DRAFT_FUTURE で条件を入れてから FROZEN_ACTIVE へ確定）。
 * 凍結の INSERT トリガを避けるため、条件挿入は draft のうちに行う。
 */
function seedFrozenRuleSet(
  db: Database.Database,
  effectiveDate: string,
  conds: { target: string; label: string | null; key: string; sort: number }[],
): number {
  const info = db
    .prepare(
      `INSERT INTO daily_rule_set (effective_date, combinator, status, content_hash, created_at, updated_at)
       VALUES (?, 'ALL', 'DRAFT_FUTURE', 'h', 0, 0)`,
    )
    .run(effectiveDate);
  const id = info.lastInsertRowid as number;
  const ins = db.prepare(
    `INSERT INTO rule_condition (rule_set_id, target, comparator, threshold_seconds, label, signal_key, condition_key, sort_order)
     VALUES (?, ?, 'GTE', NULL, ?, NULL, ?, ?)`,
  );
  for (const c of conds) ins.run(id, c.target, c.label, c.key, c.sort);
  db.prepare("UPDATE daily_rule_set SET status = 'FROZEN_ACTIVE', frozen_at = 0 WHERE id = ?").run(id);
  return id;
}

function seedCheck(db: Database.Database, dayKey: string, key: string, checked: number): void {
  db.prepare(
    'INSERT INTO daily_check (day_key, condition_key, checked, checked_at) VALUES (?, ?, ?, ?)',
  ).run(dayKey, key, checked, checked ? 1 : null);
}

const keysInSet = (db: Database.Database, rsId: number): string[] =>
  (db.prepare('SELECT condition_key FROM rule_condition WHERE rule_set_id = ? ORDER BY sort_order').all(rsId) as {
    condition_key: string;
  }[]).map((r) => r.condition_key);

const check = (db: Database.Database, dayKey: string, key: string): number | undefined =>
  (db.prepare('SELECT checked FROM daily_check WHERE day_key = ? AND condition_key = ?').get(dayKey, key) as
    | { checked: number }
    | undefined)?.checked;

describe('v15 manual-check-stable-key migration', () => {
  it('rule_condition の manual:<index> が manual:<ラベル> になり、daily_check の状態が保持される', () => {
    const db = openAtVersion(14);
    // 凍結ルールセット: total_work(0), 筋トレ(1), 瞑想(2)。
    const rsId = seedFrozenRuleSet(db, '2026-07-01', [
      { target: 'TOTAL_WORK', label: null, key: 'total_work', sort: 0 },
      { target: 'MANUAL_CHECK', label: '筋トレ', key: 'manual:1', sort: 1 },
      { target: 'MANUAL_CHECK', label: '瞑想', key: 'manual:2', sort: 2 },
    ]);
    // 当日チェック: 筋トレ=済/瞑想=未（同日）＋持ち越し日（07-05）の筋トレ=済。
    seedCheck(db, '2026-07-01', 'manual:1', 1);
    seedCheck(db, '2026-07-01', 'manual:2', 0);
    seedCheck(db, '2026-07-05', 'manual:1', 1); // 実効ルールは持ち越しで 07-01 のもの

    applyMigration(db, 15);

    // (a) rule_condition のキーがラベル由来へ。manual:<index> は残らない。
    expect(keysInSet(db, rsId)).toEqual(['total_work', 'manual:筋トレ', 'manual:瞑想']);

    // (b) daily_check が振り替わり、チェック状態は保持。
    expect(check(db, '2026-07-01', 'manual:筋トレ')).toBe(1);
    expect(check(db, '2026-07-01', 'manual:瞑想')).toBe(0);
    expect(check(db, '2026-07-05', 'manual:筋トレ')).toBe(1); // 持ち越し解決
    // 旧キーは残っていない。
    expect(check(db, '2026-07-01', 'manual:1')).toBeUndefined();
    expect(check(db, '2026-07-01', 'manual:2')).toBeUndefined();
    expect(check(db, '2026-07-05', 'manual:1')).toBeUndefined();

    // manual:<index> 形式が daily_check 全体に残っていない。
    const leftover = db
      .prepare("SELECT COUNT(*) AS c FROM daily_check WHERE condition_key GLOB 'manual:[0-9]*'")
      .get() as { c: number };
    expect(leftover.c).toBe(0);
    db.close();
  });

  it('孤児キー（対応ラベル無し）は据え置く', () => {
    const db = openAtVersion(14);
    seedFrozenRuleSet(db, '2026-07-01', [
      { target: 'MANUAL_CHECK', label: '筋トレ', key: 'manual:0', sort: 0 },
    ]);
    seedCheck(db, '2026-07-01', 'manual:0', 1);
    seedCheck(db, '2026-07-01', 'manual:9', 1); // index 9 に対応条件なし → 孤児

    applyMigration(db, 15);

    expect(check(db, '2026-07-01', 'manual:筋トレ')).toBe(1);
    expect(check(db, '2026-07-01', 'manual:9')).toBe(1); // 据え置き（削除しない）
    db.close();
  });

  it('同一ルールセット内の重複ラベルは衝突として旧キー据え置き', () => {
    const db = openAtVersion(14);
    const rsId = seedFrozenRuleSet(db, '2026-08-01', [
      { target: 'MANUAL_CHECK', label: '走る', key: 'manual:0', sort: 0 },
      { target: 'MANUAL_CHECK', label: '走る', key: 'manual:1', sort: 1 },
    ]);
    seedCheck(db, '2026-08-01', 'manual:0', 1);

    applyMigration(db, 15);

    // 重複ラベルは両方 skip（旧キーのまま）。
    expect(keysInSet(db, rsId)).toEqual(['manual:0', 'manual:1']);
    expect(check(db, '2026-08-01', 'manual:0')).toBe(1); // 据え置き
    db.close();
  });

  it('空ラベルの手動チェックは manual: にせず旧キーを据え置く', () => {
    const db = openAtVersion(14);
    const rsId = seedFrozenRuleSet(db, '2026-09-01', [
      { target: 'MANUAL_CHECK', label: '  ', key: 'manual:0', sort: 0 },
    ]);
    seedCheck(db, '2026-09-01', 'manual:0', 1);

    applyMigration(db, 15);

    expect(keysInSet(db, rsId)).toEqual(['manual:0']); // 空ラベルは据え置き
    expect(check(db, '2026-09-01', 'manual:0')).toBe(1);
    db.close();
  });
});
