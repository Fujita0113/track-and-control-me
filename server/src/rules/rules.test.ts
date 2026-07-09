import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import {
  upsertFutureRuleSet,
  deleteRuleSet,
  getRuleSet,
  ensureFrozenIfDue,
  FrozenRuleError,
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
