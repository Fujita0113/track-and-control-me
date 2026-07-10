import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import { boundaryStartOfDay, nextDayKey } from '../aggregation/index.js';
import { recordCategoryUse } from './manual-categories.js';

/**
 * 行動記録タイムライン（spec: activity-timeline / tasks 6.3–6.5, 6.7）。
 * 閉じた Session から AUTO ブロックを生成（近接同一グループを coalesce）、
 * MANUAL エントリと合わせ、未カバー区間（ギャップ）を計算する。
 */

export interface AutoBlock {
  kind: 'AUTO';
  stableGroupId: string;
  title: string;
  color: string | null;
  startAt: number;
  endAt: number;
  coactiveGroupKeys: string[];
  n: number;
  categoryKey: string | null;
  creditedMs: number;
}

export interface ManualEntry {
  id: number;
  kind: 'MANUAL';
  startAt: number;
  endAt: number;
  title: string;
  color: string | null;
  categoryKey: string | null;
  edited: boolean;
}

export interface Gap {
  startAt: number;
  endAt: number;
  seconds: number;
}

export interface Timeline {
  dayKey: string;
  window: { start: number; end: number; now: number };
  auto: AutoBlock[];
  manual: ManualEntry[];
  gaps: Gap[];
  splitOverrides: { id: number; startAt: number; endAt: number; ratios: Record<string, number> }[];
}

interface SessionRow {
  id: number;
  stable_group_id: string;
  tab_group_name_snapshot: string;
  group_color_snapshot: string | null;
  category_key_snapshot: string | null;
  started_at: number;
  ended_at: number;
  coactive_group_keys: string;
  n: number;
  credited_ms: number;
}

/** 同一グループの近接セッションを結合しきい値で1ブロックへ coalesce。 */
function coalesceSessions(sessions: SessionRow[], thresholdMs: number): AutoBlock[] {
  const byGroup = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const arr = byGroup.get(s.stable_group_id) ?? [];
    arr.push(s);
    byGroup.set(s.stable_group_id, arr);
  }
  const blocks: AutoBlock[] = [];
  for (const [, arr] of byGroup) {
    arr.sort((a, b) => a.started_at - b.started_at);
    let cur: AutoBlock | null = null;
    for (const s of arr) {
      const coactive = JSON.parse(s.coactive_group_keys) as string[];
      if (cur && s.started_at - cur.endAt <= thresholdMs) {
        cur.endAt = Math.max(cur.endAt, s.ended_at);
        cur.creditedMs += s.credited_ms;
        cur.coactiveGroupKeys = [...new Set([...cur.coactiveGroupKeys, ...coactive])];
      } else {
        if (cur) blocks.push(cur);
        cur = {
          kind: 'AUTO',
          stableGroupId: s.stable_group_id,
          title: s.tab_group_name_snapshot,
          color: s.group_color_snapshot,
          startAt: s.started_at,
          endAt: s.ended_at,
          coactiveGroupKeys: coactive,
          n: s.n,
          categoryKey: s.category_key_snapshot,
          creditedMs: s.credited_ms,
        };
      }
    }
    if (cur) blocks.push(cur);
  }
  blocks.sort((a, b) => a.startAt - b.startAt);
  return blocks;
}

/**
 * [winStart, capEnd] で、与えた区間集合に覆われない部分をギャップとして返す。
 * `minGapSeconds` 未満のギャップは「作業の呼吸として吸収」される区間なので除外する
 * （timeline-revamp D2: 閾値未満は表示せず、同一グループ間ならクライアントのランのハッチとして可視化）。
 */
function computeGaps(
  winStart: number,
  capEnd: number,
  intervals: { startAt: number; endAt: number }[],
  minGapSeconds: number,
): Gap[] {
  if (capEnd <= winStart) return [];
  const sorted = intervals
    .map((i) => ({ s: Math.max(i.startAt, winStart), e: Math.min(i.endAt, capEnd) }))
    .filter((i) => i.e > i.s)
    .sort((a, b) => a.s - b.s);
  const gaps: Gap[] = [];
  let cursor = winStart;
  for (const iv of sorted) {
    if (iv.s > cursor) {
      gaps.push({ startAt: cursor, endAt: iv.s, seconds: (iv.s - cursor) / 1000 });
    }
    cursor = Math.max(cursor, iv.e);
  }
  if (cursor < capEnd) {
    gaps.push({ startAt: cursor, endAt: capEnd, seconds: (capEnd - cursor) / 1000 });
  }
  return gaps.filter((g) => g.seconds >= minGapSeconds);
}

export function getTimeline(db: DB, dayKey: string, nowMs = Date.now()): Timeline {
  const cfg = getConfig(db);
  const winStart = boundaryStartOfDay(dayKey, cfg.tz, cfg.day_boundary_minutes);
  const winEnd = boundaryStartOfDay(nextDayKey(dayKey), cfg.tz, cfg.day_boundary_minutes);

  const sessions = db
    .prepare('SELECT * FROM session WHERE day_key = ? ORDER BY started_at')
    .all(dayKey) as SessionRow[];
  const auto = coalesceSessions(sessions, cfg.session_coalesce_seconds * 1000);

  const manualRows = db
    .prepare("SELECT * FROM activity_log_entry WHERE day_key = ? AND entry_type = 'MANUAL' ORDER BY start_at")
    .all(dayKey) as {
    id: number;
    start_at: number;
    end_at: number;
    title: string;
    color: string | null;
    category_key: string | null;
    edited: number;
  }[];
  const manual: ManualEntry[] = manualRows.map((r) => ({
    id: r.id,
    kind: 'MANUAL',
    startAt: r.start_at,
    endAt: r.end_at,
    title: r.title,
    color: r.color,
    categoryKey: r.category_key,
    edited: r.edited === 1,
  }));

  const capEnd = Math.min(winEnd, Math.max(nowMs, winStart));
  const gaps = computeGaps(winStart, capEnd, [...auto, ...manual], cfg.away_min_seconds);

  const splitOverrides = (
    db
      .prepare('SELECT id, start_at, end_at, ratios FROM split_override WHERE day_key = ? ORDER BY start_at')
      .all(dayKey) as { id: number; start_at: number; end_at: number; ratios: string }[]
  ).map((o) => ({
    id: o.id,
    startAt: o.start_at,
    endAt: o.end_at,
    ratios: JSON.parse(o.ratios) as Record<string, number>,
  }));

  return { dayKey, window: { start: winStart, end: winEnd, now: nowMs }, auto, manual, gaps, splitOverrides };
}

export interface ManualInput {
  startAt: number;
  endAt: number;
  title: string;
  color?: string | null;
  categoryKey?: string | null;
  /** 記録ポップオーバーで選択／入力されたカテゴリ名（表示ラベル）。レジストリへ upsert する。 */
  category?: string | null;
}

export function addManualEntry(db: DB, dayKey: string, input: ManualInput): number {
  const now = Date.now();
  // カテゴリ（表示ラベル）が与えられていればレジストリへ使用登録し、trim 名を category_key に格納する。
  // 空／空白のみのときは登録せず、従来どおり categoryKey ?? 'uncategorized' を使う。
  const category = (input.category ?? '').trim();
  if (category) recordCategoryUse(db, category, now);
  const categoryKey = category || (input.categoryKey ?? 'uncategorized');
  const info = db
    .prepare(
      `INSERT INTO activity_log_entry
        (day_key, start_at, end_at, entry_type, title, color, category_key, edited, created_at, updated_at)
       VALUES (?, ?, ?, 'MANUAL', ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      dayKey,
      input.startAt,
      input.endAt,
      input.title,
      input.color ?? null,
      categoryKey,
      now,
      now,
    );
  return info.lastInsertRowid as number;
}

export function updateEntry(
  db: DB,
  id: number,
  patch: { startAt?: number; endAt?: number; title?: string; color?: string | null; categoryKey?: string | null },
): boolean {
  const existing = db.prepare('SELECT * FROM activity_log_entry WHERE id = ?').get(id) as
    | { entry_type: string; start_at: number; end_at: number; edited: number; original_start_at: number | null }
    | undefined;
  if (!existing) return false;
  const now = Date.now();
  // AUTO を編集する場合は来歴（original_*, edited）を保持。
  const setOriginal =
    existing.entry_type === 'AUTO_SESSION' && existing.edited === 0
      ? ', edited = 1, original_start_at = start_at, original_end_at = end_at'
      : '';
  const fields: string[] = [];
  const params: Record<string, unknown> = { id, now };
  if (patch.startAt !== undefined) { fields.push('start_at = @startAt'); params.startAt = patch.startAt; }
  if (patch.endAt !== undefined) { fields.push('end_at = @endAt'); params.endAt = patch.endAt; }
  if (patch.title !== undefined) { fields.push('title = @title'); params.title = patch.title; }
  if (patch.color !== undefined) { fields.push('color = @color'); params.color = patch.color; }
  if (patch.categoryKey !== undefined) { fields.push('category_key = @categoryKey'); params.categoryKey = patch.categoryKey; }
  if (fields.length === 0 && setOriginal === '') return true;
  db.prepare(
    `UPDATE activity_log_entry SET ${fields.join(', ')}${setOriginal}, updated_at = @now WHERE id = @id`,
  ).run(params);
  return true;
}

export function deleteEntry(db: DB, id: number): boolean {
  return db.prepare('DELETE FROM activity_log_entry WHERE id = ?').run(id).changes > 0;
}

/** ギャップを MANUAL AWAY へ昇格（task 6.5）。 */
export function promoteGapToAway(
  db: DB,
  dayKey: string,
  startAt: number,
  endAt: number,
  title = '離席',
): number {
  return addManualEntry(db, dayKey, { startAt, endAt, title, color: 'grey', categoryKey: 'uncategorized' });
}

/** 割合上書きの保存（task 6.7）。同一区間は置換。 */
export function setSplitOverride(
  db: DB,
  dayKey: string,
  startAt: number,
  endAt: number,
  ratios: Record<string, number>,
): void {
  const now = Date.now();
  db.prepare('DELETE FROM split_override WHERE day_key = ? AND start_at = ? AND end_at = ?').run(
    dayKey,
    startAt,
    endAt,
  );
  db.prepare(
    `INSERT INTO split_override (day_key, start_at, end_at, ratios, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(dayKey, startAt, endAt, JSON.stringify(ratios), now, now);
}

export function loadSplitOverrides(
  db: DB,
  dayKeys: string[],
): { startMs: number; endMs: number; ratios: Record<string, number> }[] {
  if (dayKeys.length === 0) return [];
  const placeholders = dayKeys.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT start_at, end_at, ratios FROM split_override WHERE day_key IN (${placeholders})`)
    .all(...dayKeys) as { start_at: number; end_at: number; ratios: string }[];
  return rows.map((r) => ({
    startMs: r.start_at,
    endMs: r.end_at,
    ratios: JSON.parse(r.ratios) as Record<string, number>,
  }));
}
