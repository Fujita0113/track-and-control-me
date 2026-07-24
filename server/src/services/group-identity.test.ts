import { describe, it, expect } from 'vitest';
import { UNGROUPED_KEY } from '@track/contract';
import { openDb, type DB } from '../db/index.js';
import {
  resolveIdentity,
  getIdentity,
  listAliases,
  renameIdentity,
  listRecentGroupIdentities,
} from './group-identity.js';

function db(): DB {
  return openDb(':memory:');
}

describe('resolveIdentity', () => {
  it('同名同色は同一 identity へ解決される', () => {
    const d = db();
    const a = resolveIdentity(d, '振り返り', 'purple');
    const b = resolveIdentity(d, '振り返り', 'purple');
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it('別名色は別 identity へ解決される', () => {
    const d = db();
    const a = resolveIdentity(d, '競技プログラミング', 'yellow');
    const b = resolveIdentity(d, '面接', 'grey');
    expect(a).not.toBe(b);
  });

  it('空名は identity を作らない', () => {
    const d = db();
    expect(resolveIdentity(d, '', 'blue')).toBeNull();
  });

  it('未グループ（UNGROUPED_KEY）は identity を作らない', () => {
    const d = db();
    expect(resolveIdentity(d, 'ungrouped', null, UNGROUPED_KEY)).toBeNull();
  });

  it('新規 (name,color) は identity 本体・別名がともに作られる', () => {
    const d = db();
    const id = resolveIdentity(d, '開発', 'blue')!;
    const row = getIdentity(d, id)!;
    expect(row.name).toBe('開発');
    expect(row.color).toBe('blue');
    const aliases = listAliases(d, id);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({ name: '開発', color: 'blue' });
  });
});

describe('renameIdentity', () => {
  it('改名後も過去の名前が別名として残り、同一 identity へ解決される', () => {
    const d = db();
    const before = resolveIdentity(d, '競技プログラミング', 'yellow')!;
    const after = renameIdentity(d, { name: '競技プログラミング', color: 'yellow' }, { name: '競プロ', color: 'yellow' });
    expect(after).toBe(before);
    const row = getIdentity(d, before)!;
    expect(row.name).toBe('競プロ');
    // 旧名でも同じ identity へ解決される（別名が保持されている）。
    expect(resolveIdentity(d, '競技プログラミング', 'yellow')).toBe(before);
  });

  it('既存の名前へ改名すると統合される', () => {
    const d = db();
    const devId = resolveIdentity(d, '開発', 'blue')!;
    const enId = resolveIdentity(d, '英語', 'blue')!;
    const merged = renameIdentity(d, { name: '開発', color: 'blue' }, { name: '英語', color: 'blue' });
    // created_at が古い方（先に作られた devId）が残る。
    expect(merged).toBe(devId);
    expect(resolveIdentity(d, '開発', 'blue')).toBe(devId);
    expect(resolveIdentity(d, '英語', 'blue')).toBe(devId);
    expect(getIdentity(d, enId)).toBeUndefined();
  });
});

describe('listRecentGroupIdentities', () => {
  const TZ = 'Asia/Tokyo';

  function seedSession(d: DB, name: string, color: string, dayKey: string, ms: number): void {
    resolveIdentity(d, name, color); // recompute.ts 相当: セッション確定時に identity を解決する。
    d.prepare(
      `INSERT INTO session
        (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
         started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
       VALUES ('sg', ?, ?, NULL, 0, ?, ?, '[]', 1, ?, 'NORMAL', 0)`,
    ).run(name, color, ms, dayKey, ms);
  }

  it('実測順（合計時間降順）に候補が並ぶ', () => {
    const d = db();
    d.prepare("UPDATE app_config SET tz = ? WHERE id = 1").run(TZ);
    seedSession(d, '開発', 'blue', '2026-07-20', 12 * 3600 * 1000);
    seedSession(d, '英語', 'blue', '2026-07-20', 5 * 3600 * 1000);
    seedSession(d, '面接', 'grey', '2026-07-20', 2 * 3600 * 1000);
    const list = listRecentGroupIdentities(d, 30, Date.parse('2026-07-23T12:00:00+09:00'));
    expect(list.map((g) => g.name)).toEqual(['開発', '英語', '面接']);
  });

  it('入力途中の断片（60秒未満）は候補に出ない', () => {
    const d = db();
    d.prepare("UPDATE app_config SET tz = ? WHERE id = 1").run(TZ);
    seedSession(d, 'せっけ', 'pink', '2026-07-20', 3000);
    const list = listRecentGroupIdentities(d, 30, Date.parse('2026-07-23T12:00:00+09:00'));
    expect(list.map((g) => g.name)).not.toContain('せっけ');
  });
});
