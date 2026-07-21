/**
 * day_key（'YYYY-MM-DD'）の算術。
 *
 * UTC で計算して tz ずれを回避する（static/js/util.js の addDays と同一規則）。
 * 依存を持たない純関数だけを置く＝目標・Plan/Check・沿革のどの層からも、
 * 循環 import を作らずに参照できる。
 */

/** 'YYYY-MM-DD' に n 日加算する（n は負でもよい）。 */
export function addDaysKey(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** b - a の日数差（整数）。 */
export function dayDiff(a: string, b: string): number {
  const toUtc = (k: string): number => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}
