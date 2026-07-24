import { UNGROUPED_KEY } from '@track/contract';
import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import { totalWorkSecondsForDay, countsTowardTotal } from './categories.js';
import { getEvaluation, evaluateDay, type EvalResult } from '../rules/evaluate.js';
import { dayKeyFor, nextDayKey } from '../aggregation/index.js';
import { loadIdentityResolver } from './group-identity.js';

interface SnapshotGroupRow {
  sid: string;
  name: string;
  color: string | null;
  ms: number;
}

/**
 * 当日 `session` を記録時点スナップショット `(tab_group_name_snapshot, group_color_snapshot)` を
 * identity（`group-identity-registry`）へ解決した単位で集計し、内訳行（ms 降順）を返す
 * （design.md D1/D5、spec: today-group-breakdown）。表示名・色は identity の**現在値**（改名後）。
 * 未グループ（`stable_group_id = UNGROUPED_KEY`）は名前/色に依らず単一行へ集約する。
 */
function snapshotGroups(db: DB, dayKey: string): SnapshotGroupRow[] {
  const raw = db
    .prepare(
      `SELECT tab_group_name_snapshot AS name, group_color_snapshot AS color,
              (stable_group_id = @ung) AS is_ungrouped, SUM(credited_ms) AS ms
         FROM session
        WHERE day_key = @day
        GROUP BY is_ungrouped, tab_group_name_snapshot, COALESCE(group_color_snapshot, '')`,
    )
    .all({ ung: UNGROUPED_KEY, day: dayKey }) as {
    name: string;
    color: string | null;
    is_ungrouped: number;
    ms: number;
  }[];

  const resolver = loadIdentityResolver(db);
  const merged = new Map<string, SnapshotGroupRow>();
  for (const r of raw) {
    const resolved = resolver.resolve(r.name, r.color, r.is_ungrouped ? UNGROUPED_KEY : 'sg');
    const prev = merged.get(resolved.key);
    if (prev) prev.ms += r.ms;
    else merged.set(resolved.key, { sid: resolved.key, name: resolved.name, color: resolved.color, ms: r.ms });
  }
  return [...merged.values()].sort((a, b) => b.ms - a.ms);
}

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
  /** この行が日の総作業時間へ算入されるか（ON+未グループのとき false）。UI の非計上ヒント用。 */
  countsTowardTotal: boolean;
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
  const cfg = getConfig(db);
  // 内訳は権威集計(daily_totals)ではなく、記録時点スナップショットを identity へ解決した単位で
  // 分類する（design.md D1/D5）。表示名・色は identity の現在値（snapshotGroups が解決済み）。
  const groups: GroupTotal[] = snapshotGroups(db, dayKey).map((r) => ({
    stableGroupId: r.sid,
    name: r.name,
    color: r.color,
    ms: r.ms,
    seconds: r.ms / 1000,
    countsTowardTotal: countsTowardTotal(r.sid, cfg),
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
  const out: RangeDay[] = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard++ < 3660) {
    // 内訳（棒グラフ系列）は identity 由来（design.md D1/D5）。系列 key＝identity キー・現在名で連続表示。
    const groups = snapshotGroups(db, cur).map((r) => ({
      stableGroupId: r.sid,
      name: r.name,
      color: r.color,
      seconds: r.ms / 1000,
    }));
    // 総作業時間 KPI は権威集計(daily_totals)源泉のまま（当日サマリと同一規則。未グループ除外を尊重）。
    out.push({ dayKey: cur, totalWorkSeconds: totalWorkSecondsForDay(db, cur), groups });
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
