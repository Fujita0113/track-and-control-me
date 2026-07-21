import type { DB } from '../db/index.js';
import { GoalNotFoundError } from './goal-errors.js';
import type {
  CheckKind,
  CheckSchedule,
  CheckStatus,
  Chronicle,
  GoalCheck,
  GoalCheckResult,
  GoalPlan,
  PlanStatus,
} from '@track/contract';

/**
 * 沿革（⑤）の読み取りモデル（spec: goal-chronicle）。
 *
 * 書き込み（goal-plan-check.ts）とは別モジュールに置く。レポート（goals.ts）は沿革を含むため
 * ここを読むが、書き込み側は目標の状態検証・画像保存で goals.ts を読む — 読み取りを分けることで
 * その循環を作らずに済む。
 *
 * **日記（goal_journal）は引かない**（6.2）。沿革に載るのは Plan と Check だけ＝載る／載らないの
 * 線引きは「大きさ」ではなく「検証がぶら下がる構造に属するか」で決まる。日記は ④日記リーダーが読む。
 */

export interface PlanRow {
  id: number;
  goal_id: number;
  day_key: string;
  body: string;
  status: PlanStatus;
  withdraw_reason: string | null;
  created_at: number;
}
export interface CheckRow {
  id: number;
  plan_id: number;
  kind: CheckKind;
  caption: string;
  question_text: string;
  schedule: CheckSchedule;
  start_day_key: string;
  span_days: number | null;
  place_note: string | null;
  time_note: string | null;
  status: CheckStatus;
  cancel_reason: string | null;
  created_at: number;
}
export interface ResultRow {
  id: number;
  check_id: number;
  day_key: string;
  image_id: number | null;
  answer_text: string | null;
  created_at: number;
}

export function resultsOf(db: DB, checkId: number): ResultRow[] {
  return db
    .prepare('SELECT * FROM goal_check_result WHERE check_id = ? ORDER BY day_key, id')
    .all(checkId) as ResultRow[];
}

export function toResultView(r: ResultRow): GoalCheckResult {
  return {
    id: r.id,
    checkId: r.check_id,
    dayKey: r.day_key,
    imageId: r.image_id,
    answerText: r.answer_text,
    createdAt: r.created_at,
  };
}

export function toCheckView(db: DB, c: CheckRow, untilDayKey?: string): GoalCheck {
  // 回答は day_key 昇順（範囲Check の提出が時系列に並ぶ＝「7日中5日提出」を描ける）。
  const results = resultsOf(db, c.id).filter((r) => !untilDayKey || r.day_key <= untilDayKey);
  return {
    id: c.id,
    planId: c.plan_id,
    kind: c.kind,
    caption: c.caption,
    questionText: c.question_text,
    schedule: c.schedule,
    startDayKey: c.start_day_key,
    spanDays: c.span_days,
    placeNote: c.place_note,
    timeNote: c.time_note,
    status: c.status,
    cancelReason: c.cancel_reason,
    createdAt: c.created_at,
    results: results.map(toResultView),
  };
}

export function toPlanView(db: DB, p: PlanRow, untilDayKey?: string): GoalPlan {
  const checks = db
    .prepare('SELECT * FROM goal_check WHERE plan_id = ? ORDER BY id')
    .all(p.id) as CheckRow[];
  return {
    id: p.id,
    goalId: p.goal_id,
    dayKey: p.day_key,
    body: p.body,
    status: p.status,
    withdrawReason: p.withdraw_reason,
    createdAt: p.created_at,
    checks: checks.map((c) => toCheckView(db, c, untilDayKey)),
  };
}

/**
 * 目標の Plan 一覧（`day_key` 昇順・同日内は記録順＝id 昇順）。並びは決定的で、同じデータで
 * 2回開いても入れ替わらない。取り下げた Plan / Check も理由つきでそのまま残す（消さない）。
 *
 * `untilDayKey` を渡すと、その日までに**実際に起きた**ことだけを返す（それより後の day_key を持つ
 * Plan と回答を落とす）。走行中プレビューが「まだ起きていない未来」を見せないため＝①カレンダーで
 * 未到来を空白にするのと同じ理由。本番データでは Plan は作成日の day_key を持つので未来の Plan は
 * 存在せず、この絞り込みは no-op になる（効くのは固定 day_key を焼き込むデモの仮想日付）。
 */
export function listPlans(db: DB, goalId: number, untilDayKey?: string): GoalPlan[] {
  const exists = db.prepare('SELECT 1 FROM goal WHERE id = ?').get(goalId);
  if (!exists) throw new GoalNotFoundError(goalId);
  const rows = db
    .prepare('SELECT * FROM goal_plan WHERE goal_id = ? ORDER BY day_key, id')
    .all(goalId) as PlanRow[];
  return rows
    .filter((p) => !untilDayKey || p.day_key <= untilDayKey)
    .map((p) => toPlanView(db, p, untilDayKey));
}

/** 沿革（⑤）＝ Plan（day_key 昇順・同日内は記録順）＋ 配下 Check ＋ 回答の入れ子。日記は含まない。 */
export function getChronicle(db: DB, goalId: number, untilDayKey?: string): Chronicle {
  return { goalId, plans: listPlans(db, goalId, untilDayKey) };
}
