import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { upsertFutureRuleSet } from './rules.js';
import { evaluateDay } from './evaluate.js';
import { resolveIdentity, renameIdentity } from '../services/group-identity.js';
import { daySummary } from '../services/summary.js';

/**
 * GROUP 条件の identity 化された評価（spec: group-rule-identity / design.md D2）。
 * 内訳（today-group-breakdown）と同一源泉（session.credited_ms）で判定されること、
 * 別名（改名前の名前）が合算されること、旧 group:<uuid> 条件は従来経路のまま不変であることを担保する。
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h: number, mi: number) =>
  zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);
const DAY = '2026-07-20';
const NOW = jst(2026, 7, 19, 12, 0); // 前日にコミット → 当日は凍結扱いで評価される。

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function seedSession(
  d: DB,
  name: string,
  color: string | null,
  startAt: number,
  endAt: number,
  creditedMs = endAt - startAt,
): void {
  resolveIdentity(d, name, color); // recompute.ts 相当（セッション確定時の identity 解決）。
  d.prepare(
    `INSERT INTO session
      (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
       started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES ('sg', ?, ?, NULL, ?, ?, ?, '[]', 1, ?, 'NORMAL', ?)`,
  ).run(name, color, startAt, endAt, DAY, creditedMs, endAt);
}

function seedGroupRule(identityId: number, thresholdSeconds: number): void {
  upsertFutureRuleSet(db, DAY, { conditions: [{ target: 'GROUP', groupIdentityId: identityId, thresholdSeconds }] }, NOW);
}

describe('GROUP 条件の identity 化された評価', () => {
  it('内訳の秒数と GROUP 条件の実績秒が一致する', () => {
    const id = resolveIdentity(db, '開発', 'blue')!;
    seedSession(db, '開発', 'blue', jst(2026, 7, 20, 9, 0), jst(2026, 7, 20, 11, 27)); // 2h27m
    seedGroupRule(id, 900);

    const summary = daySummary(db, DAY);
    const breakdown = summary.groups.find((g) => g.name === '開発')!;
    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP')!;
    expect(cond.actualSeconds).toBe(breakdown.seconds);
  });

  it('別グループの時間では解錠されない', () => {
    const compId = resolveIdentity(db, '競技プログラミング', 'yellow')!;
    seedSession(db, '面接', 'grey', jst(2026, 7, 20, 9, 0), jst(2026, 7, 20, 11, 0));
    seedGroupRule(compId, 60);

    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP')!;
    expect(cond.actualSeconds).toBe(0);
    expect(cond.met).toBe(false);
  });

  it('別名（改名前の名前）区間が合算される', () => {
    const id = resolveIdentity(db, '競技プログラミング', 'yellow')!;
    seedSession(db, '競技プログラミング', 'yellow', jst(2026, 7, 20, 9, 0), jst(2026, 7, 20, 10, 30)); // 90分
    renameIdentity(db, { name: '競技プログラミング', color: 'yellow' }, { name: '競プロ', color: 'yellow' });
    seedSession(db, '競プロ', 'yellow', jst(2026, 7, 20, 11, 0), jst(2026, 7, 20, 11, 30)); // 30分
    seedGroupRule(id, 60 * 60);

    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP')!;
    expect(cond.actualSeconds).toBe(120 * 60);
    expect(cond.met).toBe(true);
    expect(cond.groupName).toBe('競プロ');
  });

  it('凍結済みルールの条件集合・閾値・condition_key は改名で変わらない（表示名だけが変わる）', () => {
    const id = resolveIdentity(db, '開発', 'blue')!;
    seedGroupRule(id, 900);
    // 当日を凍結（FROZEN_ACTIVE）にする: 実際の運用では ensureFrozenIfDue が day 境界で刻む。
    db.prepare("UPDATE daily_rule_set SET status = 'FROZEN_ACTIVE' WHERE effective_date = ?").run(DAY);
    const before = db.prepare('SELECT target, threshold_seconds, condition_key, group_identity_id FROM rule_condition').all();

    renameIdentity(db, { name: '開発', color: 'blue' }, { name: '開発（新）', color: 'blue' });

    const after = db.prepare('SELECT target, threshold_seconds, condition_key, group_identity_id FROM rule_condition').all();
    expect(after).toEqual(before);

    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP')!;
    expect(cond.groupName).toBe('開発（新）');
    expect(cond.thresholdSeconds).toBe(900);
  });

  it('旧 group:<uuid> 条件は daily_totals_snapshot 単位のまま評価される（移行前後で判定不変）', () => {
    db.prepare(
      `INSERT INTO daily_totals_snapshot (day_key, stable_group_id, ms, is_final, updated_at)
       VALUES (?, ?, ?, 0, 0)`,
    ).run(DAY, 'legacy-uuid', 30 * 60 * 1000);
    // セッションは別名として存在しても、旧条件は identity 経路を通らない（daily_totals_snapshot 固定）。
    upsertFutureRuleSet(
      db,
      DAY,
      { conditions: [{ target: 'GROUP', stableGroupId: 'legacy-uuid', thresholdSeconds: 60 }] },
      NOW,
    );

    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP')!;
    expect(cond.actualSeconds).toBe(30 * 60);
    expect(cond.met).toBe(true);
    expect(cond.groupName).toContain('要再設定');
  });
});
