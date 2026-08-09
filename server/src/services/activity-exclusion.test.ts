import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UNGROUPED_KEY } from '@track/contract';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { recompute } from './recompute.js';
import { getTimeline, addAutoExclusion, removeAutoExclusion } from './timeline.js';
import { totalWorkMsForDay } from './categories.js';
import { createRule } from './rule-registry.js';
import { evaluateDay } from '../rules/evaluate.js';

/**
 * spec: timeline-record-deletion（issue #90）
 * 閉じ忘れたタブグループの自動記録を、除外レコードとして取り消せることを固定する。
 *
 * 検証の要点:
 *  - 除外は `session` の物理削除ではないので、`recompute()` をまたいで持続する。
 *  - 同時オープンだった一方を消すと、残りへ divide-by-N → N−1 で再按分される（区間の総和は不変）。
 *  - 開いていた実グループが全て消えた区間は `ungrouped` へ落ちず非計上になる（総作業時間が減る）。
 *  - 確定済み（is_final=1）の日も、対象日に限って上書き再集計できる。
 *  - 取り消しで完全に元へ戻り、二重取り消しは冪等。
 */

const TZ = 'Asia/Tokyo';
const DAY = '2026-08-05';
const MIN = 60_000;
const jst = (h: number, mi: number) => zonedTimeToEpoch(2026, 8, 5, h, mi, 0, TZ);

// 各ウィンドウ（同時オープンの構成が一定な連続区間）。
const W1 = { start: jst(12, 0), end: jst(13, 0) }; // 開発 + ブログ投稿（同時2）
const W2 = { start: jst(14, 0), end: jst(15, 0) }; // 開発 のみ（単独）
const W3 = { start: jst(16, 0), end: jst(17, 0) }; // A + B + C（同時3）

interface G {
  stableGroupId: string;
  title: string;
  color: string;
}
const DEV: G = { stableGroupId: 'g-dev', title: '開発', color: 'green' };
const BLOG: G = { stableGroupId: 'g-blog', title: 'ブログ投稿', color: 'magenta' };
const GA: G = { stableGroupId: 'g-a', title: 'A', color: 'blue' };
const GB: G = { stableGroupId: 'g-b', title: 'B', color: 'red' };
const GC: G = { stableGroupId: 'g-c', title: 'C', color: 'yellow' };

let db: DB;
let seq = 0;

/**
 * `[start, end]` に1分刻みでハートビートを投入する（末端サンプルを含むので区間は end まで覆われる）。
 * monotonic は client_ts と同一基準にして、ウィンドウ間の空白が CLOCK_JUMP ではなく
 * GAP_EXCEEDED（gap_cap 90秒超）として素直に除外されるようにする。
 */
function seedWindow(groups: G[], win: { start: number; end: number }): void {
  const stmt = db.prepare(
    `INSERT INTO raw_sample
      (boot_id, seq, client_ts, monotonic_ms, tz, event_type, active_group_id,
       active_stable_group_id, active_title, active_color, window_id, tab_id,
       idle_state, browser_focused, open_group_keys, ext_version, received_at)
     VALUES ('boot', ?, ?, ?, 'Asia/Tokyo', 'HEARTBEAT', 1, ?, ?, ?, 1, 1, 'active', 1, ?, '0.1.0', ?)`,
  );
  const open = JSON.stringify(
    groups.map((g, i) => ({ groupId: i + 1, stableGroupId: g.stableGroupId, title: g.title, color: g.color })),
  );
  const head = groups[0]!;
  for (let t = win.start; t <= win.end; t += MIN) {
    stmt.run(seq++, t, t - jst(0, 0), head.stableGroupId, head.title, head.color, open, t);
  }
}

function totalsOf(dayKey = DAY): Record<string, number> {
  const rows = db
    .prepare('SELECT stable_group_id, ms FROM daily_totals_snapshot WHERE day_key = ?')
    .all(dayKey) as { stable_group_id: string; ms: number }[];
  return Object.fromEntries(rows.map((r) => [r.stable_group_id, r.ms]));
}

/** タイムラインの AUTO ブロックから identityKey を引く（UI が削除時に送る値と同じ経路）。 */
function identityKeyOf(title: string, startAt: number): string {
  const block = getTimeline(db, DAY).auto.find((b) => b.title === title && b.startAt === startAt);
  expect(block, `AUTO ブロックが見つからない: ${title} @${startAt}`).toBeDefined();
  return block!.identityKey;
}

beforeEach(() => {
  db = openDb(':memory:');
  seq = 0;
  seedWindow([DEV, BLOG], W1);
  seedWindow([DEV], W2);
  seedWindow([GA, GB, GC], W3);
  recompute(db);
});
afterEach(() => {
  db.close();
});

describe('前提: 削除前の集計', () => {
  it('同時オープンは divide-by-N で按分され、総作業時間は3時間', () => {
    const t = totalsOf();
    expect(t['g-dev']).toBe(30 * MIN + 60 * MIN); // W1 の半分 + W2 の全量
    expect(t['g-blog']).toBe(30 * MIN);
    expect(t['g-a']).toBe(20 * MIN);
    expect(t['g-b']).toBe(20 * MIN);
    expect(t['g-c']).toBe(20 * MIN);
    expect(totalWorkMsForDay(db, DAY)).toBe(180 * MIN);
  });
});

describe('除外レコードは再集計をまたいで持続する', () => {
  it('削除した区間の identity のセッションは再集計後も再生成されない', () => {
    const key = identityKeyOf('開発', W2.start);
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W2.start, endAt: W2.end });
    recompute(db, { onlyDays: [DAY] });

    const auto = getTimeline(db, DAY).auto;
    expect(auto.some((b) => b.title === '開発' && b.startAt === W2.start)).toBe(false);

    // もう一度再集計しても復活しない。
    recompute(db);
    expect(getTimeline(db, DAY).auto.some((b) => b.startAt === W2.start)).toBe(false);
  });

  it('削除区間の外にある同一 identity のブロックは残る', () => {
    const key = identityKeyOf('開発', W2.start);
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W2.start, endAt: W2.end });
    recompute(db);

    const auto = getTimeline(db, DAY).auto;
    expect(auto.some((b) => b.title === '開発' && b.startAt === W1.start)).toBe(true);
    expect(totalsOf()['g-dev']).toBe(30 * MIN); // W1 ぶんだけ残る
  });
});

describe('同時オープンの一方を削除すると残りへ再按分される', () => {
  it('2グループの一方を削除すると残りが区間の全量になり、総作業時間は変わらない', () => {
    const before = totalWorkMsForDay(db, DAY);
    const key = identityKeyOf('開発', W1.start);
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W1.start, endAt: W1.end });
    recompute(db, { onlyDays: [DAY] });

    const t = totalsOf();
    expect(t['g-blog']).toBe(60 * MIN); // 30分 → 60分（分母 2 → 1）
    expect(t['g-dev']).toBe(60 * MIN); // W1 ぶんが消え、W2 の 60 分のみ
    expect(totalWorkMsForDay(db, DAY)).toBe(before); // 区間の総和は不変
  });

  it('3グループのうち1つを削除すると残り2つが等分する', () => {
    const key = identityKeyOf('A', W3.start);
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W3.start, endAt: W3.end });
    recompute(db, { onlyDays: [DAY] });

    const t = totalsOf();
    expect(t['g-a']).toBeUndefined();
    expect(t['g-b']).toBe(30 * MIN);
    expect(t['g-c']).toBe(30 * MIN);
  });

  it('削除された identity は残ったブロックの同時オープン一覧から消える', () => {
    const key = identityKeyOf('開発', W1.start);
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W1.start, endAt: W1.end });
    recompute(db, { onlyDays: [DAY] });

    const blog = getTimeline(db, DAY).auto.find((b) => b.title === 'ブログ投稿')!;
    expect(blog.coactiveNames).toEqual([]);
    expect(blog.n).toBe(1);
    expect(blog.creditedMs).toBe(60 * MIN);
  });
});

describe('開いていたグループが全て除外された区間は非計上になる', () => {
  it('単独オープン区間を削除すると総作業時間がその分減る', () => {
    const key = identityKeyOf('開発', W2.start);
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W2.start, endAt: W2.end });
    recompute(db, { onlyDays: [DAY] });

    expect(totalWorkMsForDay(db, DAY)).toBe(120 * MIN); // 180分 − 60分
  });

  it('削除ぶんが未グループ（ungrouped）へ移らない', () => {
    const key = identityKeyOf('開発', W2.start);
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W2.start, endAt: W2.end });
    recompute(db, { onlyDays: [DAY] });

    expect(totalsOf()[UNGROUPED_KEY]).toBeUndefined();
  });

  it('削除区間は未記録ギャップとして返り、手動で記録し直せる', () => {
    const key = identityKeyOf('開発', W2.start);
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W2.start, endAt: W2.end });
    recompute(db, { onlyDays: [DAY] });

    const gaps = getTimeline(db, DAY, jst(23, 0)).gaps;
    expect(gaps.some((g) => g.startAt <= W2.start && g.endAt >= W2.end)).toBe(true);
  });
});

describe('確定済みの日も対象日に限って訂正できる', () => {
  function finalize(): void {
    db.prepare('UPDATE daily_totals_snapshot SET is_final = 1 WHERE day_key = ?').run(DAY);
  }

  it('force なしでは確定日の集計は変わらない', () => {
    const key = identityKeyOf('開発', W2.start);
    finalize();
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W2.start, endAt: W2.end });
    recompute(db, { onlyDays: [DAY] });

    expect(totalWorkMsForDay(db, DAY)).toBe(180 * MIN); // 確定は保護される
  });

  it('force ありなら確定日でも削除が反映され、確定フラグは維持される', () => {
    const key = identityKeyOf('開発', W2.start);
    finalize();
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W2.start, endAt: W2.end });
    recompute(db, { onlyDays: [DAY], force: true });

    expect(totalWorkMsForDay(db, DAY)).toBe(120 * MIN);
    const finals = db
      .prepare('SELECT DISTINCT is_final FROM daily_totals_snapshot WHERE day_key = ?')
      .all(DAY) as { is_final: number }[];
    expect(finals).toEqual([{ is_final: 1 }]);
  });

  it('force は onlyDays で指定した日以外の確定日を巻き込まない', () => {
    const OTHER = '2026-08-04';
    db.prepare(
      `INSERT INTO daily_totals_snapshot (day_key, stable_group_id, ms, is_final, updated_at)
       VALUES (?, 'g-dev', ?, 1, 0)`,
    ).run(OTHER, 99 * MIN);

    const key = identityKeyOf('開発', W2.start);
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W2.start, endAt: W2.end });
    recompute(db, { onlyDays: [DAY], force: true });

    expect(totalsOf(OTHER)['g-dev']).toBe(99 * MIN);
  });

  it('削除で条件を満たさなくなった確定日は force 再評価で未達成へ更新される', () => {
    createRule(
      db,
      { target: 'TOTAL_WORK', thresholdSeconds: 150 * 60, startDay: DAY, reason: 'r' },
      jst(4, 0),
    );
    const before = evaluateDay(db, DAY, jst(23, 0));
    expect(before.status).toBe('UNLOCKED'); // 180分 ≥ 150分

    db.prepare('UPDATE unlock_evaluation SET is_final = 1 WHERE day_key = ?').run(DAY);
    const key = identityKeyOf('開発', W2.start);
    addAutoExclusion(db, DAY, { identityKey: key, startAt: W2.start, endAt: W2.end });
    recompute(db, { onlyDays: [DAY], force: true });

    // 確定済みなので通常評価では動かない。
    expect(evaluateDay(db, DAY, jst(23, 0)).status).toBe('UNLOCKED');
    // force 指定で当該日だけ再評価する。
    const after = evaluateDay(db, DAY, jst(23, 0), { force: true });
    expect(after.status).toBe('LOCKED'); // 120分 < 150分
    expect(after.perCondition.find((p) => p.target === 'TOTAL_WORK')!.actualSeconds).toBe(120 * 60);
  });
});

describe('削除は取り消せる', () => {
  it('取り消すと削除前の集計へ完全に戻る', () => {
    const before = totalsOf();
    const key = identityKeyOf('開発', W2.start);
    const id = addAutoExclusion(db, DAY, { identityKey: key, startAt: W2.start, endAt: W2.end });
    recompute(db, { onlyDays: [DAY] });
    expect(totalWorkMsForDay(db, DAY)).toBe(120 * MIN);

    expect(removeAutoExclusion(db, id)).toBe(true);
    recompute(db, { onlyDays: [DAY] });

    expect(totalsOf()).toEqual(before);
    expect(getTimeline(db, DAY).auto.some((b) => b.title === '開発' && b.startAt === W2.start)).toBe(true);
  });

  it('同時オープンの再按分も取り消しで戻る', () => {
    const key = identityKeyOf('開発', W1.start);
    const id = addAutoExclusion(db, DAY, { identityKey: key, startAt: W1.start, endAt: W1.end });
    recompute(db, { onlyDays: [DAY] });
    expect(totalsOf()['g-blog']).toBe(60 * MIN);

    removeAutoExclusion(db, id);
    recompute(db, { onlyDays: [DAY] });

    expect(totalsOf()['g-blog']).toBe(30 * MIN);
    const blog = getTimeline(db, DAY).auto.find((b) => b.title === 'ブログ投稿')!;
    expect(blog.coactiveNames).toContain('開発');
  });

  it('存在しない除外レコードの取り消しは冪等（false を返しエラーにしない）', () => {
    const key = identityKeyOf('開発', W2.start);
    const id = addAutoExclusion(db, DAY, { identityKey: key, startAt: W2.start, endAt: W2.end });
    expect(removeAutoExclusion(db, id)).toBe(true);
    expect(removeAutoExclusion(db, id)).toBe(false);
    expect(removeAutoExclusion(db, 999_999)).toBe(false);
  });
});
