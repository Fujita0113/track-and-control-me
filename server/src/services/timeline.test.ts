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
