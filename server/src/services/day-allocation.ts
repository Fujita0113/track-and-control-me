import { UNGROUPED_KEY } from '@track/contract';
import type { DB } from '../db/index.js';
import { getTimeline } from './timeline.js';
import { todayKey, snapshotIdentityKey, snapshotDisplayName } from './summary.js';

/**
 * 一日の配分（day allocation）集計（spec: reflection-day-overview / design D2・D3）。
 *
 * 「その日をどう過ごしたか」を覚醒時間の近似（記録の端〜端）に対する持ち分（credited）の
 * 内訳として返す。総作業時間を分母とする today-group-breakdown とは別物で、
 * 休憩（自己申告）・未記録を含む。
 *
 * - WORK スライス: `session` を記録時点スナップショットの「名前＋色」identity 別に `credited_ms` 合算
 *   （`today-group-breakdown` と同一の束ね方。`stable_group_id` の入れ替わりで同一グループが分裂しない）。
 * - MANUAL スライス: `activity_log_entry`(MANUAL) を `category_key` 別に `span/n`（持ち分秒）合算。
 * - 分母（母数）= 最初の記録の開始〜最後の記録の終了。対象日が当日なら現在時刻を上限に含める。
 *   日境界先頭・末尾の空白は母数に含めない。
 * - 未記録 = 母数 − 全スライス持ち分。÷N の持ち分が各瞬間を過不足なく分割するため、
 *   これは端〜端の内側の未カバー区間（gap union）に一致し、円がちょうど閉じる。
 */

export type SliceKind = 'WORK' | 'MANUAL';

export interface AllocationSlice {
  key: string;
  label: string;
  color: string | null;
  kind: SliceKind;
  seconds: number;
}

export interface DayAllocation {
  dayKey: string;
  extentStart: number | null;
  extentEnd: number | null;
  totalSeconds: number;
  slices: AllocationSlice[];
  untrackedSeconds: number;
}

export function getDayAllocation(db: DB, dayKey: string, nowMs = Date.now()): DayAllocation {
  const tl = getTimeline(db, dayKey, nowMs);
  const isToday = todayKey(db, nowMs) === dayKey;

  // WORK スライス: 名前＋色 identity 別に credited_ms を合算（today-group-breakdown と共有・design D1）。
  // ラベル・色は identity 内の最新（startAt 最大）記録時点スナップショットを採用。
  // 未グループ identity は表示名「その他（未グループ）」・色 null に揃える。
  const workMap = new Map<string, { label: string; color: string | null; ms: number; last: number }>();
  for (const b of tl.auto) {
    const identity = snapshotIdentityKey(b.stableGroupId, b.title, b.color);
    const label = snapshotDisplayName(identity, b.title);
    const color = identity === UNGROUPED_KEY ? null : b.color;
    const prev = workMap.get(identity);
    if (prev) {
      prev.ms += b.creditedMs;
      if (b.startAt >= prev.last) { prev.label = label; prev.color = color; prev.last = b.startAt; }
    } else {
      workMap.set(identity, { label, color, ms: b.creditedMs, last: b.startAt });
    }
  }

  // MANUAL スライス: カテゴリ別に持ち分秒（span/n = creditedSeconds）を合算。
  const manualMap = new Map<string, { label: string; color: string | null; seconds: number; last: number }>();
  for (const m of tl.manual) {
    const key = m.categoryKey ?? 'uncategorized';
    const prev = manualMap.get(key);
    if (prev) {
      prev.seconds += m.creditedSeconds;
      if (m.startAt >= prev.last) { prev.label = m.title; prev.color = m.color; prev.last = m.startAt; }
    } else {
      manualMap.set(key, { label: m.title, color: m.color, seconds: m.creditedSeconds, last: m.startAt });
    }
  }

  // 端〜端（記録が1件も無ければ母数ゼロ・スライス空）。
  const starts = [...tl.auto.map((b) => b.startAt), ...tl.manual.map((m) => m.startAt)];
  const ends = [...tl.auto.map((b) => b.endAt), ...tl.manual.map((m) => m.endAt)];
  if (starts.length === 0) {
    return { dayKey, extentStart: null, extentEnd: null, totalSeconds: 0, slices: [], untrackedSeconds: 0 };
  }
  const extentStart = Math.min(...starts);
  const lastEnd = Math.max(...ends);
  const extentEnd = isToday ? Math.max(lastEnd, nowMs) : lastEnd;
  const totalSeconds = Math.round((extentEnd - extentStart) / 1000);

  const slices: AllocationSlice[] = [];
  for (const [key, v] of workMap) {
    slices.push({ key: `work:${key}`, label: v.label, color: v.color, kind: 'WORK', seconds: Math.round(v.ms / 1000) });
  }
  for (const [key, v] of manualMap) {
    slices.push({ key: `manual:${key}`, label: v.label, color: v.color, kind: 'MANUAL', seconds: Math.round(v.seconds) });
  }
  slices.sort((a, b) => b.seconds - a.seconds);

  // 未記録 = 母数 − 全スライス持ち分。÷N の持ち分が各瞬間を分割するため gap union に一致し、
  // 単位秒で丸めても Σスライス秒 + untrackedSeconds == totalSeconds を保証する（円が閉じる）。
  const sliceTotal = slices.reduce((acc, s) => acc + s.seconds, 0);
  const untrackedSeconds = Math.max(0, totalSeconds - sliceTotal);

  return { dayKey, extentStart, extentEnd, totalSeconds, slices, untrackedSeconds };
}
