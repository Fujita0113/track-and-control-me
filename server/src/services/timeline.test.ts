import { describe, it, expect } from 'vitest';
import { openDb, updateConfig, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { getTimeline } from './timeline.js';

/**
 * timeline-revamp D2: ギャップ抽出の閾値を `away_min_seconds` に一元化した回帰テスト。
 * 閾値未満の未カバー区間は返らず、閾値を下げると返るようになることを担保する。
 */

const TZ = 'Asia/Tokyo';
const DAY = '2026-07-06';
const jst = (h: number, mi: number) => zonedTimeToEpoch(2026, 7, 6, h, mi, 0, TZ);

/** 同一グループの AUTO セッションを1件挿入する。 */
function insertSession(
  db: DB,
  group: string,
  title: string,
  startAt: number,
  endAt: number,
): void {
  db.prepare(
    `INSERT INTO session
      (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
       started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES (?, ?, 'blue', NULL, ?, ?, ?, '[]', 1, ?, 'NORMAL', ?)`,
  ).run(group, title, startAt, endAt, DAY, endAt - startAt, endAt);
}

/** 色・coactive を指定して AUTO セッションを1件挿入する。 */
function insertSessionEx(
  db: DB,
  opts: {
    group: string;
    title: string;
    color: string;
    startAt: number;
    endAt: number;
    coactive?: string[];
    n?: number;
  },
): void {
  db.prepare(
    `INSERT INTO session
      (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
       started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'NORMAL', ?)`,
  ).run(
    opts.group,
    opts.title,
    opts.color,
    opts.startAt,
    opts.endAt,
    DAY,
    JSON.stringify(opts.coactive ?? []),
    opts.n ?? 1,
    opts.endAt - opts.startAt,
    opts.endAt,
  );
}

/** ある秒数±許容のギャップが存在するか。 */
function hasGapSeconds(
  gaps: { seconds: number }[],
  seconds: number,
  tolerance = 1,
): boolean {
  return gaps.some((g) => Math.abs(g.seconds - seconds) <= tolerance);
}

describe('getTimeline ギャップ閾値の一元化（away_min_seconds）', () => {
  function seed(): DB {
    const db = openDb(':memory:');
    // 面接: 10:47–10:55 / 11:01–11:22（間隔6分）/ 11:45–12:00（間隔23分）。
    insertSession(db, 'grp-interview', '面接', jst(10, 47), jst(10, 55));
    insertSession(db, 'grp-interview', '面接', jst(11, 1), jst(11, 22));
    insertSession(db, 'grp-interview', '面接', jst(11, 45), jst(12, 0));
    return db;
  }

  it('既定閾値（600s）では6分ギャップは返らず、23分ギャップは返る', () => {
    const db = seed();
    const tl = getTimeline(db, DAY, jst(12, 0));
    // 6分（360s）= 閾値未満 → 返らない。
    expect(hasGapSeconds(tl.gaps, 6 * 60)).toBe(false);
    // 23分（1380s）= 閾値以上 → 返る。
    expect(hasGapSeconds(tl.gaps, 23 * 60)).toBe(true);
    // 全ギャップが閾値以上であること。
    expect(tl.gaps.every((g) => g.seconds >= 600)).toBe(true);
  });

  it('閾値を300sへ下げると6分ギャップも返るようになる', () => {
    const db = seed();
    updateConfig(db, { away_min_seconds: 300 });
    const tl = getTimeline(db, DAY, jst(12, 0));
    expect(hasGapSeconds(tl.gaps, 6 * 60)).toBe(true);
    expect(hasGapSeconds(tl.gaps, 23 * 60)).toBe(true);
  });

  it('閾値を上げると（1800s）中間ギャップは両方消える', () => {
    const db = seed();
    updateConfig(db, { away_min_seconds: 1800 });
    const tl = getTimeline(db, DAY, jst(12, 0));
    expect(hasGapSeconds(tl.gaps, 6 * 60)).toBe(false);
    expect(hasGapSeconds(tl.gaps, 23 * 60)).toBe(false);
  });
});

/**
 * timeline-group-identity（issue #52）: AUTO ブロックを記録時点スナップショット identity
 * （名前＋色）単位で束ねる。改名して使い回した同一 sid は名前ごとに分離し、別 sid でも
 * 同一 identity なら近接結合する。
 */
describe('getTimeline AUTO ブロックの identity 単位化', () => {
  const SID = 'grp-reused';

  it('同一 sid を改名して使い回すと名前ごとに別ブロックへ分離する', () => {
    const db = openDb(':memory:');
    // 同一 stable_group_id を「開発」→「ブログ投稿」→「開発」へ改名して連続使用（間隔なし）。
    insertSessionEx(db, { group: SID, title: '開発', color: 'blue', startAt: jst(14, 0), endAt: jst(14, 20) });
    insertSessionEx(db, { group: SID, title: 'ブログ投稿', color: 'magenta', startAt: jst(14, 20), endAt: jst(14, 40) });
    insertSessionEx(db, { group: SID, title: '開発', color: 'blue', startAt: jst(14, 40), endAt: jst(15, 0) });

    const tl = getTimeline(db, DAY, jst(15, 0));
    // 先頭名で全区間を覆う単一ブロックにならず、名前ごとに分離する。
    const titles = tl.auto.map((b) => b.title).sort();
    expect(titles).toEqual(['ブログ投稿', '開発', '開発']);
    const blog = tl.auto.find((b) => b.title === 'ブログ投稿');
    expect(blog).toBeDefined();
    expect(blog!.startAt).toBe(jst(14, 20));
    expect(blog!.endAt).toBe(jst(14, 40));
    // 「開発」で全区間(14:00–15:00)を覆うブロックは存在しない。
    expect(tl.auto.some((b) => b.title === '開発' && b.startAt === jst(14, 0) && b.endAt === jst(15, 0))).toBe(false);
  });

  it('異なる sid でも同一 identity(名前+色) なら近接結合される', () => {
    const db = openDb(':memory:');
    // 別々の stable_group_id だが、いずれも「振り返り」(purple)。近接（間隔なし）。
    insertSessionEx(db, { group: 'refl-a', title: '振り返り', color: 'purple', startAt: jst(9, 0), endAt: jst(9, 30) });
    insertSessionEx(db, { group: 'refl-b', title: '振り返り', color: 'purple', startAt: jst(9, 30), endAt: jst(10, 0) });

    const tl = getTimeline(db, DAY, jst(10, 0));
    const refl = tl.auto.filter((b) => b.title === '振り返り');
    expect(refl).toHaveLength(1);
    expect(refl[0]!.startAt).toBe(jst(9, 0));
    expect(refl[0]!.endAt).toBe(jst(10, 0));
  });

  it('同名だが色が異なる区間は別ブロックへ分離する', () => {
    const db = openDb(':memory:');
    insertSessionEx(db, { group: 'g1', title: '作業', color: 'blue', startAt: jst(9, 0), endAt: jst(9, 20) });
    insertSessionEx(db, { group: 'g2', title: '作業', color: 'green', startAt: jst(9, 20), endAt: jst(9, 40) });

    const tl = getTimeline(db, DAY, jst(10, 0));
    const work = tl.auto.filter((b) => b.title === '作業');
    expect(work).toHaveLength(2);
    expect(new Set(work.map((b) => b.color))).toEqual(new Set(['blue', 'green']));
  });

  it('同時オープングループ名は識別子ではなく当時の名前で解決される', () => {
    const db = openDb(':memory:');
    // 「開発」と「英語」が同一区間で同時オープン（互いを coactive に持つ）。
    insertSessionEx(db, { group: 'dev', title: '開発', color: 'blue', startAt: jst(11, 0), endAt: jst(11, 30), coactive: ['eng'], n: 2 });
    insertSessionEx(db, { group: 'eng', title: '英語', color: 'red', startAt: jst(11, 0), endAt: jst(11, 30), coactive: ['dev'], n: 2 });

    const tl = getTimeline(db, DAY, jst(12, 0));
    const dev = tl.auto.find((b) => b.title === '開発');
    expect(dev).toBeDefined();
    // 生 sid ('eng') ではなく表示名「英語」で解決される。
    expect(dev!.coactiveNames).toEqual(['英語']);
    expect(dev!.coactiveGroupKeys).not.toContain('eng');
  });

  it('identity 再グルーピングは表示クレジット合計（creditedMs）を保存する', () => {
    const db = openDb(':memory:');
    // 改名使い回し＋同一 identity 別 sid の混在。表示ブロックの creditedMs 合計は
    // 全セッションの credited_ms 合計と一致する（権威データの再集計を伴わない）。
    insertSessionEx(db, { group: SID, title: '開発', color: 'blue', startAt: jst(13, 0), endAt: jst(13, 20) });
    insertSessionEx(db, { group: SID, title: 'ブログ投稿', color: 'magenta', startAt: jst(13, 20), endAt: jst(13, 50) });
    insertSessionEx(db, { group: 'refl-a', title: '振り返り', color: 'purple', startAt: jst(14, 0), endAt: jst(14, 30) });
    insertSessionEx(db, { group: 'refl-b', title: '振り返り', color: 'purple', startAt: jst(14, 30), endAt: jst(15, 0) });

    const tl = getTimeline(db, DAY, jst(15, 0));
    const totalCredited = tl.auto.reduce((sum, b) => sum + b.creditedMs, 0);
    const expected = (20 + 30 + 30 + 30) * 60 * 1000; // 各区間の credited_ms(=区間長) 合計。
    expect(totalCredited).toBe(expected);
  });
});
