import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { upsertFutureRuleSet } from '../rules/rules.js';
import { evaluateDay } from '../rules/evaluate.js';
import { saveReflection } from './reflection.js';
import { createTask } from './tasks.js';
import { getPlanningSignal, refreshPlanningStatus } from './planning.js';

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h: number, mi: number) =>
  zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);
const NOW_YESTERDAY = jst(2026, 7, 9, 12, 0);
const NOW_TODAY = jst(2026, 7, 10, 12, 0);
const DAY_TODAY = '2026-07-10';
const DAY_TOMORROW = '2026-07-11';

function seedTotals(db: DB, group: string, ms: number): void {
  db.prepare(
    `INSERT INTO daily_totals_snapshot (day_key, stable_group_id, ms, is_final, updated_at)
     VALUES (?, ?, ?, 0, 0)
     ON CONFLICT(day_key, stable_group_id) DO UPDATE SET ms = excluded.ms`,
  ).run(DAY_TODAY, group, ms);
}

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  // 当日ルール: 総作業 >= 1h ＆ PLANNING（翌日計画完了）。
  upsertFutureRuleSet(
    db,
    DAY_TODAY,
    {
      combinator: 'ALL',
      conditions: [
        { target: 'TOTAL_WORK', thresholdSeconds: 3600 },
        { target: 'PLANNING', signalKey: 'default', conditionKey: 'planning' },
      ],
    },
    NOW_YESTERDAY,
  );
  seedTotals(db, 'g-dev', 4000 * 1000); // 総作業 4000s >= 3600
});

describe('PLANNING シグナル & ゲート統合（9.3–9.5）', () => {
  it('振り返り・翌日タスクが無ければ planningDone=false', () => {
    const sig = getPlanningSignal(db, DAY_TODAY);
    expect(sig.reflectionDone).toBe(false);
    expect(sig.tomorrowTaskCount).toBe(0);
    expect(sig.planningDone).toBe(false);
  });

  it('作業条件を満たしても、翌日タスク未登録＋振り返り未記入ではロック', () => {
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    const work = r.perCondition.find((p) => p.target === 'TOTAL_WORK')!;
    const planning = r.perCondition.find((p) => p.target === 'PLANNING')!;
    expect(work.met).toBe(true);
    expect(planning.met).toBe(false);
    expect(r.status).toBe('LOCKED');
  });

  it('振り返り記録＋翌日タスク登録で planningDone=true → 達成', () => {
    saveReflection(db, DAY_TODAY, '# 今日の振り返り\n競プロを進めた。');
    createTask(db, { title: '明日: DPの復習', status: 'TOMORROW', planned_for: DAY_TOMORROW });
    const sig = refreshPlanningStatus(db, DAY_TODAY);
    expect(sig.reflectionDone).toBe(true);
    expect(sig.tomorrowTaskCount).toBe(1);
    expect(sig.planningDone).toBe(true);

    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    expect(r.perCondition.find((p) => p.target === 'PLANNING')!.met).toBe(true);
    expect(r.status).toBe('UNLOCKED');
    expect(r.justUnlocked).toBe(true);

    // planning_status が materialize されている。
    const ps = db.prepare('SELECT planning_done FROM planning_status WHERE date = ?').get(DAY_TODAY) as {
      planning_done: number;
    };
    expect(ps.planning_done).toBe(1);
  });

  it('振り返りだけ（翌日タスク無し）では未達成のまま', () => {
    saveReflection(db, DAY_TODAY, '振り返りのみ');
    const sig = refreshPlanningStatus(db, DAY_TODAY);
    expect(sig.reflectionDone).toBe(true);
    expect(sig.tomorrowTaskCount).toBe(0);
    expect(sig.planningDone).toBe(false);
    const r = evaluateDay(db, DAY_TODAY, NOW_TODAY);
    expect(r.status).toBe('LOCKED');
  });
});
