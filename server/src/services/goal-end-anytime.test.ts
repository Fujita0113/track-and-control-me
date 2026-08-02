import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import {
  createGoal,
  getGoal,
  getGoalReport,
  endGoal,
  listJournalImages,
  addDaysKey,
  GoalValidationError,
} from './goals.js';
import { evaluateDay } from '../rules/evaluate.js';
import { getChronicle } from './goal-chronicle.js';
import { reserveFreeze, getFreeze } from './goal-freeze.js';

/**
 * いつでも理由つきで終えられる（spec: goal-lifecycle-fork ADDED・issue #76）。
 *
 * 「終える」は完走後限定をやめ、進行中でも押せる。終わるときは常に3つを問う:
 *   ① めざした状態の答え（3値・任意） ② 証拠写真（任意） ③ 理由（必須）
 * 発効は **当日**（既存の `editable-rule-registry`「当日から効く」にそろえる）。
 * ゲート回避目的の終了に対する抑止は、大きい沿革に事実が残ることが担う。
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
const D4 = '2026-08-04';
const D5 = '2026-08-05';

const dataUrl = (bytes: number[] = [9, 9, 9]): string =>
  `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function baseInput(over: Record<string, unknown> = {}) {
  return {
    name: 'アルゴリズムを固める',
    purpose: 'アルゴリズムを一通り自力で実装できるようになっている',
    startReason: '試験前だが手は止めたくない',
    endDay: END,
    rules: [{ target: 'TOTAL_WORK' as const, thresholdSeconds: 14400, reason: '4時間は守りたい' }],
    ...over,
  };
}

/** 進行中の目標を1つ作る（永続ルール1本つき）。 */
function activeGoal(over: Record<string, unknown> = {}) {
  return createGoal(db, baseInput(over), NOW_D1);
}

const REASON = '試験勉強はもう大丈夫。設計に切り替えたい';

describe('進行中でも終えられる（理由必須）', () => {
  it('進行中に理由つきで終えると、当日から終了になる', () => {
    const g = activeGoal();
    const view = endGoal(db, g.id, { reason: REASON }, NOW_D4);
    expect(view.status).toBe('ended');
    expect(view.endedDayKey).toBe(D4);
    expect(view.lifecycleChoice).toBe('ended');
    expect(view.lifecycleReason).toBe(REASON);
    expect(getGoal(db, g.id, NOW_D4).status).toBe('ended');
  });

  it('理由が空だと拒否され、目標は進行中のまま残る', () => {
    const g = activeGoal();
    expect(() => endGoal(db, g.id, { reason: '   ' }, NOW_D4)).toThrow(GoalValidationError);
    expect(getGoal(db, g.id, NOW_D4).status).toBe('active');
  });

  it('永続ルールは当日からゲートを外れる（翌日ではない）', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: REASON }, NOW_D4);
    const ruleRow = db
      .prepare('SELECT r.status AS status FROM goal_rule gr JOIN rule r ON r.id = gr.rule_id WHERE gr.goal_id = ?')
      .get(g.id) as { status: string };
    expect(ruleRow.status).toBe('removed');
    // 終えた当日の評価に、この目標のルールはもう含まれない。
    expect(evaluateDay(db, D4, NOW_D4).perCondition).toHaveLength(0);
  });

  it('過去日の判定は書き換えられない', () => {
    const g = activeGoal();
    // 8/1 を先に評価して確定させておく（rollover 相当・is_final=1 を立てる。
    // evaluateDay は is_final でない日は常に現在のルール状態で再計算するため、
    // 「過去日が不変」を検証するにはまず確定させる必要がある・rules/evaluate.test.ts と同じ流儀）。
    const before = evaluateDay(db, START, NOW_D1).perCondition.length;
    expect(before).toBe(1);
    db.prepare("UPDATE unlock_evaluation SET is_final = 1 WHERE day_key = ?").run(START);
    endGoal(db, g.id, { reason: REASON }, NOW_D4);
    expect(evaluateDay(db, START, NOW_D4).perCondition).toHaveLength(1);
  });

  it('終えてもレポート・沿革は読めるまま残る', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: REASON }, NOW_D4);
    expect(() => getGoalReport(db, g.id, NOW_D4)).not.toThrow();
    expect(getChronicle(db, g.id).entries.length).toBeGreaterThan(0);
  });

  it('二度目の終了は拒否される', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: REASON }, NOW_D4);
    expect(() => endGoal(db, g.id, { reason: 'もう一度' }, NOW_D5)).toThrow();
  });
});

describe('終わるときに問う3つ（①めざした状態 ②証拠写真 ③理由）', () => {
  it('めざした状態は3値で、「できなかった」を記録できる', () => {
    const g = activeGoal();
    const view = endGoal(db, g.id, { reason: REASON, outcomeMet: false }, NOW_D4);
    expect(view.outcomeMet).toBe(false);
  });

  it('「できた」も記録できる', () => {
    const g = activeGoal();
    expect(endGoal(db, g.id, { reason: REASON, outcomeMet: true }, NOW_D4).outcomeMet).toBe(true);
  });

  it('答えないまま終えられる（未回答は null のまま）', () => {
    const g = activeGoal();
    const view = endGoal(db, g.id, { reason: REASON }, NOW_D4);
    expect(view.outcomeMet).toBeNull();
  });

  it('証拠写真は当日に、作成時のキャプションで保存される', () => {
    const g = activeGoal({ outcomeCaption: 'AtCoder レーティング' });
    endGoal(db, g.id, { reason: REASON, outcomeMet: false, photo: { dataUrl: dataUrl() } }, NOW_D4);
    const imgs = listJournalImages(db, g.id, D4);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.caption).toBe('AtCoder レーティング');
  });

  it('証拠写真を出さずに終えられる（提出は必須条件ではない）', () => {
    const g = activeGoal({ outcomeCaption: 'AtCoder レーティング' });
    expect(() => endGoal(db, g.id, { reason: REASON }, NOW_D4)).not.toThrow();
    expect(listJournalImages(db, g.id, D4)).toHaveLength(0);
  });

  it('証拠写真を設定していない目標に写真を渡すと拒否される（宛先が無い）', () => {
    const g = activeGoal();
    expect(() => endGoal(db, g.id, { reason: REASON, photo: { dataUrl: dataUrl() } }, NOW_D4)).toThrow(
      GoalValidationError,
    );
  });
});

describe('完走の「終える」も同じ問い・同じ当日発効', () => {
  const NOW_AFTER = jst(2026, 8, 7);

  it('完走後に終えても、めざした状態と写真を受け付け、当日から効く', () => {
    const g = activeGoal({ outcomeCaption: 'AtCoder レーティング' });
    const view = endGoal(
      db,
      g.id,
      { reason: 'やり切った', outcomeMet: true, photo: { dataUrl: dataUrl() } },
      NOW_AFTER,
    );
    expect(view.status).toBe('ended');
    expect(view.endedDayKey).toBe('2026-08-07');
    expect(view.outcomeMet).toBe(true);
    expect(listJournalImages(db, g.id, '2026-08-07')).toHaveLength(1);
  });

  it('完走後でも理由は必須', () => {
    const g = activeGoal();
    expect(() => endGoal(db, g.id, { reason: '' }, NOW_AFTER)).toThrow(GoalValidationError);
  });
});

describe('凍結との相互作用', () => {
  it('未発効の凍結予約は取り消され、適用済みの延長と沿革は残る', () => {
    const g = activeGoal();
    // 8/1 に予約 → 翌日 8/2 発効、8/3 まで。8/4 時点で 2 日ぶん適用済み（このぶんで8月の凍結枠を消費する）。
    reserveFreeze(db, g.id, { endDay: addDaysKey(START, 2), reason: '体調不良' }, NOW_D1);
    const extendedEnd = getGoal(db, g.id, NOW_D4).endDay;
    expect(extendedEnd > END).toBe(true);
    // 2件目の予約は、凍結枠（アプリ全体で月1回・8月分は上で消費済み）と衝突しないよう
    // 9月の枠で、8/31（翌日9/1発効＝まだ発効していない）に行う。
    const NOW_0831 = jst(2026, 8, 31);
    const NOW_0902 = jst(2026, 9, 2);
    reserveFreeze(db, g.id, { endDay: '2026-09-10', reason: 'まだ休みたい' }, NOW_0831);

    // 未発効のまま、同じ 8/31 のうちに理由つきで終える。
    endGoal(db, g.id, { reason: REASON }, NOW_0831);

    // 未発効だった2件目の予約は取り消され、1件目の適用済みの延長ぶんと凍結の沿革は残る。
    expect(getFreeze(db, g.id, NOW_0902)?.state).toBe('released');
    expect(getGoal(db, g.id, NOW_0902).endDay).toBe(extendedEnd);
    expect(JSON.stringify(getChronicle(db, g.id).freezes)).toContain('体調不良');
  });
});
