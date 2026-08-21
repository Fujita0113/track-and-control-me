import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import {
  createGoal,
  getGoal,
  listJournalImages,
  addDaysKey,
  GoalValidationError,
} from './goals.js';

/**
 * 期限の自由指定・めざす状態・作成理由・証拠写真（spec: goal-challenge・issue #76）。
 *
 * 30日固定を撤廃し、作成時に `endDay` を日付で直接指定する。`purpose`（めざす状態）と
 * `startReason`（なぜ始めるのか）は必須。証拠写真は任意で、キャプションを1つ決めると
 * それが `goal-report ③` の Before/After のグループ化キーになる（③の実装は変えない）。
 *
 * 時間軸は JST 固定。「今日」= 2026-08-01。
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

const TODAY = '2026-08-01';
const NOW_TODAY = jst(2026, 8, 1);
const END = '2026-08-06';

const dataUrl = (bytes: number[] = [1, 2, 3]): string =>
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

describe('期限は作成時に日付で指定する（30日固定の撤廃）', () => {
  it('期限を日付で指定して作成できる（6日間）', () => {
    const g = createGoal(db, baseInput(), NOW_TODAY);
    expect(g.startDay).toBe(TODAY);
    expect(g.endDay).toBe(END);
    expect(g.status).toBe('active');
    expect(g.dayNumber).toBe(1);
    expect(g.dayCount).toBe(6);
  });

  it('30日は既定でも上限でもない（90日でも作れる）', () => {
    const g = createGoal(db, baseInput({ endDay: addDaysKey(TODAY, 90) }), NOW_TODAY);
    expect(g.dayCount).toBe(91);
  });

  it('同日（1日だけ）の目標も作れる', () => {
    const g = createGoal(db, baseInput({ endDay: TODAY }), NOW_TODAY);
    expect(g.dayCount).toBe(1);
  });

  it('開始日より前の期限は拒否される', () => {
    expect(() => createGoal(db, baseInput({ endDay: '2026-07-31' }), NOW_TODAY)).toThrow(GoalValidationError);
    expect(db.prepare('SELECT COUNT(*) AS c FROM goal').get()).toEqual({ c: 0 });
  });

  it('期限の指定が無いと拒否される（暗黙の30日にフォールバックしない）', () => {
    const { endDay: _drop, ...noEnd } = baseInput();
    expect(() => createGoal(db, noEnd as never, NOW_TODAY)).toThrow(GoalValidationError);
  });

  it('明日開始でも指定した期限がそのまま使われる', () => {
    const g = createGoal(db, baseInput({ start: 'tomorrow', endDay: '2026-08-10' }), NOW_TODAY);
    expect(g.startDay).toBe('2026-08-02');
    expect(g.endDay).toBe('2026-08-10');
    expect(g.status).toBe('upcoming');
  });

  it('期限を早める手段は提供されない（end_day は前方向にのみ動く）', () => {
    const g = createGoal(db, baseInput(), NOW_TODAY);
    // 短縮 API は存在しない。読み直しても期限は変わらない。
    expect(getGoal(db, g.id, NOW_TODAY).endDay).toBe(END);
  });
});

describe('めざす状態と作成理由は必須', () => {
  it('めざす状態が空だと作成できない', () => {
    expect(() => createGoal(db, baseInput({ purpose: '   ' }), NOW_TODAY)).toThrow(GoalValidationError);
    expect(db.prepare('SELECT COUNT(*) AS c FROM goal').get()).toEqual({ c: 0 });
  });

  it('作成理由が空だと作成できない', () => {
    expect(() => createGoal(db, baseInput({ startReason: '' }), NOW_TODAY)).toThrow(GoalValidationError);
    expect(db.prepare('SELECT COUNT(*) AS c FROM goal').get()).toEqual({ c: 0 });
  });

  it('めざす状態と作成理由は別々に保持される（片方で代用しない）', () => {
    const g = createGoal(db, baseInput(), NOW_TODAY);
    expect(g.purpose).toBe('アルゴリズムを一通り自力で実装できるようになっている');
    expect(g.startReason).toBe('試験前だが手は止めたくない');
  });
});

describe('証拠写真の設定（任意・キャプションは1つ・初期写真は任意）', () => {
  it('求めない場合は outcomeCaption が null になる', () => {
    const g = createGoal(db, baseInput(), NOW_TODAY);
    expect(g.outcomeCaption).toBeNull();
  });

  it('キャプションだけ決めて初期写真を置かずに作成できる', () => {
    const g = createGoal(db, baseInput({ outcomeCaption: 'AtCoder レーティング' }), NOW_TODAY);
    expect(g.outcomeCaption).toBe('AtCoder レーティング');
    // 画像はまだ1枚も無い。
    expect(listJournalImages(db, g.id, TODAY)).toHaveLength(0);
  });

  it('初期写真は開始日に、指定したキャプションで保存される', () => {
    const g = createGoal(
      db,
      baseInput({ outcomeCaption: 'AtCoder レーティング', outcomeImage: { dataUrl: dataUrl() } }),
      NOW_TODAY,
    );
    const imgs = listJournalImages(db, g.id, TODAY);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.caption).toBe('AtCoder レーティング');
  });

  // レポート③（写真の比較・reportImages のキャプション横断集約）は capability ごと廃止された
  // （spec: goal-report REMOVED・goal-burnup-forecast）。「同じキャプションで開始日に1枚流入する」
  // という下敷きの事実は直前のテストで listJournalImages() により既に検証済みで、この
  // テストが追加で確かめていたのは③の Before/After 集約経路のみだったため、意図的に落とす。

  it('キャプション無しで初期写真だけ指定するのは拒否される（宛先が決まらない）', () => {
    expect(() => createGoal(db, baseInput({ outcomeImage: { dataUrl: dataUrl() } }), NOW_TODAY)).toThrow(
      GoalValidationError,
    );
  });
});
