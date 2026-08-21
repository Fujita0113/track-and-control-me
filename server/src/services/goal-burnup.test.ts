import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { createGoal, addDaysKey, goalPace } from './goals.js';
import { resolveIdentity } from './group-identity.js';
import { freezeGoal } from './goal-freeze.js';
import { createRootTask } from './task-tree.js';
import { setTaskEstimate } from './task-estimate.js';
import { goalBurnup } from './goal-burnup.js';

/**
 * バーンアップ（spec: goal-burnup）。
 *
 * 縦軸＝累積作業時間・横軸＝日付。累積線とスコープ線（残り想定時間）の交点が完了予想日。
 * 予測は「全体平均」と「直近3日」の2本で、**凍結日は除外せず 0h の実績として暦どおり数える**
 * （谷が深いほど復帰後の直近3日ペースが跳ねること自体が報酬になるため）。
 *
 * 時間軸は JST 固定。目標は 2026-08-01 開始・2026-12-31 期限、「今日」は 2026-08-18（経過18日）。
 *
 * 筋書き（すべてのケースで共有）:
 *   実測 36h ／ 直近3日 18h ／ 残り想定 192h
 *     全体平均 = 129,600s ÷ 18日 = 7,200s/日（2.0h/日） → ceil(691,200 ÷ 7,200) = 96日 → 11/22
 *     直近3日  =  64,800s ÷  3日 = 21,600s/日（6.0h/日） → ceil(691,200 ÷ 21,600) = 32日 →  9/19
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

const START = '2026-08-01';
const END = '2026-12-31';
const TODAY = '2026-08-18';
const NOW_D1 = jst(2026, 8, 1);
const NOW_TODAY = jst(2026, 8, 18, 23, 30);
const H = 3600;

/** 凍結しない8日（8/1〜8/4・8/12〜8/15）に 2.25h ずつ＝18h。 */
const EARLY_DAYS = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
/** 凍結する7日（8/5〜8/11）は 0h。 */
const FROZEN_DAYS = ['2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11'];
/** 直近3日は 6h ずつ＝18h。 */
const RECENT_DAYS = ['2026-08-16', '2026-08-17', '2026-08-18'];

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function seedSession(name: string, color: string | null, ms: number, dayKey: string): void {
  db.prepare(
    `INSERT INTO session
       (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
        started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES (?, ?, ?, NULL, 0, ?, ?, '[]', 1, ?, 'NORMAL', 0)`,
  ).run(`sg-${dayKey}-${name}`, name, color, ms, dayKey, ms);
}

/** 「設計理解」グループへ、筋書きどおりの実測を積む。 */
function seedScenarioWork(): void {
  for (const d of EARLY_DAYS) seedSession('設計理解', 'blue', 2.25 * H * 1000, d);
  for (const d of RECENT_DAYS) seedSession('設計理解', 'blue', 6 * H * 1000, d);
}

/** 「設計理解」を対象に持つ目標。残り想定 192h（24 + 64 + 104）を根直下3枝の仮置きで作る。 */
function seedGoalWithScope(withEstimates = true) {
  const design = resolveIdentity(db, '設計理解', 'blue')!;
  const g = createGoal(
    db,
    {
      name: '設計理解',
      purpose: '設計を自力で引けるようになっている',
      startReason: '手が止まる前に型を入れたい',
      endDay: END,
      rules: [{ target: 'TOTAL_WORK' as const, thresholdSeconds: 900, reason: '崩さない下限' }],
      targetHours: { kind: 'GROUP_SET' as const, secondsPerDay: 2 * H, groupIdentityIds: [design] },
    },
    NOW_D1,
  );
  if (withEstimates) {
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    const b = createRootTask(db, g.id, '二周目を見る');
    const c = createRootTask(db, g.id, 'track-and-control-me を作り直す');
    const put = (id: number, hours: number) =>
      setTaskEstimate(db, id, { estimatedSeconds: hours * H, reason: '仮置き', actor: 'agent' }, NOW_D1);
    put(a.id, 24);
    put(b.id, 64);
    put(c.id, 104);
  }
  return g;
}

describe('累積線と2本のペース', () => {
  it('凍結日を分母に含めた全体平均と、直近3日から2つの完了予想日が出る', () => {
    seedScenarioWork();
    const g = seedGoalWithScope();
    freezeGoal(db, g.id, { endDay: '2026-08-11', reason: 'e2e 用の谷' }, jst(2026, 8, 5));

    const v = goalBurnup(db, g.id, NOW_TODAY)!;

    expect(v.remainingSeconds).toBe(192 * H);
    // 凍結7日を含む18日で割る（除外して 11日で割った 3.27h/日 ではない）。
    expect(v.overall.averageSecondsPerDay).toBe(2 * H);
    expect(v.recent3.averageSecondsPerDay).toBe(6 * H);
    expect(v.overall.projectedDay).toBe('2026-11-22');
    expect(v.recent3.projectedDay).toBe('2026-09-19');
  });

  it('凍結日は横軸に残り、その区間で累積は伸びない', () => {
    seedScenarioWork();
    const g = seedGoalWithScope();
    freezeGoal(db, g.id, { endDay: '2026-08-11', reason: 'e2e 用の谷' }, jst(2026, 8, 5));

    const v = goalBurnup(db, g.id, NOW_TODAY)!;
    const byDay = new Map(v.points.map((p) => [p.dayKey, p.accumulatedSeconds]));

    // 8/1〜8/18 の18日ぶんが欠けずに並ぶ。
    expect(v.points).toHaveLength(18);
    for (const d of FROZEN_DAYS) expect(byDay.has(d)).toBe(true);
    // 凍結区間の入口と出口で累積が同じ＝水平。
    expect(byDay.get('2026-08-11')).toBe(byDay.get('2026-08-04'));
    // 単調増加（減る点が無い）。
    for (let i = 1; i < v.points.length; i++) {
      expect(v.points[i]!.accumulatedSeconds).toBeGreaterThanOrEqual(v.points[i - 1]!.accumulatedSeconds);
    }
    expect(v.points.at(-1)!.accumulatedSeconds).toBe(36 * H);
  });

  it('目標時間のペース（凍結日を除く既存の平均）は変わらない', () => {
    seedScenarioWork();
    const g = seedGoalWithScope();
    freezeGoal(db, g.id, { endDay: '2026-08-11', reason: 'e2e 用の谷' }, jst(2026, 8, 5));

    const pace = goalPace(db, g.id, NOW_TODAY)!;
    const v = goalBurnup(db, g.id, NOW_TODAY)!;

    // 既存は凍結日を分母から除く（11日）。バーンアップは含める（18日）。別々の指標として共存する。
    expect(pace.elapsedDays).toBe(11);
    expect(pace.averageSeconds).toBe(Math.floor(36 * H / 11));
    expect(v.overall.averageSecondsPerDay).toBe(2 * H);
  });

  it('期限を越える完了予想日も隠さず返す', () => {
    seedScenarioWork();
    const design = resolveIdentity(db, '設計理解', 'blue')!;
    const g = createGoal(
      db,
      {
        name: '設計理解',
        purpose: '設計を自力で引けるようになっている',
        startReason: '手が止まる前に型を入れたい',
        endDay: '2026-09-30',
        rules: [{ target: 'TOTAL_WORK' as const, thresholdSeconds: 900, reason: '崩さない下限' }],
        targetHours: { kind: 'GROUP_SET' as const, secondsPerDay: 2 * H, groupIdentityIds: [design] },
      },
      NOW_D1,
    );
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    setTaskEstimate(db, a.id, { estimatedSeconds: 192 * H, reason: '仮置き', actor: 'agent' }, NOW_D1);

    const v = goalBurnup(db, g.id, NOW_TODAY)!;
    expect(v.overall.projectedDay).toBe('2026-11-22');
    expect(v.overall.projectedDay! > v.endDay).toBe(true);
  });
});

describe('予想を出せない場合', () => {
  it('直近3日の累積が 0 ならその予想日は null（0 除算の値を返さない）', () => {
    for (const d of EARLY_DAYS) seedSession('設計理解', 'blue', 2.25 * H * 1000, d);
    const g = seedGoalWithScope();

    const v = goalBurnup(db, g.id, NOW_TODAY)!;
    expect(v.recent3.averageSecondsPerDay).toBe(0);
    expect(v.recent3.projectedDay).toBeNull();
    expect(Number.isFinite(v.overall.averageSecondsPerDay)).toBe(true);
  });

  it('想定が1件も無ければ残り想定も完了予想日も null になる', () => {
    seedScenarioWork();
    const g = seedGoalWithScope(false);

    const v = goalBurnup(db, g.id, NOW_TODAY)!;
    expect(v.remainingSeconds).toBeNull();
    expect(v.overall.projectedDay).toBeNull();
    expect(v.recent3.projectedDay).toBeNull();
    // 累積線そのものは描ける。
    expect(v.points.at(-1)!.accumulatedSeconds).toBe(36 * H);
  });

  it('開始前の目標は拒否される（null）', () => {
    const design = resolveIdentity(db, '設計理解', 'blue')!;
    const g = createGoal(
      db,
      {
        name: '設計理解',
        purpose: '設計を自力で引けるようになっている',
        startReason: '手が止まる前に型を入れたい',
        endDay: END,
        start: 'tomorrow',
        rules: [{ target: 'TOTAL_WORK' as const, thresholdSeconds: 900, reason: '崩さない下限' }],
        targetHours: { kind: 'GROUP_SET' as const, secondsPerDay: 2 * H, groupIdentityIds: [design] },
      },
      NOW_D1,
    );
    expect(goalBurnup(db, g.id, NOW_D1)).toBeNull();
  });
});

describe('計測対象の解決', () => {
  it('目標時間の対象が使われ、1日あたりの目標秒数は累積に影響しない', () => {
    seedScenarioWork();
    const g = seedGoalWithScope();
    const v = goalBurnup(db, g.id, NOW_TODAY)!;

    expect(v.target).not.toBeNull();
    expect(v.target!.labels).toContain('設計理解');
    // 2h/日 という目標は累積にもスコープにも現れない。
    expect(v.points.at(-1)!.accumulatedSeconds).toBe(36 * H);
    expect(v.remainingSeconds).toBe(192 * H);
  });

  it('目標時間が無ければ時間型ルールの対象を束ねて合計する', () => {
    seedSession('Python', 'green', 2 * H * 1000, TODAY);
    seedSession('設計理解', 'blue', 1 * H * 1000, TODAY);
    const python = resolveIdentity(db, 'Python', 'green')!;
    const design = resolveIdentity(db, '設計理解', 'blue')!;
    const g = createGoal(
      db,
      {
        name: '設計理解',
        purpose: '設計を自力で引けるようになっている',
        startReason: '手が止まる前に型を入れたい',
        endDay: END,
        rules: [
          { target: 'GROUP' as const, groupIdentityId: python, thresholdSeconds: 900, reason: 'Python' },
          { target: 'GROUP' as const, groupIdentityId: design, thresholdSeconds: 900, reason: '設計' },
        ],
      },
      NOW_D1,
    );
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    setTaskEstimate(db, a.id, { estimatedSeconds: 10 * H, reason: '仮置き', actor: 'agent' }, NOW_D1);

    const v = goalBurnup(db, g.id, NOW_TODAY)!;
    expect(v.points.at(-1)!.accumulatedSeconds).toBe(3 * H);
  });

  it('対象が無ければ空状態になり、全作業時間へフォールバックしない', () => {
    seedSession('家計簿', 'red', 5 * H * 1000, TODAY);
    const g = createGoal(
      db,
      {
        name: '設計理解',
        purpose: '設計を自力で引けるようになっている',
        startReason: '手が止まる前に型を入れたい',
        endDay: END,
        rules: [{ target: 'PLANNING' as const, signalKey: 'reflection_done', reason: '振り返る' }],
      },
      NOW_D1,
    );
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    setTaskEstimate(db, a.id, { estimatedSeconds: 10 * H, reason: '仮置き', actor: 'agent' }, NOW_D1);

    const v = goalBurnup(db, g.id, NOW_TODAY)!;
    expect(v.target).toBeNull();
    expect(v.points).toHaveLength(0);
    expect(v.overall.projectedDay).toBeNull();
  });
});

describe('スコープ線の段差', () => {
  it('想定を変えた日に、理由と実行者つきの段差が残る', () => {
    seedScenarioWork();
    const g = seedGoalWithScope();
    const rootId = createRootTask(db, g.id, '追加の枝').id;
    setTaskEstimate(db, rootId, { estimatedSeconds: 48 * H, reason: '当初の見立て', actor: 'agent' }, NOW_D1);
    setTaskEstimate(
      db,
      rootId,
      { estimatedSeconds: 24 * H, reason: '一周目は思ったより軽い', actor: 'agent' },
      jst(2026, 8, 17),
    );

    const v = goalBurnup(db, g.id, NOW_TODAY)!;
    const step = v.scopeChanges.find((c) => c.dayKey === '2026-08-17' && c.toSeconds === 24 * H)!;
    expect(step.reason).toBe('一周目は思ったより軽い');
    expect(step.actor).toBe('agent');
    expect(step.fromSeconds).toBe(48 * H);
  });

  it('タスクを消すとスコープが下がる', () => {
    seedScenarioWork();
    const g = seedGoalWithScope();
    const before = goalBurnup(db, g.id, NOW_TODAY)!.remainingSeconds!;

    const extra = createRootTask(db, g.id, '消す予定の枝');
    setTaskEstimate(db, extra.id, { estimatedSeconds: 12 * H, reason: '仮置き', actor: 'agent' }, NOW_D1);
    expect(goalBurnup(db, g.id, NOW_TODAY)!.remainingSeconds).toBe(before + 12 * H);

    db.prepare('DELETE FROM task WHERE id = ?').run(extra.id);
    expect(goalBurnup(db, g.id, NOW_TODAY)!.remainingSeconds).toBe(before);
  });
});

describe('解錠ゲートへ合流しない', () => {
  it('バーンアップ由来の条件は評価行に現れない', () => {
    seedScenarioWork();
    const g = seedGoalWithScope();
    goalBurnup(db, g.id, NOW_TODAY);

    const rows = db.prepare('SELECT per_condition_results FROM unlock_evaluation').all() as {
      per_condition_results: string;
    }[];
    for (const r of rows) {
      expect(r.per_condition_results).not.toContain('burnup');
    }
  });
});

describe('addDaysKey との整合', () => {
  it('完了予想日は「今日 + 切り上げた残り日数」である', () => {
    seedScenarioWork();
    const g = seedGoalWithScope();
    const v = goalBurnup(db, g.id, NOW_TODAY)!;

    expect(v.overall.projectedDay).toBe(addDaysKey(TODAY, Math.ceil((192 * H) / (2 * H))));
    expect(v.recent3.projectedDay).toBe(addDaysKey(TODAY, Math.ceil((192 * H) / (6 * H))));
  });
});
