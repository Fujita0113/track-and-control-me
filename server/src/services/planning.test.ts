import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { createRule } from './rule-registry.js';
import { evaluateDay } from '../rules/evaluate.js';
import { saveReflection } from './reflection.js';
import { createTask } from './tasks.js';
import { getPlanningSignal, refreshPlanningStatus, resolvePlanningSignal } from './planning.js';
import { updateConfig } from '../db/index.js';

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
  createRule(db, { target: 'TOTAL_WORK', thresholdSeconds: 3600, startDay: DAY_TODAY, reason: 'r' }, NOW_YESTERDAY);
  // signal_key 未設定（null）は後方互換で tomorrow_planned として評価される（既存データの再現のため
  // rule-registry の新規作成バリデーションを経由せず直接 INSERT する）。
  db.prepare(
    `INSERT INTO rule (target, comparator, threshold_seconds, label, signal_key, start_day, end_day, status, created_at)
     VALUES ('PLANNING', 'GTE', NULL, NULL, NULL, ?, NULL, 'active', ?)`,
  ).run(DAY_TODAY, NOW_YESTERDAY);
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

describe('resolvePlanningSignal（単独シグナル / signal_key 駆動）', () => {
  it('reflection_done: 本文ありで true / 未記録で false', () => {
    expect(resolvePlanningSignal(db, DAY_TODAY, 'reflection_done')).toBe(false);
    saveReflection(db, DAY_TODAY, '# 振り返り\n進めた。');
    expect(resolvePlanningSignal(db, DAY_TODAY, 'reflection_done')).toBe(true);
  });

  it('reflection_done: 空白のみの本文は false', () => {
    saveReflection(db, DAY_TODAY, '   \n  ');
    expect(resolvePlanningSignal(db, DAY_TODAY, 'reflection_done')).toBe(false);
  });

  it('tomorrow_tasks_registered: 翌日タスク数が閾値以上で true', () => {
    // 既定閾値=1。
    expect(resolvePlanningSignal(db, DAY_TODAY, 'tomorrow_tasks_registered')).toBe(false);
    createTask(db, { title: '明日: DP 復習', status: 'TODO', due: DAY_TOMORROW });
    expect(resolvePlanningSignal(db, DAY_TODAY, 'tomorrow_tasks_registered')).toBe(true);
  });

  it('tomorrow_tasks_registered: 閾値変更が評価に反映される', () => {
    updateConfig(db, { planning_min_tomorrow_tasks: 3 });
    createTask(db, { title: 'A', status: 'TODO', due: DAY_TOMORROW });
    createTask(db, { title: 'B', status: 'TODO', due: DAY_TOMORROW });
    // 2 件 < 3 → false。
    expect(resolvePlanningSignal(db, DAY_TODAY, 'tomorrow_tasks_registered')).toBe(false);
    createTask(db, { title: 'C', status: 'TODO', due: DAY_TOMORROW });
    // 3 件 >= 3 → true。
    expect(resolvePlanningSignal(db, DAY_TODAY, 'tomorrow_tasks_registered')).toBe(true);
  });

  it('tomorrow_tasks_registered: DONE の翌日タスクは計上しない', () => {
    createTask(db, { title: '完了済み', status: 'DONE', due: DAY_TOMORROW });
    expect(resolvePlanningSignal(db, DAY_TODAY, 'tomorrow_tasks_registered')).toBe(false);
  });

  it('tomorrow_planned: 振り返り＋翌日タスクの両方で true（合成）', () => {
    saveReflection(db, DAY_TODAY, '振り返り');
    expect(resolvePlanningSignal(db, DAY_TODAY, 'tomorrow_planned')).toBe(false);
    createTask(db, { title: '明日タスク', status: 'TODO', due: DAY_TOMORROW });
    expect(resolvePlanningSignal(db, DAY_TODAY, 'tomorrow_planned')).toBe(true);
  });

  it('後方互換: signal_key=null は tomorrow_planned と同一結果', () => {
    saveReflection(db, DAY_TODAY, '振り返り');
    createTask(db, { title: '明日タスク', status: 'TODO', due: DAY_TOMORROW });
    const viaNull = resolvePlanningSignal(db, DAY_TODAY, null);
    const viaPlanned = resolvePlanningSignal(db, DAY_TODAY, 'tomorrow_planned');
    const planningDone = getPlanningSignal(db, DAY_TODAY).planningDone;
    expect(viaNull).toBe(planningDone);
    expect(viaNull).toBe(viaPlanned);
    expect(viaNull).toBe(true);
  });

  it('未知の signal_key は false（誤解錠しない）', () => {
    // たとえ振り返り・翌日タスクが揃っていても未知キーは false。
    saveReflection(db, DAY_TODAY, '振り返り');
    createTask(db, { title: '明日タスク', status: 'TODO', due: DAY_TOMORROW });
    expect(resolvePlanningSignal(db, DAY_TODAY, 'no_such_signal')).toBe(false);
  });

  it('ゲート統合: signal_key=reflection_done は振り返りだけで達成しうる', () => {
    // 別途、reflection_done 単独条件のルールを翌日発効で作り評価する（beforeEach の signalKey=null
    // ルールも同時に有効なため、signalKey で絞って読む）。
    createRule(db, { target: 'PLANNING', signalKey: 'reflection_done', startDay: DAY_TOMORROW, reason: 'r' }, NOW_TODAY);
    const NOW_TMR = jst(2026, 7, 11, 12, 0);
    let r = evaluateDay(db, DAY_TOMORROW, NOW_TMR);
    expect(r.perCondition.find((p) => p.signalKey === 'reflection_done')!.met).toBe(false);
    saveReflection(db, DAY_TOMORROW, '明日側の振り返り');
    r = evaluateDay(db, DAY_TOMORROW, NOW_TMR);
    expect(r.perCondition.find((p) => p.signalKey === 'reflection_done')!.met).toBe(true);
  });
});
