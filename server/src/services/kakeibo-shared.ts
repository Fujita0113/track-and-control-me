/**
 * 家計簿の丸め・月算術の共有ヘルパー（design D7・D8）。
 * kakeibo-budget.ts / kakeibo-forecast.ts / kakeibo-analysis.ts が共通で使う。
 */

/** 10円単位への切り捨て（design D7・週の目標などの「目安」に使う）。 */
export function floor10(n: number): number {
  return Math.floor(n / 10) * 10;
}

/** 'YYYY-MM' の前月キー。 */
export function prevMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  const year = y ?? 0;
  const month = m ?? 1;
  const d = new Date(Date.UTC(year, month - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM' の日数。 */
export function daysInMonth(monthKey: string): number {
  const [y, m] = monthKey.split('-').map(Number);
  const year = y ?? 0;
  const month = m ?? 1;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' → 'YYYY-MM'。 */
export function monthOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}
