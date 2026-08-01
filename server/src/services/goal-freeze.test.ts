import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { createGoal, getGoal, getGoalReport, type GoalView } from './goals.js';
import { getChronicle } from './goal-chronicle.js';
import { evaluateDay } from '../rules/evaluate.js';
import {
  reserveFreeze,
  reserveFreezeMulti,
  updateFreeze,
  cancelFreeze,
  releaseFreeze,
  getFreeze,
  freezeQuota,
} from './goal-freeze.js';

/**
 * 目標の一時凍結（spec: goal-freeze / goal-check-gate / goal-report / goal-chronicle・issue #60）。
 *
 * 時間軸はすべて JST 固定で、目標は 2026-07-01 開始・2026-07-30 終了（30日）。
 * 凍結は「翌日発効」なので、7/10 に予約すると 7/11 から効く。
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

const NOW_0701 = jst(2026, 7, 1);
const NOW_0710 = jst(2026, 7, 10);
const NOW_0711 = jst(2026, 7, 11);
const NOW_0712 = jst(2026, 7, 12);
const NOW_0713 = jst(2026, 7, 13);
const NOW_0715 = jst(2026, 7, 15);
const NOW_0720 = jst(2026, 7, 20);
const NOW_0728 = jst(2026, 7, 28);
const NOW_0801 = jst(2026, 8, 1);
const NOW_0805 = jst(2026, 8, 5);
const NOW_0806 = jst(2026, 8, 6);

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

/** 2026-07-01 開始・2026-07-30 終了の目標を、総作業時間ルール1本つきで作る。 */
function makeGoal(name = '設計理解をしたい', nowMs = NOW_0701): GoalView {
  return createGoal(
    db,
    {
      name,
      purpose: '設計を読めるようになる',
      start: 'today',
      rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400, reason: '4時間は守りたい' }],
    },
    nowMs,
  );
}

function seedEval(dayKey: string, per: unknown[]): void {
  db.prepare(
    `INSERT INTO unlock_evaluation (day_key, status, conditions_met, per_condition_results, first_met_at, reveal_fired, is_final, updated_at)
     VALUES (?, 'LOCKED', 0, ?, NULL, 0, 0, 0)`,
  ).run(dayKey, JSON.stringify(per));
}

// --- 予約（翌日発効・理由必須）------------------------------------------------

describe('凍結の予約は翌日発効', () => {
  it('7/10 に予約すると 7/11 発効で保存され、7/10 のゲートは変わらない', () => {
    const g = makeGoal();
    const f = reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: 'OpenWork の大タスク' }, NOW_0710);
    expect(f.startDay).toBe('2026-07-11');
    expect(f.endDay).toBe('2026-07-14');
    expect(f.state).toBe('reserved');
    expect(f.reason).toBe('OpenWork の大タスク');

    // 予約した当日は凍結中ではない＝ルールはゲートに残る。
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(1);
    // 期限もまだ延びていない。
    expect(getGoal(db, g.id, NOW_0710).endDay).toBe('2026-07-30');
  });

  it('予約中の目標は GoalView に予約中として現れ、status は active のまま', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    const view = getGoal(db, g.id, NOW_0710);
    expect(view.status).toBe('active');
    expect(view.freeze?.state).toBe('reserved');
    expect(view.freeze?.startDay).toBe('2026-07-11');
  });

  it('理由が空の予約は拒否され、凍結は作られない', () => {
    const g = makeGoal();
    expect(() => reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '   ' }, NOW_0710)).toThrow();
    expect(getFreeze(db, g.id, NOW_0710)).toBeNull();
  });

  it('終了日が発効日より前の予約は拒否される', () => {
    const g = makeGoal();
    expect(() => reserveFreeze(db, g.id, { endDay: '2026-07-10', reason: '大タスク' }, NOW_0710)).toThrow();
    expect(getFreeze(db, g.id, NOW_0710)).toBeNull();
  });

  it('同じ目標への二重予約は拒否される', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(() => reserveFreeze(db, g.id, { endDay: '2026-07-20', reason: 'もう1件' }, NOW_0710)).toThrow();
  });
});

// --- 月枠（アプリ全体で月1回）--------------------------------------------------

describe('凍結の枠はアプリ全体で月1回', () => {
  it('同じ予約日（同日発効）であれば、別の目標も一緒に一括予約できる', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    const res = reserveFreezeMulti(db, [a.id, b.id], { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(res).toHaveLength(2);
    expect(res[0]!.startDay).toBe('2026-07-11');
    expect(res[1]!.startDay).toBe('2026-07-11');
  });

  it('別の日（別の予約セッション）での同月2件目は、別の目標でも拒否される', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    reserveFreeze(db, a.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(() => reserveFreeze(db, b.id, { endDay: '2026-07-20', reason: '別件' }, NOW_0715)).toThrow();

    const quota = freezeQuota(db, NOW_0710);
    expect(quota.used).toBe(true);
    expect(quota.goalId).toBe(a.id);
    expect(quota.month).toBe('2026-07');
  });

  it('発効前に取り消すと枠が戻り、同じ月に別の目標が予約できる', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    reserveFreeze(db, a.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(cancelFreeze(db, a.id, NOW_0710)).toBe(true);
    expect(freezeQuota(db, NOW_0710).used).toBe(false);

    const f = reserveFreeze(db, b.id, { endDay: '2026-07-14', reason: '別件' }, NOW_0710);
    expect(f.startDay).toBe('2026-07-11');
  });

  it('発効後に解除しても枠は戻らない（予約→発効→即解除→再予約を塞ぐ）', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    reserveFreeze(db, a.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    releaseFreeze(db, a.id, NOW_0711); // 発効当日に解除（凍結 0 日）。
    expect(freezeQuota(db, NOW_0711).used).toBe(true);
    expect(() => reserveFreeze(db, b.id, { endDay: '2026-07-20', reason: '別件' }, NOW_0712)).toThrow();
  });

  it('月をまたぐ凍結は発効日の月だけを消費する', () => {
    const a = makeGoal('設計理解をしたい');
    reserveFreeze(db, a.id, { endDay: '2026-08-05', reason: '大タスク' }, NOW_0728); // 7/29 発効＝7月枠。
    // 延長しても新しい枠は消費しない。
    updateFreeze(db, a.id, { endDay: '2026-08-20', reason: 'まだ終わらない' }, NOW_0801);
    expect(freezeQuota(db, NOW_0801).month).toBe('2026-08');
    expect(freezeQuota(db, NOW_0801).used).toBe(false);

    const b = makeGoal('茶色取りたい', NOW_0806);
    const f = reserveFreeze(db, b.id, { endDay: '2026-08-25', reason: '8月の事情' }, NOW_0806);
    expect(f.startDay).toBe('2026-08-07');
  });

  it('月末（today の翌日が翌月）に予約した直後は、翌月（発効月）の使用済みとして返る（issue #75）', () => {
    const NOW_0731 = jst(2026, 7, 31);
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    // today=7/31 で予約すると発効日は 8/1＝8月枠。
    const f = reserveFreeze(db, a.id, { endDay: '2026-08-10', reason: '大タスク' }, NOW_0731);
    expect(f.startDay).toBe('2026-08-01');

    // 予約直後（today はまだ7月）に quota を尋ねても、発効月（8月）を基準に使用済みと分かる。
    const quota = freezeQuota(db, NOW_0731);
    expect(quota.month).toBe('2026-08');
    expect(quota.used).toBe(true);
    expect(quota.goalId).toBe(a.id);

    // 実際に別目標から同じ枠へ予約しようとすると拒否される（表示と重複チェックが一致する）。
    expect(() => reserveFreeze(db, b.id, { endDay: '2026-08-15', reason: '別件' }, NOW_0731)).toThrow();
  });
});

// --- 発効前の変更・取消 --------------------------------------------------------

describe('発効前の予約は変更・取消ができる', () => {
  it('発効前なら終了日を前へも動かせる', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    const f = updateFreeze(db, g.id, { endDay: '2026-07-12', reason: '短くする' }, NOW_0710);
    expect(f.endDay).toBe('2026-07-12');
  });

  it('発効後の取消は拒否される（解除は別操作）', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(() => cancelFreeze(db, g.id, NOW_0712)).toThrow();
    expect(getFreeze(db, g.id, NOW_0712)?.state).toBe('frozen');
  });
});

// --- 延長（後ろへのみ・理由必須・枠を消費しない）--------------------------------

describe('凍結の延長', () => {
  it('凍結中に理由つきで後ろへ延ばせる', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    const f = updateFreeze(db, g.id, { endDay: '2026-07-20', reason: 'まだ終わらない' }, NOW_0712);
    expect(f.endDay).toBe('2026-07-20');
    expect(f.state).toBe('frozen');
  });

  it('理由が空の延長は拒否され、終了日は変わらない', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(() => updateFreeze(db, g.id, { endDay: '2026-07-20', reason: '' }, NOW_0712)).toThrow();
    expect(getFreeze(db, g.id, NOW_0712)?.endDay).toBe('2026-07-14');
  });

  it('発効後の短縮は拒否される', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-20', reason: '大タスク' }, NOW_0710);
    expect(() => updateFreeze(db, g.id, { endDay: '2026-07-13', reason: '短くする' }, NOW_0712)).toThrow();
    expect(getFreeze(db, g.id, NOW_0712)?.endDay).toBe('2026-07-20');
  });
});

// --- 解除（即日発効）-----------------------------------------------------------

describe('凍結の解除は即日発効', () => {
  it('解除した当日からルールがゲートに戻る', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(evaluateDay(db, '2026-07-12', NOW_0712).perCondition).toHaveLength(0);

    const f = releaseFreeze(db, g.id, NOW_0713);
    expect(f.endDay).toBe('2026-07-12'); // 解除日の前日まで。
    expect(evaluateDay(db, '2026-07-13', NOW_0713).perCondition).toHaveLength(1);
    // 凍結は 7/11・7/12 の2日分だけ効いた。
    expect(getGoal(db, g.id, NOW_0713).endDay).toBe('2026-08-01');
  });

  it('発効当日の解除は凍結 0 日で、期限は延びない', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    releaseFreeze(db, g.id, NOW_0711);
    const view = getGoal(db, g.id, NOW_0711);
    expect(view.endDay).toBe('2026-07-30');
    expect(view.dayCount).toBe(30);
    expect(evaluateDay(db, '2026-07-11', NOW_0711).perCondition).toHaveLength(1);
  });

  it('発効前の解除は拒否される（取消を使う）', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(() => releaseFreeze(db, g.id, NOW_0710)).toThrow();
  });
});

// --- 凍結日は「無かった日」＝期限が延びる ---------------------------------------

describe('凍結日ぶん期限が延びる', () => {
  it('4日凍結すると実効の終了日が4日後ろへ動き、Day N/M の M が伸びる', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    const view = getGoal(db, g.id, NOW_0720);
    expect(view.endDay).toBe('2026-08-03');
    expect(view.dayCount).toBe(34);
    expect(view.dayNumber).toBe(20);
  });

  it('凍結中は残り日数（M − N）が減らない', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    const at12 = getGoal(db, g.id, NOW_0712);
    const at13 = getGoal(db, g.id, NOW_0713);
    expect(at12.dayCount - at12.dayNumber!).toBe(at13.dayCount - at13.dayNumber!);
  });

  it('未到来の凍結予定日は期限に影響しない', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    const view = getGoal(db, g.id, NOW_0710);
    expect(view.endDay).toBe('2026-07-30');
    expect(view.dayCount).toBe(30);
  });

  it('凍結中に元の終了日を越えても完走しない', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-08-10', reason: '大タスク' }, NOW_0728); // 7/29 発効。
    const view = getGoal(db, g.id, NOW_0805);
    expect(view.status).toBe('active');
    expect(view.showLifecycleFork).toBe(false);
    expect(view.freeze?.state).toBe('frozen');
  });
});

// --- ゲート除外（spec: goal-check-gate）----------------------------------------

describe('凍結中の目標のルールはゲートから外れる', () => {
  it('凍結中は消え、明けると戻る', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    expect(evaluateDay(db, '2026-07-12', NOW_0712).perCondition).toHaveLength(0);
    expect(evaluateDay(db, '2026-07-15', NOW_0715).perCondition).toHaveLength(1);
  });

  it('凍結していない目標のルールはゲートに残る', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    reserveFreeze(db, a.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    const res = evaluateDay(db, '2026-07-12', NOW_0712);
    expect(res.perCondition).toHaveLength(1);
    expect(res.perCondition[0]!.goalId).toBe(b.id);
  });

  it('単発ルールの繰り越しは凍結中だけ止まる', () => {
    const g = createGoal(
      db,
      {
        name: '髪質を改善する',
        purpose: '前髪を見る',
        start: 'today',
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
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    // 未提出のまま：凍結前は繰り越して現れる → 凍結中は消える → 明けると戻る。
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(1);
    expect(evaluateDay(db, '2026-07-12', NOW_0712).perCondition).toHaveLength(0);
    expect(evaluateDay(db, '2026-07-15', NOW_0715).perCondition).toHaveLength(1);
  });

  it('唯一の目標を凍結してもゲートは開かない（LOCKED のまま）', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
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
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);

    const report = getGoalReport(db, g.id, NOW_0720);
    expect(report.goal.dayCount).toBe(34);
    const cells = report.rules[0]!.cells;
    expect(cells[10]!.dayKey).toBe('2026-07-11');
    expect(cells[10]!.frozen).toBe(true);
    expect(cells[10]!.met).toBe(false);
    expect(cells[13]!.frozen).toBe(true);
    expect(cells[0]!.frozen).toBe(false);
    expect(cells[0]!.met).toBe(true);
    // 経過20日のうち凍結4日を除いた16日が達成日数。
    expect(report.goal.achievedDays).toBe(16);
  });
});

// --- 沿革（spec: goal-chronicle）------------------------------------------------

describe('沿革に凍結が理由つきで残る', () => {
  it('予約・発効・延長・解除が day_key 昇順に並ぶ', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    updateFreeze(db, g.id, { endDay: '2026-07-20', reason: 'まだ終わらない' }, NOW_0712);
    releaseFreeze(db, g.id, NOW_0713);

    const ch = getChronicle(db, g.id, '2026-07-20');
    expect(ch.freezes.map((f) => f.kind)).toEqual(['reserve', 'activate', 'extend', 'release']);
    expect(ch.freezes.map((f) => f.dayKey)).toEqual([
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
      '2026-07-13',
    ]);
    expect(ch.freezes[0]!.reason).toBe('大タスク');
    expect(ch.freezes[2]!.reason).toBe('まだ終わらない');
  });

  it('取り消した予約も消えずに残る（発効は載らない）', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    cancelFreeze(db, g.id, NOW_0710);

    const ch = getChronicle(db, g.id, '2026-07-20');
    expect(ch.freezes.map((f) => f.kind)).toEqual(['reserve', 'cancel']);
    expect(ch.freezes[0]!.reason).toBe('大タスク');
  });

  it('untilDayKey より後の凍結イベントは見せない', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);
    updateFreeze(db, g.id, { endDay: '2026-07-20', reason: 'まだ終わらない' }, NOW_0712);
    releaseFreeze(db, g.id, NOW_0713);

    const ch = getChronicle(db, g.id, '2026-07-12');
    expect(ch.freezes.map((f) => f.kind)).toEqual(['reserve', 'activate', 'extend']);
  });

  it('ルール操作と凍結は同じ並び順キーで併合できる', () => {
    const g = makeGoal();
    reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: '大タスク' }, NOW_0710);

    const ch = getChronicle(db, g.id, '2026-07-20');
    expect(ch.entries.every((e) => typeof e.sortKey === 'string')).toBe(true);
    expect(ch.freezes.every((f) => typeof f.sortKey === 'string')).toBe(true);
    const keys = ch.freezes.map((f) => f.sortKey);
    expect(keys).toEqual([...keys].sort());
  });
});
