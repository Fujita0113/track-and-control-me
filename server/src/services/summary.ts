import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import { totalWorkSecondsForDay } from './categories.js';
import { getEvaluation, evaluateDay, type EvalResult } from '../rules/evaluate.js';
import { dayKeyFor, nextDayKey } from '../aggregation/index.js';

/**
 * ダッシュボード/ルール評価が使う集計サマリ（spec: work-time-summary）。
 * 総作業秒（全グループ合算）・グループ内訳・除外・当日達成状態を返す。
 */

export interface GroupTotal {
  stableGroupId: string;
  name: string;
  color: string | null;
  ms: number;
  seconds: number;
}

export interface GroupInfo {
  stable_group_id: string;
  name: string;
  color: string | null;
}

export interface DaySummary {
  dayKey: string;
  totalWorkSeconds: number;
  groups: GroupTotal[];
  excluded: { reason: string; seconds: number }[];
  unlock: EvalResult | null;
}

export function todayKey(db: DB, nowMs = Date.now()): string {
  const cfg = getConfig(db);
  return dayKeyFor(nowMs, cfg.tz, cfg.day_boundary_minutes);
}

export function daySummary(db: DB, dayKey: string): DaySummary {
  const groupRows = db
    .prepare(
      `SELECT d.stable_group_id AS id, d.ms AS ms, g.name AS name, g.color AS color
       FROM daily_totals_snapshot d
       LEFT JOIN tab_group g ON g.stable_group_id = d.stable_group_id
       WHERE d.day_key = ?
       ORDER BY d.ms DESC`,
    )
    .all(dayKey) as { id: string; ms: number; name: string | null; color: string | null }[];

  const groups: GroupTotal[] = groupRows.map((r) => ({
    stableGroupId: r.id,
    name: r.name ?? (r.id === 'ungrouped' ? 'その他（未グループ）' : r.id),
    color: r.color,
    ms: r.ms,
    seconds: r.ms / 1000,
  }));

  const excluded = (
    db
      .prepare('SELECT reason, ms FROM daily_excluded_snapshot WHERE day_key = ? ORDER BY ms DESC')
      .all(dayKey) as { reason: string; ms: number }[]
  ).map((e) => ({ reason: e.reason, seconds: e.ms / 1000 }));

  return {
    dayKey,
    totalWorkSeconds: totalWorkSecondsForDay(db, dayKey),
    groups,
    excluded,
    unlock: getEvaluation(db, dayKey),
  };
}

export interface RangeDay {
  dayKey: string;
  totalWorkSeconds: number;
  groups: { stableGroupId: string; name: string; color: string | null; seconds: number }[];
}

/** [from, to]（両端含む、day_key 文字列）のグループ別推移（棒グラフ用）。 */
export function rangeSummary(db: DB, from: string, to: string): RangeDay[] {
  const stmt = db.prepare(
    `SELECT d.stable_group_id AS id, d.ms AS ms, g.name AS name, g.color AS color
     FROM daily_totals_snapshot d
     LEFT JOIN tab_group g ON g.stable_group_id = d.stable_group_id
     WHERE d.day_key = ?
     ORDER BY d.ms DESC`,
  );
  const out: RangeDay[] = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard++ < 3660) {
    const rows = stmt.all(cur) as { id: string; ms: number; name: string | null; color: string | null }[];
    let totalMs = 0;
    const groups = rows.map((r) => {
      totalMs += r.ms;
      return {
        stableGroupId: r.id,
        name: r.name ?? (r.id === 'ungrouped' ? 'その他（未グループ）' : r.id),
        color: r.color,
        seconds: r.ms / 1000,
      };
    });
    out.push({ dayKey: cur, totalWorkSeconds: Math.floor(totalMs / 1000), groups });
    cur = nextDayKey(cur);
  }
  return out;
}

/** ルール編集のグループピッカー用（日付非依存のタブグループ一覧）。 */
export function listGroups(db: DB): GroupInfo[] {
  return db
    .prepare('SELECT stable_group_id, name, color FROM tab_group ORDER BY last_seen_at DESC')
    .all() as GroupInfo[];
}

/** 当日達成状態を（評価を走らせて）返す。 */
export function evaluateToday(db: DB, nowMs = Date.now()): EvalResult {
  return evaluateDay(db, todayKey(db, nowMs), nowMs);
}
