import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import {
  upsertFutureRuleSet,
  deleteRuleSet,
  getRuleSet,
  ensureFrozenIfDue,
  FrozenRuleError,
  BaselineViolationError,
  GoalLockError,
  ThresholdReasonRequiredError,
  RuleConditionError,
  todayKey,
} from './rules.js';
import { evaluateDay } from './evaluate.js';
import { setCheck } from './checks.js';
import {
  createPlan,
  createCheck,
  cancelCheck,
  withdrawPlan,
  submitPhoto,
  answerQuestion,
} from '../services/goal-plan-check.js';

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

  it('採用中 timeline:運動 を別ラベルへ変える編集は GoalLockError で拒否', () => {
    upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      { conditions: [{ target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 }] },
      NOW_TODAY,
    );
    seedGoal([{ key: 'timeline:運動', target: 'TIMELINE' }]);
    // 「読書」へ差し替え → timeline:運動 が残期間から消える。
    expect(() =>
      upsertFutureRuleSet(
        db,
        DAY_TOMORROW,
        { conditions: [{ target: 'TIMELINE', label: '読書', thresholdSeconds: 1800 }] },
        NOW_TODAY,
      ),
    ).toThrow(GoalLockError);
    expect(getRuleSet(db, DAY_TOMORROW)!.conditions[0]!.condition_key).toBe('timeline:運動');
  });

  it('採用中 TIMELINE の閾値変更は理由なしで拒否・理由つきで記録される', () => {
    upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      { conditions: [{ target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 }] },
      NOW_TODAY,
    );
    seedGoal([{ key: 'timeline:運動', target: 'TIMELINE' }]);
    // 30分→15分の緩和も理由が必須。
    expect(() =>
      upsertFutureRuleSet(
        db,
        DAY_TOMORROW,
        { conditions: [{ target: 'TIMELINE', label: '運動', thresholdSeconds: 900 }] },
        NOW_TODAY,
      ),
    ).toThrow(ThresholdReasonRequiredError);
    upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      { conditions: [{ target: 'TIMELINE', label: '運動', thresholdSeconds: 900 }] },
      NOW_TODAY,
      { thresholdChangeReason: '疲労気味。ゼロにはしない' },
    );
    const rows = db
      .prepare('SELECT * FROM practice_threshold_change WHERE condition_key = ?')
      .all('timeline:運動') as { old_seconds: number; new_seconds: number; reason: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.old_seconds).toBe(1800);
    expect(rows[0]!.new_seconds).toBe(900);
    expect(rows[0]!.reason).toContain('疲労');
  });
});

describe('TIMELINE 条件（タイムライン記録）', () => {
  /** 昨日の時点で「今日」発効の TIMELINE ルール（ラベル運動・閾値可変）を作る。 */
  function seedTimelineRule(thresholdSeconds = 1800): void {
    upsertFutureRuleSet(
      db,
      DAY_TODAY,
      { combinator: 'ALL', conditions: [{ target: 'TIMELINE', label: '運動', thresholdSeconds }] },
      NOW_YESTERDAY,
    );
  }
  /** 当日の activity_log_entry を1件シードする（duration = seconds）。 */
  function seedEntry(
    categoryKey: string,
    seconds: number,
    entryType: 'MANUAL' | 'AUTO_SESSION' = 'MANUAL',
    startAt = jst(2026, 7, 10, 9, 0),
  ): void {
    db.prepare(
      `INSERT INTO activity_log_entry (day_key, start_at, end_at, entry_type, title, category_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
    ).run(DAY_TODAY, startAt, startAt + seconds * 1000, entryType, categoryKey, categoryKey);
  }

  it('ラベル一致合計≥閾値で met（実測と閾値が焼き込まれる）', () => {
    seedTimelineRule(1800);
    seedEntry('運動', 1200);
    seedEntry('運動', 900, 'MANUAL', jst(2026, 7, 10, 11, 0)); // 合計2100s
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const p = r.perCondition.find((x) => x.target === 'TIMELINE')!;
    expect(p.conditionKey).toBe('timeline:運動');
    expect(p.actualSeconds).toBe(2100);
    expect(p.thresholdSeconds).toBe(1800);
    expect(p.met).toBe(true);
  });

  it('閾値未満は not met', () => {
    seedTimelineRule(1800);
    seedEntry('運動', 1200); // 20分 < 30分
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const p = r.perCondition.find((x) => x.target === 'TIMELINE')!;
    expect(p.actualSeconds).toBe(1200);
    expect(p.met).toBe(false);
  });

  it('別ラベル・AUTO_SESSION は算入しない', () => {
    seedTimelineRule(1800);
    seedEntry('読書', 3000); // 別ラベル
    seedEntry('運動', 3000, 'AUTO_SESSION'); // AUTO は対象外
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const p = r.perCondition.find((x) => x.target === 'TIMELINE')!;
    expect(p.actualSeconds).toBe(0);
    expect(p.met).toBe(false);
  });

  it('condition_key は timeline:<label> で並べ替えても不変', () => {
    upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      {
        conditions: [
          { target: 'TOTAL_WORK', thresholdSeconds: 3600 },
          { target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 },
        ],
      },
      NOW_TODAY,
    );
    const key1 = getRuleSet(db, DAY_TOMORROW)!.conditions.find((c) => c.target === 'TIMELINE')!.condition_key;
    expect(key1).toBe('timeline:運動');
    // 並び順を入れ替えて再保存 → キーは不変。
    upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      {
        conditions: [
          { target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 },
          { target: 'TOTAL_WORK', thresholdSeconds: 3600 },
        ],
      },
      NOW_TODAY,
    );
    const key2 = getRuleSet(db, DAY_TOMORROW)!.conditions.find((c) => c.target === 'TIMELINE')!.condition_key;
    expect(key2).toBe('timeline:運動');
  });

  it('TIMELINE 条件の保存でカテゴリがレジストリへ upsert される', () => {
    seedTimelineRule(1800);
    const rows = db.prepare('SELECT name FROM manual_category WHERE name = ?').all('運動') as { name: string }[];
    expect(rows.length).toBe(1);
  });

  /** 同時記録グループ（n=構成数・同一 co_record_group_id）で MANUAL 行をシードする。 */
  function seedCoRecord(categories: string[], seconds: number, startAt = jst(2026, 7, 10, 9, 0)): void {
    const n = categories.length;
    const groupId = n > 1 ? 9000 : null; // 任意の共有 ID（単独は NULL）。
    const ins = db.prepare(
      `INSERT INTO activity_log_entry (day_key, start_at, end_at, entry_type, title, category_key, n, co_record_group_id, created_at, updated_at)
       VALUES (?, ?, ?, 'MANUAL', ?, ?, ?, ?, 0, 0)`,
    );
    for (const cat of categories) ins.run(DAY_TODAY, startAt, startAt + seconds * 1000, cat, cat, n, groupId);
  }

  it('同時記録は持ち分（区間長 ÷ N）で算入される（2時間・2カテゴリで1時間）', () => {
    upsertFutureRuleSet(
      db,
      DAY_TODAY,
      { combinator: 'ALL', conditions: [{ target: 'TIMELINE', label: '掃除', thresholdSeconds: 1800 }] },
      NOW_YESTERDAY,
    );
    // 2時間の区間を「掃除」「洗濯」で同時記録（各持ち分1時間 = 3600秒）。
    seedCoRecord(['掃除', '洗濯'], 7200);
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const p = r.perCondition.find((x) => x.target === 'TIMELINE' && x.conditionKey === 'timeline:掃除')!;
    expect(p.actualSeconds).toBe(3600); // 区間長そのまま(7200)ではなく持ち分(3600)。
    expect(p.met).toBe(true); // 3600 ≥ 1800。
  });

  it('単独記録の持ち分は区間長そのまま（n=1 で結果不変＝後方互換）', () => {
    seedTimelineRule(1800);
    seedCoRecord(['運動'], 2100); // n=1・単独。
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const p = r.perCondition.find((x) => x.target === 'TIMELINE' && x.conditionKey === 'timeline:運動')!;
    expect(p.actualSeconds).toBe(2100);
    expect(p.met).toBe(true);
  });

  it('閾値バッジの有無は評価結果を変えない（表示専用・目標採用に非依存）', () => {
    // ルール・記録だけの状態で評価。
    seedTimelineRule(1800);
    seedCoRecord(['運動'], 1200);
    const before = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const pb = before.perCondition.find((x) => x.conditionKey === 'timeline:運動')!;
    // 目標を採用してもルール評価（met/actualSeconds）は同一。
    db.prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)').run(
      '運動チャレンジ', '', DAY_TODAY, '2026-08-08', NOW_YESTERDAY,
    );
    const gid = (db.prepare('SELECT id FROM goal').get() as { id: number }).id;
    db.prepare('INSERT INTO goal_practice (goal_id, condition_key, target, sort_order) VALUES (?, ?, ?, 0)').run(
      gid, 'timeline:運動', 'TIMELINE',
    );
    // is_final ではないので再評価される。
    db.prepare('DELETE FROM unlock_evaluation WHERE day_key = ?').run(DAY_TODAY);
    const after = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const pa = after.perCondition.find((x) => x.conditionKey === 'timeline:運動')!;
    expect(pa.actualSeconds).toBe(pb.actualSeconds);
    expect(pa.met).toBe(pb.met);
  });
});

describe('当日ルールへの新規条件追加（same-day-rule-additions）', () => {
  const NOW_TOMORROW = jst(2026, 7, 11, 12, 0);

  /** baseline: 前日にコミットされた「今日」発効ルール（当日は凍結される）。 */
  function seedFrozenTodayRule(total = 3600): void {
    upsertFutureRuleSet(
      db,
      DAY_TODAY,
      { combinator: 'ALL', conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: total }] },
      NOW_YESTERDAY,
    );
    ensureFrozenIfDue(db, DAY_TODAY, NOW_TODAY); // FROZEN_ACTIVE
  }

  /** baseline を保存しつつ TIMELINE を1本足した当日フルセット。 */
  function withRunAddition(runSeconds = 1800): { conditions: { target: 'TOTAL_WORK' | 'TIMELINE'; thresholdSeconds: number; label?: string }[] } {
    return {
      conditions: [
        { target: 'TOTAL_WORK', thresholdSeconds: 3600 },
        { target: 'TIMELINE', label: '運動', thresholdSeconds: runSeconds },
      ],
    };
  }

  it('実効ルールがある当日でも新規条件を追加でき、baseline は不変（DRAFT_TODAY）', () => {
    seedFrozenTodayRule();
    const rs = upsertFutureRuleSet(db, DAY_TODAY, withRunAddition(1800), NOW_TODAY);
    expect(rs.ruleSet.status).toBe('DRAFT_TODAY');
    expect(rs.conditions.map((c) => c.condition_key).sort()).toEqual(['timeline:運動', 'total_work']);
    expect(rs.conditions.find((c) => c.condition_key === 'total_work')!.threshold_seconds).toBe(3600);
  });

  it('既存の凍結条件を外す/緩める当日編集は BaselineViolationError で拒否', () => {
    seedFrozenTodayRule();
    // total_work を外す（削除）。
    expect(() =>
      upsertFutureRuleSet(db, DAY_TODAY, { conditions: [{ target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 }] }, NOW_TODAY),
    ).toThrow(BaselineViolationError);
    // total_work を引き下げる。
    expect(() =>
      upsertFutureRuleSet(db, DAY_TODAY, { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 60 }] }, NOW_TODAY),
    ).toThrow(BaselineViolationError);
    // ルールは変更されていない（total_work 3600 が残る）。
    expect(getRuleSet(db, DAY_TODAY)!.conditions.find((c) => c.condition_key === 'total_work')!.threshold_seconds).toBe(3600);
  });

  it('当日追加分は同日中に自由に編集・削除でき baseline へ戻せる', () => {
    seedFrozenTodayRule();
    upsertFutureRuleSet(db, DAY_TODAY, withRunAddition(1800), NOW_TODAY);
    // 追加分の閾値を変更（採用されていないので自由）。
    const rs2 = upsertFutureRuleSet(db, DAY_TODAY, withRunAddition(3600), NOW_TODAY);
    expect(rs2.conditions.find((c) => c.condition_key === 'timeline:運動')!.threshold_seconds).toBe(3600);
    // 追加分を input から外す → baseline へ戻る（total_work のみ）。
    const rs3 = upsertFutureRuleSet(db, DAY_TODAY, { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }] }, NOW_TODAY);
    expect(rs3.conditions.map((c) => c.condition_key)).toEqual(['total_work']);
  });

  it('当日の解錠判定に当日追加条件が算入される', () => {
    seedFrozenTodayRule();
    upsertFutureRuleSet(db, DAY_TODAY, withRunAddition(1800), NOW_TODAY);
    // total_work だけ満たし、運動は未記録 → 追加条件が効いて未達成。
    seedTotals(db, DAY_TODAY, 'g-dev', 4000 * 1000);
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const run = r.perCondition.find((p) => p.conditionKey === 'timeline:運動')!;
    expect(run.met).toBe(false);
    expect(r.conditionsMet).toBe(false);
  });

  it('deleteRuleSet(today) は当日追加分だけを撤回し baseline（FROZEN）へ戻す', () => {
    seedFrozenTodayRule();
    upsertFutureRuleSet(db, DAY_TODAY, withRunAddition(1800), NOW_TODAY);
    expect(deleteRuleSet(db, DAY_TODAY, NOW_TODAY)).toBe(true);
    const rs = getRuleSet(db, DAY_TODAY)!;
    expect(rs.ruleSet.status).toBe('FROZEN_ACTIVE'); // reopen 由来は再凍結。
    expect(rs.conditions.map((c) => c.condition_key)).toEqual(['total_work']);
  });

  it('当日追加した条件は翌日から凍結され編集不可になる', () => {
    seedFrozenTodayRule();
    upsertFutureRuleSet(db, DAY_TODAY, withRunAddition(1800), NOW_TODAY);
    ensureFrozenIfDue(db, DAY_TODAY, NOW_TOMORROW);
    expect(getRuleSet(db, DAY_TODAY)!.ruleSet.status).toBe('FROZEN_ACTIVE');
    expect(() =>
      upsertFutureRuleSet(db, DAY_TODAY, { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }] }, NOW_TOMORROW),
    ).toThrow(FrozenRuleError);
  });

  it('materialize: 継承 baseline のある当日は追加で DRAFT_TODAY 行が作られ、撤回で継承へ戻る', () => {
    upsertFutureRuleSet(db, '2026-07-08', { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }] }, jst(2026, 7, 7, 12, 0));
    expect(getRuleSet(db, DAY_TODAY)).toBeNull(); // 当日は継承（明示行なし）。
    const rs = upsertFutureRuleSet(db, DAY_TODAY, withRunAddition(1800), NOW_TODAY);
    expect(rs.ruleSet.status).toBe('DRAFT_TODAY');
    expect(rs.conditions.map((c) => c.condition_key).sort()).toEqual(['timeline:運動', 'total_work']);
    // materialize 由来（当日作成行）の撤回は行ごと削除 → 継承へ戻る。
    expect(deleteRuleSet(db, DAY_TODAY, NOW_TODAY)).toBe(true);
    expect(getRuleSet(db, DAY_TODAY)).toBeNull();
  });
});

describe('今日開始の目標: ジャンル固定・理由必須が当日から効く', () => {
  /** baseline today rule + 当日追加した timeline:運動 を今日開始の目標が採用した状態を作る。 */
  function seedTodayAdoptedRun(): void {
    upsertFutureRuleSet(db, DAY_TODAY, { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }] }, NOW_YESTERDAY);
    ensureFrozenIfDue(db, DAY_TODAY, NOW_TODAY);
    upsertFutureRuleSet(
      db,
      DAY_TODAY,
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }, { target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 }] },
      NOW_TODAY,
    );
    const gid = db
      .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('運動', '', DAY_TODAY, '2026-08-08', NOW_TODAY).lastInsertRowid as number;
    db.prepare('INSERT INTO goal_practice (goal_id, condition_key, target, sort_order) VALUES (?, ?, ?, 0)').run(
      gid,
      'timeline:運動',
      'TIMELINE',
    );
  }

  it('当日採用した当日追加条件は同日でも削除できない（GoalLockError）', () => {
    seedTodayAdoptedRun();
    // input から timeline:運動 を外す（撤回）→ 採用中のため拒否。
    expect(() =>
      upsertFutureRuleSet(db, DAY_TODAY, { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }] }, NOW_TODAY),
    ).toThrow(GoalLockError);
    // deleteRuleSet でも拒否。
    expect(() => deleteRuleSet(db, DAY_TODAY, NOW_TODAY)).toThrow(GoalLockError);
    expect(getRuleSet(db, DAY_TODAY)!.conditions.some((c) => c.condition_key === 'timeline:運動')).toBe(true);
  });

  it('採用中の当日追加条件の閾値変更は理由必須・理由つきで記録される', () => {
    seedTodayAdoptedRun();
    // 1800→900 の変更を理由なしで送る → 拒否。
    expect(() =>
      upsertFutureRuleSet(
        db,
        DAY_TODAY,
        { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }, { target: 'TIMELINE', label: '運動', thresholdSeconds: 900 }] },
        NOW_TODAY,
      ),
    ).toThrow(ThresholdReasonRequiredError);
    // 理由つきなら成功・記録される。
    upsertFutureRuleSet(
      db,
      DAY_TODAY,
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600 }, { target: 'TIMELINE', label: '運動', thresholdSeconds: 900 }] },
      NOW_TODAY,
      { thresholdChangeReason: '疲労気味。ゼロにはしない' },
    );
    const rows = db.prepare('SELECT * FROM practice_threshold_change WHERE condition_key = ?').all('timeline:運動') as {
      old_seconds: number;
      new_seconds: number;
    }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.old_seconds).toBe(1800);
    expect(rows[0]!.new_seconds).toBe(900);
  });
});

describe('MANUAL_CHECK の安定キー manual:<ラベル>（manual-check-stable-key）', () => {
  const keysOf = (dayKey: string): string[] =>
    (getRuleSet(db, dayKey)?.conditions ?? []).map((c) => c.condition_key);

  it('手動チェックのキーはラベル由来（manual:<ラベル>）になる', () => {
    upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      { conditions: [{ target: 'MANUAL_CHECK', label: '筋トレ' }] },
      NOW_TODAY,
    );
    expect(keysOf(DAY_TOMORROW)).toEqual(['manual:筋トレ']);
  });

  it('ラベルは trim され、前後空白は無視される', () => {
    upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      { conditions: [{ target: 'MANUAL_CHECK', label: '  筋トレ  ' }] },
      NOW_TODAY,
    );
    expect(keysOf(DAY_TOMORROW)).toEqual(['manual:筋トレ']);
  });

  it('並べ替え・他条件の追加でキーが変わらない', () => {
    upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      { conditions: [{ target: 'MANUAL_CHECK', label: '筋トレ' }] },
      NOW_TODAY,
    );
    // 前に別条件（グループ作業）を追加し、手動チェックを後ろへ回す。
    upsertFutureRuleSet(
      db,
      DAY_TOMORROW,
      {
        conditions: [
          { target: 'GROUP', stableGroupId: 'g-x', thresholdSeconds: 300 },
          { target: 'MANUAL_CHECK', label: '筋トレ' },
        ],
      },
      NOW_TODAY,
    );
    expect(keysOf(DAY_TOMORROW)).toContain('manual:筋トレ'); // index に依らず不変
  });

  it('空ラベル（trim 後空）の手動チェックは拒否される', () => {
    expect(() =>
      upsertFutureRuleSet(
        db,
        DAY_TOMORROW,
        { conditions: [{ target: 'MANUAL_CHECK', label: '   ' }] },
        NOW_TODAY,
      ),
    ).toThrow(RuleConditionError);
    // 保存されていない。
    expect(getRuleSet(db, DAY_TOMORROW)).toBeNull();
  });

  it('同一ルールセット内のラベル重複は拒否される', () => {
    expect(() =>
      upsertFutureRuleSet(
        db,
        DAY_TOMORROW,
        {
          conditions: [
            { target: 'MANUAL_CHECK', label: '筋トレ' },
            { target: 'MANUAL_CHECK', label: '筋トレ' },
          ],
        },
        NOW_TODAY,
      ),
    ).toThrow(RuleConditionError);
  });
});

describe('Check の解錠ゲートへの合流（spec: goal-check-gate / design D4）', () => {
  const PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  /** 今日（2026-07-10）を Day1 とする進行中の目標に、Plan を1つ置く。 */
  function seedPlan(): number {
    const goalId = db
      .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('髪質を改善する', '', DAY_TODAY, '2026-08-08', NOW_TODAY).lastInsertRowid as number;
    return createPlan(db, goalId, { body: 'シャンプーを変えれば髪質が良くなるのでは' }, NOW_TODAY).id;
  }

  /** 他の全条件（時間・グループ・手動チェック）を満たした状態にする。 */
  function satisfyOthers(): void {
    seedTotals(db, DAY_TODAY, 'g-dev', 4000 * 1000);
    seedTotals(db, DAY_TODAY, 'g-atcoder', 400 * 1000);
    setCheck(db, DAY_TODAY, 'reflection', true, NOW_TODAY);
  }

  beforeEach(() => {
    seedTodayRule(db);
    satisfyOthers();
  });

  it('他条件を全部満たしても、未達の Check があれば LOCKED（パスワードは出ない）', () => {
    const planId = seedPlan();
    createCheck(db, planId, { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 0 }, NOW_TODAY);

    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const check = r.perCondition.find((p) => p.target === 'CHECK')!;
    expect(check.met).toBe(false);
    expect(check.conditionKey).toMatch(/^check:\d+$/);
    expect(r.conditionsMet).toBe(false);
    expect(r.status).toBe('LOCKED');
  });

  it('label にキャプション／質問文が載り、由来の Plan も辿れる（今日タブの不足条件行）', () => {
    const planId = seedPlan();
    createCheck(db, planId, { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 0 }, NOW_TODAY);
    createCheck(
      db,
      planId,
      { kind: 'question', questionText: '使用感はどうだった？', schedule: 'single', startInDays: 0 },
      NOW_TODAY,
    );

    const checks = evaluateDay(db, DAY_TODAY, NOW_TODAY).perCondition.filter((p) => p.target === 'CHECK');
    expect(checks.map((c) => c.label)).toEqual(['前髪・正面', '使用感はどうだった？']);
    expect(checks[0]).toMatchObject({
      checkKind: 'photo',
      planBody: 'シャンプーを変えれば髪質が良くなるのでは',
      goalName: '髪質を改善する',
    });
  });

  it('範囲Check は「期間の何日目か」を合流条件に載せる（今日タブが「7/18〜7/24 の1日目」を描ける）', () => {
    const planId = seedPlan();
    createCheck(
      db,
      planId,
      { kind: 'question', questionText: '使用感は？', schedule: 'range', startInDays: 0, spanDays: 7 },
      NOW_TODAY,
    );
    const c = evaluateDay(db, DAY_TODAY, NOW_TODAY).perCondition.find((p) => p.target === 'CHECK')!;
    expect(c).toMatchObject({
      checkSchedule: 'range',
      rangeDayNumber: 1,
      spanDays: 7,
      startDayKey: DAY_TODAY,
    });
  });

  it('回答すると合流条件が met になり UNLOCKED', () => {
    const planId = seedPlan();
    const c = createCheck(
      db,
      planId,
      { kind: 'question', questionText: '使用感はどうだった？', schedule: 'single', startInDays: 0 },
      NOW_TODAY,
    );
    expect(evaluateDay(db, DAY_TODAY, NOW_TODAY).status).toBe('LOCKED');

    answerQuestion(db, c.id, DAY_TODAY, { answerText: '泡立ちは良い' }, NOW_TODAY);
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    expect(r.perCondition.find((p) => p.target === 'CHECK')!.met).toBe(true);
    expect(r.conditionsMet).toBe(true);
    expect(r.status).toBe('UNLOCKED');
  });

  it('写真を出すとゲートが開く', () => {
    const planId = seedPlan();
    const c = createCheck(db, planId, { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 0 }, NOW_TODAY);
    submitPhoto(db, c.id, DAY_TODAY, { dataUrl: PNG_DATA_URL }, NOW_TODAY);
    expect(evaluateDay(db, DAY_TODAY, NOW_TODAY).status).toBe('UNLOCKED');
  });

  it('開始日前は合流しない（仕掛けた直後はゲートに影響しない）', () => {
    const planId = seedPlan();
    createCheck(db, planId, { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 3 }, NOW_TODAY);

    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    expect(r.perCondition.some((p) => p.target === 'CHECK')).toBe(false);
    expect(r.status).toBe('UNLOCKED'); // 他条件は満たしているので開く。
  });

  it('取り下げると合流しなくなり、他条件を満たしていればパスワードが出る', () => {
    const planId = seedPlan();
    const c = createCheck(db, planId, { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 0 }, NOW_TODAY);
    expect(evaluateDay(db, DAY_TODAY, NOW_TODAY).status).toBe('LOCKED');

    cancelCheck(db, c.id, { reason: 'シャンプーが肌に合わず返品した' });
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    expect(r.perCondition.some((p) => p.target === 'CHECK')).toBe(false);
    expect(r.status).toBe('UNLOCKED');
  });

  it('Plan ごと取り下げると配下の Check がゲートから外れる', () => {
    const planId = seedPlan();
    createCheck(db, planId, { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 0 }, NOW_TODAY);
    withdrawPlan(db, planId, { reason: '効果が無かった' });
    expect(evaluateDay(db, DAY_TODAY, NOW_TODAY).status).toBe('UNLOCKED');
  });

  it('範囲Check は各日が独立してゲートを閉じる（前日の達成は今日を助けない）', () => {
    const planId = seedPlan();
    const c = createCheck(
      db,
      planId,
      { kind: 'question', questionText: '使用感は？', schedule: 'range', startInDays: 0, spanDays: 3 },
      NOW_TODAY,
    );
    // Day1（今日）に回答 → 開く。
    answerQuestion(db, c.id, DAY_TODAY, { answerText: '1日目' }, NOW_TODAY);
    expect(evaluateDay(db, DAY_TODAY, NOW_TODAY).status).toBe('UNLOCKED');

    // Day2（翌日）は翌日の分を要求する＝前日の達成では開かない。
    const NOW_TOMORROW = jst(2026, 7, 11, 12, 0);
    seedTotals(db, DAY_TOMORROW, 'g-dev', 4000 * 1000);
    seedTotals(db, DAY_TOMORROW, 'g-atcoder', 400 * 1000);
    setCheck(db, DAY_TOMORROW, 'reflection', true, NOW_TOMORROW);
    const r = evaluateDay(db, DAY_TOMORROW, NOW_TOMORROW);
    expect(r.perCondition.find((p) => p.target === 'CHECK')!.met).toBe(false);
    expect(r.status).toBe('LOCKED');
  });

  it('is_final の過去確定日は再評価しない（後から満たしても過去は未達のまま・D2 の非対称）', () => {
    const planId = seedPlan();
    const c = createCheck(db, planId, { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 0 }, NOW_TODAY);
    evaluateDay(db, DAY_TODAY, NOW_TODAY); // LOCKED のスナップショットを書く。
    db.prepare('UPDATE unlock_evaluation SET is_final = 1 WHERE day_key = ?').run(DAY_TODAY);

    // 後から提出しても、確定済みの日は LOCKED のまま（欠測を美化しない思想と一致）。
    submitPhoto(db, c.id, DAY_TODAY, { dataUrl: PNG_DATA_URL }, NOW_TODAY);
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    expect(r.status).toBe('LOCKED');
    expect(r.perCondition.find((p) => p.target === 'CHECK')!.met).toBe(false);
  });

  it('未達 Check は latch 済みの UNLOCKED を relock しない', () => {
    // 先に他条件だけで UNLOCK（latch）。
    evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const planId = seedPlan();
    createCheck(db, planId, { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 0 }, NOW_TODAY);

    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY + 60_000);
    expect(r.conditionsMet).toBe(false); // 現時点の充足は落ちる。
    expect(r.status).toBe('UNLOCKED'); // が、latch は維持される。
  });
});
