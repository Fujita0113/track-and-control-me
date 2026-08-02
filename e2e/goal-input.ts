/**
 * 目標作成 API の共通入力ヘルパー（issue #76 / spec: goal-challenge）。
 *
 * `POST /api/goals` は `purpose`（めざす状態）・`startReason`（なぜ始めるのか）・`endDay`（期限）を
 * 必須で受け取る。30日固定は撤廃されたため、期限は呼び出し側が日付で明示する。
 * 既存 e2e は従来どおりの30日相当を使いたいだけなので、`daysFromToday()` で期限を作る。
 */

/** `YYYY-MM-DD` に n 日足す（UTC 基準・day_key はローカル日付文字列なのでズレない）。 */
export function addDaysKey(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** 従来の「30日」に相当する期限（今日から数えて 29 日後）。 */
export function thirtyDayEnd(todayKey: string): string {
  return addDaysKey(todayKey, 29);
}
