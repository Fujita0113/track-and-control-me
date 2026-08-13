import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import {
  createEntry,
  listEntries,
  suggestNames,
  updateEntry,
  createBulkEntry,
  isSpecialEntry,
  isKakeiboRecorded,
  declareZeroDay,
  KakeiboError,
} from './kakeibo.js';
import { resolvePlanningSignal } from './planning.js';

/**
 * 家計簿の台帳（spec: kakeibo-ledger / kakeibo-gate）。
 *
 * 期待値は ref/kakeibo/kakeibo-mock.html の筋書き（2026-08-11 時点）を凍結したもの。
 * 支出レコードは日数を持たない（design D1・D2）。予想の調整弁は「特別費」だけ（design D3）。
 */

const TODAY = '2026-08-11';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

/** モックの8月の変動費をそのまま流し込む（固定費・予算は別テストで扱う）。合計 22,650。 */
function seedAugust(target: DB): void {
  createEntry(target, { dayKey: '2026-08-01', name: '業務スーパー', amountYen: 4200, category: 'FOOD', importance: 'MUST' });
  createEntry(target, { dayKey: '2026-08-02', name: 'ドラッグストア', amountYen: 1850, category: 'DAILY', importance: 'MUST' });
  createBulkEntry(target, { fromDayKey: '2026-08-02', toDayKey: '2026-08-05', amountYen: 3400 });
  createEntry(target, { dayKey: '2026-08-06', name: '業務スーパー', amountYen: 2600, category: 'FOOD', importance: 'MUST' });
  createEntry(target, { dayKey: '2026-08-07', name: 'Steam サマーセール', amountYen: 3480, category: 'FUN', importance: 'WASTE', detail: 'Hollow Knight 1,480\nFactorio 1,500\nCeleste 500' });
  createEntry(target, { dayKey: '2026-08-08', name: 'コンビニ', amountYen: 820, category: 'FOOD', importance: 'WASTE' });
  createEntry(target, { dayKey: '2026-08-09', name: '一蘭（外食）', amountYen: 1100, category: 'FOOD', importance: 'SEMI', detail: 'ラーメン・替え玉' });
  createEntry(target, { dayKey: '2026-08-09', name: '歯医者', amountYen: 3300, category: 'SUDDEN', importance: 'MUST' });
  createEntry(target, { dayKey: '2026-08-10', name: 'ドラッグストア', amountYen: 1280, category: 'DAILY', importance: 'SEMI' });
  createEntry(target, { dayKey: '2026-08-11', name: 'コンビニ', amountYen: 620, category: 'FOOD', importance: 'WASTE', detail: 'おにぎり2個・お茶' });
}

describe('支出レコードの作成と検証（kakeibo-ledger）', () => {
  it('項目一式を保存する。日数の列は持たない', () => {
    const e = createEntry(db, { dayKey: TODAY, name: 'コンビニ', amountYen: 620, category: 'FOOD', importance: 'WASTE' });
    expect(e.amount_yen).toBe(620);
    expect(e.category).toBe('FOOD');
    expect(e.importance).toBe('WASTE');
    expect(e.day_key).toBe(TODAY);
    // 予想は日々の出費の平均単価ひとつで出すので、レコードは日数を持たない（design D2）。
    expect(e).not.toHaveProperty('planned_days');
    expect(e).not.toHaveProperty('actual_days');
    expect(e).not.toHaveProperty('covers_from');
  });

  it('特別費の既定は「通常の出費」', () => {
    const e = createEntry(db, { dayKey: TODAY, name: 'コンビニ', amountYen: 620, category: 'FOOD', importance: 'WASTE' });
    expect(e.is_special).toBe(0);
  });

  it('内訳は任意で、既定は未入力', () => {
    const e = createEntry(db, { dayKey: TODAY, name: 'コンビニ', amountYen: 620, category: 'FOOD', importance: 'WASTE' });
    expect(e.detail).toBeNull();
    const withDetail = createEntry(db, { dayKey: TODAY, name: '一蘭', amountYen: 1100, category: 'FOOD', importance: 'SEMI', detail: 'ラーメン・替え玉' });
    expect(withDetail.detail).toBe('ラーメン・替え玉');
  });

  it('金額は正の整数だけ受け付ける', () => {
    const bad = { dayKey: TODAY, name: 'x', category: 'FOOD', importance: 'MUST' } as const;
    expect(() => createEntry(db, { ...bad, amountYen: 0 })).toThrow(KakeiboError);
    expect(() => createEntry(db, { ...bad, amountYen: -100 })).toThrow(KakeiboError);
    expect(() => createEntry(db, { ...bad, amountYen: 12.5 })).toThrow(KakeiboError);
  });

  it('未知のカテゴリ・重要度を拒否する', () => {
    const base = { dayKey: TODAY, name: 'x', amountYen: 100 } as const;
    expect(() => createEntry(db, { ...base, category: 'TRAVEL', importance: 'MUST' })).toThrow(KakeiboError);
    expect(() => createEntry(db, { ...base, category: 'FOOD', importance: 'NICE' })).toThrow(KakeiboError);
  });

  // issue #102: 記録し忘れた過去の出費を通常の記録として入れられるようにする。
  it('任意の過去日で記録できる（登録し忘れの後追い）', () => {
    const e = createEntry(db, { dayKey: '2020-01-01', name: '昔の出費', amountYen: 500, category: 'FOOD', importance: 'MUST' });
    expect(e.day_key).toBe('2020-01-01');
  });

  it('未来日は拒否する', () => {
    const bad = { dayKey: '2099-12-31', name: '未来の出費', amountYen: 500, category: 'FOOD', importance: 'MUST' } as const;
    expect(() => createEntry(db, bad)).toThrow(KakeiboError);
  });
});

describe('特別費の判定（kakeibo-forecast の母数・design D3）', () => {
  it('カテゴリが「急な出費」なら自動で特別費になる', () => {
    const e = createEntry(db, { dayKey: TODAY, name: '歯医者', amountYen: 3300, category: 'SUDDEN', importance: 'MUST' });
    expect(e.is_special).toBe(0); // 手動フラグは立てない
    expect(isSpecialEntry(e)).toBe(true); // 実効の判定は自動で真
  });

  it('手で特別費にできる', () => {
    const e = createEntry(db, { dayKey: '2026-08-07', name: 'Steam サマーセール', amountYen: 3480, category: 'FUN', importance: 'WASTE' });
    expect(isSpecialEntry(e)).toBe(false);
    const after = updateEntry(db, e.id, { isSpecial: true });
    expect(after.is_special).toBe(1);
    expect(isSpecialEntry(after)).toBe(true);
  });

  it('手のフラグを外せば通常の出費に戻る', () => {
    const e = createEntry(db, { dayKey: '2026-08-07', name: 'Steam', amountYen: 3480, category: 'FUN', importance: 'WASTE', isSpecial: true });
    expect(isSpecialEntry(e)).toBe(true);
    expect(isSpecialEntry(updateEntry(db, e.id, { isSpecial: false }))).toBe(false);
  });

  it('カテゴリを急な出費から変えると、自動の除外も外れる（保存していないので追随する）', () => {
    const e = createEntry(db, { dayKey: TODAY, name: '謎の出費', amountYen: 3300, category: 'SUDDEN', importance: 'MUST' });
    expect(isSpecialEntry(e)).toBe(true);
    expect(isSpecialEntry(updateEntry(db, e.id, { category: 'FOOD' }))).toBe(false);
  });

  it('まとめ登録は通常の出費（日々の出費の母数に入る・design D9）', () => {
    const b = createBulkEntry(db, { fromDayKey: '2026-08-02', toDayKey: '2026-08-05', amountYen: 3400 });
    expect(isSpecialEntry(b)).toBe(false);
  });
});

describe('一覧・サジェスト・後追い修正（kakeibo-ledger）', () => {
  beforeEach(() => seedAugust(db));

  it('その月だけを買った日の新しい順で返す', () => {
    createEntry(db, { dayKey: '2026-07-30', name: '先月', amountYen: 500, category: 'FOOD', importance: 'MUST' });
    const rows = listEntries(db, '2026-08');
    expect(rows).toHaveLength(10);
    expect(rows[0]!.day_key).toBe('2026-08-11');
    expect(rows.at(-1)!.day_key).toBe('2026-08-01');
    expect(rows.some((r) => r.name === '先月')).toBe(false);
  });

  it('月の変動費の合計はモックどおり 22,650', () => {
    expect(listEntries(db, '2026-08').reduce((a, r) => a + r.amount_yen, 0)).toBe(22_650);
  });

  it('名称は直近使用順・部分一致でサジェストされ、空名称は出ない', () => {
    expect(suggestNames(db, '業務')).toEqual(['業務スーパー']);
    expect(suggestNames(db, 'ドラッグ')).toEqual(['ドラッグストア']);
    expect(suggestNames(db, '')).not.toContain('');
    // コンビニ(8/11) のほうが 一蘭(8/09) より新しい。
    const all = suggestNames(db, '');
    expect(all.indexOf('コンビニ')).toBeLessThan(all.indexOf('一蘭（外食）'));
  });

  it('金額・カテゴリ・重要度・内訳を後から直せる', () => {
    const id = listEntries(db, '2026-08').find((r) => r.name === 'コンビニ')!.id;
    const after = updateEntry(db, id, { amountYen: 700, importance: 'SEMI', detail: 'お茶だけ' });
    expect(after.amount_yen).toBe(700);
    expect(after.importance).toBe('SEMI');
    expect(after.detail).toBe('お茶だけ');
  });

  it('内訳を後から書き足せる', () => {
    const row = listEntries(db, '2026-08').find((r) => r.name === 'ドラッグストア')!;
    expect(row.detail).toBeNull();
    expect(updateEntry(db, row.id, { detail: '洗剤・ティッシュ' }).detail).toBe('洗剤・ティッシュ');
  });
});

describe('未記録期間の一括入力（kakeibo-ledger）', () => {
  it('名称なし・重要度なしで1件になる', () => {
    const b = createBulkEntry(db, { fromDayKey: '2026-08-02', toDayKey: '2026-08-05', amountYen: 3400 });
    expect(b.name).toBe('');
    expect(b.importance).toBeNull();
    expect(b.category).toBe('NONE');
    expect(b.bulk_from).toBe('2026-08-02');
    expect(b.bulk_to).toBe('2026-08-05');
    expect(b.day_key).toBe('2026-08-02');
  });

  it('期間が逆転していたら拒否する', () => {
    expect(() => createBulkEntry(db, { fromDayKey: '2026-08-05', toDayKey: '2026-08-02', amountYen: 3400 })).toThrow(KakeiboError);
  });

  it('月の合計に入る', () => {
    createBulkEntry(db, { fromDayKey: '2026-08-02', toDayKey: '2026-08-05', amountYen: 3400 });
    expect(listEntries(db, '2026-08').reduce((a, r) => a + r.amount_yen, 0)).toBe(3400);
  });
});

describe('解錠ゲートのシグナル（kakeibo-gate）', () => {
  it('その日の記録が1件でもあれば真', () => {
    expect(isKakeiboRecorded(db, TODAY)).toBe(false);
    createEntry(db, { dayKey: TODAY, name: 'コンビニ', amountYen: 620, category: 'FOOD', importance: 'WASTE' });
    expect(isKakeiboRecorded(db, TODAY)).toBe(true);
  });

  it('0円宣言でも真になり、台帳には何も増えない', () => {
    declareZeroDay(db, TODAY);
    expect(isKakeiboRecorded(db, TODAY)).toBe(true);
    expect(listEntries(db, '2026-08')).toHaveLength(0);
  });

  it('0円宣言は重複しても壊れない', () => {
    declareZeroDay(db, TODAY);
    declareZeroDay(db, TODAY);
    expect(isKakeiboRecorded(db, TODAY)).toBe(true);
  });

  it('日をまたぐと独立している', () => {
    declareZeroDay(db, TODAY);
    expect(isKakeiboRecorded(db, '2026-08-12')).toBe(false);
  });

  it('PLANNING シグナルとして解決できる', () => {
    expect(resolvePlanningSignal(db, TODAY, 'kakeibo_recorded')).toBe(false);
    createEntry(db, { dayKey: TODAY, name: 'コンビニ', amountYen: 620, category: 'FOOD', importance: 'WASTE' });
    expect(resolvePlanningSignal(db, TODAY, 'kakeibo_recorded')).toBe(true);
  });
});
