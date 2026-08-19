import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { createGoal } from './goals.js';
import { resolveIdentity } from './group-identity.js';
import { createRootTask, createChildTask, setSubtreeDone, dropBranch } from './task-tree.js';
import {
  setTaskEstimate,
  setTaskProgress,
  runningBranch,
  remainingScopeSeconds,
  branchRemaining,
  TaskEstimateError,
} from './task-estimate.js';

/**
 * 想定時間と小数の進捗（spec: task-estimate）。
 *
 * 想定時間は**根直下のノードにだけ**置ける（祖先と子孫の両方にあると二重に数えるため）。
 * 進捗は葉にだけ置ける 0〜1 の小数で、「1個も終わってないが8割方は読めている」を数字にする。
 * 走行中の枝では実測から単価を導き、仮置きを上書きする。
 *
 * 時間軸は JST 固定。目標は 2026-08-01 開始、「今日」は 2026-08-18。
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

const END = '2026-12-31';
const NOW_D1 = jst(2026, 8, 1);
const NOW_TODAY = jst(2026, 8, 18, 23, 30);
const H = 3600;

let db: DB;
let designId: number;
beforeEach(() => {
  db = openDb(':memory:');
});

function seedSession(ms: number, dayKey: string): void {
  db.prepare(
    `INSERT INTO session
       (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
        started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES (?, ?, ?, NULL, 0, ?, ?, '[]', 1, ?, 'NORMAL', 0)`,
  ).run(`sg-${dayKey}`, '設計理解', 'blue', ms, dayKey, ms);
}

function seedGoal() {
  designId = resolveIdentity(db, '設計理解', 'blue')!;
  return createGoal(
    db,
    {
      name: '設計理解',
      purpose: '設計を自力で引けるようになっている',
      startReason: '手が止まる前に型を入れたい',
      endDay: END,
      rules: [{ target: 'TOTAL_WORK' as const, thresholdSeconds: 900, reason: '崩さない下限' }],
      targetHours: { kind: 'GROUP_SET' as const, secondsPerDay: 2 * H, groupIdentityIds: [designId] },
    },
    NOW_D1,
  );
}

const put = (id: number, hours: number, reason = '仮置き', now = NOW_D1) =>
  setTaskEstimate(db, id, { estimatedSeconds: hours * H, reason, actor: 'agent' }, now);

describe('想定時間は根直下のノードにだけ置ける', () => {
  it('根直下に置くと残り想定の合計に加わる', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    const b = createRootTask(db, g.id, '二周目を見る');
    put(a.id, 24);
    put(b.id, 64);

    expect(remainingScopeSeconds(db, g.id, NOW_TODAY)).toBe(88 * H);
  });

  it('深い階層への設定は拒否される', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    const sec3 = createChildTask(db, a.id, { title: 'sec3' });

    expect(() => put(sec3.id, 4)).toThrow(TaskEstimateError);
    expect(remainingScopeSeconds(db, g.id, NOW_TODAY)).toBeNull();
  });

  it('決着した枝は 0 として数える', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    const b = createRootTask(db, g.id, '二周目を見る');
    createChildTask(db, a.id, { title: 'sec1' });
    put(a.id, 24);
    put(b.id, 64);
    setSubtreeDone(db, a.id, true);

    expect(remainingScopeSeconds(db, g.id, NOW_TODAY)).toBe(64 * H);
  });

  it('想定時間を持たない枝は合計に数えられない（推測で埋めない）', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    createRootTask(db, g.id, '想定なしの枝');
    put(a.id, 24);

    expect(remainingScopeSeconds(db, g.id, NOW_TODAY)).toBe(24 * H);
  });

  it('負の想定時間は拒否される', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    expect(() =>
      setTaskEstimate(db, a.id, { estimatedSeconds: -1, reason: '誤入力', actor: 'agent' }, NOW_D1),
    ).toThrow(TaskEstimateError);
  });
});

describe('葉の小数の進捗', () => {
  it('0.8 の進捗が消化量に入り、残りの葉は 4.2 になる', () => {
    const g = seedGoal();
    seedSession(4 * H * 1000, '2026-08-18');
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    for (const t of ['sec1', 'sec2', 'sec3', 'sec4', 'sec5']) createChildTask(db, a.id, { title: t });
    put(a.id, 80);

    const leaf = db.prepare('SELECT id FROM task WHERE title = ?').get('sec1') as { id: number };
    setTaskProgress(db, leaf.id, { ratio: 0.8, reason: '8割方は読めている', actor: 'agent' }, NOW_TODAY);

    const br = branchRemaining(db, g.id, NOW_TODAY)!;
    expect(br.consumed).toBeCloseTo(0.8, 6);
    expect(br.remainingLeafWeight).toBeCloseTo(4.2, 6);
  });

  it('完了した葉は進捗の値によらず 1.0 として数える', () => {
    const g = seedGoal();
    seedSession(4 * H * 1000, '2026-08-18');
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    for (const t of ['sec1', 'sec2']) createChildTask(db, a.id, { title: t });
    put(a.id, 80);

    const leaf = db.prepare('SELECT id FROM task WHERE title = ?').get('sec1') as { id: number };
    setTaskProgress(db, leaf.id, { ratio: 0.8, reason: '途中', actor: 'agent' }, NOW_TODAY);
    setSubtreeDone(db, leaf.id, true);

    expect(branchRemaining(db, g.id, NOW_TODAY)!.consumed).toBeCloseTo(1.0, 6);
  });

  it('打ち切った葉は消化量にも残りにも数えられない', () => {
    const g = seedGoal();
    seedSession(4 * H * 1000, '2026-08-18');
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    const sub = createChildTask(db, a.id, { title: '飛ばす章' });
    createChildTask(db, sub.id, { title: 'sec13' });
    createChildTask(db, sub.id, { title: 'sec14' });
    createChildTask(db, a.id, { title: 'sec1' });
    createChildTask(db, a.id, { title: 'sec2' });
    createChildTask(db, a.id, { title: 'sec3' });
    put(a.id, 80);

    dropBranch(db, sub.id, '志望先が変わったため');

    const br = branchRemaining(db, g.id, NOW_TODAY)!;
    expect(br.consumed).toBe(0);
    expect(br.remainingLeafWeight).toBe(3);
  });

  it('範囲外の進捗と、容れ物への進捗は拒否される', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    const leaf = createChildTask(db, a.id, { title: 'sec1' });

    expect(() => setTaskProgress(db, leaf.id, { ratio: 1.4, reason: 'r', actor: 'agent' }, NOW_TODAY)).toThrow(
      TaskEstimateError,
    );
    expect(() => setTaskProgress(db, leaf.id, { ratio: -0.1, reason: 'r', actor: 'agent' }, NOW_TODAY)).toThrow(
      TaskEstimateError,
    );
    expect(() => setTaskProgress(db, a.id, { ratio: 0.5, reason: 'r', actor: 'agent' }, NOW_TODAY)).toThrow(
      TaskEstimateError,
    );
  });
});

describe('走行中の枝', () => {
  it('未決着の葉を持つ最初の枝が走行中になり、開始日は目標の開始日', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    createChildTask(db, a.id, { title: 'sec1' });
    const b = createRootTask(db, g.id, '二周目を見る');
    createChildTask(db, b.id, { title: 'sec1(2周目)' });

    const rb = runningBranch(db, g.id, NOW_TODAY)!;
    expect(rb.taskId).toBe(a.id);
    expect(rb.startDay).toBe('2026-08-01');
  });

  it('前の枝が決着すると次の枝へ移り、開始日は決着日の翌日', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    const leaf = createChildTask(db, a.id, { title: 'sec1' });
    const b = createRootTask(db, g.id, '二周目を見る');
    createChildTask(db, b.id, { title: 'sec1(2周目)' });

    setSubtreeDone(db, leaf.id, true);
    db.prepare('UPDATE task SET done_at = ? WHERE id = ?').run(jst(2026, 8, 10), leaf.id);

    const rb = runningBranch(db, g.id, NOW_TODAY)!;
    expect(rb.taskId).toBe(b.id);
    expect(rb.startDay).toBe('2026-08-11');
  });

  it('走行中の枝は高々1つ', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    createChildTask(db, a.id, { title: 'sec1' });
    const b = createRootTask(db, g.id, '二周目を見る');
    createChildTask(db, b.id, { title: 'sec1(2周目)' });

    const rb = runningBranch(db, g.id, NOW_TODAY)!;
    expect(rb.taskId).not.toBe(b.id);
  });
});

describe('実測から単価を導き、仮置きを上書きする', () => {
  /** 8/1〜8/18 に合計 `hours` を均さず、最終日にまとめて積むための素朴な種。 */
  function seedHours(hours: number, dayKey = '2026-08-18'): void {
    seedSession(hours * H * 1000, dayKey);
  }

  it('消化量 0 なら仮置きがそのまま使われる', () => {
    const g = seedGoal();
    seedHours(4);
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    for (const t of ['sec1', 'sec2']) createChildTask(db, a.id, { title: t });
    put(a.id, 64);

    const br = branchRemaining(db, g.id, NOW_TODAY)!;
    expect(br.consumed).toBe(0);
    expect(br.source).toBe('placeholder');
    expect(br.remainingSeconds).toBe(64 * H);
  });

  it('単価は実測 ÷ 消化量で、残りは単価 × 残りの葉の重み', () => {
    const g = seedGoal();
    seedHours(4);
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    for (const t of ['sec1', 'sec2', 'sec3', 'sec4', 'sec5']) createChildTask(db, a.id, { title: t });
    put(a.id, 80);

    const leaf = db.prepare('SELECT id FROM task WHERE title = ?').get('sec1') as { id: number };
    setTaskProgress(db, leaf.id, { ratio: 0.8, reason: '8割方は読めている', actor: 'agent' }, NOW_TODAY);

    const br = branchRemaining(db, g.id, NOW_TODAY)!;
    expect(br.source).toBe('measured');
    // 単価 = 4h ÷ 0.8 = 5.0h/葉、残り 4.2 葉 → 21h。仮置きの 80h は使われない。
    expect(br.unitSeconds).toBeCloseTo(5 * H, 0);
    expect(br.remainingSeconds).toBeCloseTo(21 * H, 0);
  });

  it('4h 積んで葉を2つ終えると、残り想定は 13.6h 減る', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    for (let i = 1; i <= 16; i++) createChildTask(db, a.id, { title: `sec${i}` });
    put(a.id, 80);

    const leafIds = (db.prepare('SELECT id FROM task WHERE parent_task_id = ? ORDER BY tree_order').all(a.id) as {
      id: number;
    }[]).map((r) => r.id);

    // 前日まで: 実測 40h・完了 8 葉・残り 8 葉 → 単価 5.0h・残り 40h
    seedSession(40 * H * 1000, '2026-08-17');
    for (const id of leafIds.slice(0, 8)) setSubtreeDone(db, id, true);
    const before = branchRemaining(db, g.id, jst(2026, 8, 17, 23, 30))!;
    expect(before.remainingSeconds).toBeCloseTo(40 * H, 0);

    // 今日: 4h 積んで 2 葉 → 実測 44h・完了 10 葉・残り 6 葉 → 単価 4.4h・残り 26.4h
    seedSession(4 * H * 1000, '2026-08-18');
    for (const id of leafIds.slice(8, 10)) setSubtreeDone(db, id, true);
    const after = branchRemaining(db, g.id, NOW_TODAY)!;

    expect(after.unitSeconds).toBeCloseTo(4.4 * H, 0);
    expect(after.remainingSeconds).toBeCloseTo(26.4 * H, 0);
    expect(before.remainingSeconds - after.remainingSeconds).toBeCloseTo(13.6 * H, 0);
  });

  it('まだ走っていない枝に単価を適用しない', () => {
    const g = seedGoal();
    seedHours(4);
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    for (const t of ['sec1', 'sec2']) createChildTask(db, a.id, { title: t });
    put(a.id, 8);
    const b = createRootTask(db, g.id, '二周目を見る');
    for (let i = 1; i <= 16; i++) createChildTask(db, b.id, { title: `sec${i}(2周目)` });
    put(b.id, 64);

    const leaf = db.prepare('SELECT id FROM task WHERE title = ?').get('sec1') as { id: number };
    setSubtreeDone(db, leaf.id, true);

    const rows = branchRemaining(db, g.id, NOW_TODAY, { all: true }) as unknown as {
      taskId: number;
      remainingSeconds: number;
      source: string;
    }[];
    const second = rows.find((r) => r.taskId === b.id)!;
    expect(second.source).toBe('placeholder');
    expect(second.remainingSeconds).toBe(64 * H);
  });

  it('上書きしても仮置きの記録は残る', () => {
    const g = seedGoal();
    seedHours(4);
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    for (const t of ['sec1', 'sec2']) createChildTask(db, a.id, { title: t });
    put(a.id, 80, '一周目と同じくらいと仮定');

    const leaf = db.prepare('SELECT id FROM task WHERE title = ?').get('sec1') as { id: number };
    setSubtreeDone(db, leaf.id, true);

    expect(branchRemaining(db, g.id, NOW_TODAY)!.source).toBe('measured');
    const row = db.prepare('SELECT estimated_seconds FROM task WHERE id = ?').get(a.id) as {
      estimated_seconds: number;
    };
    expect(row.estimated_seconds).toBe(80 * H);
  });
});

describe('変更は理由と実行者つきで記録される', () => {
  it('理由が空なら拒否され、値も記録も変わらない', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    put(a.id, 24);

    expect(() =>
      setTaskEstimate(db, a.id, { estimatedSeconds: 12 * H, reason: '  ', actor: 'agent' }, NOW_TODAY),
    ).toThrow(TaskEstimateError);

    const row = db.prepare('SELECT estimated_seconds FROM task WHERE id = ?').get(a.id) as {
      estimated_seconds: number;
    };
    expect(row.estimated_seconds).toBe(24 * H);
    const n = db.prepare('SELECT COUNT(*) AS c FROM task_estimate_change WHERE task_id = ?').get(a.id) as {
      c: number;
    };
    expect(n.c).toBe(1);
  });

  it('変更前後・理由・実行者・適用日が1行として追記される', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    put(a.id, 240, '当初の見立て');
    put(a.id, 216, '一周目は思ったより軽い', jst(2026, 8, 17));

    const rows = db
      .prepare('SELECT field, from_value, to_value, reason, actor, day_key FROM task_estimate_change WHERE task_id = ? ORDER BY id')
      .all(a.id) as { field: string; from_value: number | null; to_value: number; reason: string; actor: string; day_key: string }[];

    expect(rows).toHaveLength(2);
    expect(rows[0]!.from_value).toBeNull();
    expect(rows[1]).toMatchObject({
      field: 'estimate',
      from_value: 240 * H,
      to_value: 216 * H,
      reason: '一周目は思ったより軽い',
      actor: 'agent',
      day_key: '2026-08-17',
    });
  });

  it('実行者は human と agent を書き分けられる', () => {
    const g = seedGoal();
    const a = createRootTask(db, g.id, 'Udemy で講座一周見る');
    setTaskEstimate(db, a.id, { estimatedSeconds: 24 * H, reason: '自分で決めた', actor: 'human' }, NOW_D1);

    const row = db.prepare('SELECT actor FROM task_estimate_change WHERE task_id = ?').get(a.id) as { actor: string };
    expect(row.actor).toBe('human');
  });
});
