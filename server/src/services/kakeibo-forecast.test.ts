import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { createEntry, createBulkEntry, listEntries, updateEntry } from './kakeibo.js';
import { setBudget, upsertFixedCost, upsertPlannedExpense } from './kakeibo-budget.js';
import {
  forecastMonth,
  listAdjustRows,
  weeklyRemaining,
  wasteSummary,
  wasteReductionEffect,
} from './kakeibo-forecast.js';

/**
 * 月末予想（spec: kakeibo-forecast・design D2・D3・D4・D5・D6）。
 *
 * 予想は「日々の出費 ÷ 経過日数 × 残り日数」の一本だけ。名称ごとの周期は持たない。
 * 期待値は ref/kakeibo/kakeibo-mock.html の筋書き（design.md「数字の筋書き」）を凍結したもの:
 *   実績 40,030 / 計算対象 19,350 / 1日平均 1,759 / 月末 77,010 / 超過日 8/23
 */

const MONTH = '2026-08';
const TODAY = '2026-08-11';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  // 変動費 22,650（モックの8月）
  createEntry(db, { dayKey: '2026-08-01', name: '業務スーパー', amountYen: 4200, category: 'FOOD', importance: 'MUST' });
  createEntry(db, { dayKey: '2026-08-02', name: 'ドラッグストア', amountYen: 1850, category: 'DAILY', importance: 'MUST' });
  createBulkEntry(db, { fromDayKey: '2026-08-02', toDayKey: '2026-08-05', amountYen: 3400 });
  createEntry(db, { dayKey: '2026-08-06', name: '業務スーパー', amountYen: 2600, category: 'FOOD', importance: 'MUST' });
  createEntry(db, { dayKey: '2026-08-07', name: 'Steam サマーセール', amountYen: 3480, category: 'FUN', importance: 'WASTE' });
  createEntry(db, { dayKey: '2026-08-08', name: 'コンビニ', amountYen: 820, category: 'FOOD', importance: 'WASTE' });
  createEntry(db, { dayKey: '2026-08-09', name: '一蘭（外食）', amountYen: 1100, category: 'FOOD', importance: 'SEMI' });
  createEntry(db, { dayKey: '2026-08-09', name: '歯医者', amountYen: 3300, category: 'SUDDEN', importance: 'MUST' });
  createEntry(db, { dayKey: '2026-08-10', name: 'ドラッグストア', amountYen: 1280, category: 'DAILY', importance: 'SEMI' });
  createEntry(db, { dayKey: '2026-08-11', name: 'コンビニ', amountYen: 620, category: 'FOOD', importance: 'WASTE' });
  // 予算・固定費・予定出費
  setBudget(db, MONTH, { capYen: 62_000, wasteCapYen: 4_000 });
  upsertFixedCost(db, MONTH, { name: '電気代', amountYen: 8_500 });
  upsertFixedCost(db, MONTH, { name: 'ガス代', amountYen: 3_000 });
  upsertFixedCost(db, MONTH, { name: '通信費', amountYen: 4_400 });
  upsertFixedCost(db, MONTH, { name: 'サブスク', amountYen: 1_480 });
  upsertPlannedExpense(db, { name: '床屋', category: 'SUDDEN', cycleDays: 30, nextDayKey: '2026-08-20', amountYen: 1_800 });
});

const idOf = (name: string, dayKey: string): number =>
  listEntries(db, MONTH).find((r) => r.name === name && r.day_key === dayKey)!.id;

describe('1日平均は日々の出費を経過日数で割る（design D2）', () => {
  it('急な出費を母数から外したうえで、切り捨てた1日平均を出す', () => {
    const f = forecastMonth(db, MONTH, TODAY);
    expect(f.variableActualYen).toBe(22_650);
    expect(f.specialYen).toBe(3_300); // 歯医者（カテゴリ = 急な出費）
    expect(f.dailyPoolYen).toBe(19_350);
    expect(f.elapsedDays).toBe(11); // 今日を含む
    expect(f.dailyAverageYen).toBe(1_759); // floor(19350 / 11) = 1759.09… → 1759
  });

  it('先に切り捨ててから残り日数を掛ける（design D6）', () => {
    const f = forecastMonth(db, MONTH, TODAY);
    expect(f.remainingDays).toBe(20); // 8/12 – 8/31
    expect(f.forecastYen).toBe(35_180); // 1759 × 20。35,181（先に掛ける）ではない
  });

  it('カテゴリや買い方で母数を分けない', () => {
    // まとめ登録も、まとめ買いも、コンビニも、同じ母数に入る。
    const f = forecastMonth(db, MONTH, TODAY);
    expect(f.dailyPoolYen).toBe(4200 + 1850 + 3400 + 2600 + 3480 + 820 + 1100 + 1280 + 620);
  });

  it('月の日数を使う（30 固定ではない）', () => {
    const feb = openDb(':memory:');
    createEntry(feb, { dayKey: '2026-02-01', name: 'x', amountYen: 2_800, category: 'FOOD', importance: 'MUST' });
    setBudget(feb, '2026-02', { capYen: 100_000, wasteCapYen: 4_000 });
    const f = forecastMonth(feb, '2026-02', '2026-02-14');
    expect(f.elapsedDays).toBe(14);
    expect(f.remainingDays).toBe(14); // 2026年2月は28日
  });
});

describe('月末予想と上限超過日（design D5）', () => {
  it('モックの筋書きどおりに着地する', () => {
    const f = forecastMonth(db, MONTH, TODAY);
    expect(f.fixedYen).toBe(17_380);
    expect(f.actualYen).toBe(40_030); // 固定費 + 変動費（特別費を含む）
    expect(f.plannedYen).toBe(1_800); // 床屋 8/20
    expect(f.landingYen).toBe(77_010); // 40,030 + 35,180 + 1,800
    expect(f.capYen).toBe(62_000);
    expect(f.overYen).toBe(15_010);
  });

  it('上限を初めて超える日は 8/23', () => {
    expect(forecastMonth(db, MONTH, TODAY).crossDayKey).toBe('2026-08-23');
  });

  it('series は月の日数ぶんあり、末尾が月末予想に一致する', () => {
    const f = forecastMonth(db, MONTH, TODAY);
    expect(f.series).toHaveLength(31);
    expect(f.series[0]!.dayKey).toBe('2026-08-01');
    expect(f.series.at(-1)!.cumulativeYen).toBe(77_010);
    expect(f.series[10]!.kind).toBe('ACTUAL'); // 8/11 = 今日
    expect(f.series[10]!.cumulativeYen).toBe(40_030);
    expect(f.series[11]!.kind).toBe('FORECAST');
  });

  it('予定出費は予想の段として乗る', () => {
    const f = forecastMonth(db, MONTH, TODAY);
    const d19 = f.series[18]!; // 8/19
    const d20 = f.series[19]!; // 8/20
    expect(d20.plannedYen).toBe(1_800);
    expect(d20.cumulativeYen - d19.cumulativeYen).toBe(1_759 + 1_800);
  });

  it('上限内なら crossDayKey は null', () => {
    setBudget(db, MONTH, { capYen: 100_000, wasteCapYen: 4_000 });
    const f = forecastMonth(db, MONTH, TODAY);
    expect(f.overYen).toBe(0);
    expect(f.crossDayKey).toBeNull();
  });
});

describe('特別費（design D3）', () => {
  it('特別費は実績に残り、母数からだけ抜ける', () => {
    const before = forecastMonth(db, MONTH, TODAY);
    updateEntry(db, idOf('Steam サマーセール', '2026-08-07'), { isSpecial: true });
    const after = forecastMonth(db, MONTH, TODAY);

    expect(after.variableActualYen).toBe(22_650); // 実績は変わらない
    expect(after.actualYen).toBe(40_030);
    expect(after.dailyPoolYen).toBe(15_870); // 19,350 − 3,480
    expect(after.dailyAverageYen).toBe(1_442); // floor(15870 / 11)
    expect(after.landingYen).toBe(70_670);
    expect(after.overYen).toBe(8_670);
    expect(after.crossDayKey).toBe('2026-08-25');
    expect(before.landingYen).toBeGreaterThan(after.landingYen);
  });

  it('特別費は残り日へ引き伸ばさない（実績としてちょうど1回だけ数える）', () => {
    const f = forecastMonth(db, MONTH, TODAY);
    // 歯医者 3,300 は actual に入り、forecast には 1 円も寄与しない。
    expect(f.actualYen - f.fixedYen).toBe(22_650);
    expect(f.forecastYen).toBe(f.dailyAverageYen * f.remainingDays);
  });

  it('overrides で保存せずに出し直せる（調整モーダルのプレビュー）', () => {
    const preview = forecastMonth(db, MONTH, TODAY, { 'Steam サマーセール': true });
    expect(preview.landingYen).toBe(70_670);
    // 保存されていないので、素で呼べば元のまま。
    expect(forecastMonth(db, MONTH, TODAY).landingYen).toBe(77_010);
  });

  it('何を特別費にしても、上限内へは戻らない（design D4 の性質）', () => {
    const all: Record<string, boolean> = {};
    for (const r of listAdjustRows(db, MONTH, TODAY)) all[r.name] = true;
    expect(forecastMonth(db, MONTH, TODAY, all).overYen).toBeGreaterThan(0);
  });
});

describe('調整モーダルの一覧（design D3・D14）', () => {
  it('名称ごとに金額と件数をまとめ、金額の大きい順に並ぶ', () => {
    const rows = listAdjustRows(db, MONTH, TODAY);
    expect(rows.map((r) => r.name)).toEqual([
      '業務スーパー', 'Steam サマーセール', '', 'ドラッグストア', '歯医者', 'コンビニ', '一蘭（外食）',
    ]);
    expect(rows.find((r) => r.name === '業務スーパー')!).toMatchObject({ amountYen: 6_800, count: 2 });
    expect(rows.find((r) => r.name === 'コンビニ')!).toMatchObject({ amountYen: 1_440, count: 2 });
  });

  it('急な出費の行は特別費かつ自動（手では戻せない）', () => {
    const dent = listAdjustRows(db, MONTH, TODAY).find((r) => r.name === '歯医者')!;
    expect(dent).toMatchObject({ isSpecial: true, auto: true });
  });

  it('それ以外の行は通常の出費で、手で切り替えられる', () => {
    const steam = listAdjustRows(db, MONTH, TODAY).find((r) => r.name === 'Steam サマーセール')!;
    expect(steam).toMatchObject({ isSpecial: false, auto: false });
  });
});

describe('今週の残り予算（design D7）', () => {
  it('月曜始まりで、残り日数は今日を含む', () => {
    const w = weeklyRemaining(db, TODAY);
    expect(w.weekFromDayKey).toBe('2026-08-10');
    expect(w.weekToDayKey).toBe('2026-08-16');
    expect(w.remainingDays).toBe(6); // 8/11 – 8/16
    expect(w.targetYen).toBe(10_070); // floor10(44,620 ÷ 31 × 7)
    expect(w.spentYen).toBe(1_900); // 8/10 の 1,280 と 8/11 の 620
    expect(w.remainingYen).toBe(8_170);
    expect(w.perDayYen).toBe(1_360); // floor10(8,170 ÷ 6)
  });
});

describe('「無駄遣い」の合計と上限（spec: kakeibo-forecast）', () => {
  it('合計・割合・上限超過がモックどおり', () => {
    const w = wasteSummary(db, MONTH);
    expect(w.totalYen).toBe(4_920);
    expect(w.capYen).toBe(4_000);
    expect(w.overYen).toBe(920);
    expect(w.ratioPct).toBe(22); // 4920 / 22650 = 21.7% → 四捨五入
  });

  it('内訳は名称ごとに金額の大きい順', () => {
    const w = wasteSummary(db, MONTH);
    expect(w.rows).toEqual([
      { name: 'Steam サマーセール', amountYen: 3_480, count: 1 },
      { name: 'コンビニ', amountYen: 1_440, count: 2 },
    ]);
  });

  it('上限ぶんを抑えたときの月末超過の変化を出す', () => {
    const e = wasteReductionEffect(db, MONTH, TODAY);
    expect(e.reducibleYen).toBe(920);
    expect(e.overNowYen).toBe(15_010);
    expect(e.overAfterYen).toBe(12_410); // 母数 18,430 → 1日平均 1,675 → 着地 74,410
  });

  it('上限内なら抑える余地は 0', () => {
    setBudget(db, MONTH, { capYen: 62_000, wasteCapYen: 6_000 });
    expect(wasteReductionEffect(db, MONTH, TODAY).reducibleYen).toBe(0);
  });
});
