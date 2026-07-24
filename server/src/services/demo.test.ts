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

  it('開始前のみレポート不可（進行中は走行中プレビューとして開ける）、完走後は4ブロックが埋まる', () => {
    // 開始前（まだ1日も走っていない）は拒否。
    expect(() => getGoalReport(db, DEMO_GOAL_ID, vnow(DEMO_PRE_START_DAY))).toThrow(
      GoalReportNotReadyError,
    );
    // 進行中は開ける（「完走後のみ」の制約は撤廃・spec: goal-report）。
    expect(getGoalReport(db, DEMO_GOAL_ID, vnow(DEMO_START_DAY)).goal.status).toBe('active');

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

  describe('⑤沿革のサンプル（Plan / Check）', () => {
    /** 完走レポートの沿革（Plan は day_key 昇順・同日内は記録順）。 */
    const chronicle = (): ReturnType<typeof getGoalReport>['chronicle'] =>
      getGoalReport(db, DEMO_GOAL_ID, vnow(DEMO_AFTER_END_DAY)).chronicle;

    it('Plan が3件、既存の谷（Day11 / Day13 / Day20）に時系列で並ぶ', () => {
      const plans = chronicle().plans;
      expect(plans.map((p) => p.dayKey)).toEqual(['2026-06-21', '2026-06-23', '2026-06-30']);
      expect(plans[0]!.body).toContain('朝いちに前倒し');
      expect(plans[1]!.body).toContain('3時間へ下げる'); // Day13 の閾値変更の判断と呼応する。
    });

    it('📷×単発・💬×単発・📷×範囲・取り下げ済み が1つずつ揃う（沿革が読み物になる）', () => {
      const checks = chronicle().plans.flatMap((p) => p.checks);
      const shape = (c: (typeof checks)[number]): string =>
        `${c.kind}/${c.schedule}${c.status === 'cancelled' ? '/cancelled' : ''}`;
      expect(checks.map(shape)).toEqual([
        'photo/single', // 朝の机（Day14）
        'question/single', // 集中はどうだった？（Day15）
        'photo/range', // その日の空（Day14〜20）
        'question/range/cancelled', // 取り下げ済み
      ]);
    });

    it('📷×単発は画像つきで提出済み', () => {
      const c = chronicle().plans[0]!.checks[0]!;
      expect(c).toMatchObject({ kind: 'photo', caption: '朝の机', startDayKey: '2026-06-24', spanDays: null });
      expect(c.results).toHaveLength(1);
      expect(c.results[0]!.imageId).toBeTypeOf('number');
    });

    it('💬×単発は Q&A のペアで残る', () => {
      const c = chronicle().plans[0]!.checks[1]!;
      expect(c.questionText).toBe('前倒しで集中は変わったか');
      expect(c.results[0]!.answerText).toContain('朝は入りが速い');
    });

    it('📷×範囲は「7日中5日提出」の事実がそのまま残る（サボりを美化も負債化もしない）', () => {
      const c = chronicle().plans[1]!.checks[0]!;
      expect(c).toMatchObject({ kind: 'photo', schedule: 'range', caption: 'その日の空', spanDays: 7 });
      expect(c.results).toHaveLength(5);
      // Day16（06-26）・Day19（06-29）はサボった日＝提出が無い。
      expect(c.results.map((r) => r.dayKey)).toEqual([
        '2026-06-24',
        '2026-06-25',
        '2026-06-27',
        '2026-06-28',
        '2026-06-30',
      ]);
    });

    it('取り下げた Plan / Check が理由つきで沿革に残る', () => {
      const p = chronicle().plans[2]!;
      expect(p).toMatchObject({ status: 'withdrawn' });
      expect(p.withdrawReason).toContain('置き場所から変える');
      expect(p.checks[0]).toMatchObject({ status: 'cancelled' });
      expect(p.checks[0]!.cancelReason).toContain('置き場所から変える');
      // 取り下げても、それまでに答えた2日は消えない。
      expect(p.checks[0]!.results).toHaveLength(2);
    });

    it('走行中プレビューの沿革は「その日までに起きたこと」だけを載せる（未来を見せない）', () => {
      // Day12（06-22）時点: Day11 の Plan A だけが存在し、Day13 の Plan B・Day20 の Plan C はまだ無い。
      const day12 = getGoalReport(db, DEMO_GOAL_ID, vnow('2026-06-22')).chronicle;
      expect(day12.plans.map((p) => p.dayKey)).toEqual(['2026-06-21']);
      // Plan A の Check は仕掛かり中（Day14・Day15 の回答はまだ起きていない）。
      expect(day12.plans[0]!.checks.every((c) => c.results.length === 0)).toBe(true);

      // Day15（06-25）時点: Plan B まで現れ、Day14・Day15 の回答だけが載る。
      const day15 = getGoalReport(db, DEMO_GOAL_ID, vnow('2026-06-25')).chronicle;
      expect(day15.plans.map((p) => p.dayKey)).toEqual(['2026-06-21', '2026-06-23']);
      const sky = day15.plans[1]!.checks[0]!;
      expect(sky.results.map((r) => r.dayKey)).toEqual(['2026-06-24', '2026-06-25']); // 06-27 以降はまだ。
    });

    it('沿革に日記本文は載らない（④日記リーダーが読む）', () => {
      const json = JSON.stringify(chronicle());
      expect(json).not.toContain('はじめての一日'); // Day1 の日記見出し。
      expect(json).not.toContain('30日を終えて'); // Day30 の日記見出し。
    });

    it('写真Check の提出画像は③ Before/After へ流入する（先指定キャプションでグループ化）', () => {
      const rep = getGoalReport(db, DEMO_GOAL_ID, vnow(DEMO_AFTER_END_DAY));
      const sky = rep.reportImages.filter((i) => i.caption === 'その日の空');
      expect(sky.map((i) => i.dayNumber)).toEqual([14, 15, 17, 18, 20]); // 古い→新しい順。
      expect(rep.reportImages.filter((i) => i.caption === '朝の机')).toHaveLength(1);
    });

    it('Plan / Check は達成日数 24/30 の筋書きに影響しない（goal_practice ではない）', () => {
      const rep = getGoalReport(db, DEMO_GOAL_ID, vnow(DEMO_AFTER_END_DAY));
      expect(rep.goal.achievedDays).toBe(24);
      // Check は実践ではないので①の行に現れない（沿革⑤が読み手）。
      expect(rep.practices).toHaveLength(4);
      expect(rep.practices.every((p) => !p.conditionKey.startsWith('check:'))).toBe(true);
    });
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
    // WORK は「振り返り / 勉強 / 制作」に加え、改名使い回し（issue #52・未登録）の「執筆 / 調査」、
    // および登録済み改名（group-rule-snapshot-identity）で合算された「英語」の6スライス。
    // 同一 identity の分裂は起きないが、改名イベントとして記録されていない別 identity は別スライスのまま。
    expect(work).toHaveLength(6);
    expect(new Set(work.map((s) => s.label))).toEqual(
      new Set(['振り返り', '勉強', '制作', '執筆', '調査', '英語']),
    );
    // 「英会話」→「英語」の登録済み改名: 改名前後の2区間(30分×2)が同一 identity として
    // 現在名「英語」の1本(60分)へ合算される。旧名「英会話」のスライスは残らない（進捗が巻き戻らない）。
    const renamed = work.find((s) => s.label === '英語')!;
    expect(renamed).toBeDefined();
    expect(renamed.seconds).toBe(60 * 60);
    expect(renamed.color).toBe('cyan');
    expect(work.some((s) => s.label === '英会話')).toBe(false);
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

  it('登録済みの改名（英会話→英語）は隣接ブロックが1本へ結合され現在名で表示される', () => {
    const now = zonedTimeToEpoch(2026, 6, 25, 23, 0, 0, TZ);
    const tl = getTimeline(db, DEMO_ALLOC_DAY, now);
    const start = zonedTimeToEpoch(2026, 6, 25, 17, 0, 0, TZ);
    const end = zonedTimeToEpoch(2026, 6, 25, 18, 0, 0, TZ);
    const merged = tl.auto.find((b) => b.startAt === start && b.endAt === end);
    expect(merged).toBeDefined();
    expect(merged!.title).toBe('英語'); // 改名前の「英会話」区間を含め、現在名の1ブロック。
    expect(tl.auto.some((b) => b.title === '英会話')).toBe(false);
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
