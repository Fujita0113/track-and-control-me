import type { DB } from '../db/index.js';
import {
  CreatePlanInputSchema,
  CreateCheckInputSchema,
  AnswerQuestionInputSchema,
  SubmitPhotoInputSchema,
  WithdrawInputSchema,
  type CheckKind,
  type CheckSchedule,
  type CheckStatus,
  type Chronicle,
  type DueCheck,
  type GoalCheck,
  type GoalCheckResult,
  type GoalPlan,
  type PlanStatus,
} from '@track/contract';
import { addJournalImage, getGoal, GoalNotFoundError } from './goals.js';
import { addDaysKey } from './day-key.js';
import {
  listPlans,
  getChronicle,
  resultsOf,
  toResultView,
  toCheckView,
  toPlanView,
  type CheckRow,
  type PlanRow,
  type ResultRow,
} from './goal-chronicle.js';
import { todayKey } from './summary.js';
import {
  checkLabel,
  isCheckActiveOn,
  isCheckMetOn,
  rangeDayNumber,
  type CheckState,
} from './goal-check-state.js';

/**
 * Plan（賭け）と Check（答え合わせ）のサービス層
 * （spec: goal-plan-check / goal-chronicle / design.md D1・D5・D9）。
 *
 * 達成状態は永続化しない（D2）。ここが永続させるのは終端の `withdrawn` / `cancelled` と
 * その理由テキストのみ＝「逃げた事実そのものが歴史に残る」（D9）。
 */

export class PlanCheckError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PlanCheckError';
  }
}
export class PlanNotFoundError extends Error {
  constructor(id: number) {
    super(`Plan が見つかりません: ${id}`);
    this.name = 'PlanNotFoundError';
  }
}
export class CheckNotFoundError extends Error {
  constructor(id: number) {
    super(`Check が見つかりません: ${id}`);
    this.name = 'CheckNotFoundError';
  }
}
/** 作成後は変更できない項目（写真Check の先指定キャプション）への変更。API は 409。 */
export class CheckImmutableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CheckImmutableError';
  }
}

// 行の型・ビュー整形（toPlanView など）は読み取りモデル（goal-chronicle.ts）と共有する。

function planRow(db: DB, id: number): PlanRow {
  const r = db.prepare('SELECT * FROM goal_plan WHERE id = ?').get(id) as PlanRow | undefined;
  if (!r) throw new PlanNotFoundError(id);
  return r;
}
function checkRow(db: DB, id: number): CheckRow {
  const r = db.prepare('SELECT * FROM goal_check WHERE id = ?').get(id) as CheckRow | undefined;
  if (!r) throw new CheckNotFoundError(id);
  return r;
}
function resultDayKeys(db: DB, checkId: number): string[] {
  return (
    db.prepare('SELECT day_key FROM goal_check_result WHERE check_id = ?').all(checkId) as {
      day_key: string;
    }[]
  ).map((r) => r.day_key);
}

/** 導出用の CheckState（Plan の取り下げも織り込む）へ写す。 */
function toState(c: CheckRow, planWithdrawn: boolean): CheckState {
  return {
    schedule: c.schedule,
    startDayKey: c.start_day_key,
    spanDays: c.span_days,
    status: c.status,
    planWithdrawn,
  };
}

/**
 * 単発Check が「達成済み」か＝提出が1件でもあるか。
 *
 * 範囲Check は各日が独立で「全体としての達成」という概念を持たないため、途中まで提出していても
 * 取り下げられる（ユーザーフローの「やめた ― 続かなかった。3日で飽きた」＝3日提出後の取り下げ）。
 * 一度きりの事実が確定した単発Check だけが取り下げ不能になる。
 */
function isSatisfied(db: DB, c: CheckRow): boolean {
  if (c.schedule !== 'single') return false;
  const n = db
    .prepare('SELECT COUNT(*) AS c FROM goal_check_result WHERE check_id = ?')
    .get(c.id) as { c: number };
  return n.c > 0;
}

/** 進行中の目標のみ書き込みを許す（開始前・完走後は拒否）。 */
function requireActiveGoal(db: DB, goalId: number, nowMs: number): { startDay: string; endDay: string } {
  const g = getGoal(db, goalId, nowMs); // 不在は GoalNotFoundError（404）。
  if (g.status !== 'active')
    throw new PlanCheckError(
      g.status === 'completed' ? '完走した目標には書き込めません' : '開始前の目標には書き込めません',
    );
  return { startDay: g.startDay, endDay: g.endDay };
}

// --- Plan -----------------------------------------------------------------

/**
 * Plan を作成する（3.1）。進行中の目標のみ・本文非空。**種別は無い**（本文を読めば分かる）。
 * Check を1つも持たない Plan も作れる（方針だけを書く場合）。
 */
export function createPlan(db: DB, goalId: number, input: unknown, nowMs = Date.now()): GoalPlan {
  requireActiveGoal(db, goalId, nowMs);
  const parsed = CreatePlanInputSchema.safeParse(input);
  if (!parsed.success) throw new PlanCheckError('Plan の本文を入力してください');
  const dayKey = todayKey(db, nowMs);
  const info = db
    .prepare(
      `INSERT INTO goal_plan (goal_id, day_key, body, status, withdraw_reason, created_at)
       VALUES (?, ?, ?, 'active', NULL, ?)`,
    )
    .run(goalId, dayKey, parsed.data.body, nowMs);
  return toPlanView(db, planRow(db, info.lastInsertRowid as number));
}

/**
 * Plan を理由つきで取り下げる（3.6 / D9）。理由は非空必須。
 * ぶら下がる**未達**の Check をすべて `cancelled` にする（達成済みの単発Check は事実として残す）。
 * 取り下げた Plan / Check は沿革から消さない。
 */
export function withdrawPlan(db: DB, planId: number, input: unknown): GoalPlan {
  const p = planRow(db, planId);
  const parsed = WithdrawInputSchema.safeParse(input);
  if (!parsed.success) throw new PlanCheckError('取り下げの理由を入力してください');
  if (p.status === 'withdrawn') throw new PlanCheckError('この Plan は既に取り下げ済みです');
  const reason = parsed.data.reason;

  const tx = db.transaction(() => {
    db.prepare("UPDATE goal_plan SET status = 'withdrawn', withdraw_reason = ? WHERE id = ?").run(
      reason,
      planId,
    );
    const checks = db.prepare('SELECT * FROM goal_check WHERE plan_id = ?').all(planId) as CheckRow[];
    for (const c of checks) {
      if (c.status === 'cancelled') continue;
      if (isSatisfied(db, c)) continue; // 達成済みの事実は取り消さない。
      db.prepare("UPDATE goal_check SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(
        reason,
        c.id,
      );
    }
  });
  tx();
  return toPlanView(db, planRow(db, planId));
}

// --- Check ----------------------------------------------------------------

/**
 * Check を作成する（3.2 / 3.3）。**種類（📷/💬）と いつ（単発/範囲）は独立した2軸**で、
 * 全4通り（📷×単発・📷×範囲・💬×単発・💬×範囲）が等しく作れる — 種類が「いつ」を決めない。
 *
 * 「いつ」は相対（`startInDays`＝3日後）・絶対（`startDayKey`＝7/18）のどちらの入力でも、
 * ここで固定 `start_day_key` へ解決して保存する（以後どちらの入力だったかは残さない）。
 * 場所メモ・時刻メモは説明メタデータのみで判定には使わない（D8）。
 */
export function createCheck(db: DB, planId: number, input: unknown, nowMs = Date.now()): GoalCheck {
  const p = planRow(db, planId);
  const { endDay } = requireActiveGoal(db, p.goal_id, nowMs);
  if (p.status === 'withdrawn') throw new PlanCheckError('取り下げた Plan には Check を足せません');

  // 2軸それぞれを独立に検証してから schema で最終確定する。軸ごとに見ることで、
  // 「📷 なのに範囲日数が足りない」を キャプションのエラーとして誤報しない。
  const i = (input ?? {}) as Record<string, unknown>;
  if (i.kind === 'photo' && !String(i.caption ?? '').trim())
    throw new PlanCheckError('撮るもの（キャプション）を入力してください');
  if (i.kind === 'question' && !String(i.questionText ?? '').trim())
    throw new PlanCheckError('質問文を入力してください');
  if (i.schedule === 'range' && !(Number.isInteger(i.spanDays) && (i.spanDays as number) >= 2))
    throw new PlanCheckError('範囲は2日以上で指定してください');

  const parsed = CreateCheckInputSchema.safeParse(input);
  if (!parsed.success) throw new PlanCheckError('Check の入力が不正です');
  // 2軸の独立を表す「union の交差」は、型としては判別 union にならず TS が絞り込めない。
  // 検証は上の safeParse が済ませているので、ここは検証後の値を平坦な形で読む。
  const d = parsed.data as {
    kind: CheckKind;
    caption?: string;
    questionText?: string;
    schedule: CheckSchedule;
    startDayKey?: string;
    startInDays?: number;
    spanDays?: number;
    placeNote?: string;
    timeNote?: string;
  };

  // 相対・絶対のどちらも固定 day_key へ解決する。相対の基準日は「仕掛けた日」。
  const today = todayKey(db, nowMs);
  const startDayKey = d.startDayKey ? d.startDayKey : addDaysKey(today, d.startInDays ?? 0);
  if (startDayKey < today) throw new PlanCheckError('過去の日には Check を仕掛けられません');
  if (startDayKey > endDay) throw new PlanCheckError('目標期間より後の日には Check を仕掛けられません');

  const kind: CheckKind = d.kind;
  const schedule: CheckSchedule = d.schedule;
  const spanDays = schedule === 'range' ? (d.spanDays ?? null) : null;
  const info = db
    .prepare(
      `INSERT INTO goal_check
         (plan_id, kind, caption, question_text, schedule, start_day_key, span_days, place_note, time_note, status, cancel_reason, created_at)
       VALUES (@plan, @kind, @caption, @question, @schedule, @start, @span, @place, @time, 'active', NULL, @now)`,
    )
    .run({
      plan: planId,
      kind,
      caption: kind === 'photo' ? (d.caption ?? '') : '',
      question: kind === 'question' ? (d.questionText ?? '') : '',
      schedule,
      start: startDayKey,
      span: spanDays,
      place: d.placeNote || null,
      time: d.timeNote || null,
      now: nowMs,
    });
  return toCheckView(db, checkRow(db, info.lastInsertRowid as number));
}

/**
 * 写真Check のキャプションは**作成後変更できない**（3.4 / D5）。
 * 先に決めて後から変えないことで ③Before/After のグループ化キーが決定的になり、提出物が
 * 自動で正しい列に入る。呼ばれたら常に拒否する（この関数が「変更不可」の実装点）。
 */
export function updateCheckCaption(db: DB, checkId: number, _caption: string): never {
  const c = checkRow(db, checkId); // 不在は 404 のまま返す。
  throw new CheckImmutableError(
    c.kind === 'photo'
      ? '写真Check のキャプションは作成後に変更できません'
      : '質問Check にキャプションはありません',
  );
}

/**
 * Check を理由つきで取り下げる（3.6 / D9）。理由は非空必須。達成済み（単発で提出済み）は拒否。
 * 取り下げるとゲートから外れ、沿革には理由つきで残る。
 */
export function cancelCheck(db: DB, checkId: number, input: unknown): GoalCheck {
  const c = checkRow(db, checkId);
  const parsed = WithdrawInputSchema.safeParse(input);
  if (!parsed.success) throw new PlanCheckError('取り下げの理由を入力してください');
  if (c.status === 'cancelled') throw new PlanCheckError('この Check は既に取り下げ済みです');
  if (isSatisfied(db, c)) throw new PlanCheckError('達成済みの Check は取り下げられません');
  db.prepare("UPDATE goal_check SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(
    parsed.data.reason,
    checkId,
  );
  return toCheckView(db, checkRow(db, checkId));
}

// --- 回答 -----------------------------------------------------------------

/** 回答を受け付ける前の共通検証（有効な Check か・その日に要求されているか）。 */
function requireAnswerable(db: DB, c: CheckRow, dayKey: string): void {
  const p = planRow(db, c.plan_id);
  const state = toState(c, p.status === 'withdrawn');
  if (c.status === 'cancelled') throw new PlanCheckError('取り下げた Check には回答できません');
  if (p.status === 'withdrawn') throw new PlanCheckError('取り下げた Plan の Check には回答できません');
  if (dayKey < c.start_day_key) throw new PlanCheckError('この Check はまだ始まっていません');
  if (isCheckMetOn(state, resultDayKeys(db, c.id), dayKey))
    throw new PlanCheckError('この Check には既に回答済みです');
  // 範囲Check は期間内の各日のみ（期間を過ぎた分は後から埋められない＝その日の姿は再現不能）。
  if (c.schedule === 'range' && rangeDayNumber(state, dayKey) === null)
    throw new PlanCheckError('範囲Check の期間を過ぎています（後から埋めることはできません）');
}

/**
 * 写真Check へ提出する（D5）。**キャプションは先指定のため受け取らない**。
 * 画像は既存 `goal_journal_image` へ goal_id・提出日 day_key・Check の先指定キャプションで保存し、
 * その image_id を result に持つ＝ `goal-report ③` の Before/After へ自動流入する。
 */
export function submitPhoto(
  db: DB,
  checkId: number,
  dayKey: string,
  input: unknown,
  nowMs = Date.now(),
): GoalCheckResult {
  const c = checkRow(db, checkId);
  if (c.kind !== 'photo') throw new PlanCheckError('この Check は写真の提出先ではありません');
  const parsed = SubmitPhotoInputSchema.safeParse(input);
  if (!parsed.success) throw new PlanCheckError('画像を選択してください');
  requireAnswerable(db, c, dayKey);
  const goalId = planRow(db, c.plan_id).goal_id;

  const tx = db.transaction(() => {
    // 先指定キャプションで焼き込む（③のグループ化キーが決定的になる）。
    const img = addJournalImage(
      db,
      goalId,
      dayKey,
      {
        dataUrl: parsed.data.dataUrl,
        caption: c.caption,
        width: parsed.data.width ?? null,
        height: parsed.data.height ?? null,
      },
      nowMs,
    );
    const info = db
      .prepare(
        `INSERT INTO goal_check_result (check_id, day_key, image_id, answer_text, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(checkId, dayKey, img.imageId, nowMs);
    return info.lastInsertRowid as number;
  });
  const id = tx();
  return toResultView(db.prepare('SELECT * FROM goal_check_result WHERE id = ?').get(id) as ResultRow);
}

/** 質問Check へ回答する。空回答は拒否（AnswerQuestionInputSchema が trim 後に非空を要求）。 */
export function answerQuestion(
  db: DB,
  checkId: number,
  dayKey: string,
  input: unknown,
  nowMs = Date.now(),
): GoalCheckResult {
  const c = checkRow(db, checkId);
  if (c.kind !== 'question') throw new PlanCheckError('この Check は質問への回答先ではありません');
  const parsed = AnswerQuestionInputSchema.safeParse(input);
  if (!parsed.success) throw new PlanCheckError('答えを入力してください');
  requireAnswerable(db, c, dayKey);
  const info = db
    .prepare(
      `INSERT INTO goal_check_result (check_id, day_key, image_id, answer_text, created_at)
       VALUES (?, ?, NULL, ?, ?)`,
    )
    .run(checkId, dayKey, parsed.data.answerText, nowMs);
  return toResultView(
    db.prepare('SELECT * FROM goal_check_result WHERE id = ?').get(info.lastInsertRowid as number) as ResultRow,
  );
}

// 沿革の読み取り（listPlans / getChronicle）は goal-chronicle.ts にある。
// 書き込み後の応答で使うため、ここから再エクスポートして呼び出し側の import 先を1つに保つ。
export { listPlans, getChronicle };

// --- その日に回答すべき Check（今日タブ・トースト）-------------------------

/** 対象日に有効な Check 1件（met つき）。解錠評価の合流と今日タブの表示が共有する。 */
export interface ActiveCheckOn extends DueCheck {
  met: boolean;
}

/**
 * その日に**有効な**（＝ゲートに合流する）Check を全目標から集める。met も併せて導出する。
 * 有効／met の判定は純関数（goal-check-state）に委ね、ここは行の供給に徹する。
 * 並びは決定的（goal_id → plan_id → check_id）。
 *
 * 解錠評価（合成条件の AND 合流・D4）と今日タブの不足条件が同じ母集合を使うため、
 * 「ゲートは閉じているのに今日タブに出ない」というズレが構造的に起きない。
 */
export function listActiveChecksOn(db: DB, dayKey: string): ActiveCheckOn[] {
  // start_day_key <= dayKey で粗く絞り、範囲の上限・取り下げは純関数側で確定させる。
  const rows = db
    .prepare(
      `SELECT c.*, p.goal_id AS goal_id, p.body AS plan_body, p.status AS plan_status, g.name AS goal_name
         FROM goal_check c
         JOIN goal_plan p ON p.id = c.plan_id
         JOIN goal g ON g.id = p.goal_id
        WHERE c.status = 'active' AND p.status = 'active' AND c.start_day_key <= ?
        ORDER BY p.goal_id, c.plan_id, c.id`,
    )
    .all(dayKey) as (CheckRow & {
    goal_id: number;
    plan_body: string;
    plan_status: PlanStatus;
    goal_name: string;
  })[];

  const out: ActiveCheckOn[] = [];
  for (const r of rows) {
    const state = toState(r, r.plan_status === 'withdrawn');
    if (!isCheckActiveOn(state, dayKey)) continue; // 範囲の期間外はここで落ちる。
    out.push({
      checkId: r.id,
      planId: r.plan_id,
      goalId: r.goal_id,
      goalName: r.goal_name,
      planBody: r.plan_body,
      kind: r.kind,
      schedule: r.schedule,
      label: checkLabel(r.kind, r.caption, r.question_text),
      caption: r.caption,
      questionText: r.question_text,
      placeNote: r.place_note,
      timeNote: r.time_note,
      startDayKey: r.start_day_key,
      rangeDayNumber: rangeDayNumber(state, dayKey),
      spanDays: r.span_days,
      met: isCheckMetOn(state, resultDayKeys(db, r.id), dayKey),
    });
  }
  return out;
}

/**
 * その日に**回答すべき**（有効かつ未達の）Check（8.4）。
 * 今日タブの不足条件行と、初回オープン時のトースト（D7）が使う。
 */
export function listDueChecks(db: DB, dayKey: string): DueCheck[] {
  return listActiveChecksOn(db, dayKey)
    .filter((c) => !c.met)
    .map(({ met: _met, ...rest }) => rest);
}

/** 目標の存在確認つきで Plan を作る前に使う再エクスポート（API 層のエラー写像を揃えるため）。 */
export { GoalNotFoundError };
