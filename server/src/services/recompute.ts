import type { GroupColor, GroupRef } from '@track/contract';
import type { DB } from '../db/index.js';
import { getConfig, toAggregationConfig } from '../db/index.js';
import { aggregateSamples, type AggregationResult, type RawSample } from '../aggregation/index.js';
import type { SplitOverride } from '../aggregation/aggregate.js';
import { loadSplitOverrides } from './timeline.js';
import { resolveIdentity } from './group-identity.js';

/**
 * raw_sample → 集計 → セッション/日次合計/除外 の永続化（design.md D4/D6）。
 * is_final=1 の確定日は再計算しない。それ以外の日は毎回作り直す（single-user 規模で十分）。
 */

interface RawSampleRow {
  boot_id: string;
  seq: number;
  client_ts: number;
  monotonic_ms: number;
  idle_state: 'active' | 'idle' | 'locked';
  active_stable_group_id: string | null;
  open_group_keys: string;
}

export function loadRawSamples(db: DB): RawSample[] {
  const rows = db
    .prepare(
      `SELECT boot_id, seq, client_ts, monotonic_ms, idle_state, active_stable_group_id, open_group_keys
       FROM raw_sample ORDER BY client_ts, boot_id, seq`,
    )
    .all() as RawSampleRow[];
  return rows.map((r) => {
    let open: GroupRef[] = [];
    try {
      open = JSON.parse(r.open_group_keys) as GroupRef[];
    } catch {
      open = [];
    }
    return {
      clientTs: r.client_ts,
      monotonicMs: r.monotonic_ms,
      bootId: r.boot_id,
      seq: r.seq,
      idleState: r.idle_state,
      openGroupKeys: open.map((g) => ({
        stableGroupId: g.stableGroupId,
        title: g.title,
        color: g.color,
      })),
      activeStableGroupId: r.active_stable_group_id,
    };
  });
}

/** 集計して非確定日を作り直す。返り値は集計結果（評価に流用可）。 */
export function recompute(db: DB, opts: { onlyDays?: string[] } = {}): AggregationResult {
  const cfg = toAggregationConfig(getConfig(db));
  const samples = loadRawSamples(db);
  const overrides: SplitOverride[] = loadAllSplitOverrides(db);
  const result = aggregateSamples(samples, cfg, overrides);
  persist(db, result, opts.onlyDays);
  return result;
}

/** 全期間の割合上書きを読み込む（task 6.7 の再割当を集計に反映）。 */
function loadAllSplitOverrides(db: DB): SplitOverride[] {
  const days = (db.prepare('SELECT DISTINCT day_key FROM split_override').all() as {
    day_key: string;
  }[]).map((r) => r.day_key);
  return loadSplitOverrides(db, days);
}

function persist(db: DB, result: AggregationResult, onlyDays?: string[]): void {
  const finalDays = new Set(
    (db.prepare('SELECT day_key FROM daily_totals_snapshot WHERE is_final = 1').all() as {
      day_key: string;
    }[]).map((r) => r.day_key),
  );
  const finalEval = new Set(
    (db.prepare('SELECT day_key FROM unlock_evaluation WHERE is_final = 1').all() as {
      day_key: string;
    }[]).map((r) => r.day_key),
  );

  const touched = new Set<string>();
  for (const t of result.dailyTotals) touched.add(t.dayKey);
  for (const s of result.sessions) touched.add(s.dayKey);
  for (const e of result.excluded) touched.add(e.dayKey);

  const target = (day: string): boolean => {
    if (finalDays.has(day) || finalEval.has(day)) return false;
    if (onlyDays && !onlyDays.includes(day)) return false;
    return true;
  };

  const now = Date.now();
  const insSession = db.prepare(
    `INSERT INTO session
       (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
        started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES (@stable, @name, @color, @cat, @start, @end, @day, @coactive, @n, @credited, @reason, @now)`,
  );
  const upTotal = db.prepare(
    `INSERT INTO daily_totals_snapshot (day_key, stable_group_id, ms, is_final, updated_at)
     VALUES (@day, @key, @ms, 0, @now)
     ON CONFLICT(day_key, stable_group_id) DO UPDATE SET ms = excluded.ms, updated_at = excluded.updated_at`,
  );
  const upExcluded = db.prepare(
    `INSERT INTO daily_excluded_snapshot (day_key, reason, ms, updated_at)
     VALUES (@day, @reason, @ms, @now)
     ON CONFLICT(day_key, reason) DO UPDATE SET ms = excluded.ms, updated_at = excluded.updated_at`,
  );

  const tx = db.transaction(() => {
    for (const day of touched) {
      if (!target(day)) continue;
      db.prepare('DELETE FROM session WHERE day_key = ?').run(day);
      db.prepare('DELETE FROM daily_totals_snapshot WHERE day_key = ? AND is_final = 0').run(day);
      db.prepare('DELETE FROM daily_excluded_snapshot WHERE day_key = ?').run(day);
    }
    for (const s of result.sessions) {
      if (!target(s.dayKey)) continue;
      // セッション確定時に記録時点スナップショットを identity へ解決する（design.md D1・task 1.6）。
      // 未グループ・空名は resolveIdentity 側で identity を作らない。
      resolveIdentity(db, s.title, s.color, s.stableGroupId, s.endMs);
      // category_key_snapshot は dormant（カテゴリ層撤廃）。既定値のみ保持。
      const cat = 'uncategorized';
      insSession.run({
        stable: s.stableGroupId,
        name: s.title,
        color: s.color,
        cat,
        start: s.startMs,
        end: s.endMs,
        day: s.dayKey,
        coactive: JSON.stringify(s.coactiveGroupKeys),
        n: s.n,
        credited: s.creditedMs,
        reason: s.closeReason,
        now,
      });
    }
    for (const t of result.dailyTotals) {
      if (!target(t.dayKey)) continue;
      upTotal.run({ day: t.dayKey, key: t.stableGroupId, ms: t.ms, now });
    }
    for (const e of result.excluded) {
      if (!target(e.dayKey)) continue;
      upExcluded.run({ day: e.dayKey, reason: e.reason, ms: e.ms, now });
    }
  });
  tx();
}

/** ingest 時に tab_group メタ（名前/色/last_seen）を upsert する。 */
export function upsertTabGroups(db: DB, groups: GroupRef[], seenAt: number): void {
  const up = db.prepare(
    `INSERT INTO tab_group (stable_group_id, name, color, external_group_id, first_seen_at, last_seen_at)
     VALUES (@id, @name, @color, @ext, @now, @now)
     ON CONFLICT(stable_group_id) DO UPDATE SET
       name = excluded.name, color = excluded.color,
       external_group_id = excluded.external_group_id, last_seen_at = excluded.last_seen_at`,
  );
  const tx = db.transaction(() => {
    for (const g of groups) {
      up.run({ id: g.stableGroupId, name: g.title, color: g.color as GroupColor, ext: g.groupId, now: seenAt });
    }
  });
  tx();
}
