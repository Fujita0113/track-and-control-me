import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { createGoal, getGoal, getGoalReport, goalPace, type GoalView } from './goals.js';
import { getChronicle } from './goal-chronicle.js';
import { evaluateDay } from '../rules/evaluate.js';
import {
  freezeGoal,
  freezeGoalMulti,
  updateFreeze,
  releaseFreeze,
  getFreeze,
  freezeQuota,
  FreezeValidationError,
  FreezeStateError,
} from './goal-freeze.js';

/**
 * 目標の一時凍結（spec: goal-freeze MODIFIED / goal-check-gate / goal-report / goal-chronicle・issue #103）。
 *
 * 種別（当日凍結／期間凍結）を廃止し、単一の凍結（**常に当日発効**・終了日は自由指定）へ統合した。
 * 時間軸はすべて JST 固定で、目標は 2026-07-01 開始・2026-07-30 終了（30日）。
 * `start_day` は常に予約した当日で固定なので、7/10 に予約すると 7/10 から即座に効く。
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

/** 目標は 2026-07-01 開始・2026-07-30 終了（30日）。 */
const GOAL_END = '2026-07-30';
const NOW_0701 = jst(2026, 7, 1);
const NOW_0710 = jst(2026, 7, 10);
const NOW_0711 = jst(2026, 7, 11);
const NOW_0712 = jst(2026, 7, 12);
const NOW_0713 = jst(2026, 7, 13);
const NOW_0715 = jst(2026, 7, 15);
const NOW_0720 = jst(2026, 7, 20);
const NOW_0728 = jst(2026, 7, 28);
const NOW_0731 = jst(2026, 7, 31);
const NOW_0801 = jst(2026, 8, 1);
const NOW_0805 = jst(2026, 8, 5);

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

/**
 * 総作業時間ルール1本つきの目標を作る（既定は 2026-07-01 開始・30日間）。
 * `endDay` は既定で `GOAL_END`（2026-07-30）だが、`nowMs` を変えて別の開始日で作る場合は
 * 明示的に渡す（期限は必須・30日固定は撤廃済み・spec: goal-challenge）。
 */
function makeGoal(name = '設計理解をしたい', nowMs = NOW_0701, endDay = GOAL_END): GoalView {
  return createGoal(
    db,
    { startReason: '始める理由', endDay,
      name,
      purpose: '設計を読めるようになる',
      start: 'today',
      rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400, reason: '4時間は守りたい' }],
    },
    nowMs,
  );
}

/** 目標時間つきの目標（ペースの分母＝経過日数を見るため）。 */
function makeGoalWithHours(name = '設計理解をしたい'): GoalView {
  return createGoal(
    db,
    {
      name,
      purpose: '設計を読めるようになる',
      startReason: '始める理由',
      endDay: GOAL_END,
      start: 'today',
      rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400, reason: '4時間は守りたい' }],
      targetHours: { kind: 'TOTAL_WORK', secondsPerDay: 2 * 3600 },
    },
    NOW_0701,
  );
}

function seedEval(dayKey: string, per: unknown[]): void {
  db.prepare(
    `INSERT INTO unlock_evaluation (day_key, status, conditions_met, per_condition_results, first_met_at, reveal_fired, is_final, updated_at)
     VALUES (?, 'LOCKED', 0, ?, NULL, 0, 0, 0)`,
  ).run(dayKey, JSON.stringify(per));
}

// --- 予約はその場で当日発効（理由必須）------------------------------------------

describe('凍結は予約したその場で当日発効する', () => {
  it('7/10 に予約すると start_day/end_day とも 7/10 側で保存され、その日のゲートから即座に外れる', () => {
    const g = makeGoal();
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(1);

    const f = freezeGoal(db, g.id, { endDay: '2026-07-14', reason: 'OpenWork の大タスク' }, NOW_0710);
    expect(f.startDay).toBe('2026-07-10');
    expect(f.endDay).toBe('2026-07-14');
    expect(f.state).toBe('frozen');
    expect(f.reason).toBe('OpenWork の大タスク');

    // 予約したその場で当日のゲートから外れる（旧・当日凍結の目的を統合後も引き継ぐ）。
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(0);
  });

  it('終了日に当日を指定すれば実質1日だけの凍結になり、翌日にはひとりでに解ける', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-10', reason: '明日の面接に持っていく課題を今夜潰す' }, NOW_0710);
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(0);
    expect(getFreeze(db, g.id, NOW_0711)?.state).toBe('released');
    expect(evaluateDay(db, '2026-07-11', NOW_0711).perCondition).toHaveLength(1);
  });

  it('凍結すると GoalView に凍結中として現れ、status は active のまま', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    const view = getGoal(db, g.id, NOW_0710);
    expect(view.status).toBe('active');
    expect(view.freeze?.state).toBe('frozen');
    expect(view.freeze?.startDay).toBe('2026-07-10');
  });

  it('理由が空の予約は拒否され、凍結は作られない', () => {
    const g = makeGoal();
    expect(() => freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '   ' }, NOW_0710)).toThrow(FreezeValidationError);
    expect(getFreeze(db, g.id, NOW_0710)).toBeNull();
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(1);
  });

  it('終了日が当日より前の予約は拒否される', () => {
    const g = makeGoal();
    expect(() => freezeGoal(db, g.id, { endDay: '2026-07-09', reason: '大タスク' }, NOW_0710)).toThrow(FreezeValidationError);
    expect(getFreeze(db, g.id, NOW_0710)).toBeNull();
  });

  it('同じ目標への二重予約は拒否される', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(() => freezeGoal(db, g.id, { endDay: '2026-07-20', reason: 'もう1件' }, NOW_0710)).toThrow(FreezeStateError);
  });
});

// --- 月枠（アプリ全体で月1回・常に today の月）----------------------------------

describe('凍結の枠はアプリ全体で月1回・常に today の月で数える', () => {
  it('同じ日に複数の目標を一括で凍結できる', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    const res = freezeGoalMulti(db, [a.id, b.id], { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(res).toHaveLength(2);
    expect(res[0]!.startDay).toBe('2026-07-10');
    expect(res[1]!.startDay).toBe('2026-07-10');
  });

  it('別の日（別セッション）での同月2件目は、別の目標でも拒否される', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    freezeGoal(db, a.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(() => freezeGoal(db, b.id, { endDay: '2026-07-20', reason: '別件' }, NOW_0715)).toThrow(FreezeStateError);

    const quota = freezeQuota(db, NOW_0710);
    expect(quota.used).toBe(true);
    expect(quota.goalId).toBe(a.id);
    expect(quota.month).toBe('2026-07');
  });

  it('即日解除しても枠は戻らない（予約→即解除→再予約を塞ぐ）', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    freezeGoal(db, a.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    releaseFreeze(db, a.id, NOW_0710); // 発効当日に解除（凍結 0 日）。
    expect(freezeQuota(db, NOW_0710).used).toBe(true);
    expect(() => freezeGoal(db, b.id, { endDay: '2026-07-20', reason: '別件' }, NOW_0712)).toThrow(FreezeStateError);
  });

  it('終了日がどれだけ先でも、消費するのは予約日（today）の月だけ（月末の食い違いは起きない）', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい', NOW_0801, '2026-09-04');
    // 7/31 に予約し、終了日は8月でも、start_day は today（7/31）＝7月の枠を消費する。
    const f = freezeGoal(db, a.id, { endDay: '2026-08-10', reason: '大タスク' }, NOW_0731);
    expect(f.startDay).toBe('2026-07-31');
    expect(freezeQuota(db, NOW_0731).month).toBe('2026-07');
    expect(freezeQuota(db, NOW_0731).used).toBe(true);

    // 8月になれば枠は回復する。
    expect(freezeQuota(db, NOW_0801).month).toBe('2026-08');
    expect(freezeQuota(db, NOW_0801).used).toBe(false);
    const f2 = freezeGoal(db, b.id, { endDay: '2026-08-25', reason: '8月の事情' }, NOW_0801);
    expect(f2.startDay).toBe('2026-08-01');
  });

  it('月をまたいで存続する凍結は、予約日の月だけを消費し続ける（延長しても新しい枠は要らない）', () => {
    const a = makeGoal('設計理解をしたい');
    freezeGoal(db, a.id, { endDay: '2026-08-05', reason: '大タスク' }, NOW_0728); // 7/28 発効＝7月枠。
    updateFreeze(db, a.id, { endDay: '2026-08-20', reason: 'まだ終わらない' }, NOW_0801);
    expect(freezeQuota(db, NOW_0801).month).toBe('2026-08');
    expect(freezeQuota(db, NOW_0801).used).toBe(false);

    const b = makeGoal('茶色取りたい', NOW_0805, '2026-09-04');
    const f = freezeGoal(db, b.id, { endDay: '2026-08-25', reason: '8月の事情' }, NOW_0805);
    expect(f.startDay).toBe('2026-08-05');
  });
});

// --- 延長（後ろへのみ・理由必須・枠を消費しない）--------------------------------

describe('凍結の延長', () => {
  it('凍結中に理由つきで後ろへ延ばせる', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    const f = updateFreeze(db, g.id, { endDay: '2026-07-20', reason: 'まだ終わらない' }, NOW_0712);
    expect(f.endDay).toBe('2026-07-20');
    expect(f.state).toBe('frozen');
  });

  it('理由が空の延長は拒否され、終了日は変わらない', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(() => updateFreeze(db, g.id, { endDay: '2026-07-20', reason: '' }, NOW_0712)).toThrow(FreezeValidationError);
    expect(getFreeze(db, g.id, NOW_0712)?.endDay).toBe('2026-07-14');
  });

  it('短縮は拒否される', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-20', reason: '大タスク' }, NOW_0710);
    expect(() => updateFreeze(db, g.id, { endDay: '2026-07-13', reason: '短くする' }, NOW_0712)).toThrow(FreezeValidationError);
    expect(getFreeze(db, g.id, NOW_0712)?.endDay).toBe('2026-07-20');
  });
});

// --- 解除（即日発効）-----------------------------------------------------------

describe('凍結の解除は即日発効', () => {
  it('解除した当日からルールがゲートに戻る', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(evaluateDay(db, '2026-07-12', NOW_0712).perCondition).toHaveLength(0);

    const f = releaseFreeze(db, g.id, NOW_0713);
    expect(f.endDay).toBe('2026-07-12'); // 解除日の前日まで。
    expect(evaluateDay(db, '2026-07-13', NOW_0713).perCondition).toHaveLength(1);
    // 凍結は 7/10・7/11・7/12 の3日分だけ効いた。
    expect(getGoal(db, g.id, NOW_0713).endDay).toBe('2026-08-02');
  });

  it('予約と同じ日に解除すると凍結 0 日で、期限は延びない', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    releaseFreeze(db, g.id, NOW_0710);
    const view = getGoal(db, g.id, NOW_0710);
    expect(view.endDay).toBe(GOAL_END);
    expect(view.dayCount).toBe(30);
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(1);
  });
});

// --- 凍結日は「無かった日」＝期限が延びる ---------------------------------------

describe('凍結日ぶん期限が延びる', () => {
  it('4日凍結すると実効の終了日が4日後ろへ動き、Day N/M の M が伸びる', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-13', reason: '大タスク' }, NOW_0710);
    const view = getGoal(db, g.id, NOW_0720);
    expect(view.endDay).toBe('2026-08-03');
    expect(view.dayCount).toBe(34);
    expect(view.dayNumber).toBe(20);
  });

  it('凍結中は残り日数（M − N）が減らない', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-13', reason: '大タスク' }, NOW_0710);
    const at12 = getGoal(db, g.id, NOW_0712);
    const at13 = getGoal(db, g.id, NOW_0713);
    expect(at12.dayCount - at12.dayNumber!).toBe(at13.dayCount - at13.dayNumber!);
  });

  it('未到来の凍結予定日は期限に影響しない（予約した当日ぶんの1日しかまだ数えない）', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-20', reason: '大タスク' }, NOW_0710);
    const view = getGoal(db, g.id, NOW_0710);
    expect(view.endDay).toBe('2026-07-31');
    expect(view.dayCount).toBe(31);
  });

  it('凍結中に元の終了日を越えても完走しない', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-08-10', reason: '大タスク' }, NOW_0728);
    const view = getGoal(db, g.id, NOW_0805);
    expect(view.status).toBe('active');
    expect(view.showLifecycleFork).toBe(false);
    expect(view.freeze?.state).toBe('frozen');
  });

  it('凍結した日はペースの分母（経過日数）から抜ける', () => {
    const g = makeGoalWithHours();
    // 凍結が無ければ 7/1〜7/11 の 11 日。
    expect(goalPace(db, g.id, NOW_0711)!.elapsedDays).toBe(11);
    freezeGoal(db, g.id, { endDay: '2026-07-10', reason: '明日の面接に持っていく課題を今夜潰す' }, NOW_0710);
    expect(goalPace(db, g.id, NOW_0711)!.elapsedDays).toBe(10);
  });
});

// --- ゲート除外（spec: goal-check-gate）----------------------------------------

describe('凍結中の目標のルールはゲートから外れる', () => {
  it('凍結中は消え、明けると戻る', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(evaluateDay(db, '2026-07-12', NOW_0712).perCondition).toHaveLength(0);
    expect(evaluateDay(db, '2026-07-15', NOW_0715).perCondition).toHaveLength(1);
  });

  it('凍結していない目標のルールはゲートに残る', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    freezeGoal(db, a.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    const res = evaluateDay(db, '2026-07-12', NOW_0712);
    expect(res.perCondition).toHaveLength(1);
    expect(res.perCondition[0]!.goalId).toBe(b.id);
  });

  it('単発ルールの繰り越しは凍結中だけ止まる', () => {
    const g = createGoal(
      db,
      { startReason: '始める理由',
        name: '髪質を改善する',
        purpose: '前髪を見る',
        start: 'today',
        endDay: GOAL_END,
        rules: [
          {
            target: 'PHOTO',
            caption: '前髪・正面',
            startDay: '2026-07-01',
            endDay: '2026-07-01',
            reason: '毎日見たい',
          },
        ],
      },
      NOW_0701,
    );
    // 凍結前は繰り越して現れる。
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(1);
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    // 凍結すると当日のうちに消える → 明けると戻る。
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(0);
    expect(evaluateDay(db, '2026-07-12', NOW_0712).perCondition).toHaveLength(0);
    expect(evaluateDay(db, '2026-07-15', NOW_0715).perCondition).toHaveLength(1);
  });

  it('唯一の目標を凍結してもゲートは開かない（LOCKED のまま）', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    const res = evaluateDay(db, '2026-07-12', NOW_0712);
    expect(res.perCondition).toHaveLength(0);
    expect(res.conditionsMet).toBe(false);
    expect(res.status).toBe('LOCKED');
    expect(res.hasRuleSet).toBe(false);
  });
});

// --- レポート（spec: goal-report）----------------------------------------------

describe('レポートは凍結日を対象外として扱う', () => {
  it('凍結日のマスは frozen で、達成日数にも数えない', () => {
    const g = makeGoal();
    const ruleId = g.rules[0]!.ruleId;
    // 7/1〜7/20 はすべて達成として焼き込む（凍結日も含めて焼き込み、凍結が勝つことを見る）。
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
      seedEval(d, [{ conditionKey: `rule:${ruleId}`, ruleId, target: 'TOTAL_WORK', met: true }]);
    }
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);

    const report = getGoalReport(db, g.id, NOW_0720);
    expect(report.goal.dayCount).toBe(35);
    const cells = report.rules[0]!.cells;
    expect(cells[9]!.dayKey).toBe('2026-07-10');
    expect(cells[9]!.frozen).toBe(true);
    expect(cells[9]!.met).toBe(false);
    expect(cells[13]!.dayKey).toBe('2026-07-14');
    expect(cells[13]!.frozen).toBe(true);
    expect(cells[0]!.frozen).toBe(false);
    expect(cells[0]!.met).toBe(true);
    // 経過20日のうち凍結5日（7/10〜7/14）を除いた15日が達成日数。
    expect(report.goal.achievedDays).toBe(15);
  });
});

// --- 沿革（spec: goal-chronicle）------------------------------------------------

describe('沿革に凍結が理由つきで残る', () => {
  it('発効・延長・解除が day_key 昇順に並ぶ（予約と発効は同一イベント）', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    updateFreeze(db, g.id, { endDay: '2026-07-20', reason: 'まだ終わらない' }, NOW_0712);
    releaseFreeze(db, g.id, NOW_0713);

    const ch = getChronicle(db, g.id, '2026-07-20');
    expect(ch.freezes.map((f) => f.kind)).toEqual(['activate', 'extend', 'release']);
    expect(ch.freezes.map((f) => f.dayKey)).toEqual(['2026-07-10', '2026-07-12', '2026-07-13']);
    expect(ch.freezes[0]!.reason).toBe('大タスク');
    expect(ch.freezes[1]!.reason).toBe('まだ終わらない');
  });

  it('untilDayKey より後の凍結イベントは見せない', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    updateFreeze(db, g.id, { endDay: '2026-07-20', reason: 'まだ終わらない' }, NOW_0712);
    releaseFreeze(db, g.id, NOW_0713);

    const ch = getChronicle(db, g.id, '2026-07-12');
    expect(ch.freezes.map((f) => f.kind)).toEqual(['activate', 'extend']);
  });

  it('ルール操作と凍結は同じ並び順キーで併合できる', () => {
    const g = makeGoal();
    freezeGoal(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);

    const ch = getChronicle(db, g.id, '2026-07-20');
    expect(ch.entries.every((e) => typeof e.sortKey === 'string')).toBe(true);
    expect(ch.freezes.every((f) => typeof f.sortKey === 'string')).toBe(true);
    const keys = ch.freezes.map((f) => f.sortKey);
    expect(keys).toEqual([...keys].sort());
  });
});
