import { describe, it, expect } from 'vitest';
import type { GroupColor } from '@track/contract';
import { UNGROUPED_KEY } from '@track/contract';
import {
  aggregateSamples,
  DEFAULT_AGG_CONFIG,
  type AggregationConfig,
  type RawSample,
} from './aggregate.js';
import { zonedTimeToEpoch } from './time-zone.js';

const TZ = 'Asia/Tokyo';

function group(id: string, color: GroupColor = 'blue') {
  return { stableGroupId: id, title: id, color };
}

/** Asia/Tokyo のローカル壁時計 → epoch ms。 */
function jst(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return zonedTimeToEpoch(y, mo, d, h, mi, s, TZ);
}

/** サンプル列ビルダー（seq 自動採番・monotonic=wall 既定）。 */
function builder(bootId = 'boot1') {
  let seq = 0;
  const samples: RawSample[] = [];
  return {
    add(clientTs: number, opts: Partial<RawSample> = {}): void {
      samples.push({
        clientTs,
        monotonicMs: clientTs,
        bootId,
        seq: seq++,
        idleState: 'active',
        openGroupKeys: [],
        activeStableGroupId: null,
        ...opts,
      });
    },
    get(): RawSample[] {
      return samples;
    },
  };
}

function totalFor(
  result: ReturnType<typeof aggregateSamples>,
  dayKey: string,
  key: string,
): number {
  return result.dailyTotals.find((t) => t.dayKey === dayKey && t.stableGroupId === key)?.ms ?? 0;
}

describe('aggregateSamples — CAP 境界', () => {
  it('gap 89s は計上される', () => {
    const b = builder();
    b.add(0, { openGroupKeys: [group('g')] });
    b.add(89_000, { openGroupKeys: [group('g')] });
    const r = aggregateSamples(b.get());
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, 'g')).toBe(89_000);
  });

  it('gap 90s（=CAP）は計上される', () => {
    const b = builder();
    b.add(0, { openGroupKeys: [group('g')] });
    b.add(90_000, { openGroupKeys: [group('g')] });
    const r = aggregateSamples(b.get());
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, 'g')).toBe(90_000);
  });

  it('gap 91s は除外（GAP_EXCEEDED）・0 計上', () => {
    const b = builder();
    b.add(0, { openGroupKeys: [group('g')] });
    b.add(91_000, { openGroupKeys: [group('g')] });
    const r = aggregateSamples(b.get());
    expect(r.dailyTotals).toHaveLength(0);
    expect(r.excluded.some((e) => e.reason === 'GAP_EXCEEDED' && e.ms === 91_000)).toBe(true);
  });
});

describe('aggregateSamples — 深夜 03:30→05:00 の日跨ぎ分割', () => {
  it('03:30〜04:00 は前日、04:00〜05:00 は当日に帰属', () => {
    const b = builder();
    const start = jst(2026, 7, 6, 3, 30, 0);
    // 60s 間隔で 03:30:00〜05:00:00（91 サンプル・90 区間）を単一グループ active で。
    for (let k = 0; k <= 90; k++) {
      b.add(start + k * 60_000, { openGroupKeys: [group('dev')] });
    }
    const r = aggregateSamples(b.get());
    // 04:00 境界 → 前日 2026-07-05、当日 2026-07-06。
    expect(totalFor(r, '2026-07-05', 'dev')).toBe(30 * 60_000); // 30分
    expect(totalFor(r, '2026-07-06', 'dev')).toBe(60 * 60_000); // 60分
    // セッションは日境界で分割される。
    const devSessions = r.sessions.filter((s) => s.stableGroupId === 'dev');
    expect(devSessions.length).toBeGreaterThanOrEqual(2);
    expect(devSessions.some((s) => s.dayKey === '2026-07-05')).toBe(true);
    expect(devSessions.some((s) => s.dayKey === '2026-07-06')).toBe(true);
  });

  it('単一区間が 04:00 をまたぐと按分される', () => {
    const b = builder();
    b.add(jst(2026, 7, 6, 3, 59, 30), { openGroupKeys: [group('dev')] });
    b.add(jst(2026, 7, 6, 4, 0, 30), { openGroupKeys: [group('dev')] });
    const r = aggregateSamples(b.get());
    expect(totalFor(r, '2026-07-05', 'dev')).toBe(30_000);
    expect(totalFor(r, '2026-07-06', 'dev')).toBe(30_000);
  });
});

describe('aggregateSamples — divide-by-N', () => {
  it('2グループ同時オープンは各 1/2、合計 = 実時間', () => {
    const b = builder();
    const open = [group('atcoder'), group('dev')];
    // 60s x 4 区間 = 240s。
    for (let k = 0; k <= 4; k++) {
      b.add(k * 60_000, { openGroupKeys: open, activeStableGroupId: 'atcoder' });
    }
    const r = aggregateSamples(b.get());
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, 'atcoder')).toBe(120_000);
    expect(totalFor(r, day, 'dev')).toBe(120_000);
    const sum = r.dailyTotals.reduce((a, t) => a + t.ms, 0);
    expect(sum).toBe(240_000); // 総和は実時間を超えない
  });

  it('端数は 1ms ずつ配って総和を保存する（3グループ・奇数ミリ秒）', () => {
    const b = builder();
    const open = [group('a'), group('b'), group('c')];
    b.add(0, { openGroupKeys: open });
    b.add(10_001, { openGroupKeys: open }); // 10001 / 3 = 3333 余り 2
    const r = aggregateSamples(b.get());
    const day = r.dailyTotals[0]!.dayKey;
    const sum = r.dailyTotals.reduce((a, t) => a + t.ms, 0);
    expect(sum).toBe(10_001);
    const vals = r.dailyTotals.map((t) => t.ms).sort((x, y) => x - y);
    expect(vals).toEqual([3333, 3334, 3334]);
  });

  it('グループを閉じると分母が減り残りに全額', () => {
    const b = builder();
    b.add(0, { openGroupKeys: [group('a'), group('b')] }); // [0,60s) 2分割
    b.add(60_000, { openGroupKeys: [group('a')] }); // [60s,120s) a のみ
    b.add(120_000, { openGroupKeys: [group('a')] });
    const r = aggregateSamples(b.get());
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, 'a')).toBe(30_000 + 60_000);
    expect(totalFor(r, day, 'b')).toBe(30_000);
  });
});

describe('aggregateSamples — 割合上書き（split override, task 6.7）', () => {
  it('区間を単一グループへ 100% 再割当（0 可）でき、総和は実時間を保存', () => {
    const b = builder();
    const open = [group('a'), group('b')];
    for (let k = 0; k <= 4; k++) b.add(k * 60_000, { openGroupKeys: open });
    const override = [{ startMs: -1, endMs: 240_001, ratios: { a: 1, b: 0 } }];
    const r = aggregateSamples(b.get(), DEFAULT_AGG_CONFIG, override);
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, 'a')).toBe(240_000); // 全額 a
    expect(totalFor(r, day, 'b')).toBe(0);
    expect(r.dailyTotals.reduce((s, t) => s + t.ms, 0)).toBe(240_000);
  });

  it('比率 3:1 で再割当（総和保存）', () => {
    const b = builder();
    const open = [group('a'), group('b')];
    for (let k = 0; k <= 4; k++) b.add(k * 60_000, { openGroupKeys: open });
    const override = [{ startMs: -1, endMs: 240_001, ratios: { a: 3, b: 1 } }];
    const r = aggregateSamples(b.get(), DEFAULT_AGG_CONFIG, override);
    const day = r.dailyTotals[0]!.dayKey;
    const a = totalFor(r, day, 'a');
    const bb = totalFor(r, day, 'b');
    expect(a + bb).toBe(240_000); // 実時間を保存
    expect(a).toBeGreaterThan(bb); // 3:1
    expect(Math.round(a / 60_000)).toBe(3); // ≈180s = 3分
  });
});

describe('aggregateSamples — 在席/フォーカス', () => {
  it('Edge 背面（browserFocused 相当を無視）でも active なら計上', () => {
    // aggregation は browserFocused を受け取らない = フォーカスは計上条件でない。
    const b = builder();
    b.add(0, { idleState: 'active', openGroupKeys: [group('dev')] });
    b.add(60_000, { idleState: 'active', openGroupKeys: [group('dev')] });
    const r = aggregateSamples(b.get());
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, 'dev')).toBe(60_000);
  });
});

describe('aggregateSamples — 未グループ分母除外', () => {
  it('active タブが未グループでも開いている実グループへ全額（既定 false）', () => {
    const b = builder();
    b.add(0, { openGroupKeys: [group('dev')], activeStableGroupId: null });
    b.add(60_000, { openGroupKeys: [group('dev')], activeStableGroupId: null });
    const r = aggregateSamples(b.get());
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, 'dev')).toBe(60_000);
    expect(totalFor(r, day, UNGROUPED_KEY)).toBe(0);
  });

  it('実グループが1つも無ければ ungrouped バケットへ', () => {
    const b = builder();
    b.add(0, { openGroupKeys: [], activeStableGroupId: null });
    b.add(60_000, { openGroupKeys: [], activeStableGroupId: null });
    const r = aggregateSamples(b.get());
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, UNGROUPED_KEY)).toBe(60_000);
  });

  it('include_ungrouped_in_split=true なら未グループも分母に含む', () => {
    const cfg: AggregationConfig = { ...DEFAULT_AGG_CONFIG, includeUngroupedInSplit: true };
    const b = builder();
    b.add(0, { openGroupKeys: [group('dev')], activeStableGroupId: null });
    b.add(60_000, { openGroupKeys: [group('dev')], activeStableGroupId: null });
    const r = aggregateSamples(b.get(), cfg);
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, 'dev')).toBe(30_000);
    expect(totalFor(r, day, UNGROUPED_KEY)).toBe(30_000);
  });
});

describe('aggregateSamples — idle/locked/gap 除外', () => {
  it('idle 区間は計上しない', () => {
    const b = builder();
    b.add(0, { idleState: 'idle', openGroupKeys: [group('g')] });
    b.add(60_000, { idleState: 'active', openGroupKeys: [group('g')] });
    const r = aggregateSamples(b.get());
    expect(r.dailyTotals).toHaveLength(0);
    expect(r.excluded.some((e) => e.reason === 'IDLE' && e.ms === 60_000)).toBe(true);
  });

  it('locked 区間は計上しない', () => {
    const b = builder();
    b.add(0, { idleState: 'locked', openGroupKeys: [group('g')] });
    b.add(60_000, { idleState: 'active', openGroupKeys: [group('g')] });
    const r = aggregateSamples(b.get());
    expect(r.dailyTotals).toHaveLength(0);
    expect(r.excluded.some((e) => e.reason === 'LOCKED')).toBe(true);
  });
});

describe('aggregateSamples — 重複/順不同/clock jump', () => {
  it('(bootId,seq) 重複は1回だけ計上', () => {
    const dup: RawSample = {
      clientTs: 0,
      monotonicMs: 0,
      bootId: 'b',
      seq: 0,
      idleState: 'active',
      openGroupKeys: [group('g')],
      activeStableGroupId: 'g',
    };
    const next: RawSample = { ...dup, clientTs: 60_000, monotonicMs: 60_000, seq: 1 };
    const r = aggregateSamples([dup, dup, next]); // dup を2回
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, 'g')).toBe(60_000);
    expect(r.anomalies.some((a) => a.kind === 'DUPLICATE')).toBe(true);
  });

  it('順不同で渡しても clientTs 昇順で処理される', () => {
    const s0: RawSample = {
      clientTs: 0,
      monotonicMs: 0,
      bootId: 'b',
      seq: 0,
      idleState: 'active',
      openGroupKeys: [group('g')],
      activeStableGroupId: 'g',
    };
    const s1: RawSample = { ...s0, clientTs: 60_000, monotonicMs: 60_000, seq: 1 };
    const s2: RawSample = { ...s0, clientTs: 120_000, monotonicMs: 120_000, seq: 2 };
    const r = aggregateSamples([s2, s0, s1]); // シャッフル
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, 'g')).toBe(120_000);
  });

  it('時計ジャンプ（wall と monotonic の乖離）は除外', () => {
    const b = builder();
    b.add(0, { monotonicMs: 0, openGroupKeys: [group('g')] });
    // wall は 60s 進むが monotonic は 1s しか進んでいない → clock jump
    b.add(60_000, { monotonicMs: 1_000, openGroupKeys: [group('g')] });
    const r = aggregateSamples(b.get());
    expect(r.dailyTotals).toHaveLength(0);
    expect(r.excluded.some((e) => e.reason === 'CLOCK_JUMP')).toBe(true);
    expect(r.anomalies.some((a) => a.kind === 'CLOCK_JUMP')).toBe(true);
  });

  it('ゼロギャップ（同一 clientTs の連続）は 0＋NEGATIVE_GAP フラグ', () => {
    // sort 後は必ず clientTs 昇順なので、逆行は「同一時刻の連続」= gap 0 として現れる。
    const base: RawSample = {
      clientTs: 0,
      monotonicMs: 0,
      bootId: 'b',
      seq: 0,
      idleState: 'active',
      openGroupKeys: [group('g')],
      activeStableGroupId: 'g',
    };
    const s0 = base;
    const s1: RawSample = { ...base, seq: 1 }; // 同一 clientTs=0
    const s2: RawSample = { ...base, clientTs: 60_000, monotonicMs: 60_000, seq: 2 };
    const r = aggregateSamples([s0, s1, s2]);
    const day = r.dailyTotals[0]!.dayKey;
    expect(totalFor(r, day, 'g')).toBe(60_000); // [s1,s2) の 60s のみ計上
    expect(r.anomalies.some((a) => a.kind === 'NEGATIVE_GAP')).toBe(true);
  });
});
