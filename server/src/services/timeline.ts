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
  /** 同時記録グループ ID。単独記録は null（spec: timeline-coactive-record / D1）。 */
  coRecordGroupId: number | null;
  /** 同時記録グループの構成数（＝持ち分の分母）。単独記録は 1。 */
  n: number;
  /** 持ち分秒 = (endAt - startAt) / n / 1000（D2: 読み取り時に算出）。 */
  creditedSeconds: number;
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
    co_record_group_id: number | null;
    n: number;
  }[];
  const manual: ManualEntry[] = manualRows.map((r) => {
    const n = r.n > 0 ? r.n : 1;
    return {
      id: r.id,
      kind: 'MANUAL',
      startAt: r.start_at,
      endAt: r.end_at,
      title: r.title,
      color: r.color,
      categoryKey: r.category_key,
      edited: r.edited === 1,
      coRecordGroupId: r.co_record_group_id ?? null,
      n,
      creditedSeconds: (r.end_at - r.start_at) / n / 1000,
    };
  });

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

export interface CoRecordInput {
  startAt: number;
  endAt: number;
  /** 選択・入力されたカテゴリ名の配列（順序保持）。trim・重複・空白は正規化される。 */
  categories: string[];
  color?: string | null;
}

/**
 * 同一区間を複数カテゴリで均等割同時記録する（spec: timeline-coactive-record / design.md D1・D4）。
 * カテゴリ名を trim・重複除去・空白除外で正規化し、正規化後の件数 N に応じて:
 *  - N=1: 従来どおりの単独記録（co_record_group_id=NULL, n=1）を1件作成。
 *  - N≥2: 同一 co_record_group_id・n=N の MANUAL 行を N 件作成（区間全体を共有）。
 * 作成は単一トランザクション。途中失敗ではどの行も残さない（MUST NOT 部分作成）。
 * 返り値は作成したエントリ ID の配列（正規化後 0 件なら空配列）。
 */
export function addCoRecordEntries(db: DB, dayKey: string, input: CoRecordInput): number[] {
  const cats = normalizeCategories(input.categories);
  if (cats.length === 0) return [];
  const now = Date.now();
  const color = input.color ?? null;
  const n = cats.length;

  const tx = db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO activity_log_entry
        (day_key, start_at, end_at, entry_type, title, color, category_key, coactive_group_keys,
         n, co_record_group_id, edited, created_at, updated_at)
       VALUES (?, ?, ?, 'MANUAL', ?, ?, ?, '[]', ?, ?, 0, ?, ?)`,
    );
    const ids: number[] = [];
    // 単独（N=1）は co_record_group_id=NULL・n=1。グループ ID は先頭行の id を採用する。
    let groupId: number | null = null;
    for (const cat of cats) {
      recordCategoryUse(db, cat, now);
      const info = ins.run(dayKey, input.startAt, input.endAt, cat, color, cat, n, groupId, now, now);
      const id = info.lastInsertRowid as number;
      ids.push(id);
      if (n > 1 && groupId === null) {
        groupId = id;
        db.prepare('UPDATE activity_log_entry SET co_record_group_id = ? WHERE id = ?').run(groupId, id);
      }
    }
    return ids;
  });
  return tx();
}

/** カテゴリ名配列を trim → 空白除外 → 先勝ちで重複除去して正規化する（順序保持）。 */
function normalizeCategories(categories: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of categories ?? []) {
    const c = (raw ?? '').trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
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

/**
 * MANUAL/AUTO エントリを削除する。同時記録グループのメンバーを削除した場合は、
 * 残メンバーの n を新しい構成数へ更新して再按分する（spec: timeline-coactive-record / D2）。
 * 残り1件になったら単独記録へ戻す（co_record_group_id=NULL, n=1 → 持ち分＝区間長）。
 */
export function deleteEntry(db: DB, id: number): boolean {
  const tx = db.transaction(() => {
    const row = db
      .prepare('SELECT co_record_group_id FROM activity_log_entry WHERE id = ?')
      .get(id) as { co_record_group_id: number | null } | undefined;
    const deleted = db.prepare('DELETE FROM activity_log_entry WHERE id = ?').run(id).changes > 0;
    if (!deleted) return false;
    const groupId = row?.co_record_group_id ?? null;
    if (groupId !== null) {
      const now = Date.now();
      const remaining = db
        .prepare('SELECT id FROM activity_log_entry WHERE co_record_group_id = ?')
        .all(groupId) as { id: number }[];
      if (remaining.length <= 1) {
        // 単独へ戻す: グループ解消・n=1・持ち分＝区間長。
        db.prepare(
          'UPDATE activity_log_entry SET co_record_group_id = NULL, n = 1, updated_at = ? WHERE co_record_group_id = ?',
        ).run(now, groupId);
      } else {
        db.prepare(
          'UPDATE activity_log_entry SET n = ?, updated_at = ? WHERE co_record_group_id = ?',
        ).run(remaining.length, now, groupId);
      }
    }
    return true;
  });
  return tx();
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
