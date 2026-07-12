import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { listGoals, getGoalReport, getJournal, GoalReportNotReadyError } from './goals.js';
import { getDemoDb, resetDemoDb } from './demo-db.js';
import {
  seedDemo,
  DEMO_GOAL_ID,
  DEMO_START_DAY,
  DEMO_END_DAY,
  DEMO_PRE_START_DAY,
  DEMO_AFTER_END_DAY,
} from './demo-seed.js';

const TZ = 'Asia/Tokyo';
/** 仮想 day_key（正午 JST）→ epoch ms。demo.ts の virtualNowMs と同じ規則。 */
const vnow = (dayKey: string): number => {
  const [y, m, d] = dayKey.split('-').map(Number);
  return zonedTimeToEpoch(y!, m!, d!, 12, 0, 0, TZ);
};

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  seedDemo(db);
});

describe('デモ seed の仮想日付連動（5.2 / 1.4）', () => {
  it('開始前 → 進行中 Day N/30 → 完走 が仮想 day_key に連動する', () => {
    // 開始前（start − 1）。
    let g = listGoals(db, vnow(DEMO_PRE_START_DAY))[0]!;
    expect(g.status).toBe('upcoming');
    expect(g.startDay).toBe(DEMO_START_DAY);
    expect(g.endDay).toBe(DEMO_END_DAY);
    expect(g.dayNumber).toBeNull();

    // Day1（開始日）。
    g = listGoals(db, vnow(DEMO_START_DAY))[0]!;
    expect(g.status).toBe('active');
    expect(g.dayNumber).toBe(1);

    // Day8（+7 進行中）。
    g = listGoals(db, vnow('2026-06-18'))[0]!;
    expect(g.status).toBe('active');
    expect(g.dayNumber).toBe(8);

    // Day30（最終日）。
    g = listGoals(db, vnow(DEMO_END_DAY))[0]!;
    expect(g.status).toBe('active');
    expect(g.dayNumber).toBe(30);

    // 完走（end + 1）。
    g = listGoals(db, vnow(DEMO_AFTER_END_DAY))[0]!;
    expect(g.status).toBe('completed');
    expect(g.dayNumber).toBeNull();
  });

  it('完走前はレポート不可（GoalReportNotReadyError）、完走後は4ブロックが埋まる', () => {
    // 進行中はレポート不可。
    expect(() => getGoalReport(db, DEMO_GOAL_ID, vnow(DEMO_START_DAY))).toThrow(
      GoalReportNotReadyError,
    );

    const rep = getGoalReport(db, DEMO_GOAL_ID, vnow(DEMO_AFTER_END_DAY));
    // ヘッダ: 達成 24/30。
    expect(rep.goal.dayCount).toBe(30);
    expect(rep.goal.achievedDays).toBe(24);
    // ① 実践3つ・各30マス。
    expect(rep.practices.length).toBe(3);
    for (const p of rep.practices) expect(p.cells.length).toBe(30);
    // ② 時間型（総作業）あり＋Day13 の閾値変更（4h→3h・理由つき）。
    expect(rep.hasTimeType).toBe(true);
    expect(rep.thresholdChanges.length).toBe(1);
    expect(rep.thresholdChanges[0]!.dayNumber).toBe(13);
    expect(rep.thresholdChanges[0]!.oldSeconds).toBe(14400);
    expect(rep.thresholdChanges[0]!.newSeconds).toBe(10800);
    expect(rep.thresholdChanges[0]!.reason).toContain('課題週間');
    // ③④ 30日ぶんの日記が全て埋まっている（Before/After 含む）。
    expect(rep.days.length).toBe(30);
    expect(rep.days.every((d) => d.source === 'journal' && d.text.trim().length > 0)).toBe(true);
    expect(rep.days[0]!.text).toContain('はじめて');
    expect(rep.days[29]!.text).toContain('30日を終えて');
  });

  it('中盤の谷（未達成日）が存在し、後半は持ち直す', () => {
    const rep = getGoalReport(db, DEMO_GOAL_ID, vnow(DEMO_AFTER_END_DAY));
    const total = rep.practices.find((p) => p.conditionKey === 'total_work')!;
    // Day11（谷）は総作業未達成、Day30（後半）は達成。
    expect(total.cells[10]!.met).toBe(false); // Day11
    expect(total.cells[29]!.met).toBe(true); // Day30
    // 閾値の引き下げが時系列に反映（Day1 は 4h、Day30 は 3h 基準）。
    expect(total.cells[0]!.thresholdSeconds).toBe(14400);
    expect(total.cells[29]!.thresholdSeconds).toBe(10800);
  });

  it('日記は日付単位で引ける（getJournal）', () => {
    expect(getJournal(db, DEMO_GOAL_ID, DEMO_START_DAY).content).toContain('はじめて');
    expect(getJournal(db, DEMO_GOAL_ID, DEMO_END_DAY).content).toContain('30日を終えて');
  });
});

describe('本番非干渉ガードレール（5.1）', () => {
  it('デモ DB のリセットは本番 DB（別コネクション）に一切触れない', () => {
    const prod = openDb(':memory:');
    const before = (prod.prepare('SELECT COUNT(*) AS c FROM goal').get() as { c: number }).c;
    expect(before).toBe(0);

    // デモ DB を構築・リセット・読み取り。
    const demo = getDemoDb();
    expect(listGoals(demo, vnow(DEMO_AFTER_END_DAY)).length).toBe(1);
    resetDemoDb();
    getGoalReport(getDemoDb(), DEMO_GOAL_ID, vnow(DEMO_AFTER_END_DAY));

    // 本番 DB は無傷（目標ゼロのまま）。
    const after = (prod.prepare('SELECT COUNT(*) AS c FROM goal').get() as { c: number }).c;
    expect(after).toBe(0);
    prod.close();
  });

  it('デモ関連ソースは reveal・本番書き込み関数を import/参照しない', () => {
    const here = dirname(fileURLToPath(import.meta.url)); // .../server/src/services
    const files = [
      join(here, 'demo-db.ts'),
      join(here, 'demo-seed.ts'),
      join(here, '..', 'api', 'demo.ts'),
    ];
    // reveal・パスワード生成・本番書き込み系の識別子は現れてはならない（design.md D3）。
    const forbidden = [
      'revealPasswords',
      'password/reveal',
      'runPasswordCommand',
      'markRevealFired',
      'createGoal',
      'saveJournal',
      'deleteGoal',
      'updateConfig',
      'saveReflection',
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const token of forbidden) {
        expect(src.includes(token), `${f} に禁止識別子 ${token} が含まれています`).toBe(false);
      }
    }
  });
});
