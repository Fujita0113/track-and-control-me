import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import {
  createGoal,
  getGoal,
  endGoal,
  cancelEndGoal,
  listJournalImages,
  addDaysKey,
  GoalValidationError,
  GoalLifecycleError,
} from './goals.js';
import { evaluateDay } from '../rules/evaluate.js';
import { getChronicle } from './goal-chronicle.js';
import { goalBurnup } from './goal-burnup.js';
import { freezeGoal, getFreeze } from './goal-freeze.js';

/**
 * いつでも理由つきで終えられる（spec: goal-lifecycle-fork ADDED・issue #76）。
 *
 * 「終える」は完走後限定をやめ、進行中でも押せる。終わるときは常に3つを問う:
 *   ① めざした状態の答え（3値・任意） ② 証拠写真（任意） ③ 理由（必須）
 *
 * 発効は **翌日**（`ended_day_key = today + 1`）。今夜ノルマを外す必要がある正当な事情は
 * `goal-freeze` の一時凍結（月1枠）が担うので、目標終了に当日発効の力は要らない。
 * 上限の無い当日発効ボタンは「ノルマ全消しの無制限なボタン」になり、記録の汚れだけを抑止に
 * 当てにすると、ブレーキが最も必要な局面（調子が悪いとき）で効かないためである。
 *
 * 翌日発効に伴い、発効前は取り消せる（`goal-freeze` の「発効前の予約は取消できる」と同じ形）。
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
const NOW_D6 = jst(2026, 8, 6);
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

describe('進行中でも終えられる（理由必須・翌日発効）', () => {
  it('進行中に理由つきで終えると、翌日から終了になる', () => {
    const g = activeGoal();
    const view = endGoal(db, g.id, { reason: REASON }, NOW_D4);
    // 終えた当日はまだ進行中で、終了予約中として発効日が読める。
    expect(view.status).toBe('active');
    expect(view.endingOn).toBe(D5);
    expect(view.endedDayKey).toBeNull();
    expect(view.lifecycleChoice).toBe('ended');
    expect(view.lifecycleReason).toBe(REASON);
    // 翌日に終了として現れる。
    const next = getGoal(db, g.id, NOW_D5);
    expect(next.status).toBe('ended');
    expect(next.endedDayKey).toBe(D5);
    expect(next.endingOn).toBeNull();
  });

  it('理由が空だと拒否され、目標は進行中のまま残る', () => {
    const g = activeGoal();
    expect(() => endGoal(db, g.id, { reason: '   ' }, NOW_D4)).toThrow(GoalValidationError);
    expect(getGoal(db, g.id, NOW_D4).status).toBe('active');
    expect(getGoal(db, g.id, NOW_D4).endingOn).toBeNull();
  });

  it('永続ルールは翌日からゲートを外れる（今夜のノルマは今夜のノルマとして残る）', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: REASON }, NOW_D4);
    // 終えた当日の評価は一切変わらない（これが当日破壊の禁止そのもの）。
    expect(evaluateDay(db, D4, NOW_D4).perCondition).toHaveLength(1);
    // 翌日から外れる。
    expect(evaluateDay(db, D5, NOW_D5).perCondition).toHaveLength(0);
  });

  it('終了は rule 行を書き換えない（凍結と同じ導出方式で外す）', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: REASON }, NOW_D4);
    const ruleRow = db
      .prepare('SELECT r.status AS status FROM goal_rule gr JOIN rule r ON r.id = gr.rule_id WHERE gr.goal_id = ?')
      .get(g.id) as { status: string };
    expect(ruleRow.status).toBe('active');
  });

  it('終了で⑤沿革がルール削除の行で埋まらない', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: REASON }, NOW_D4);
    const chr = getChronicle(db, g.id);
    expect(chr.entries.filter((e) => e.change.op === 'remove')).toHaveLength(0);
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

  it('終えても進捗グラフ・沿革は読めるまま残る', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: REASON }, NOW_D4);
    expect(() => goalBurnup(db, g.id, NOW_D5)).not.toThrow();
    expect(getChronicle(db, g.id).entries.length).toBeGreaterThan(0);
  });

  it('二度目の終了は拒否される（発効前でも発効後でも）', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: REASON }, NOW_D4);
    expect(() => endGoal(db, g.id, { reason: 'もう一度' }, NOW_D4)).toThrow();
    expect(() => endGoal(db, g.id, { reason: 'もう一度' }, NOW_D5)).toThrow();
  });
});

describe('終了は発効前なら取り消せる', () => {
  it('同じ日のうちに取り消すと進行中に戻り、焼き込みも消える', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: REASON, outcomeMet: false }, NOW_D4);
    const view = cancelEndGoal(db, g.id, NOW_D4);
    expect(view.status).toBe('active');
    expect(view.endingOn).toBeNull();
    expect(view.endedDayKey).toBeNull();
    expect(view.lifecycleChoice).toBeNull();
    expect(view.lifecycleReason).toBeNull();
    expect(view.outcomeMet).toBeNull();
    // 翌日のゲートも通常どおりに戻る。
    expect(evaluateDay(db, D5, NOW_D5).perCondition).toHaveLength(1);
  });

  it('発効後は取り消せない', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: REASON }, NOW_D4);
    expect(() => cancelEndGoal(db, g.id, NOW_D5)).toThrow(GoalLifecycleError);
    expect(getGoal(db, g.id, NOW_D5).status).toBe('ended');
  });

  it('終えていない目標の取消は拒否される', () => {
    const g = activeGoal();
    expect(() => cancelEndGoal(db, g.id, NOW_D4)).toThrow(GoalLifecycleError);
  });

  it('取り消しても終了時に出した証拠写真は残る（記録は消さない）', () => {
    const g = activeGoal({ outcomeCaption: 'AtCoder レーティング' });
    endGoal(db, g.id, { reason: REASON, photo: { dataUrl: dataUrl() } }, NOW_D4);
    cancelEndGoal(db, g.id, NOW_D4);
    expect(listJournalImages(db, g.id, D4)).toHaveLength(1);
  });

  it('取り消してからもう一度終えられる', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: REASON }, NOW_D4);
    cancelEndGoal(db, g.id, NOW_D4);
    const again = endGoal(db, g.id, { reason: 'やっぱり終える' }, NOW_D4);
    expect(again.endingOn).toBe(D5);
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

  it('証拠写真は終えた当日に、作成時のキャプションで保存される', () => {
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

describe('完走の「終える」も同じ問い・同じ翌日発効', () => {
  const NOW_AFTER = jst(2026, 8, 7);
  const NOW_AFTER_NEXT = jst(2026, 8, 8);

  it('完走後に終えても、めざした状態と写真を受け付け、翌日から効く', () => {
    const g = activeGoal({ outcomeCaption: 'AtCoder レーティング' });
    const view = endGoal(
      db,
      g.id,
      { reason: 'やり切った', outcomeMet: true, photo: { dataUrl: dataUrl() } },
      NOW_AFTER,
    );
    // 完走した目標の永続ルールも「続ける／終える」に答えるまでゲートに残るため、
    // 完走経路でも発効タイミングを分けない（spec: 発効タイミングを分けてはならない）。
    expect(view.status).toBe('completed');
    expect(view.endingOn).toBe('2026-08-08');
    expect(view.outcomeMet).toBe(true);
    expect(listJournalImages(db, g.id, '2026-08-07')).toHaveLength(1);
    expect(getGoal(db, g.id, NOW_AFTER_NEXT).status).toBe('ended');
  });

  it('完走後に終えた当日も、永続ルールはゲートに残る', () => {
    const g = activeGoal();
    endGoal(db, g.id, { reason: 'やり切った' }, NOW_AFTER);
    expect(evaluateDay(db, '2026-08-07', NOW_AFTER).perCondition).toHaveLength(1);
    expect(evaluateDay(db, '2026-08-08', NOW_AFTER_NEXT).perCondition).toHaveLength(0);
  });

  it('完走後でも理由は必須', () => {
    const g = activeGoal();
    expect(() => endGoal(db, g.id, { reason: '' }, NOW_AFTER)).toThrow(GoalValidationError);
  });
});

describe('凍結との相互作用', () => {
  it('凍結を経てから終えても、凍結の記録はそのまま残り、適用済みの延長と沿革も残る', () => {
    const g = activeGoal();
    // 8/1 に凍結（当日発効・8/3まで）。8/4 時点で凍結は既に経過済み（3日ぶん適用済み・以降は
    // 増えず安定する＝frozenDaysUpTo は経過区間を min(end_day, today) でキャップするため）。
    freezeGoal(db, g.id, { endDay: addDaysKey(START, 2), reason: '体調不良' }, NOW_D1);
    const extendedEnd = getGoal(db, g.id, NOW_D4).endDay;
    expect(extendedEnd > END).toBe(true);

    // 凍結を経た後に理由つきで終える。
    endGoal(db, g.id, { reason: REASON }, NOW_D4);

    // 終了は永続ルールをゲートから外すだけで、凍結の記録（解凍済み・適用済みの延長・沿革）は
    // 取り消されずそのまま残る。
    expect(getFreeze(db, g.id, NOW_D5)?.state).toBe('released');
    expect(getGoal(db, g.id, NOW_D5).endDay).toBe(extendedEnd);
    expect(JSON.stringify(getChronicle(db, g.id).freezes)).toContain('体調不良');
  });

  it('一時凍結で今夜を空けた上で終えると、当日は凍結で外れ、翌日以降は終了で外れる', () => {
    const g = activeGoal();
    freezeGoal(db, g.id, { endDay: D5, reason: '明日の面接の課題' }, NOW_D5);
    endGoal(db, g.id, { reason: REASON }, NOW_D5);
    // 8/5 は凍結のぶんで外れている（終了はまだ効いていない）。
    expect(evaluateDay(db, D5, NOW_D5).perCondition).toHaveLength(0);
    // 8/6 は凍結が明けているが、終了が発効しているので戻ってこない。
    expect(evaluateDay(db, '2026-08-06', NOW_D6).perCondition).toHaveLength(0);
    expect(getGoal(db, g.id, NOW_D6).status).toBe('ended');
  });
});
