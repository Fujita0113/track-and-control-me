import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { listManualCategories, recordCategoryUse } from './manual-categories.js';
import { addManualEntry } from './timeline.js';

/**
 * spec: manual-category-registry。
 * 既定シードの並び・記録による upsert（新規登録／再使用の浮上）・空白名の非登録を担保する。
 * カテゴリは表示ラベルにすぎず、集計・ルール層へ波及しないことは依存の不在で保証する。
 */

const SEED_ORDER = ['昼食', '休憩', '移動', '仮眠', '運動', '雑務', 'その他'];
const DAY = '2026-07-06';

function fresh(): DB {
  return openDb(':memory:');
}

describe('manual-category-registry: 既定シード', () => {
  it('初期状態では既定7語がシード順で並ぶ', () => {
    const db = fresh();
    const names = listManualCategories(db).map((c) => c.name);
    expect(names).toEqual(SEED_ORDER);
  });
});

describe('manual-category-registry: recordCategoryUse（upsert）', () => {
  it('新規カテゴリが登録され直近使用として先頭に来る', () => {
    const db = fresh();
    recordCategoryUse(db, '通院', 1000);
    const list = listManualCategories(db);
    expect(list[0]).toMatchObject({ name: '通院', useCount: 1, lastUsedAt: 1000 });
  });

  it('既存カテゴリの再使用で last_used_at が更新され前方へ浮上する', () => {
    const db = fresh();
    // 昼食（シード, last_used_at=0）を後の時刻で使用 → 先頭へ、use_count は 1。
    recordCategoryUse(db, '昼食', 5000);
    const list = listManualCategories(db);
    expect(list[0]).toMatchObject({ name: '昼食', useCount: 1, lastUsedAt: 5000 });
    // もう一度使うと last_used_at が進み use_count が加算される。
    recordCategoryUse(db, '昼食', 9000);
    const again = listManualCategories(db).find((c) => c.name === '昼食');
    expect(again?.useCount).toBe(2);
    expect(again?.lastUsedAt).toBe(9000);
  });

  it('前後空白を除いて空になる名前は登録しない', () => {
    const db = fresh();
    const before = listManualCategories(db).length;
    recordCategoryUse(db, '   ', 1000);
    recordCategoryUse(db, '', 1000);
    expect(listManualCategories(db).length).toBe(before);
  });

  it('前後空白は trim して登録される', () => {
    const db = fresh();
    recordCategoryUse(db, '  買い物  ', 1000);
    expect(listManualCategories(db).some((c) => c.name === '買い物')).toBe(true);
    expect(listManualCategories(db).some((c) => c.name === '  買い物  ')).toBe(false);
  });
});

describe('manual-category-registry: addManualEntry 経由の使用登録', () => {
  it('記録で新規カテゴリが登録され listManualCategories の先頭に来る', () => {
    const db = fresh();
    addManualEntry(db, DAY, { startAt: 1, endAt: 2, title: '買い物', category: '買い物' });
    expect(listManualCategories(db)[0]?.name).toBe('買い物');
  });

  it('空白のみのカテゴリで記録してもレジストリは増えない', () => {
    const db = fresh();
    const before = listManualCategories(db).length;
    addManualEntry(db, DAY, { startAt: 1, endAt: 2, title: '離席', category: '   ' });
    expect(listManualCategories(db).length).toBe(before);
  });
});
