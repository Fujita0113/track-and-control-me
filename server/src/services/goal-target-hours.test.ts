import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { createGoal, getGoal, goalPace, addDaysKey, GoalValidationError } from './goals.js';
import { resolveIdentity } from './group-identity.js';
import { evaluateDay } from '../rules/evaluate.js';
import { freezeGoal } from './goal-freeze.js';

/**
 * 目標時間（spec: goal-target-hours・issue #76）。
 *
 * 目標時間は「1日あたり何時間」を1目標につき最大1つ・任意で持つ。**解錠ゲートには合流しない**
 * （平均は日次で確定しないため乗せられない／乗せると実質の下限になり二段構えが消える）。
 * ペースは `必要累計 = 目標時間 × 経過日数（今日を含む・凍結日を除く）` から `今日あと` を出す。
 *
 * 時間軸は JST 固定。目標は 2026-08-01 開始・2026-08-06 期限（6日）。
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

const START = '2026-08-01';
const END = '2026-08-06';
const NOW_D1 = jst(2026, 8, 1);
const NOW_D4 = jst(2026, 8, 4);
const NOW_D5 = jst(2026, 8, 5);
const MIN = 60_000;
const H = 3600;

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

/** その日そのグループの実測を積む（today-group-breakdown と同じ identity 規則で読まれる）。 */
function seedSession(sid: string, name: string, color: string | null, ms: number, dayKey: string): void {
  db.prepare(
    `INSERT INTO session
       (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
        started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES (?, ?, ?, NULL, 0, ?, ?, '[]', 1, ?, 'NORMAL', 0)`,
  ).run(sid, name, color, ms, dayKey, ms);
}

function seedTotals(sid: string, ms: number, dayKey: string): void {
  db.prepare(
    `INSERT INTO daily_totals_snapshot (day_key, stable_group_id, ms, is_final, updated_at)
     VALUES (?, ?, ?, 0, 0)
     ON CONFLICT(day_key, stable_group_id) DO UPDATE SET ms = excluded.ms`,
  ).run(dayKey, sid, ms);
}

/** 下限ルール1本だけを持つ素の目標（目標時間なし）。 */
function baseInput(over: Record<string, unknown> = {}) {
  return {
    name: 'アルゴリズムを固める',
    purpose: 'アルゴリズムを一通り自力で実装できるようになっている',
    startReason: '試験前だが手は止めたくない',
    endDay: END,
    rules: [{ target: 'TOTAL_WORK' as const, thresholdSeconds: 900, reason: '崩さない下限' }],
    ...over,
  };
}

describe('目標時間の定義（1目標に最大1つ・任意・時間型のみ）', () => {
  it('目標時間なしの目標を作れる（ペースが出ないだけ）', () => {
    const g = createGoal(db, baseInput(), NOW_D1);
    expect(g.targetHours).toBeNull();
    expect(goalPace(db, g.id, NOW_D1)).toBeNull();
    // 他はすべて通常どおり（状態・期間・ルール）。
    expect(g.status).toBe('active');
    expect(g.dayCount).toBe(6);
    expect(g.rules).toHaveLength(1);
  });

  it('下限ルールが無い対象にも目標時間を置ける', () => {
    const design = resolveIdentity(db, '設計理解', 'blue')!;
    const g = createGoal(
      db,
      baseInput({
        // 下限は総作業時間のみ。設計理解グループの下限ルールは存在しない。
        targetHours: { kind: 'GROUP_SET', secondsPerDay: 1 * H, groupIdentityIds: [design] },
      }),
      NOW_D1,
    );
    expect(g.targetHours!.secondsPerDay).toBe(1 * H);
    // ゲートの条件は増えていない（下限ルール1本のまま）。
    expect(evaluateDay(db, START, NOW_D1).perCondition).toHaveLength(1);
  });

  it('時間型以外（MANUAL_CHECK / PHOTO 等）は目標時間の対象にできない', () => {
    expect(() =>
      createGoal(db, baseInput({ targetHours: { kind: 'MANUAL_CHECK', secondsPerDay: 1 * H } }), NOW_D1),
    ).toThrow(GoalValidationError);
  });

  it('GROUP_SET は対象を1つ以上必要とし、0件は拒否される', () => {
    expect(() =>
      createGoal(db, baseInput({ targetHours: { kind: 'GROUP_SET', secondsPerDay: 2 * H, groupIdentityIds: [] } }), NOW_D1),
    ).toThrow(GoalValidationError);
  });
});

describe('「or」＝複数グループを束ねて合計する', () => {
  function goalWithOr() {
    const algo = resolveIdentity(db, 'アルゴリズム', 'yellow')!;
    const py = resolveIdentity(db, 'Python', 'green')!;
    return createGoal(
      db,
      baseInput({ targetHours: { kind: 'GROUP_SET', secondsPerDay: 2 * H, groupIdentityIds: [algo, py] } }),
      NOW_D1,
    );
  }

  it('2グループの合計で実測が積まれる', () => {
    const g = goalWithOr();
    seedSession('sid-algo', 'アルゴリズム', 'yellow', 70 * MIN, START);
    seedSession('sid-py', 'Python', 'green', 50 * MIN, START);

    const pace = goalPace(db, g.id, NOW_D1)!;
    expect(pace.elapsedDays).toBe(1);
    expect(pace.accumulatedSeconds).toBe(120 * 60); // 70分 + 50分 = 2時間
    expect(pace.met).toBe(true);
    expect(pace.todayRemainSeconds).toBe(0);
  });

  it('同名同色のグループが開き直しで別 sid になっても分裂せず合算される', () => {
    const g = goalWithOr();
    // 同じ「アルゴリズム(yellow)」が 3 つの別 sid として 40 分ずつ記録される。
    seedSession('sid-a1', 'アルゴリズム', 'yellow', 40 * MIN, START);
    seedSession('sid-a2', 'アルゴリズム', 'yellow', 40 * MIN, START);
    seedSession('sid-a3', 'アルゴリズム', 'yellow', 40 * MIN, START);

    const pace = goalPace(db, g.id, NOW_D1)!;
    expect(pace.accumulatedSeconds).toBe(120 * 60);
  });

  it('束ねる対象に同じものを2回入れられない（二重計上の防止）', () => {
    const algo = resolveIdentity(db, 'アルゴリズム', 'yellow')!;
    expect(() =>
      createGoal(
        db,
        baseInput({ targetHours: { kind: 'GROUP_SET', secondsPerDay: 2 * H, groupIdentityIds: [algo, algo] } }),
        NOW_D1,
      ),
    ).toThrow(GoalValidationError);
  });

  it('束ねた対象の並びは決定的（指定順を保ち、2回読んでも入れ替わらない）', () => {
    const g = goalWithOr();
    // 作成時に返るビューと、読み直したビューで並びが一致する。
    expect(g.targetHours!.labels).toEqual(['アルゴリズム', 'Python']);
    expect(getGoal(db, g.id, NOW_D1).targetHours!.labels).toEqual(['アルゴリズム', 'Python']);
    expect(getGoal(db, g.id, NOW_D1).targetHours!.refs).toEqual(
      getGoal(db, g.id, NOW_D1).targetHours!.refs,
    );
  });
});

describe('ペースの算定（分母＝経過日数・今日を含む）', () => {
  function goalWithTarget(secondsPerDay = 2 * H) {
    const algo = resolveIdentity(db, 'アルゴリズム', 'yellow')!;
    return createGoal(
      db,
      baseInput({ targetHours: { kind: 'GROUP_SET', secondsPerDay, groupIdentityIds: [algo] } }),
      NOW_D1,
    );
  }

  it('分母は今日を含む（4日目・累計4h12m → 平均1h03m・今日あと3h48m）', () => {
    const g = goalWithTarget();
    // Day1〜3 で 4 時間、Day4（今日）で 12 分 → 累計 4h12m。
    seedSession('sid-a', 'アルゴリズム', 'yellow', 240 * MIN, START);
    seedSession('sid-a', 'アルゴリズム', 'yellow', 12 * MIN, addDaysKey(START, 3));

    const pace = goalPace(db, g.id, NOW_D4)!;
    expect(pace.elapsedDays).toBe(4);
    expect(pace.accumulatedSeconds).toBe(252 * 60); // 4h12m
    expect(pace.averageSeconds).toBe(63 * 60); // 1h03m
    expect(pace.targetSecondsPerDay).toBe(2 * H);
    expect(pace.met).toBe(false);
    // 必要累計 = 2h × 4 = 8h、今日あと = 8h − 4h12m = 3h48m
    expect(pace.todayRemainSeconds).toBe(228 * 60);
  });

  it('到達済みは todayRemain が 0 になる', () => {
    const g = goalWithTarget();
    seedSession('sid-a', 'アルゴリズム', 'yellow', 300 * MIN, START); // 5時間

    const pace = goalPace(db, g.id, NOW_D1)!;
    expect(pace.met).toBe(true);
    expect(pace.todayRemainSeconds).toBe(0);
  });

  it('伸びるほど必要量が増える（同じ累計でも翌日は目標時間ぶん増える）', () => {
    const g = goalWithTarget();
    seedSession('sid-a', 'アルゴリズム', 'yellow', 60 * MIN, START); // 1時間だけ

    const d4 = goalPace(db, g.id, NOW_D4)!;
    const d5 = goalPace(db, g.id, NOW_D5)!;
    expect(d5.todayRemainSeconds - d4.todayRemainSeconds).toBe(2 * H);
  });

  it('凍結日は分母に入らない', () => {
    const g = goalWithTarget();
    // 8/1 に凍結（当日発効・8/2まで）。8/4 時点の経過は 8/3・8/4 の2日（8/1・8/2 は凍結で除外）。
    freezeGoal(db, g.id, { endDay: addDaysKey(START, 1), reason: '体調不良' }, NOW_D1);
    seedSession('sid-a', 'アルゴリズム', 'yellow', 120 * MIN, '2026-08-04');

    const pace = goalPace(db, g.id, NOW_D4)!;
    expect(pace.elapsedDays).toBe(2);
    expect(pace.averageSeconds).toBe(60 * 60);
  });

  it('開始前（経過0日）はペースを返さない', () => {
    const algo = resolveIdentity(db, 'アルゴリズム', 'yellow')!;
    const g = createGoal(
      db,
      baseInput({
        start: 'tomorrow',
        endDay: addDaysKey(START, 6),
        targetHours: { kind: 'GROUP_SET', secondsPerDay: 2 * H, groupIdentityIds: [algo] },
      }),
      NOW_D1,
    );
    expect(goalPace(db, g.id, NOW_D1)).toBeNull();
  });

  it('TOTAL_WORK の目標時間は日次サマリの総作業秒を分子にする', () => {
    const g = createGoal(
      db,
      baseInput({ targetHours: { kind: 'TOTAL_WORK', secondsPerDay: 4 * H } }),
      NOW_D1,
    );
    seedTotals('sid-x', 120 * MIN, START);

    const pace = goalPace(db, g.id, NOW_D1)!;
    expect(pace.accumulatedSeconds).toBe(120 * 60);
    expect(pace.met).toBe(false);
  });
});

describe('目標時間は解錠ゲートへ合流しない（design D3・中核禁止事項）', () => {
  it('per_condition_results に目標時間由来のエントリが1件も現れない', () => {
    const algo = resolveIdentity(db, 'アルゴリズム', 'yellow')!;
    const g = createGoal(
      db,
      baseInput({ targetHours: { kind: 'GROUP_SET', secondsPerDay: 2 * H, groupIdentityIds: [algo] } }),
      NOW_D1,
    );
    // 前提: 目標時間が本当に保持されていること（これが無いと以下は空虚に通ってしまう）。
    expect(g.targetHours!.secondsPerDay).toBe(2 * H);

    const res = evaluateDay(db, START, NOW_D1);
    // 下限ルール（総作業時間）1件のみ。目標時間の行は無い。
    expect(res.perCondition).toHaveLength(1);
    expect(res.perCondition[0]!.target).toBe('TOTAL_WORK');
    for (const c of res.perCondition) {
      expect(c.conditionKey.startsWith('target:')).toBe(false);
      expect(c.conditionKey.startsWith('targetHours')).toBe(false);
    }
  });

  it('目標時間が大きく未達でも、下限を満たせば UNLOCKED になる', () => {
    const algo = resolveIdentity(db, 'アルゴリズム', 'yellow')!;
    const g = createGoal(
      db,
      baseInput({ targetHours: { kind: 'GROUP_SET', secondsPerDay: 8 * H, groupIdentityIds: [algo] } }),
      NOW_D1,
    );
    // 下限は総作業 15 分。20 分だけ働く（目標時間 8h には遠く及ばない）。
    seedTotals('sid-x', 20 * MIN, START);
    // 前提: 目標時間は確かに大きく未達である。
    expect(goalPace(db, g.id, NOW_D1)!.met).toBe(false);

    expect(evaluateDay(db, START, NOW_D1).status).toBe('UNLOCKED');
  });
});
