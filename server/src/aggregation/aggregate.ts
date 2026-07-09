import type { GroupColor, IdleState } from '@track/contract';
import { UNGROUPED_KEY } from '@track/contract';
import { splitByDayBoundary } from './time-zone.js';

/**
 * 時間集計 pure 関数（design.md D4）。
 *
 * サンプル列 → 区間化 → divide-by-N 分配 → day_boundary 分割 → 同一 pass で
 *   (a) 日×stableGroupId の（分配後）ミリ秒（DailyTotals）
 *   (b) セッション列 [start,end,group,coactiveGroups]（カレンダー1日ビュー用）
 * を生成する。副作用なし・DB 非依存。
 *
 * 計上ルール:
 *   countable(h) := idleState=='active'（Edge が前面かは不問）
 *   gap = t_{i+1} - t_i、CAP = 90s。countable かつ 0 < gap <= CAP のみ計上。
 *   gap > CAP は 0（スリープ/終了）、負ギャップ・時計ジャンプは 0＋フラグ。
 *   同時オープンは openGroupKeys の全グループへ gap/N 均等分配（総和 = 実時間）。
 */

/** aggregation が必要とする、ActivitySample の最小射影。 */
export interface RawSample {
  clientTs: number; // epoch ms（区間長の一次ソース）
  monotonicMs: number; // 単調時計（時計ジャンプ検出）
  bootId: string;
  seq: number;
  idleState: IdleState;
  /** その時点で開いている実グループ集合（未グループ疑似要素は含まない）。 */
  openGroupKeys: OpenGroup[];
  /** アクティブタブのグループ安定キー。未グループ/無しは null。 */
  activeStableGroupId: string | null;
}

export interface OpenGroup {
  stableGroupId: string;
  title: string;
  color: GroupColor;
}

export interface AggregationConfig {
  gapCapMs: number; // 既定 90_000
  dayBoundaryMinutes: number; // 既定 240 (04:00)
  tz: string; // IANA
  includeUngroupedInSplit: boolean; // 既定 false（未グループを分母に含めない）
  clockJumpToleranceMs: number; // 既定 2_000
}

export const DEFAULT_AGG_CONFIG: AggregationConfig = {
  gapCapMs: 90_000,
  dayBoundaryMinutes: 240,
  tz: 'Asia/Tokyo',
  includeUngroupedInSplit: false,
  clockJumpToleranceMs: 2_000,
};

export type ExcludeReason =
  | 'IDLE'
  | 'LOCKED'
  | 'GAP_EXCEEDED'
  | 'NEGATIVE_GAP'
  | 'CLOCK_JUMP';

export type CloseReason = 'NORMAL' | 'IDLE_TIMEOUT' | 'DAY_BOUNDARY_SPLIT' | 'SLEEP_GAP';

export interface DailyGroupTotal {
  dayKey: string;
  stableGroupId: string; // 実グループ or UNGROUPED_KEY
  ms: number; // 分配後ミリ秒（整数・権威）
  seconds: number; // ms/1000（表示用・端数あり）
}

export interface ExcludedTotal {
  dayKey: string;
  reason: ExcludeReason;
  ms: number;
}

export interface SessionRow {
  stableGroupId: string; // 実グループ or UNGROUPED_KEY
  title: string;
  color: GroupColor | null;
  startMs: number;
  endMs: number;
  dayKey: string;
  /** 同区間に同時オープンだった他グループの安定キー（ソート済み）。 */
  coactiveGroupKeys: string[];
  /** 分配の分母（openKeys の数。未グループ単独は 1）。 */
  n: number;
  /** このセッションの分配後ミリ秒 = duration/n。 */
  creditedMs: number;
  closeReason: CloseReason;
}

export interface Anomaly {
  kind: 'DUPLICATE' | 'NEGATIVE_GAP' | 'CLOCK_JUMP';
  atMs: number;
  detail: string;
}

export interface AggregationResult {
  dailyTotals: DailyGroupTotal[];
  sessions: SessionRow[];
  excluded: ExcludedTotal[];
  anomalies: Anomaly[];
  stats: {
    inputSamples: number;
    dedupedSamples: number;
    countedMs: number;
    excludedMs: number;
  };
}

// --- 内部表現 -------------------------------------------------------------

/** day_boundary で分割後の「計上スラブ」。start/end は同一日内。 */
interface Slab {
  kind: 'slab';
  startMs: number;
  endMs: number;
  dayKey: string;
  openKeys: string[]; // 分配先（ソート済み）。空なら未グループ単独。
  meta: Map<string, OpenGroup>;
}

/** セッションの連続性を断ち切る非計上区間。 */
interface Gap {
  kind: 'gap';
  reason: ExcludeReason;
}

type StreamItem = Slab | Gap;

function keyCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** (bootId, seq) で重複排除。最初に現れたものを採用。 */
function dedupe(samples: RawSample[]): { kept: RawSample[]; duplicates: number } {
  const seen = new Set<string>();
  const kept: RawSample[] = [];
  let duplicates = 0;
  for (const s of samples) {
    const k = `${s.bootId}#${s.seq}`;
    if (seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    kept.push(s);
  }
  return { kept, duplicates };
}

/** clientTs 昇順、同着は (bootId, seq)。 */
function sortSamples(samples: RawSample[]): RawSample[] {
  return [...samples].sort((a, b) => {
    if (a.clientTs !== b.clientTs) return a.clientTs - b.clientTs;
    if (a.bootId !== b.bootId) return keyCompare(a.bootId, b.bootId);
    return a.seq - b.seq;
  });
}

/** 区間 [head, next) の計上可否を判定する。 */
function classifyInterval(
  head: RawSample,
  next: RawSample,
  config: AggregationConfig,
): { counted: true } | { counted: false; reason: ExcludeReason } {
  const rawGap = next.clientTs - head.clientTs;
  if (rawGap <= 0) return { counted: false, reason: 'NEGATIVE_GAP' };
  if (head.bootId === next.bootId) {
    const monoGap = next.monotonicMs - head.monotonicMs;
    if (monoGap < 0 || Math.abs(rawGap - monoGap) > config.clockJumpToleranceMs) {
      return { counted: false, reason: 'CLOCK_JUMP' };
    }
  }
  if (head.idleState === 'idle') return { counted: false, reason: 'IDLE' };
  if (head.idleState === 'locked') return { counted: false, reason: 'LOCKED' };
  if (rawGap > config.gapCapMs) return { counted: false, reason: 'GAP_EXCEEDED' };
  return { counted: true };
}

/** 分配先キー集合を決める（未グループの分母算入は設定次第）。 */
function resolveOpenKeys(
  head: RawSample,
  config: AggregationConfig,
): { openKeys: string[]; meta: Map<string, OpenGroup> } {
  const meta = new Map<string, OpenGroup>();
  for (const g of head.openGroupKeys) meta.set(g.stableGroupId, g);
  const realKeys = head.openGroupKeys.map((g) => g.stableGroupId);
  if (realKeys.length === 0) return { openKeys: [], meta };
  const keys = [...realKeys];
  if (config.includeUngroupedInSplit && head.activeStableGroupId === null) {
    keys.push(UNGROUPED_KEY);
  }
  keys.sort(keyCompare);
  return { openKeys: keys, meta };
}

/** duration を n 分割し、端数(ms)を先頭から 1ms ずつ配って総和を保存。 */
function distribute(durationMs: number, keys: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const n = keys.length;
  if (n === 0) return out;
  const base = Math.floor(durationMs / n);
  let remainder = durationMs - base * n;
  for (const k of keys) {
    out.set(k, base + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder--;
  }
  return out;
}

/**
 * 重み付き分配（task 6.7 の割合上書き用）。weights は keys 部分集合の比率。
 * 総和は durationMs を保存（実時間を超えない）。全重み 0 の場合は均等分配に戻す。
 */
function distributeWeighted(
  durationMs: number,
  keys: string[],
  weights: Record<string, number>,
): Map<string, number> {
  const w = keys.map((k) => Math.max(0, weights[k] ?? 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) return distribute(durationMs, keys);
  const out = new Map<string, number>();
  let allocated = 0;
  // 最終キー以外を floor 配分し、残差を末尾に寄せて総和を保存。
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (i === keys.length - 1) {
      out.set(key, durationMs - allocated);
    } else {
      const share = Math.floor((durationMs * w[i]!) / sum);
      out.set(key, share);
      allocated += share;
    }
  }
  return out;
}

/** 区間 [start,end) の中点を含む override を返す（先勝ち）。 */
function overrideFor(
  startMs: number,
  endMs: number,
  overrides: SplitOverride[],
): SplitOverride | undefined {
  const mid = (startMs + endMs) / 2;
  return overrides.find((o) => mid >= o.startMs && mid < o.endMs);
}

/** task 6.7: 同時進行区間の割合上書き。 */
export interface SplitOverride {
  startMs: number;
  endMs: number;
  ratios: Record<string, number>; // stableGroupId -> 比率（0 可）
}

/** メイン集計関数。 */
export function aggregateSamples(
  samples: RawSample[],
  config: AggregationConfig = DEFAULT_AGG_CONFIG,
  overrides: SplitOverride[] = [],
): AggregationResult {
  const { kept, duplicates } = dedupe(samples);
  const sorted = sortSamples(kept);

  const anomalies: Anomaly[] = [];
  if (duplicates > 0) {
    anomalies.push({
      kind: 'DUPLICATE',
      atMs: sorted[0]?.clientTs ?? 0,
      detail: `${duplicates} 件の重複サンプルを排除`,
    });
  }

  const totalsMs = new Map<string, number>(); // `${dayKey} ${key}` -> ms
  const excludedMs = new Map<string, number>(); // `${dayKey} ${reason}` -> ms
  const stream: StreamItem[] = [];
  let countedMs = 0;
  let excludedTotalMs = 0;

  for (let i = 0; i + 1 < sorted.length; i++) {
    const head = sorted[i]!;
    const next = sorted[i + 1]!;
    const verdict = classifyInterval(head, next, config);

    if (!verdict.counted) {
      if (verdict.reason === 'NEGATIVE_GAP') {
        anomalies.push({ kind: 'NEGATIVE_GAP', atMs: head.clientTs, detail: `seq ${head.seq}` });
      } else if (verdict.reason === 'CLOCK_JUMP') {
        anomalies.push({ kind: 'CLOCK_JUMP', atMs: head.clientTs, detail: `seq ${head.seq}` });
      }
      const parts = splitByDayBoundary(
        head.clientTs,
        next.clientTs,
        config.tz,
        config.dayBoundaryMinutes,
      );
      for (const p of parts) {
        const dur = p.endMs - p.startMs;
        if (dur <= 0) continue;
        const ek = `${p.dayKey} ${verdict.reason}`;
        excludedMs.set(ek, (excludedMs.get(ek) ?? 0) + dur);
        excludedTotalMs += dur;
      }
      stream.push({ kind: 'gap', reason: verdict.reason });
      continue;
    }

    const { openKeys, meta } = resolveOpenKeys(head, config);
    const parts = splitByDayBoundary(
      head.clientTs,
      next.clientTs,
      config.tz,
      config.dayBoundaryMinutes,
    );
    for (const p of parts) {
      const dur = p.endMs - p.startMs;
      if (dur <= 0) continue;
      stream.push({
        kind: 'slab',
        startMs: p.startMs,
        endMs: p.endMs,
        dayKey: p.dayKey,
        openKeys,
        meta,
      });
      if (openKeys.length === 0) {
        const tk = `${p.dayKey} ${UNGROUPED_KEY}`;
        totalsMs.set(tk, (totalsMs.get(tk) ?? 0) + dur);
      } else {
        const ov = overrides.length > 0 ? overrideFor(p.startMs, p.endMs, overrides) : undefined;
        const shares = ov ? distributeWeighted(dur, openKeys, ov.ratios) : distribute(dur, openKeys);
        for (const [k, v] of shares) {
          const tk = `${p.dayKey} ${k}`;
          totalsMs.set(tk, (totalsMs.get(tk) ?? 0) + v);
        }
      }
      countedMs += dur;
    }
  }

  const sessions = buildSessions(stream);

  const dailyTotals: DailyGroupTotal[] = [];
  for (const [k, ms] of totalsMs) {
    const [dayKey, stableGroupId] = k.split(' ');
    dailyTotals.push({ dayKey: dayKey!, stableGroupId: stableGroupId!, ms, seconds: ms / 1000 });
  }
  dailyTotals.sort(
    (a, b) => keyCompare(a.dayKey, b.dayKey) || keyCompare(a.stableGroupId, b.stableGroupId),
  );

  const excluded: ExcludedTotal[] = [];
  for (const [k, ms] of excludedMs) {
    const [dayKey, reason] = k.split(' ');
    excluded.push({ dayKey: dayKey!, reason: reason as ExcludeReason, ms });
  }
  excluded.sort((a, b) => keyCompare(a.dayKey, b.dayKey) || keyCompare(a.reason, b.reason));

  return {
    dailyTotals,
    sessions,
    excluded,
    anomalies,
    stats: {
      inputSamples: samples.length,
      dedupedSamples: sorted.length,
      countedMs,
      excludedMs: excludedTotalMs,
    },
  };
}

interface LaneBuilder {
  stableGroupId: string;
  title: string;
  color: GroupColor | null;
  startMs: number;
  endMs: number;
  dayKey: string;
  coactiveGroupKeys: string[];
  n: number;
}

function laneKeyOf(groupKey: string, coactiveSig: string): string {
  return `${groupKey} ${coactiveSig}`;
}

function gapCloseReason(reason: ExcludeReason): CloseReason {
  switch (reason) {
    case 'IDLE':
    case 'LOCKED':
      return 'IDLE_TIMEOUT';
    default:
      return 'SLEEP_GAP';
  }
}

/**
 * ストリーム（Slab | Gap）→ セッション列。
 * divide-by-N の各グループを「レーン」とみなす。連続かつ同 day・同 co-active
 * のスラブは1セッションへ結合。co-active/グループ離脱は NORMAL、日跨ぎは
 * DAY_BOUNDARY_SPLIT、非計上区間による中断は IDLE_TIMEOUT/SLEEP_GAP で close。
 */
function buildSessions(stream: StreamItem[]): SessionRow[] {
  const open = new Map<string, LaneBuilder>();
  const done: SessionRow[] = [];

  const flush = (b: LaneBuilder, reason: CloseReason): void => {
    const durationMs = b.endMs - b.startMs;
    done.push({
      stableGroupId: b.stableGroupId,
      title: b.title,
      color: b.color,
      startMs: b.startMs,
      endMs: b.endMs,
      dayKey: b.dayKey,
      coactiveGroupKeys: b.coactiveGroupKeys,
      n: b.n,
      creditedMs: Math.round(durationMs / b.n),
      closeReason: reason,
    });
  };

  let prevEnd: number | null = null;

  for (const item of stream) {
    if (item.kind === 'gap') {
      for (const b of open.values()) flush(b, gapCloseReason(item.reason));
      open.clear();
      prevEnd = null;
      continue;
    }

    const slab = item;
    const contiguous = prevEnd !== null && slab.startMs === prevEnd;

    // このスラブが定義するレーン集合。
    const lanes: Array<{ laneKey: string; groupKey: string; n: number; coactive: string[] }> = [];
    if (slab.openKeys.length === 0) {
      lanes.push({ laneKey: laneKeyOf(UNGROUPED_KEY, ''), groupKey: UNGROUPED_KEY, n: 1, coactive: [] });
    } else {
      const n = slab.openKeys.length;
      for (const gk of slab.openKeys) {
        const coactive = slab.openKeys.filter((k) => k !== gk);
        lanes.push({ laneKey: laneKeyOf(gk, coactive.join(',')), groupKey: gk, n, coactive });
      }
    }
    const laneKeySet = new Set(lanes.map((l) => l.laneKey));

    // 継続しない既存レーンを close。
    for (const [lk, b] of [...open]) {
      const continues = contiguous && laneKeySet.has(lk) && b.dayKey === slab.dayKey;
      if (!continues) {
        const reason: CloseReason =
          contiguous && laneKeySet.has(lk) && b.dayKey !== slab.dayKey ? 'DAY_BOUNDARY_SPLIT' : 'NORMAL';
        flush(b, reason);
        open.delete(lk);
      }
    }

    // 継続 or 新規オープン。
    for (const lane of lanes) {
      const existing = open.get(lane.laneKey);
      if (existing && existing.dayKey === slab.dayKey) {
        existing.endMs = slab.endMs;
      } else {
        const meta = slab.meta.get(lane.groupKey);
        open.set(lane.laneKey, {
          stableGroupId: lane.groupKey,
          title: meta?.title ?? (lane.groupKey === UNGROUPED_KEY ? 'ungrouped' : lane.groupKey),
          color: meta?.color ?? null,
          startMs: slab.startMs,
          endMs: slab.endMs,
          dayKey: slab.dayKey,
          coactiveGroupKeys: lane.coactive,
          n: lane.n,
        });
      }
    }
    prevEnd = slab.endMs;
  }

  for (const b of open.values()) flush(b, 'NORMAL');
  done.sort((a, b) => a.startMs - b.startMs || keyCompare(a.stableGroupId, b.stableGroupId));
  return done;
}
