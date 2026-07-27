import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import { dayKeyFor } from '../aggregation/index.js';
import { addDaysKey, dayDiff } from './day-key.js';
import { GoalNotFoundError } from './goal-errors.js';

/**
 * 目標の一時凍結（spec: goal-freeze・issue #60）。
 *
 * 凍結の状態（予約中/凍結中/解凍済み）は保存せず、`goal_freeze.start_day`/`end_day` と対象日から
 * 都度導出する（design D1）。日次 cron を使わない既存方針（`goal-check-gate`）に揃える。
 *
 * `goal_freeze` は生きている凍結（取消で行が削除・解除は `end_day` の切り詰め）を持ち、
 * `goal_freeze_change` は起きた事実の追記専用ログ（`goal_freeze` へ FK を張らない・design D4）。
 * 月枠はログではなく `goal_freeze` の行の存在（`start_day` の `YYYY-MM`）から導出する。
 */

export type FreezeState = 'reserved' | 'frozen' | 'released';

export interface FreezeInterval {
  startDay: string;
  endDay: string;
}

export interface FreezeView {
  id: number;
  goalId: number;
  startDay: string;
  endDay: string;
  reason: string;
  state: FreezeState;
}

export interface FreezeQuota {
  month: string;
  used: boolean;
  goalId: number | null;
  goalName: string | null;
  startDay: string | null;
  endDay: string | null;
  /** 枠が回復する月（YYYY-MM）。 */
  recoversOn: string;
}

export class FreezeValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'FreezeValidationError';
  }
}
export class FreezeStateError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'FreezeStateError';
  }
}

interface GoalFreezeRow {
  id: number;
  goal_id: number;
  start_day: string;
  end_day: string;
  reason: string;
  created_at: number;
  updated_at: number;
}

function todayKey(db: DB, nowMs: number): string {
  const cfg = getConfig(db);
  return dayKeyFor(nowMs, cfg.tz, cfg.day_boundary_minutes);
}

function nextMonthOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1 + 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 凍結区間の状態（予約中・凍結中・解凍済み）を対象日から導出する（design D1）。 */
export function freezeStateOn(f: { start_day: string; end_day: string }, today: string): FreezeState {
  if (today < f.start_day) return 'reserved';
  if (today <= f.end_day) return 'frozen';
  return 'released';
}

/** 経過した凍結日数の合計（各区間 `[start, min(end, today)]`・未到来分は数えない・design D2）。 */
export function frozenDaysUpTo(intervals: FreezeInterval[], today: string): number {
  let total = 0;
  for (const iv of intervals) {
    const to = iv.endDay < today ? iv.endDay : today;
    if (to < iv.startDay) continue;
    total += dayDiff(iv.startDay, to) + 1;
  }
  return total;
}

/** 実効 end_day（凍結日数ぶん前方向へ延長・design D2）。 */
export function effectiveEndDay(goalEndDay: string, intervals: FreezeInterval[], today: string): string {
  const frozen = frozenDaysUpTo(intervals, today);
  return frozen > 0 ? addDaysKey(goalEndDay, frozen) : goalEndDay;
}

/** 目標が持つ全凍結区間（解凍済みの過去分も累積のため含む）。id 昇順。 */
export function goalFreezeIntervals(db: DB, goalId: number): FreezeInterval[] {
  return (
    db.prepare('SELECT start_day, end_day FROM goal_freeze WHERE goal_id = ? ORDER BY id').all(goalId) as {
      start_day: string;
      end_day: string;
    }[]
  ).map((r) => ({ startDay: r.start_day, endDay: r.end_day }));
}

/** 対象日に凍結中の目標 id 集合（design D3。`listActiveRules`/`listDueRules` が共通利用）。 */
export function frozenGoalIdsOn(db: DB, dayKey: string): Set<number> {
  const rows = db
    .prepare('SELECT DISTINCT goal_id FROM goal_freeze WHERE start_day <= ? AND end_day >= ?')
    .all(dayKey, dayKey) as { goal_id: number }[];
  return new Set(rows.map((r) => r.goal_id));
}

function toFreezeView(row: GoalFreezeRow, today: string): FreezeView {
  return {
    id: row.id,
    goalId: row.goal_id,
    startDay: row.start_day,
    endDay: row.end_day,
    reason: row.reason,
    state: freezeStateOn(row, today),
  };
}

function latestFreezeRow(db: DB, goalId: number): GoalFreezeRow | undefined {
  return db.prepare('SELECT * FROM goal_freeze WHERE goal_id = ? ORDER BY id DESC LIMIT 1').get(goalId) as
    | GoalFreezeRow
    | undefined;
}

function requireReason(reason: string): string {
  const trimmed = String(reason ?? '').trim();
  if (!trimmed) throw new FreezeValidationError('理由を入力してください');
  return trimmed;
}

function requireGoal(db: DB, goalId: number): void {
  if (!db.prepare('SELECT 1 FROM goal WHERE id = ?').get(goalId)) throw new GoalNotFoundError(goalId);
}

function logChange(
  db: DB,
  args: {
    goalId: number;
    dayKey: string;
    op: 'reserve' | 'cancel' | 'extend' | 'release';
    startDay: string;
    beforeEndDay: string | null;
    afterEndDay: string | null;
    reason: string | null;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO goal_freeze_change (goal_id, day_key, op, start_day, before_end_day, after_end_day, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.goalId,
    args.dayKey,
    args.op,
    args.startDay,
    args.beforeEndDay,
    args.afterEndDay,
    args.reason,
    args.createdAt,
  );
}

/** その月に `start_day` を持つ凍結行（アプリ全体で1つ・design D4）。無ければ null。 */
function quotaRowForMonth(
  db: DB,
  month: string,
): { goalId: number; goalName: string; startDay: string; endDay: string } | null {
  const row = db
    .prepare(
      `SELECT gf.goal_id AS goalId, g.name AS goalName, gf.start_day AS startDay, gf.end_day AS endDay
         FROM goal_freeze gf JOIN goal g ON g.id = gf.goal_id
        WHERE substr(gf.start_day, 1, 7) = ?
        ORDER BY gf.id LIMIT 1`,
    )
    .get(month) as { goalId: number; goalName: string; startDay: string; endDay: string } | undefined;
  return row ?? null;
}

/** 今月の凍結枠の状態（使用済みか・使った目標・回復する月）。 */
export function freezeQuota(db: DB, nowMs = Date.now()): FreezeQuota {
  const today = todayKey(db, nowMs);
  const month = today.slice(0, 7);
  const row = quotaRowForMonth(db, month);
  return {
    month,
    used: row != null,
    goalId: row?.goalId ?? null,
    goalName: row?.goalName ?? null,
    startDay: row?.startDay ?? null,
    endDay: row?.endDay ?? null,
    recoversOn: nextMonthOf(month),
  };
}

/** その目標の最新の凍結（予約中/凍結中/解凍済み）を対象日から導出する。一度も凍結したことが無ければ null。 */
export function getFreezeOn(db: DB, goalId: number, today: string): FreezeView | null {
  const row = latestFreezeRow(db, goalId);
  return row ? toFreezeView(row, today) : null;
}

/** その目標の最新の凍結（予約中/凍結中/解凍済み）。一度も凍結したことが無ければ null。 */
export function getFreeze(db: DB, goalId: number, nowMs = Date.now()): FreezeView | null {
  return getFreezeOn(db, goalId, todayKey(db, nowMs));
}

/** 凍結を予約する（翌日発効固定・理由必須・二重予約と月枠超過は拒否・design 該当 Requirement）。 */
export function reserveFreeze(
  db: DB,
  goalId: number,
  input: { endDay: string; reason: string },
  nowMs = Date.now(),
): FreezeView {
  return reserveFreezeMulti(db, [goalId], input, nowMs)[0]!;
}

/** 複数の目標を同時に一括で凍結予約する（1回の月枠機会で複数選択・design D4/D11）。 */
export function reserveFreezeMulti(
  db: DB,
  goalIds: number[],
  input: { endDay: string; reason: string },
  nowMs = Date.now(),
): FreezeView[] {
  if (!goalIds || goalIds.length === 0) throw new FreezeValidationError('目標を1つ以上選択してください');

  const today = todayKey(db, nowMs);
  const reason = requireReason(input.reason);
  const startDay = addDaysKey(today, 1);
  if (input.endDay < startDay) throw new FreezeValidationError('終了日は発効日以降にしてください');

  for (const id of goalIds) {
    requireGoal(db, id);
    const existing = latestFreezeRow(db, id);
    if (existing && freezeStateOn(existing, today) !== 'released') {
      throw new FreezeStateError(`目標 ID ${id} には既に凍結の予約があります`);
    }
  }

  if (quotaRowForMonth(db, startDay.slice(0, 7))) {
    throw new FreezeStateError('今月の凍結枠は使用済みです');
  }

  const createdIds: number[] = [];
  const tx = db.transaction(() => {
    for (const goalId of goalIds) {
      const info = db
        .prepare(
          'INSERT INTO goal_freeze (goal_id, start_day, end_day, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(goalId, startDay, input.endDay, reason, nowMs, nowMs);
      const id = info.lastInsertRowid as number;
      logChange(db, {
        goalId,
        dayKey: today,
        op: 'reserve',
        startDay,
        beforeEndDay: null,
        afterEndDay: input.endDay,
        reason,
        createdAt: nowMs,
      });
      createdIds.push(id);
    }
  });
  tx();

  return createdIds.map(
    (id) => toFreezeView(db.prepare('SELECT * FROM goal_freeze WHERE id = ?').get(id) as GoalFreezeRow, today),
  );
}

/** 凍結期間を変更する（発効後は後ろへのみ・理由必須・月枠は消費しない）。 */
export function updateFreeze(
  db: DB,
  goalId: number,
  input: { endDay: string; reason: string },
  nowMs = Date.now(),
): FreezeView {
  requireGoal(db, goalId);
  const today = todayKey(db, nowMs);
  const reason = requireReason(input.reason);
  const row = latestFreezeRow(db, goalId);
  if (!row) throw new FreezeStateError('凍結がありません');
  const state = freezeStateOn(row, today);
  if (state === 'released') throw new FreezeStateError('凍結は既に終了しています');
  if (input.endDay < row.start_day) throw new FreezeValidationError('終了日は発効日以降にしてください');
  if (state === 'frozen' && input.endDay < row.end_day) {
    throw new FreezeValidationError('凍結中は短縮できません');
  }

  const beforeEndDay = row.end_day;
  const tx = db.transaction(() => {
    db.prepare('UPDATE goal_freeze SET end_day = ?, reason = ?, updated_at = ? WHERE id = ?').run(
      input.endDay,
      reason,
      nowMs,
      row.id,
    );
    logChange(db, {
      goalId,
      dayKey: today,
      op: 'extend',
      startDay: row.start_day,
      beforeEndDay,
      afterEndDay: input.endDay,
      reason,
      createdAt: nowMs,
    });
  });
  tx();
  return toFreezeView(db.prepare('SELECT * FROM goal_freeze WHERE id = ?').get(row.id) as GoalFreezeRow, today);
}

/** 発効前の予約を取り消す（行を削除・月枠は解放・沿革には残る）。発効後は拒否。 */
export function cancelFreeze(db: DB, goalId: number, nowMs = Date.now()): boolean {
  requireGoal(db, goalId);
  const today = todayKey(db, nowMs);
  const row = latestFreezeRow(db, goalId);
  if (!row) throw new FreezeStateError('凍結がありません');
  if (freezeStateOn(row, today) !== 'reserved') {
    throw new FreezeStateError('発効後は取消できません（解除を使ってください）');
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM goal_freeze WHERE id = ?').run(row.id);
    logChange(db, {
      goalId,
      dayKey: today,
      op: 'cancel',
      startDay: row.start_day,
      beforeEndDay: row.end_day,
      afterEndDay: null,
      reason: null,
      createdAt: nowMs,
    });
  });
  tx();
  return true;
}

/** 凍結中の凍結を即日解除する（`end_day` を解除日の前日へ切り詰め。理由不要・月枠は戻らない）。 */
export function releaseFreeze(db: DB, goalId: number, nowMs = Date.now()): FreezeView {
  requireGoal(db, goalId);
  const today = todayKey(db, nowMs);
  const row = latestFreezeRow(db, goalId);
  if (!row) throw new FreezeStateError('凍結がありません');
  if (freezeStateOn(row, today) !== 'frozen') {
    throw new FreezeStateError('凍結中のみ解除できます');
  }
  const beforeEndDay = row.end_day;
  const newEndDay = addDaysKey(today, -1);
  const tx = db.transaction(() => {
    db.prepare('UPDATE goal_freeze SET end_day = ?, updated_at = ? WHERE id = ?').run(newEndDay, nowMs, row.id);
    logChange(db, {
      goalId,
      dayKey: today,
      op: 'release',
      startDay: row.start_day,
      beforeEndDay,
      afterEndDay: newEndDay,
      reason: null,
      createdAt: nowMs,
    });
  });
  tx();
  return toFreezeView(db.prepare('SELECT * FROM goal_freeze WHERE id = ?').get(row.id) as GoalFreezeRow, today);
}
