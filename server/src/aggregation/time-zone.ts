/**
 * タイムゾーン対応の日付境界ヘルパー（依存ライブラリなし・Intl のみ）。
 *
 * すべてのタイムスタンプは UTC epoch ms。日帰属は day_boundary(既定 04:00) で
 * 導出する（naive midnight は使わない。design.md D6）。DST のあるゾーンでも
 * 正しく動くよう、オフセットは対象時刻ごとに実測する。
 */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

interface TzParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    partsCache.set(tz, f);
  }
  return f;
}

/** epoch ms を指定 tz のローカル暦要素へ分解する。 */
export function getTzParts(tsMs: number, tz: string): TzParts {
  const parts = formatterFor(tz).formatToParts(new Date(tsMs));
  const get = (t: string): number => {
    const p = parts.find((x) => x.type === t);
    return p ? Number(p.value) : 0;
  };
  let hour = get('hour');
  // Intl は 24:00 を返すことがある（真夜中）ので 0 に正規化。
  if (hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** 指定時刻における tz のオフセット（local - utc, ms）を実測する。 */
function tzOffsetMs(tsMs: number, tz: string): number {
  const p = getTzParts(tsMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - tsMs;
}

/**
 * ローカル壁時計（tz）→ epoch ms。DST を考慮した2パス変換。
 */
export function zonedTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): number {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = tzOffsetMs(guessUtc, tz);
  let epoch = guessUtc - off1;
  const off2 = tzOffsetMs(epoch, tz);
  if (off2 !== off1) {
    epoch = guessUtc - off2;
  }
  return epoch;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 'YYYY-MM-DD' 文字列を作る。 */
export function toDayKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** 'YYYY-MM-DD' を分解。 */
export function parseDayKey(dayKey: string): { year: number; month: number; day: number } {
  const [y, m, d] = dayKey.split('-').map(Number);
  return { year: y ?? 0, month: m ?? 1, day: d ?? 1 };
}

/**
 * ある epoch ms が属する「作業日」の day key を返す。
 * boundaryMinutes（例 240=04:00）より前の時刻は前日に帰属させる。
 * = 時刻を boundary 分だけ手前にずらしてローカル暦日を読む。
 */
export function dayKeyFor(tsMs: number, tz: string, boundaryMinutes: number): string {
  const shifted = tsMs - boundaryMinutes * MINUTE_MS;
  const p = getTzParts(shifted, tz);
  return toDayKey(p.year, p.month, p.day);
}

/** その day key の「開始境界」の epoch ms（= その日の 04:00 ローカル）。 */
export function boundaryStartOfDay(dayKey: string, tz: string, boundaryMinutes: number): number {
  const { year, month, day } = parseDayKey(dayKey);
  const h = Math.floor(boundaryMinutes / 60);
  const mi = boundaryMinutes % 60;
  return zonedTimeToEpoch(year, month, day, h, mi, 0, tz);
}

/** 翌日の day key。 */
export function nextDayKey(dayKey: string): string {
  const { year, month, day } = parseDayKey(dayKey);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return toDayKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** 前日の day key。 */
export function prevDayKey(dayKey: string): string {
  const { year, month, day } = parseDayKey(dayKey);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return toDayKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * 区間 [startMs, endMs) を day_boundary で分割し、各サブ区間に day key を付す。
 * endMs <= startMs の場合は空配列。
 */
export function splitByDayBoundary(
  startMs: number,
  endMs: number,
  tz: string,
  boundaryMinutes: number,
): Array<{ startMs: number; endMs: number; dayKey: string }> {
  if (endMs <= startMs) return [];
  const out: Array<{ startMs: number; endMs: number; dayKey: string }> = [];
  let cur = startMs;
  let guard = 0;
  while (cur < endMs) {
    if (++guard > 4000) break; // 数千日を超える異常入力への安全弁
    const dk = dayKeyFor(cur, tz, boundaryMinutes);
    const nextBoundary = boundaryStartOfDay(nextDayKey(dk), tz, boundaryMinutes);
    const segEnd = Math.min(endMs, nextBoundary);
    // nextBoundary <= cur になり得る異常時は cur を強制前進させて無限ループを防ぐ。
    if (segEnd <= cur) {
      out.push({ startMs: cur, endMs, dayKey: dk });
      break;
    }
    out.push({ startMs: cur, endMs: segEnd, dayKey: dk });
    cur = segEnd;
  }
  return out;
}
