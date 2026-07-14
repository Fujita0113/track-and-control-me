import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { listGoals, getGoalReport, getJournal, GoalReportNotReadyError } from './goals.js';
import { getDayAllocation } from './day-allocation.js';
import { daySummary } from './summary.js';
import { getTimeline } from './timeline.js';
import { getDemoDb, resetDemoDb } from './demo-db.js';
import {
  seedDemo,
  DEMO_GOAL_ID,
  DEMO_GOAL2_ID,
  DEMO_START_DAY,
  DEMO_END_DAY,
  DEMO_PRE_START_DAY,
  DEMO_AFTER_END_DAY,
  DEMO_GOAL2_START_DAY,
  DEMO_ALLOC_DAY,
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
    // ① 実践4つ（総作業 / 振り返り / 明日タスク / 筋トレ手動チェック）・各30マス。
    expect(rep.practices.length).toBe(4);
    for (const p of rep.practices) expect(p.cells.length).toBe(30);
    // 手動チェック実践（筋トレ）が非時間型として乗る（goal-adopt-manual-check）。
    const kin = rep.practices.find((p) => p.conditionKey === 'manual:筋トレ')!;
    expect(kin).toBeDefined();
    expect(kin.target).toBe('MANUAL_CHECK');
    expect(kin.isTimeType).toBe(false);
    expect(kin.label).toBe('筋トレ');
    // 谷の一部（Day11,12,16）で未達成、それ以外は達成。達成日数 24/30 は維持。
    expect(kin.cells[10]!.met).toBe(false); // Day11
    expect(kin.cells[0]!.met).toBe(true); // Day1
    expect(kin.cells[29]!.met).toBe(true); // Day30
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

  it('手動チェックのみの目標（DEMO_GOAL2）は①のみで②時間の推移が出ない', () => {
    // 一覧では主目標（後の期間）が先、手動チェックのみ目標が後に並ぶ。
    const goals = listGoals(db, vnow(DEMO_AFTER_END_DAY));
    expect(goals.length).toBe(2);
    const g2 = goals.find((g) => g.id === DEMO_GOAL2_ID)!;
    expect(g2.name).toBe('朝の散歩を習慣にする');

    const rep = getGoalReport(db, DEMO_GOAL2_ID, vnow(DEMO_AFTER_END_DAY));
    // ① 実践は手動チェック2つ・各30マス。全て非時間型。
    expect(rep.practices.length).toBe(2);
    for (const p of rep.practices) {
      expect(p.target).toBe('MANUAL_CHECK');
      expect(p.isTimeType).toBe(false);
      expect(p.cells.length).toBe(30);
    }
    // ② 時間の推移は出ない（時間型実践ゼロ）＋閾値変更も無い。
    expect(rep.hasTimeType).toBe(false);
    expect(rep.thresholdChanges.length).toBe(0);
    // 達成日数（両方 met の日）＝ 24/30。個別 met は 朝散歩27・ストレッチ26。
    expect(rep.goal.achievedDays).toBe(24);
    const walk = rep.practices.find((p) => p.conditionKey === 'manual:朝散歩')!;
    const stretch = rep.practices.find((p) => p.conditionKey === 'manual:ストレッチ')!;
    expect(walk.cells.filter((c) => c.met).length).toBe(27);
    expect(stretch.cells.filter((c) => c.met).length).toBe(26);
    expect(walk.cells[4]!.met).toBe(false); // Day5 は朝散歩を飛ばした
    // 手動チェックは時間実測を持たない。
    expect(walk.cells[0]!.actualSeconds).toBeNull();
    expect(walk.cells[0]!.thresholdSeconds).toBeNull();
    // ③④ Before/After の日記が引ける。
    expect(getJournal(db, DEMO_GOAL2_ID, DEMO_GOAL2_START_DAY).content).toContain('朝散歩を始める');
  });
});

describe('配分バー seed（reflection-alloc-group-identity）', () => {
  it('振り返り(紫)が1本の大きな WORK スライスへ合算され、今日タブ内訳と一致する（issue #47）', () => {
    const now = zonedTimeToEpoch(2026, 6, 25, 23, 0, 0, TZ); // Day15 の記録より後
    const a = getDayAllocation(db, DEMO_ALLOC_DAY, now);
    const work = a.slices.filter((s) => s.kind === 'WORK');
    // 振り返り(紫)は 30 分 × 6（別 stable_group_id）が1本の 3h スライスへ合算される。
    const reflect = work.find((s) => s.label === '振り返り')!;
    expect(reflect).toBeDefined();
    expect(reflect.seconds).toBe(3 * 3600);
    expect(reflect.color).toBe('purple');
    // WORK は「振り返り / 勉強 / 制作」に加え、改名使い回し（issue #52）の「執筆 / 調査」の5スライス。
    // 同一 identity の分裂は起きないが、改名した別 identity は別スライスとして現れる。
    expect(work).toHaveLength(5);
    expect(new Set(work.map((s) => s.label))).toEqual(new Set(['振り返り', '勉強', '制作', '執筆', '調査']));
    // 振り返りが最大スライス（埋没せず先頭）。
    expect(a.slices[0]!.label).toBe('振り返り');
    // WORK スライス合計＝daySummary（today-group-breakdown）の同グループ合計（ドリフト防止）。
    const summary = daySummary(db, DEMO_ALLOC_DAY);
    for (const w of work) {
      const g = summary.groups.find((gr) => gr.name === w.label)!;
      expect(g, `daySummary に ${w.label} が無い`).toBeDefined();
      expect(w.seconds).toBe(Math.round(g.seconds));
    }
    // 休憩(MANUAL・grey)が1本。
    const manual = a.slices.filter((s) => s.kind === 'MANUAL');
    expect(manual).toHaveLength(1);
    expect(manual[0]!.seconds).toBe(45 * 60);
  });
});

describe('タイムライン identity 単位化 seed（timeline-group-identity / issue #52）', () => {
  it('改名して使い回した同一 sid が名前ごとに別 AUTO ブロックへ分離する', () => {
    const now = zonedTimeToEpoch(2026, 6, 25, 23, 0, 0, TZ); // Day15 の記録より後
    const tl = getTimeline(db, DEMO_ALLOC_DAY, now);
    const write = tl.auto.find((b) => b.title === '執筆');
    const research = tl.auto.find((b) => b.title === '調査');
    // 同一 stable_group_id('demo-reuse-52') だが、名前ごとに別ブロックへ分離する。
    expect(write).toBeDefined();
    expect(research).toBeDefined();
    expect(write!.color).toBe('green');
    expect(research!.color).toBe('blue');
    // 先頭名(執筆)で 16:00–17:00 全区間を覆う単一ブロックにはならない。
    expect(tl.auto.some((b) => b.title === '執筆' && b.endAt - b.startAt > 30 * 60 * 1000)).toBe(false);
    // 別 sid・同一 identity の連続「振り返り」(demo-refl-1/2) は1本へ結合される（#47 と一貫）。
    // 9:00–9:30 と 9:30–10:00 は別 stable_group_id だが連続・同一 identity のため 9:00–10:00 の1ブロック。
    const reflStart = zonedTimeToEpoch(2026, 6, 25, 9, 0, 0, TZ);
    const reflEnd = zonedTimeToEpoch(2026, 6, 25, 10, 0, 0, TZ);
    expect(tl.auto.some((b) => b.title === '振り返り' && b.startAt === reflStart && b.endAt === reflEnd)).toBe(true);
  });
});

describe('本番非干渉ガードレール（5.1）', () => {
  it('デモ DB のリセットは本番 DB（別コネクション）に一切触れない', () => {
    const prod = openDb(':memory:');
    const before = (prod.prepare('SELECT COUNT(*) AS c FROM goal').get() as { c: number }).c;
    expect(before).toBe(0);

    // デモ DB を構築・リセット・読み取り（主目標＋手動チェックのみ目標の2件）。
    const demo = getDemoDb();
    expect(listGoals(demo, vnow(DEMO_AFTER_END_DAY)).length).toBe(2);
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
