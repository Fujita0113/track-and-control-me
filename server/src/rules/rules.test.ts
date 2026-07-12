import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import {
  upsertFutureRuleSet,
  deleteRuleSet,
  getRuleSet,
  ensureFrozenIfDue,
  FrozenRuleError,
  GoalLockError,
  ThresholdReasonRequiredError,
  todayKey,
} from './rules.js';
import { evaluateDay } from './evaluate.js';
import { setCheck } from './checks.js';

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h: number, mi: number) =>
  zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

// 固定の時間軸: 「昨日」= 2026-07-09、「今日」= 2026-07-10。
const NOW_YESTERDAY = jst(2026, 7, 9, 12, 0);
const NOW_TODAY = jst(2026, 7, 10, 12, 0);
const DAY_TODAY = '2026-07-10';
const DAY_TOMORROW = '2026-07-11';

function seedTotals(db: DB, dayKey: string, group: string, ms: number): void {
  db.prepare(
    `INSERT INTO daily_totals_snapshot (day_key, stable_group_id, ms, is_final, updated_at)
     VALUES (?, ?, ?, 0, 0)
     ON CONFLICT(day_key, stable_group_id) DO UPDATE SET ms = excluded.ms`,
  ).run(dayKey, group, ms);
}

/** 昨日の時点で「今日」発効のルールを作成（未来ルールとして許可される）。 */
function seedTodayRule(db: DB): void {
  upsertFutureRuleSet(
    db,
    DAY_TODAY,
    {
      combinator: 'ALL',
      conditions: [
        { target: 'TOTAL_WORK', thresholdSeconds: 3600 },
        { target: 'GROUP', stableGroupId: 'g-atcoder', thresholdSeconds: 300 },
        { target: 'MANUAL_CHECK', label: '振り返り＋明日のタスク登録 完了', conditionKey: 'reflection' },
      ],
    },
    NOW_YESTERDAY,
  );
}

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('凍結（freeze）', () => {
  it('未来日ルールは作成・編集できる', () => {
    const rs = upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 300 }] },
      NOW_TODAY,
    );
    expect(rs.ruleSet.status).toBe('DRAFT_FUTURE');
    // 変更も可能
    const rs2 = upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 18000 }] },
      NOW_TODAY,
    );
    expect(rs2.conditions[0]!.threshold_seconds).toBe(18000);
  });

  it('当日ルールの編集は FrozenRuleError で拒否', () => {
    seedTodayRule(db);
    ensureFrozenIfDue(db, DAY_TODAY, NOW_TODAY); // 日境界で凍結
    expect(() =>
      upsertFutureRuleSet(
        db,
        DAY_TODAY,
        { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 1 }] },
        NOW_TODAY,
      ),
    ).toThrow(FrozenRuleError);
  });

  it('当日ルールの削除も拒否', () => {
    seedTodayRule(db);
    ensureFrozenIfDue(db, DAY_TODAY, NOW_TODAY);
    expect(() => deleteRuleSet(db, DAY_TODAY, NOW_TODAY)).toThrow(FrozenRuleError);
  });

  it('DBトリガも凍結ルールの条件編集を拒否（app層をすり抜けても防ぐ）', () => {
    seedTodayRule(db);
    ensureFrozenIfDue(db, DAY_TODAY, NOW_TODAY);
    const rs = getRuleSet(db, DAY_TODAY)!;
    const condId = rs.conditions[0]!.id;
    // 直接 UPDATE を試みる → トリガが ABORT。
    expect(() =>
      db.prepare('UPDATE rule_condition SET threshold_seconds = 1 WHERE id = ?').run(condId),
    ).toThrow(/frozen/i);
    // 直接 DELETE も拒否。
    expect(() =>
      db.prepare('DELETE FROM daily_rule_set WHERE effective_date = ?').run(DAY_TODAY),
    ).toThrow(/frozen/i);
  });

  it('freeze-on-read: 当日ルールは status/frozen_at が刻まれる', () => {
    seedTodayRule(db);
    const before = getRuleSet(db, DAY_TODAY)!;
    expect(before.ruleSet.status).toBe('DRAFT_FUTURE');
    ensureFrozenIfDue(db, DAY_TODAY, NOW_TODAY);
    const after = getRuleSet(db, DAY_TODAY)!;
    expect(after.ruleSet.status).toBe('FROZEN_ACTIVE');
    expect(after.ruleSet.frozen_at).toBeGreaterThan(0);
  });
});

describe('初期ブートストラップ（当日ルールの当日作成）', () => {
  const NOW_TOMORROW = jst(2026, 7, 11, 12, 0);

  it('実効ルール皆無なら当日ルールを作成でき、同日中は何度でも編集できる', () => {
    // 当日作成（ブートストラップ）。
    const rs = upsertFutureRuleSet(
      db,
      DAY_TODAY,
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }] },
      NOW_TODAY,
    );
    expect(rs.ruleSet.effective_date).toBe(DAY_TODAY);
    expect(rs.ruleSet.status).toBe('DRAFT_FUTURE');

    // freeze-on-read しても当日ブートストラップは凍結されない。
    ensureFrozenIfDue(db, DAY_TODAY, NOW_TODAY);
    expect(getRuleSet(db, DAY_TODAY)!.ruleSet.status).toBe('DRAFT_FUTURE');

    // 同日中はやり直し（タイポ/達成不能）で再編集できる。
    const rs2 = upsertFutureRuleSet(
      db,
      DAY_TODAY,
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 600 }] },
      NOW_TODAY,
    );
    expect(rs2.conditions[0]!.threshold_seconds).toBe(600);
  });

  it('継承元（過去/持ち越しルール）がある日は当日ルールの新規作成を拒否（骨抜き防止）', () => {
    // DAY_TODAY 発効ルールを前日にコミット済み。
    upsertFutureRuleSet(
      db,
      DAY_TODAY,
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }] },
      NOW_YESTERDAY,
    );
    // 「今日」を DAY_TOMORROW とみなす。当日(DAY_TOMORROW)ルールは無いが継承元(DAY_TODAY)がある。
    expect(() =>
      upsertFutureRuleSet(
        db,
        DAY_TOMORROW,
        { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 1 }] },
        NOW_TOMORROW,
      ),
    ).toThrow(FrozenRuleError);
  });

  it('翌日以降はブートストラップ当日ルールも凍結され、編集不可になる', () => {
    upsertFutureRuleSet(
      db,
      DAY_TODAY,
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }] },
      NOW_TODAY,
    );
    // 翌日視点では effective_date < today なので凍結される。
    ensureFrozenIfDue(db, DAY_TODAY, NOW_TOMORROW);
    expect(getRuleSet(db, DAY_TODAY)!.ruleSet.status).toBe('FROZEN_ACTIVE');
    expect(() =>
      upsertFutureRuleSet(
        db,
        DAY_TODAY,
        { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 1 }] },
        NOW_TOMORROW,
      ),
    ).toThrow(FrozenRuleError);
  });

  it('ブートストラップ当日ルールは同日中は削除できる', () => {
    upsertFutureRuleSet(
      db,
      DAY_TODAY,
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }] },
      NOW_TODAY,
    );
    expect(deleteRuleSet(db, DAY_TODAY, NOW_TODAY)).toBe(true);
    expect(getRuleSet(db, DAY_TODAY)).toBeNull();
  });
});

describe('AND 評価 & MANUAL_CHECK ゲート', () => {
  beforeEach(() => {
    seedTodayRule(db);
    seedTotals(db, DAY_TODAY, 'g-dev', 4000 * 1000); // g-dev 4000s
    seedTotals(db, DAY_TODAY, 'g-atcoder', 400 * 1000); // g-atcoder 400s
  });

  it('時間条件OKでも MANUAL_CHECK 未了なら未達成', () => {
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const total = r.perCondition.find((p) => p.target === 'TOTAL_WORK')!;
    const grp = r.perCondition.find((p) => p.target === 'GROUP')!;
    const manual = r.perCondition.find((p) => p.target === 'MANUAL_CHECK')!;
    expect(total.met).toBe(true); // 4400 >= 3600
    expect(grp.met).toBe(true); // g-atcoder 400 >= 300
    expect(manual.met).toBe(false); // 未チェック
    expect(r.conditionsMet).toBe(false);
    expect(r.status).toBe('LOCKED');
  });

  it('チェックすると達成し UNLOCKED（justUnlocked=true は一度だけ）', () => {
    setCheck(db, DAY_TODAY, 'reflection', true, NOW_TODAY);
    const r1 = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    expect(r1.conditionsMet).toBe(true);
    expect(r1.status).toBe('UNLOCKED');
    expect(r1.justUnlocked).toBe(true);
    expect(r1.firstMetAt).not.toBeNull();
    // 再評価では justUnlocked は false（latch 済み）。
    const r2 = evaluateDay(db, DAY_TODAY, NOW_TODAY + 60_000);
    expect(r2.justUnlocked).toBe(false);
    expect(r2.status).toBe('UNLOCKED');
  });

  it('latch: 達成後に総計が閾値未満へ減っても UNLOCKED を維持', () => {
    setCheck(db, DAY_TODAY, 'reflection', true, NOW_TODAY);
    evaluateDay(db, DAY_TODAY, NOW_TODAY); // UNLOCK
    // 手動編集で作業時間が激減。
    seedTotals(db, DAY_TODAY, 'g-dev', 10 * 1000);
    seedTotals(db, DAY_TODAY, 'g-atcoder', 10 * 1000);
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY + 120_000);
    expect(r.conditionsMet).toBe(false); // 現時点は未充足
    expect(r.status).toBe('UNLOCKED'); // だが latch で維持
  });
});

describe('undefined_day_policy', () => {
  it('ルール未定義かつフォールバック無しなら LOCKED', () => {
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    expect(r.hasRuleSet).toBe(false);
    expect(r.status).toBe('LOCKED');
    expect(r.conditionsMet).toBe(false);
  });

  it('翌日ルール未設定でも直近の過去ルールへフォールバック', () => {
    // 昨日発効のルールを作り（過去ルール）、当日ルールは未設定。
    upsertFutureRuleSet(
      db,
      DAY_TODAY,
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 100 }] },
      NOW_YESTERDAY,
    );
    // DAY_TOMORROW は未設定 → フォールバックで当日ルールを継承。
    const r = evaluateDay(db, DAY_TOMORROW, jst(2026, 7, 11, 12, 0));
    expect(r.hasRuleSet).toBe(true);
  });
});

describe('ジャンル固定・理由付き閾値変更（目標が採用中の条件）', () => {
  const END = '2026-08-09'; // DAY_TOMORROW(2026-07-11) + 29

  /** DAY_TOMORROW 発効の実効ルール（採用元）を作る。 */
  function seedTomorrowRule(): void {
    upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      {
        conditions: [
          { target: 'TOTAL_WORK', thresholdSeconds: 14400 },
          { target: 'GROUP', stableGroupId: 'g-atcoder', thresholdSeconds: 1800 },
        ],
      },
      NOW_TODAY,
    );
  }

  /** [DAY_TOMORROW..END] を稼働期間とする目標を直接挿入し、実践 keys を採用させる。 */
  function seedGoal(keys: { key: string; target: string }[], startDay = DAY_TOMORROW, endDay = END): number {
    const id = db
      .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('目標', '', startDay, endDay, NOW_TODAY).lastInsertRowid as number;
    const ins = db.prepare(
      'INSERT INTO goal_practice (goal_id, condition_key, target, sort_order) VALUES (?, ?, ?, ?)',
    );
    keys.forEach((k, i) => ins.run(id, k.key, k.target, i));
    return id;
  }

  it('採用中条件の削除（対象から外す編集）は GoalLockError で拒否', () => {
    seedTomorrowRule();
    seedGoal([{ key: 'total_work', target: 'TOTAL_WORK' }]);
    // DAY_TOMORROW を GROUP のみに置換 → total_work が残期間から消える。
    expect(() =>
      upsertFutureRuleSet(
        db,
        DAY_TOMORROW,
        { conditions: [{ target: 'GROUP', stableGroupId: 'g-atcoder', thresholdSeconds: 1800 }] },
        NOW_TODAY,
      ),
    ).toThrow(GoalLockError);
    // ルールセットは変更されていない（total_work が残る）。
    expect(getRuleSet(db, DAY_TOMORROW)!.conditions.some((c) => c.condition_key === 'total_work')).toBe(true);
  });

  it('削除フォールバックでも実践が残るなら許可される', () => {
    seedTomorrowRule();
    // 期間中の別日に明示ルールを作る（total_work を含む）。
    upsertFutureRuleSet(
      db,
      '2026-07-15',
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400 }] },
      NOW_TODAY,
    );
    seedGoal([{ key: 'total_work', target: 'TOTAL_WORK' }]);
    // 2026-07-15 を削除 → DAY_TOMORROW へフォールバックし total_work は残る。
    expect(deleteRuleSet(db, '2026-07-15', NOW_TODAY)).toBe(true);
  });

  it('目標期間外の日だけに影響する編集は制約されない', () => {
    seedTomorrowRule();
    seedGoal([{ key: 'total_work', target: 'TOTAL_WORK' }]);
    // end_day より後の日に total_work 無しのルールを作る → 期間内は DAY_TOMORROW にフォールバックのまま。
    const rs = upsertFutureRuleSet(
      db,
      '2026-08-20',
      { conditions: [{ target: 'GROUP', stableGroupId: 'g-atcoder', thresholdSeconds: 60 }] },
      NOW_TODAY,
    );
    expect(rs.ruleSet.effective_date).toBe('2026-08-20');
  });

  it('採用中条件の閾値変更は理由なしだと ThresholdReasonRequiredError', () => {
    seedTomorrowRule();
    seedGoal([{ key: 'total_work', target: 'TOTAL_WORK' }]);
    expect(() =>
      upsertFutureRuleSet(
        db,
        DAY_TOMORROW,
        {
          conditions: [
            { target: 'TOTAL_WORK', thresholdSeconds: 10800 },
            { target: 'GROUP', stableGroupId: 'g-atcoder', thresholdSeconds: 1800 },
          ],
        },
        NOW_TODAY,
      ),
    ).toThrow(ThresholdReasonRequiredError);
  });

  it('理由つきの閾値変更は成功し practice_threshold_change に記録される', () => {
    seedTomorrowRule();
    seedGoal([{ key: 'total_work', target: 'TOTAL_WORK' }]);
    upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      {
        conditions: [
          { target: 'TOTAL_WORK', thresholdSeconds: 10800 },
          { target: 'GROUP', stableGroupId: 'g-atcoder', thresholdSeconds: 1800 },
        ],
      },
      NOW_TODAY,
      { thresholdChangeReason: '課題週間。ゼロにはしない' },
    );
    const rows = db
      .prepare('SELECT * FROM practice_threshold_change WHERE condition_key = ?')
      .all('total_work') as { old_seconds: number; new_seconds: number; reason: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.old_seconds).toBe(14400);
    expect(rows[0]!.new_seconds).toBe(10800);
    expect(rows[0]!.reason).toContain('課題週間');
  });

  it('採用されていない条件の閾値変更は理由不要', () => {
    seedTomorrowRule();
    // 目標は GROUP のみ採用 → total_work の変更は自由。
    seedGoal([{ key: 'group:g-atcoder', target: 'GROUP' }]);
    const rs = upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      {
        conditions: [
          { target: 'TOTAL_WORK', thresholdSeconds: 7200 },
          { target: 'GROUP', stableGroupId: 'g-atcoder', thresholdSeconds: 1800 },
        ],
      },
      NOW_TODAY,
    );
    expect(rs.conditions.find((c) => c.condition_key === 'total_work')!.threshold_seconds).toBe(7200);
  });
});
