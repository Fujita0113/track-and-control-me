import type { DB } from '../db/index.js';
import { addDaysKey } from './day-key.js';
import { getGoal, goalPace, type GoalPaceView, type GoalTargetHoursView } from './goals.js';

/**
 * 大きい沿革＝目標そのものの年表（spec: goal-history / design D7）。
 *
 * 載るのは目標の**作成・終了・完走**の3種のみ（ルール操作・凍結は⑤沿革が読み手）。
 * 終了・完走の行は数字（目標時間の到達/未達）・自己申告（めざした状態）・証拠写真の3つを並べる。
 * 到達判定と自己申告は**終了・完走の時点で焼き込む**（`goal.final_pace_json` / `outcome_met`）。
 * 写真は焼き込まず、常に**都度解決**する（後から出した写真を反映するため）。
 *
 * 「完走」は明示的なイベントが起きない（cron を持たない設計）ため、焼き込みが無い。
 * その代わり `goalPace()` は完走後（`today > 実効 end_day`）ずっと同じ値を返す
 * （分母のクランプにより自然に安定する）ので、都度計算で焼き込みと同じ効果が得られる。
 * 状態（'ended'/'completed'/未決着の単発ルールによる保留）は既存の `getGoal()` の導出に委ね、
 * ここで独自の判定ロジックを持たない。
 */

export type GoalHistoryEntryKind = 'created' | 'ended' | 'completed';

export interface GoalHistoryPhoto {
  imageId: number;
  dayKey: string;
  caption: string;
}

export interface GoalHistoryEntry {
  kind: GoalHistoryEntryKind;
  goalId: number;
  name: string;
  dayKey: string;
  /** 'created' のみ非 null: めざす状態・始めた理由。 */
  purpose: string | null;
  /** 'created' は始めた理由、'ended' は終えた理由。'completed'（自然完走）は null。 */
  reason: string | null;
  /** 目標時間の到達/未達（'ended'/'completed' のみ）。目標時間が無ければ null。 */
  pace: GoalPaceView | null;
  /** 目標時間の定義（'created' のみ非 null）。「＋作成」行に内容を出すため（design D7）。 */
  targetHours: GoalTargetHoursView | null;
  /** めざした状態の自己申告（3値）。未回答・対象外は null。 */
  outcomeMet: boolean | null;
  /**
   * 'ended' が**まだ発効していない**（終了予約中＝`today < ended_day_key`）か。
   * 終了は翌日発効なので、終えた当日から「予約中」の印つきで並ぶ（spec: goal-history MODIFIED）。
   * 'created'/'completed' は常に false。
   */
  pending: boolean;
  /** 証拠写真（都度解決・design D7）。無ければ両方 null。 */
  photos: { before: GoalHistoryPhoto | null; after: GoalHistoryPhoto | null };
}

interface GoalRow {
  id: number;
  name: string;
  purpose: string;
  start_day: string;
  start_reason: string;
  ended_day_key: string | null;
  end_reason: string | null;
  final_pace_json: string | null;
  outcome_caption: string | null;
  outcome_met: number | null;
}

/** 証拠写真の都度解決（design D7・goal-report ③ と同じ規則: 最古=Before・最新=After）。 */
function resolvePhotos(db: DB, goalId: number, caption: string | null): GoalHistoryEntry['photos'] {
  if (!caption) return { before: null, after: null };
  const rows = db
    .prepare(
      `SELECT id, day_key, caption FROM goal_journal_image
        WHERE goal_id = ? AND caption = ? ORDER BY day_key, sort_order, id`,
    )
    .all(goalId, caption) as { id: number; day_key: string; caption: string }[];
  if (rows.length === 0) return { before: null, after: null };
  const toPhoto = (r: { id: number; day_key: string; caption: string }): GoalHistoryPhoto => ({
    imageId: r.id,
    dayKey: r.day_key,
    caption: r.caption,
  });
  const before = toPhoto(rows[0]!);
  const after = rows.length > 1 ? toPhoto(rows[rows.length - 1]!) : null;
  return { before, after };
}

function outcomeMetOf(row: { outcome_met: number | null }): boolean | null {
  return row.outcome_met == null ? null : row.outcome_met === 1;
}

/** dayKey 昇順・同日内は id 昇順で決定的に並べるためのソートキー。 */
function sortKey(dayKey: string, id: number, rank: number): string {
  return `${dayKey}|${String(id).padStart(10, '0')}|${rank}`;
}

/**
 * 大きい沿革を組み立てる。目標の作成・終了・完走を day_key 昇順（同日内は id 昇順）で返す。
 * 完走（自然・未終了）の到達判定は都度計算（焼き込みと同じ安定性を持つ・上部コメント参照）。
 */
export function goalHistory(db: DB, nowMs = Date.now()): GoalHistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT id, name, purpose, start_day, start_reason, ended_day_key, end_reason,
              final_pace_json, outcome_caption, outcome_met
         FROM goal ORDER BY id`,
    )
    .all() as GoalRow[];

  const out: { key: string; entry: GoalHistoryEntry }[] = [];
  for (const row of rows) {
    const view = getGoal(db, row.id, nowMs);
    // 「＋作成」行の初期写真＝そのキャプションで最古の画像（Before）。設定時に置いていなければ null。
    const initialPhoto = resolvePhotos(db, row.id, row.outcome_caption).before;
    out.push({
      key: sortKey(row.start_day, row.id, 0),
      entry: {
        kind: 'created',
        goalId: row.id,
        name: row.name,
        dayKey: row.start_day,
        purpose: row.purpose,
        reason: row.start_reason,
        pace: null,
        targetHours: view.targetHours,
        outcomeMet: null,
        photos: { before: initialPhoto, after: null },
        pending: false,
      },
    });

    // 「−終える」の行は `ended_day_key`（＝発効日）から導出する。終了は翌日発効なので、
    // 発効前でも「予約中」として当日から並び、取消で `ended_day_key` が消えれば行も消える。
    if (row.ended_day_key != null) {
      out.push({
        key: sortKey(row.ended_day_key, row.id, 1),
        entry: {
          kind: 'ended',
          goalId: row.id,
          name: row.name,
          dayKey: row.ended_day_key,
          purpose: null,
          reason: row.end_reason,
          pace: row.final_pace_json ? (JSON.parse(row.final_pace_json) as GoalPaceView) : null,
          targetHours: null,
          outcomeMet: outcomeMetOf(row),
          photos: resolvePhotos(db, row.id, row.outcome_caption),
          pending: view.endingOn != null,
        },
      });
    } else if (view.status === 'completed') {
      const completedDayKey = addDaysKey(view.endDay, 1);
      out.push({
        key: sortKey(completedDayKey, row.id, 1),
        entry: {
          kind: 'completed',
          goalId: row.id,
          name: row.name,
          dayKey: completedDayKey,
          purpose: null,
          reason: null,
          pace: goalPace(db, row.id, nowMs),
          targetHours: null,
          outcomeMet: outcomeMetOf(row),
          photos: resolvePhotos(db, row.id, row.outcome_caption),
          pending: false,
        },
      });
    }
  }

  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out.map((x) => x.entry);
}
