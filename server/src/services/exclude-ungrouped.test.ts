import { describe, it, expect, beforeEach } from 'vitest';
import { UNGROUPED_KEY } from '@track/contract';
import { openDb, type DB, getConfig, updateConfig } from '../db/index.js';
import { MIGRATIONS } from '../db/migrations.js';
import { totalWorkMsForDay, totalWorkSecondsForDay } from './categories.js';
import { daySummary, rangeSummary } from './summary.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { createRule } from './rule-registry.js';
import { evaluateDay } from '../rules/evaluate.js';

/**
 * spec: work-time-scope — 未グループ（`ungrouped`）時間を総作業時間へ算入するかの設定。
 * 集計 source（categories）・range サマリ・ルール評価が同一規則で波及することを固定する。
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h: number, mi: number) =>
  zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);
const DAY = '2026-07-10';
const NOW_BEFORE = jst(2026, 7, 9, 12, 0); // ルールを未来ルールとして作成
const NOW_DAY = jst(2026, 7, 10, 12, 0);
const MIN = 60_000; // 1 分の ms

function seedTotals(db: DB, dayKey: string, group: string, ms: number): void {
  db.prepare(
    `INSERT INTO daily_totals_snapshot (day_key, stable_group_id, ms, is_final, updated_at)
     VALUES (?, ?, ?, 0, 0)
     ON CONFLICT(day_key, stable_group_id) DO UPDATE SET ms = excluded.ms`,
  ).run(dayKey, group, ms);
}

function setExclude(db: DB, on: boolean): void {
  updateConfig(db, { exclude_ungrouped_from_total: on ? 1 : 0 });
}

/** 内訳(groups)は session 由来（today-group-breakdown）。表示検証用に1セッション行を投入する。 */
function seedSession(
  db: DB,
  dayKey: string,
  sid: string,
  name: string,
  color: string | null,
  ms: number,
): void {
  db.prepare(
    `INSERT INTO session
       (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
        started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES (?, ?, ?, NULL, 0, ?, ?, '[]', 1, ?, 'NORMAL', 0)`,
  ).run(sid, name, color, ms, dayKey, ms);
}

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('5.1 集計: 未グループの算入は設定で切り替わる', () => {
  it('OFF（既定）では未グループを含めて合算する', () => {
    seedTotals(db, DAY, 'g-dev', 40 * MIN);
    seedTotals(db, DAY, UNGROUPED_KEY, 20 * MIN);
    expect(getConfig(db).exclude_ungrouped_from_total).toBe(0); // 既定 OFF
    expect(totalWorkMsForDay(db, DAY)).toBe(60 * MIN);
  });

  it('ON では未グループを合算から除外する（実グループは残す）', () => {
    seedTotals(db, DAY, 'g-dev', 40 * MIN);
    seedTotals(db, DAY, UNGROUPED_KEY, 20 * MIN);
    setExclude(db, true);
    expect(totalWorkMsForDay(db, DAY)).toBe(40 * MIN);
  });

  it('ON かつ未グループのみの日は総作業時間ゼロ', () => {
    seedTotals(db, DAY, UNGROUPED_KEY, 30 * MIN);
    setExclude(db, true);
    expect(totalWorkMsForDay(db, DAY)).toBe(0);
    expect(totalWorkSecondsForDay(db, DAY)).toBe(0);
  });
});

describe('5.2 per-group 生データは設定に依存しない', () => {
  it('daily_totals_snapshot の ungrouped 行の ms は OFF/ON で不変', () => {
    seedTotals(db, DAY, 'g-dev', 40 * MIN);
    seedTotals(db, DAY, UNGROUPED_KEY, 20 * MIN);
    const readUngroupedMs = () =>
      (
        db
          .prepare('SELECT ms FROM daily_totals_snapshot WHERE day_key = ? AND stable_group_id = ?')
          .get(DAY, UNGROUPED_KEY) as { ms: number }
      ).ms;

    const before = readUngroupedMs();
    setExclude(db, true);
    expect(totalWorkMsForDay(db, DAY)).toBe(40 * MIN); // 除外は読み出し時のみ
    setExclude(db, false);
    expect(readUngroupedMs()).toBe(before); // 生データは書き換わらない
    expect(before).toBe(20 * MIN);
  });
});

describe('5.3 ルール評価（TOTAL_WORK）へ一貫波及する', () => {
  const THRESHOLD_S = 120 * 60; // 120 分以上

  function seedRule(db: DB): void {
    createRule(db, { target: 'TOTAL_WORK', thresholdSeconds: THRESHOLD_S, startDay: DAY, reason: 'r' }, NOW_BEFORE);
  }

  it('ON かつ未グループのみでは総作業時間条件が未達成（unmet）', () => {
    seedRule(db);
    seedTotals(db, DAY, UNGROUPED_KEY, 150 * MIN); // 未グループ 150 分のみ
    setExclude(db, true);
    const r = evaluateDay(db, DAY, NOW_DAY);
    const total = r.perCondition.find((p) => p.target === 'TOTAL_WORK')!;
    expect(total.actualSeconds).toBe(0); // 未グループは非計上
    expect(total.met).toBe(false);
    expect(r.status).toBe('LOCKED');
  });

  it('ON でも実グループが閾値を満たせば達成（met）', () => {
    seedRule(db);
    seedTotals(db, DAY, 'g-dev', 130 * MIN); // 実グループ 130 分
    seedTotals(db, DAY, UNGROUPED_KEY, 60 * MIN); // 未グループ 60 分（非計上）
    setExclude(db, true);
    const r = evaluateDay(db, DAY, NOW_DAY);
    const total = r.perCondition.find((p) => p.target === 'TOTAL_WORK')!;
    expect(total.actualSeconds).toBe(130 * 60); // 未グループを除いた 130 分
    expect(total.met).toBe(true);
    expect(r.status).toBe('UNLOCKED');
  });
});

describe('5.4 range サマリと当日サマリの総作業時間は同一規則で一致', () => {
  it.each([false, true])('exclude=%s で daySummary と rangeSummary の総作業秒が一致', (on) => {
    seedTotals(db, DAY, 'g-dev', 40 * MIN);
    seedTotals(db, DAY, UNGROUPED_KEY, 20 * MIN);
    // KPI は daily_totals 源泉、内訳(groups)は session 源泉。両者を揃えて投入する。
    seedSession(db, DAY, 'g-dev', '開発', 'blue', 40 * MIN);
    seedSession(db, DAY, UNGROUPED_KEY, 'ungrouped', null, 20 * MIN);
    setExclude(db, on);
    const day = daySummary(db, DAY);
    const range = rangeSummary(db, DAY, DAY);
    expect(range).toHaveLength(1);
    expect(day.totalWorkSeconds).toBe(totalWorkSecondsForDay(db, DAY));
    expect(range[0]!.totalWorkSeconds).toBe(day.totalWorkSeconds);
    expect(day.totalWorkSeconds).toBe(on ? 40 * 60 : 60 * 60);
    // 行自体は ON でも消えない（未グループも groups に残る）。
    expect(day.groups.map((g) => g.stableGroupId)).toContain(UNGROUPED_KEY);
    const ung = day.groups.find((g) => g.stableGroupId === UNGROUPED_KEY)!;
    expect(ung.countsTowardTotal).toBe(!on); // ON のとき非計上フラグ
  });
});

describe('5.5 UNGROUPED_KEY とマイグレーションの整合', () => {
  it('UNGROUPED_KEY は "ungrouped" 固定で、マイグレーションのコメント/対象と一致', () => {
    expect(UNGROUPED_KEY).toBe('ungrouped');
    const mig = MIGRATIONS.find((m) => m.name === 'exclude-ungrouped-from-total')!;
    expect(mig).toBeDefined();
    expect(mig.sql).toContain('exclude_ungrouped_from_total');
    expect(mig.sql).toContain(`'${UNGROUPED_KEY}'`); // コメントが 'ungrouped' を参照
  });

  it('既存 DB へ列が既定値 0 で安全に付与される', () => {
    expect(getConfig(db).exclude_ungrouped_from_total).toBe(0);
  });
});
