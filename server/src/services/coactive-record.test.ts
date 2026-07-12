import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { addCoRecordEntries, deleteEntry, getTimeline } from './timeline.js';

/**
 * 複数カテゴリの均等割同時記録（spec: timeline-coactive-record / tasks 6.1・6.3）。
 * - 作成の原子性（途中失敗で部分作成しない）と正規化（重複・空白除外）。
 * - 削除時の再按分（2→1 で持ち分が区間長へ戻る）。
 */

const TZ = 'Asia/Tokyo';
const DAY = '2026-07-06';
const jst = (h: number, mi: number) => zonedTimeToEpoch(2026, 7, 6, h, mi, 0, TZ);

function manualRows(db: DB): {
  id: number;
  category_key: string;
  n: number;
  co_record_group_id: number | null;
  start_at: number;
  end_at: number;
}[] {
  return db
    .prepare(
      "SELECT id, category_key, n, co_record_group_id, start_at, end_at FROM activity_log_entry WHERE entry_type = 'MANUAL' ORDER BY id",
    )
    .all() as never;
}

describe('addCoRecordEntries 同時記録の作成と正規化', () => {
  it('2カテゴリで同一グループ・n=2 の2行を作成する', () => {
    const db = openDb(':memory:');
    const ids = addCoRecordEntries(db, DAY, {
      startAt: jst(12, 0),
      endAt: jst(14, 0),
      categories: ['昼食', '洗濯'],
    });
    expect(ids.length).toBe(2);
    const rows = manualRows(db);
    expect(rows.length).toBe(2);
    // 同一 co_record_group_id・n=2・区間全体共有。
    expect(rows[0]!.n).toBe(2);
    expect(rows[1]!.n).toBe(2);
    expect(rows[0]!.co_record_group_id).not.toBeNull();
    expect(rows[0]!.co_record_group_id).toBe(rows[1]!.co_record_group_id);
    expect(rows.map((r) => r.category_key).sort()).toEqual(['昼食', '洗濯']);
    expect(rows[0]!.start_at).toBe(rows[1]!.start_at);
    expect(rows[0]!.end_at).toBe(rows[1]!.end_at);
  });

  it('単独選択は従来どおり co_record_group_id=NULL・n=1', () => {
    const db = openDb(':memory:');
    const ids = addCoRecordEntries(db, DAY, {
      startAt: jst(12, 0),
      endAt: jst(14, 0),
      categories: ['昼食'],
    });
    expect(ids.length).toBe(1);
    const rows = manualRows(db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.n).toBe(1);
    expect(rows[0]!.co_record_group_id).toBeNull();
  });

  it('重複・空白カテゴリは正規化され「昼食」1件のみになる', () => {
    const db = openDb(':memory:');
    const ids = addCoRecordEntries(db, DAY, {
      startAt: jst(12, 0),
      endAt: jst(14, 0),
      categories: ['昼食', '昼食', '   ', ''],
    });
    expect(ids.length).toBe(1);
    const rows = manualRows(db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.category_key).toBe('昼食');
    expect(rows[0]!.n).toBe(1); // 正規化後1件 → 単独扱い。
    expect(rows[0]!.co_record_group_id).toBeNull();
  });

  it('途中失敗では部分的なエントリを1件も残さない（原子性）', () => {
    const db = openDb(':memory:');
    // 2件目の挿入で必ず ABORT するトリガを仕込む（「爆弾」カテゴリ）。
    db.prepare(
      `CREATE TRIGGER trg_boom BEFORE INSERT ON activity_log_entry
       FOR EACH ROW WHEN NEW.category_key = '爆弾'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    ).run();
    expect(() =>
      addCoRecordEntries(db, DAY, {
        startAt: jst(12, 0),
        endAt: jst(14, 0),
        categories: ['昼食', '爆弾'],
      }),
    ).toThrow();
    // 先に挿入された「昼食」も rollback され、行は残らない。
    expect(manualRows(db).length).toBe(0);
  });
});

describe('deleteEntry 同時記録の削除と再按分', () => {
  it('2→1 で残メンバーが単独へ戻り持ち分が区間長になる', () => {
    const db = openDb(':memory:');
    const ids = addCoRecordEntries(db, DAY, {
      startAt: jst(12, 0),
      endAt: jst(14, 0),
      categories: ['昼食', '洗濯'],
    });
    // 「洗濯」を削除。
    const washingId = (manualRows(db).find((r) => r.category_key === '洗濯')!).id;
    expect(deleteEntry(db, washingId)).toBe(true);

    const rows = manualRows(db);
    expect(rows.length).toBe(1);
    const lunch = rows[0]!;
    expect(lunch.category_key).toBe('昼食');
    // 構成数1へ再按分: n=1・グループ解消。
    expect(lunch.n).toBe(1);
    expect(lunch.co_record_group_id).toBeNull();

    // タイムライン payload の持ち分は区間長(2時間 = 7200秒)そのままへ戻る。
    const tl = getTimeline(db, DAY, jst(14, 0));
    const m = tl.manual.find((x) => x.categoryKey === '昼食')!;
    expect(m.n).toBe(1);
    expect(m.creditedSeconds).toBe(7200);
    void ids;
  });

  it('3→2 で残メンバーの n が2へ更新される', () => {
    const db = openDb(':memory:');
    addCoRecordEntries(db, DAY, {
      startAt: jst(12, 0),
      endAt: jst(15, 0),
      categories: ['昼食', '洗濯', '掃除'],
    });
    const cleaning = manualRows(db).find((r) => r.category_key === '掃除')!;
    deleteEntry(db, cleaning.id);
    const rows = manualRows(db);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.n).toBe(2);
      expect(r.co_record_group_id).not.toBeNull();
    }
  });
});

describe('getTimeline 同時記録の payload（並列表示の素地）', () => {
  it('同時記録メンバーは同一 start/end・同一グループ ID・持ち分＝区間長÷N', () => {
    const db = openDb(':memory:');
    addCoRecordEntries(db, DAY, {
      startAt: jst(12, 0),
      endAt: jst(14, 0),
      categories: ['昼食', '洗濯'],
    });
    const tl = getTimeline(db, DAY, jst(14, 0));
    expect(tl.manual.length).toBe(2);
    const [a, b] = tl.manual;
    // 区間全体を共有 → クライアントの列分割 layout() が並列列へ配置する。
    expect(a!.startAt).toBe(b!.startAt);
    expect(a!.endAt).toBe(b!.endAt);
    expect(a!.coRecordGroupId).toBe(b!.coRecordGroupId);
    expect(a!.coRecordGroupId).not.toBeNull();
    // 各持ち分 = 2時間 ÷ 2 = 1時間。
    expect(a!.creditedSeconds).toBe(3600);
    expect(b!.creditedSeconds).toBe(3600);
  });
});
