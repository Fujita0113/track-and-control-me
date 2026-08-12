import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { createEntry, createBulkEntry } from './kakeibo.js';
import { importanceBreakdown, categoryTree } from './kakeibo-analysis.js';

/**
 * 分析（spec: kakeibo-analysis）。
 * 期待値は ref/kakeibo/kakeibo-mock.html の 2026-08。変動費 22,650 に対して
 * 必須 11,950(53%) / 準必須 2,380(10%) / 無駄遣い 4,920(22%) / 内訳未入力 3,400(15%)。
 * 割合は四捨五入・`%` は一段上に対する割合（design D6 / spec: kakeibo-analysis）。
 */

const MONTH = '2026-08';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  createEntry(db, { dayKey: '2026-08-01', name: '業務スーパー', amountYen: 4_200, category: 'FOOD', importance: 'MUST' });
  createEntry(db, { dayKey: '2026-08-06', name: '業務スーパー', amountYen: 2_600, category: 'FOOD', importance: 'MUST' });
  createEntry(db, { dayKey: '2026-08-08', name: 'コンビニ', amountYen: 820, category: 'FOOD', importance: 'WASTE' });
  createEntry(db, { dayKey: '2026-08-11', name: 'コンビニ', amountYen: 620, category: 'FOOD', importance: 'WASTE', detail: 'おにぎり2個・お茶' });
  createEntry(db, { dayKey: '2026-08-09', name: '一蘭（外食）', amountYen: 1_100, category: 'FOOD', importance: 'SEMI', detail: 'ラーメン・替え玉' });
  createEntry(db, { dayKey: '2026-08-02', name: 'ドラッグストア', amountYen: 1_850, category: 'DAILY', importance: 'MUST' });
  createEntry(db, { dayKey: '2026-08-10', name: 'ドラッグストア', amountYen: 1_280, category: 'DAILY', importance: 'SEMI' });
  createEntry(db, { dayKey: '2026-08-07', name: 'Steam サマーセール', amountYen: 3_480, category: 'FUN', importance: 'WASTE', detail: 'Hollow Knight・Factorio ほか' });
  createEntry(db, { dayKey: '2026-08-09', name: '歯医者', amountYen: 3_300, category: 'SUDDEN', importance: 'MUST' });
  createBulkEntry(db, { fromDayKey: '2026-08-02', toDayKey: '2026-08-05', amountYen: 3_400 });
});

describe('重要度の帯（kakeibo-analysis）', () => {
  it('4区画の金額と割合がモックどおり', () => {
    const b = importanceBreakdown(db, MONTH);
    expect(b.totalYen).toBe(22_650);
    expect(b.must).toMatchObject({ amountYen: 11_950, pct: 53 });
    expect(b.semi).toMatchObject({ amountYen: 2_380, pct: 10 });
    expect(b.waste).toMatchObject({ amountYen: 4_920, pct: 22 });
    expect(b.noDetail).toMatchObject({ amountYen: 3_400, pct: 15 });
  });

  it('内訳未入力は他の3区画に混ざらない', () => {
    const b = importanceBreakdown(db, MONTH);
    expect(b.must.amountYen + b.semi.amountYen + b.waste.amountYen).toBe(19_250);
    expect(b.must.amountYen + b.semi.amountYen + b.waste.amountYen + b.noDetail.amountYen).toBe(b.totalYen);
  });

  it('特別費（急な出費）も重要度の帯には入る', () => {
    // 予想の母数からは外れるが、実績の分析からは外れない（design D3）。
    expect(importanceBreakdown(db, MONTH).must.amountYen).toBe(11_950); // 4,200 + 2,600 + 1,850 + 3,300
  });

  it('支出が1件も無い月でも例外にならず 0 を返す', () => {
    const b = importanceBreakdown(db, '2026-09');
    expect(b.totalYen).toBe(0);
    expect(b.must.pct).toBe(0);
  });
});

describe('カテゴリ → 名称 → 明細（kakeibo-analysis）', () => {
  it('カテゴリの金額と、変動費に対する割合', () => {
    const tree = categoryTree(db, MONTH);
    const food = tree.find((c) => c.category === 'FOOD')!;
    expect(food.amountYen).toBe(9_340);
    expect(food.pct).toBe(41); // 9340 / 22650 = 41.2%
    expect(tree.find((c) => c.category === 'DAILY')!).toMatchObject({ amountYen: 3_130, pct: 14 });
    expect(tree.find((c) => c.category === 'FUN')!).toMatchObject({ amountYen: 3_480, pct: 15 });
    expect(tree.find((c) => c.category === 'SUDDEN')!).toMatchObject({ amountYen: 3_300, pct: 15 });
    expect(tree.find((c) => c.category === 'NONE')!).toMatchObject({ amountYen: 3_400, pct: 15 });
  });

  it('名称の % は一段上（カテゴリ）に対する割合', () => {
    const food = categoryTree(db, MONTH).find((c) => c.category === 'FOOD')!;
    expect(food.names.find((n) => n.name === '業務スーパー')!).toMatchObject({ amountYen: 6_800, pct: 73 });
    expect(food.names.find((n) => n.name === 'コンビニ')!).toMatchObject({ amountYen: 1_440, pct: 15 });
    expect(food.names.find((n) => n.name === '一蘭（外食）')!).toMatchObject({ amountYen: 1_100, pct: 12 });
  });

  it('名称は完全一致でまとめ、金額の大きい順に並ぶ', () => {
    const food = categoryTree(db, MONTH).find((c) => c.category === 'FOOD')!;
    expect(food.names.map((n) => n.name)).toEqual(['業務スーパー', 'コンビニ', '一蘭（外食）']);
  });

  it('明細は日付の新しい順', () => {
    const food = categoryTree(db, MONTH).find((c) => c.category === 'FOOD')!;
    const gyosu = food.names.find((n) => n.name === '業務スーパー')!;
    expect(gyosu.entries.map((e) => e.day_key)).toEqual(['2026-08-06', '2026-08-01']);
  });

  it('明細は内訳とレシートの有無を持つ（押せるかどうかの判定に使う）', () => {
    const food = categoryTree(db, MONTH).find((c) => c.category === 'FOOD')!;
    const conv = food.names.find((n) => n.name === 'コンビニ')!;
    const withDetail = conv.entries.find((e) => e.day_key === '2026-08-11')!;
    const without = conv.entries.find((e) => e.day_key === '2026-08-08')!;
    expect(withDetail).toMatchObject({ has_detail: true, has_receipt: false });
    expect(without).toMatchObject({ has_detail: false, has_receipt: false });
  });

  it('まとめ登録は「名称なし」の1行で、明細は元の1件だけ', () => {
    const none = categoryTree(db, MONTH).find((c) => c.category === 'NONE')!;
    expect(none.names).toHaveLength(1);
    expect(none.names[0]!.name).toBe('');
    expect(none.names[0]!.entries).toHaveLength(1);
    expect(none.names[0]!.entries[0]!.importance).toBeNull();
    expect(none.names[0]!.entries[0]!.has_detail).toBe(false);
  });

  it('棒の長さの基準は全段で同じ（カテゴリの合計＝変動費）', () => {
    const tree = categoryTree(db, MONTH);
    expect(tree.reduce((a, c) => a + c.amountYen, 0)).toBe(22_650);
    // 名称の合計はカテゴリの金額に一致する（取りこぼしが無い）。
    for (const c of tree) {
      expect(c.names.reduce((a, n) => a + n.amountYen, 0)).toBe(c.amountYen);
    }
  });
});
