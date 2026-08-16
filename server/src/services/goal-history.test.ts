import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import {
  createGoal,
  endGoal,
  cancelEndGoal,
  resumeGoal,
  cancelResumeGoal,
  addRuleToGoal,
  removeGoalRule,
  addJournalImage,
  addDaysKey,
} from './goals.js';
import { goalHistory } from './goal-history.js';
import { resolveIdentity, renameIdentity } from './group-identity.js';

/**
 * 大きい沿革＝目標そのものの年表（spec: goal-history・issue #76）。
 *
 * 載るのは目標の **作成・終了・完走** の3種だけ（ルール操作と凍結は⑤沿革が読み手）。
 * 終了・完走の行には **数字（到達/未達）・自己申告（めざした状態）・証拠写真** の3つが並ぶ。
 * 数字と自己申告は終了・完走の時点で焼き込み、写真だけは都度解決する。
 *
 * 時間軸は JST 固定。「今日」= 2026-08-01 開始。
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

const START = '2026-08-01';
const END = '2026-08-06';
const NOW_D1 = jst(2026, 8, 1);
const NOW_D4 = jst(2026, 8, 4);
const NOW_D5 = jst(2026, 8, 5);
const NOW_D6 = jst(2026, 8, 6);
const NOW_AFTER = jst(2026, 8, 7);
const NOW_D8 = jst(2026, 8, 8);
const MIN = 60_000;
const H = 3600;

const dataUrl = (bytes: number[] = [7, 7, 7]): string =>
  `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function seedSession(sid: string, name: string, color: string | null, ms: number, dayKey: string): void {
  db.prepare(
    `INSERT INTO session
       (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
        started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES (?, ?, ?, NULL, 0, ?, ?, '[]', 1, ?, 'NORMAL', 0)`,
  ).run(sid, name, color, ms, dayKey, ms);
}

function baseInput(over: Record<string, unknown> = {}) {
  return {
    name: 'アルゴリズムを固める',
    purpose: 'アルゴリズムを一通り自力で実装できるようになっている',
    startReason: '試験前だが手は止めたくない',
    endDay: END,
    rules: [{ target: 'TOTAL_WORK' as const, thresholdSeconds: 900, reason: '崩さない下限' }],
    ...over,
  };
}

/** 目標時間つき（アルゴリズム 2h/日）の目標。 */
function goalWithTarget(over: Record<string, unknown> = {}) {
  const algo = resolveIdentity(db, 'アルゴリズム', 'yellow')!;
  return createGoal(
    db,
    baseInput({
      targetHours: { kind: 'GROUP_SET', secondsPerDay: 2 * H, groupIdentityIds: [algo] },
      ...over,
    }),
    NOW_D1,
  );
}

describe('載るのは目標の作成・終了・完走だけ', () => {
  it('作成・終了・完走が時系列に並ぶ', () => {
    const a = createGoal(db, baseInput({ name: 'アルゴリズムを固める' }), NOW_D1);
    // 終了は翌日発効なので、8/4 に終えた行は 8/5（＝`ended_day_key`）に並ぶ（spec: goal-history MODIFIED）。
    endGoal(db, a.id, { reason: '試験勉強はもう大丈夫。設計に切り替えたい' }, NOW_D4);
    // 期限は a と無関係に長く取る（NOW_AFTER 時点でまだ完走させないため。狙いは「作成・終了・完走」の
    // 3件だけが並ぶことの確認であり、この2つ目の目標を完走させることではない）。
    createGoal(
      db,
      baseInput({ name: '設計を固める', startReason: '競プロより今はこっちに熱がある', endDay: addDaysKey(START, 90) }),
      NOW_D6,
    );

    const h = goalHistory(db, NOW_AFTER);
    expect(h.map((e) => e.kind)).toEqual(['created', 'ended', 'created']);
    expect(h.map((e) => e.dayKey)).toEqual([START, '2026-08-05', '2026-08-06']);
  });

  it('発効前（終了予約中）の終了も、予約中の印つきで当日から並ぶ', () => {
    const a = createGoal(db, baseInput({ name: 'アルゴリズムを固める' }), NOW_D1);
    endGoal(db, a.id, { reason: 'ここで降りる' }, NOW_D4);

    // 終えたその日（8/4）に見ても「−終える」の行は並ぶ。行の日付は発効日（8/5）。
    const h = goalHistory(db, NOW_D4);
    const ended = h.find((e) => e.kind === 'ended')!;
    expect(ended.dayKey).toBe('2026-08-05');
    expect(ended.pending).toBe(true);
    expect(ended.reason).toBe('ここで降りる');
  });

  it('終了を取り消すと「−終える」の行は消える（発効しなかった終了は起きなかった終了）', () => {
    const a = createGoal(db, baseInput({ name: 'アルゴリズムを固める' }), NOW_D1);
    endGoal(db, a.id, { reason: '押し間違えた' }, NOW_D4);
    cancelEndGoal(db, a.id, NOW_D4);

    const h = goalHistory(db, NOW_D4);
    expect(h.map((e) => e.kind)).toEqual(['created']);
    expect(JSON.stringify(h)).not.toContain('押し間違えた');
  });

  it('発効後の行は予約中ではない', () => {
    const a = createGoal(db, baseInput({ name: 'アルゴリズムを固める' }), NOW_D1);
    endGoal(db, a.id, { reason: 'ここで降りる' }, NOW_D4);
    const ended = goalHistory(db, NOW_D5).find((e) => e.kind === 'ended')!;
    expect(ended.pending).toBe(false);
  });

  it('期限を過ぎて終えていない目標は completed として載る', () => {
    createGoal(db, baseInput(), NOW_D1);
    const h = goalHistory(db, NOW_AFTER);
    expect(h.map((e) => e.kind)).toEqual(['created', 'completed']);
    expect(h[1]!.dayKey).toBe(addDaysKey(END, 1));
  });

  it('ルール操作は大きい沿革に載らない（⑤沿革が読み手）', () => {
    const g = createGoal(db, baseInput(), NOW_D1);
    const added = addRuleToGoal(db, g.id, { target: 'MANUAL_CHECK', label: '筋トレ', reason: '足す' }, {}, NOW_D1);
    removeGoalRule(db, g.id, added.rule.id, 'やっぱりやめる', NOW_D4);

    const h = goalHistory(db, NOW_D5);
    expect(h.every((e) => e.kind === 'created' || e.kind === 'ended' || e.kind === 'completed')).toBe(true);
    expect(JSON.stringify(h)).not.toContain('やっぱりやめる');
  });

  it('作成理由が「＋作成」の行に載る', () => {
    createGoal(db, baseInput(), NOW_D1);
    const created = goalHistory(db, NOW_D1).find((e) => e.kind === 'created')!;
    expect(created.reason).toBe('試験前だが手は止めたくない');
    expect(created.purpose).toBe('アルゴリズムを一通り自力で実装できるようになっている');
  });

  it('並びは決定的（同じデータで2回読んでも入れ替わらない）', () => {
    const a = createGoal(db, baseInput({ name: 'A' }), NOW_D1);
    const b = createGoal(db, baseInput({ name: 'B' }), NOW_D1);
    endGoal(db, a.id, { reason: 'r1' }, NOW_D4);
    endGoal(db, b.id, { reason: 'r2' }, NOW_D4);

    const first = goalHistory(db, NOW_D5);
    const second = goalHistory(db, NOW_D5);
    expect(first).toEqual(second);
  });
});

describe('終了・完走の行は「数字・自己申告・証拠写真」の3つを並べる', () => {
  it('3つが同じ行に並ぶ', () => {
    const g = goalWithTarget({ outcomeCaption: 'AtCoder レーティング', outcomeImage: { dataUrl: dataUrl([1]) } });
    // Day1〜4 で 6 時間（平均 1h30m）→ 目標 2h/日 に未達。
    seedSession('sid-a', 'アルゴリズム', 'yellow', 360 * MIN, START);
    endGoal(
      db,
      g.id,
      { reason: '試験勉強はもう大丈夫。設計に切り替えたい', outcomeMet: false, photo: { dataUrl: dataUrl([2]) } },
      NOW_D4,
    );

    const ended = goalHistory(db, NOW_D5).find((e) => e.kind === 'ended')!;
    // ① 数字
    expect(ended.pace!.targetSecondsPerDay).toBe(2 * H);
    expect(ended.pace!.averageSeconds).toBe(90 * 60);
    expect(ended.pace!.met).toBe(false);
    // ② 自己申告
    expect(ended.outcomeMet).toBe(false);
    // ③ 証拠写真（最古=Before・最新=After）
    expect(ended.photos.before).not.toBeNull();
    expect(ended.photos.after).not.toBeNull();
    expect(ended.photos.before!.dayKey).toBe(START);
    expect(ended.photos.after!.dayKey).toBe('2026-08-04');
    // 理由
    expect(ended.reason).toBe('試験勉強はもう大丈夫。設計に切り替えたい');
  });

  it('目標時間が無い行では到達判定を出さない', () => {
    const g = createGoal(db, baseInput({ name: '試験期間の筋トレ' }), NOW_D1);
    endGoal(db, g.id, { reason: '終わり', outcomeMet: true }, NOW_D4);

    const ended = goalHistory(db, NOW_D5).find((e) => e.kind === 'ended')!;
    expect(ended.pace).toBeNull();
    expect(ended.outcomeMet).toBe(true);
  });

  it('未回答は null のまま（欠けたまま返す・埋めない）', () => {
    const g = createGoal(db, baseInput(), NOW_D1);
    endGoal(db, g.id, { reason: '終わり' }, NOW_D4);

    const ended = goalHistory(db, NOW_D5).find((e) => e.kind === 'ended')!;
    expect(ended.outcomeMet).toBeNull();
    expect(ended.photos.before).toBeNull();
    expect(ended.photos.after).toBeNull();
  });
});

describe('焼き込みと都度解決の切り分け', () => {
  it('終えた後にグループを改名しても、焼き込んだ数字は動かない', () => {
    const g = goalWithTarget();
    seedSession('sid-a', 'アルゴリズム', 'yellow', 360 * MIN, START);
    endGoal(db, g.id, { reason: '終わり', outcomeMet: false }, NOW_D4);
    const before = goalHistory(db, NOW_D5).find((e) => e.kind === 'ended')!.pace!;

    renameIdentity(db, { name: 'アルゴリズム', color: 'yellow' }, { name: '競プロ', color: 'yellow' }, NOW_D5);

    const after = goalHistory(db, NOW_D5).find((e) => e.kind === 'ended')!.pace!;
    expect(after.averageSeconds).toBe(before.averageSeconds);
    expect(after.met).toBe(before.met);
  });

  it('後から出した写真は反映されるが、焼き込んだ数字と答えは動かない', () => {
    const g = goalWithTarget({ outcomeCaption: 'AtCoder レーティング' });
    seedSession('sid-a', 'アルゴリズム', 'yellow', 360 * MIN, START);
    endGoal(db, g.id, { reason: '終わり', outcomeMet: false }, NOW_D4);

    const before = goalHistory(db, NOW_D5).find((e) => e.kind === 'ended')!;
    expect(before.photos.before).toBeNull();

    // 締めた後に、同じキャプションで写真を出す（振り返りタブ相当の経路）。
    addJournalImage(db, g.id, '2026-08-05', { dataUrl: dataUrl([3]), caption: 'AtCoder レーティング' }, NOW_D5);

    const after = goalHistory(db, NOW_D5).find((e) => e.kind === 'ended')!;
    expect(after.photos.before).not.toBeNull();
    expect(after.pace!.averageSeconds).toBe(before.pace!.averageSeconds);
    expect(after.outcomeMet).toBe(false);
  });

  it('終えた事実は消せない（削除の手段が無い）', () => {
    const g = createGoal(db, baseInput(), NOW_D1);
    endGoal(db, g.id, { reason: '逃げた' }, NOW_D4);
    const h = goalHistory(db, NOW_D5);
    expect(h.some((e) => e.kind === 'ended' && e.reason === '逃げた')).toBe(true);
  });
});

describe('再開は「→再開」として理由つきで載る（spec: goal-history MODIFIED・issue #103）', () => {
  it('発効済みの再開の行が理由つきで載る', () => {
    const g = createGoal(db, baseInput(), NOW_D1);
    endGoal(db, g.id, { reason: '一旦降りる' }, NOW_D4); // ended_day_key = 8/5。
    resumeGoal(db, g.id, { reason: 'コーディングテストが終わった' }, NOW_D5); // resumed_day_key = 8/6。

    const h = goalHistory(db, NOW_D6);
    expect(h.map((e) => e.kind)).toEqual(['created', 'ended', 'resumed']);
    const resumed = h.find((e) => e.kind === 'resumed')!;
    expect(resumed.dayKey).toBe('2026-08-06');
    expect(resumed.reason).toBe('コーディングテストが終わった');
    expect(resumed.pending).toBe(false);
  });

  it('再開予約中の行は予約中として当日から並ぶ', () => {
    const g = createGoal(db, baseInput(), NOW_D1);
    endGoal(db, g.id, { reason: '一旦降りる' }, NOW_D4);
    resumeGoal(db, g.id, { reason: '再開したい' }, NOW_D5);

    const h = goalHistory(db, NOW_D5);
    const resumed = h.find((e) => e.kind === 'resumed')!;
    expect(resumed.dayKey).toBe('2026-08-06');
    expect(resumed.pending).toBe(true);
  });

  it('再開を取り消すと「→再開」の行は消える', () => {
    const g = createGoal(db, baseInput(), NOW_D1);
    endGoal(db, g.id, { reason: '一旦降りる' }, NOW_D4);
    resumeGoal(db, g.id, { reason: '再開したい' }, NOW_D5);
    cancelResumeGoal(db, g.id, NOW_D5);

    const h = goalHistory(db, NOW_D5);
    expect(h.map((e) => e.kind)).toEqual(['created', 'ended']);
  });

  it('終了→再開のサイクルを繰り返すと全サイクルが並ぶ', () => {
    const g = createGoal(db, baseInput(), NOW_D1);
    endGoal(db, g.id, { reason: '1回目に降りる' }, NOW_D4); // ended_day_key = 8/5。
    resumeGoal(db, g.id, { reason: '1回目の再開' }, NOW_D5); // resumed_day_key = 8/6。
    endGoal(db, g.id, { reason: '2回目に降りる' }, NOW_D6); // ended_day_key = 8/7。
    resumeGoal(db, g.id, { reason: '2回目の再開' }, NOW_AFTER); // resumed_day_key = 8/8。

    const h = goalHistory(db, NOW_D8);
    expect(h.map((e) => e.kind)).toEqual(['created', 'ended', 'resumed', 'ended', 'resumed']);
    expect(h.map((e) => e.reason)).toEqual([
      '試験前だが手は止めたくない',
      '1回目に降りる',
      '1回目の再開',
      '2回目に降りる',
      '2回目の再開',
    ]);
  });
});
