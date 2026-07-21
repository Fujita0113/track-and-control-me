import { describe, it, expect } from 'vitest';
import {
  ActivitySampleSchema,
  ClientMessageSchema,
  ServerMessageSchema,
  GroupRefSchema,
  DEFAULTS,
  CheckKindSchema,
  CheckScheduleSchema,
  CheckStatusSchema,
  CreateCheckInputSchema,
  CreatePlanInputSchema,
  AnswerQuestionInputSchema,
  WithdrawInputSchema,
  GoalPlanSchema,
  ChronicleSchema,
  CHECK_CONDITION_PREFIX,
  CHECK_TARGET,
  type ActivitySample,
  type GoalPlan,
  type GroupRef,
} from './index.js';

const validGroupRef = {
  groupId: 3,
  stableGroupId: 'grp-atcoder',
  title: 'AtCoder',
  color: 'blue',
} satisfies GroupRef;

const validSample: ActivitySample = {
  eventType: 'HEARTBEAT',
  clientTs: 1_770_000_000_000,
  monotonicMs: 123_456.7,
  bootId: 'boot-abc',
  seq: 42,
  tz: 'Asia/Tokyo',
  groupId: 3,
  stableGroupId: 'grp-atcoder',
  groupTitle: 'AtCoder',
  groupColor: 'blue',
  windowId: 1,
  tabId: 99,
  idleState: 'active',
  browserFocused: false,
  openGroupKeys: [validGroupRef, { groupId: 5, stableGroupId: 'grp-dev', title: '開発', color: 'green' }],
  extVersion: '0.1.0',
};

describe('GroupRefSchema', () => {
  it('parses a valid group ref', () => {
    expect(GroupRefSchema.parse(validGroupRef)).toEqual(validGroupRef);
  });
});

describe('ActivitySampleSchema', () => {
  it('parses a valid heartbeat sample (Edge 背面でも browserFocused:false を許容)', () => {
    const parsed = ActivitySampleSchema.parse(validSample);
    expect(parsed.idleState).toBe('active');
    expect(parsed.openGroupKeys).toHaveLength(2);
  });

  it('parses an ungrouped active tab (nullable な active group フィールド)', () => {
    const ungrouped = {
      ...validSample,
      groupId: -1,
      stableGroupId: null,
      groupTitle: null,
      groupColor: null,
      openGroupKeys: [],
    };
    expect(() => ActivitySampleSchema.parse(ungrouped)).not.toThrow();
  });

  it('rejects an invalid idleState', () => {
    expect(() =>
      ActivitySampleSchema.parse({ ...validSample, idleState: 'sleeping' }),
    ).toThrow();
  });

  it('rejects a missing required field (bootId)', () => {
    const { bootId: _omit, ...rest } = validSample;
    expect(() => ActivitySampleSchema.parse(rest)).toThrow();
  });

  it('rejects an invalid group color inside openGroupKeys', () => {
    expect(() =>
      ActivitySampleSchema.parse({
        ...validSample,
        openGroupKeys: [{ ...validGroupRef, color: 'teal' }],
      }),
    ).toThrow();
  });
});

describe('ClientMessageSchema', () => {
  it('parses a hello handshake', () => {
    const hello = {
      type: 'hello',
      token: 'shared-secret',
      bootId: 'boot-abc',
      extVersion: '0.1.0',
      tz: 'Asia/Tokyo',
    };
    expect(ClientMessageSchema.parse(hello)).toMatchObject({ type: 'hello' });
  });

  it('parses a sample message envelope', () => {
    const msg = { type: 'sample', sample: validSample };
    expect(ClientMessageSchema.parse(msg)).toMatchObject({ type: 'sample' });
  });

  it('rejects an unknown message type', () => {
    expect(() => ClientMessageSchema.parse({ type: 'bogus' })).toThrow();
  });
});

describe('ServerMessageSchema welcome（awayMinSeconds は optional で後方互換）', () => {
  it('parses a welcome without awayMinSeconds（旧サーバー互換）', () => {
    const parsed = ServerMessageSchema.parse({ type: 'welcome', serverTime: 1_770_000_000_000 });
    expect(parsed).toMatchObject({ type: 'welcome' });
    expect((parsed as { awayMinSeconds?: number }).awayMinSeconds).toBeUndefined();
  });

  it('parses a welcome with awayMinSeconds', () => {
    const parsed = ServerMessageSchema.parse({
      type: 'welcome',
      serverTime: 1_770_000_000_000,
      awayMinSeconds: DEFAULTS.AWAY_MIN_SECONDS,
    });
    expect(parsed).toMatchObject({ type: 'welcome', awayMinSeconds: 600 });
  });

  it('rejects a non-positive awayMinSeconds', () => {
    expect(() =>
      ServerMessageSchema.parse({ type: 'welcome', serverTime: 1, awayMinSeconds: 0 }),
    ).toThrow();
  });
});

describe('DEFAULTS', () => {
  it('exposes AWAY_MIN_SECONDS = 600（一元化閾値の既定）', () => {
    expect(DEFAULTS.AWAY_MIN_SECONDS).toBe(600);
  });
});

describe('Check の enum（種類・いつ・状態）', () => {
  it('kind は photo|question のみ', () => {
    expect(CheckKindSchema.parse('photo')).toBe('photo');
    expect(CheckKindSchema.parse('question')).toBe('question');
    expect(() => CheckKindSchema.parse('video')).toThrow();
  });

  it('schedule は single|range のみ', () => {
    expect(CheckScheduleSchema.parse('single')).toBe('single');
    expect(CheckScheduleSchema.parse('range')).toBe('range');
    expect(() => CheckScheduleSchema.parse('weekly')).toThrow();
  });

  it('永続状態に satisfied は無い（達成は対象日から遅延導出する・design D2）', () => {
    expect(CheckStatusSchema.parse('active')).toBe('active');
    expect(CheckStatusSchema.parse('cancelled')).toBe('cancelled');
    expect(() => CheckStatusSchema.parse('satisfied')).toThrow();
  });

  it('合成条件の名前空間は既存キーと衝突しない', () => {
    expect(CHECK_CONDITION_PREFIX).toBe('check:');
    expect(CHECK_TARGET).toBe('CHECK');
    for (const existing of ['total_work', 'group:abc', 'timeline:運動', 'manual:読書', 'planning:tomorrow_planned'])
      expect(existing.startsWith(CHECK_CONDITION_PREFIX)).toBe(false);
  });
});

describe('CreateCheckInputSchema（種類×いつ の2軸は独立）', () => {
  it('全4通りの組み合わせを受理する', () => {
    const combos = [
      { kind: 'photo', caption: '前髪・正面', schedule: 'single', startDayKey: '2026-07-18' },
      { kind: 'photo', caption: '前髪・正面', schedule: 'range', startDayKey: '2026-07-18', spanDays: 7 },
      { kind: 'question', questionText: '使用感はどうだった？', schedule: 'single', startDayKey: '2026-07-18' },
      { kind: 'question', questionText: '使用感はどうだった？', schedule: 'range', startDayKey: '2026-07-18', spanDays: 7 },
    ];
    for (const c of combos) expect(() => CreateCheckInputSchema.parse(c)).not.toThrow();
  });

  it('2軸の交差は両方の軸を出力に残す（種類が「いつ」を落とさない）', () => {
    const parsed = CreateCheckInputSchema.parse({
      kind: 'photo',
      caption: '前髪・正面',
      schedule: 'range',
      startDayKey: '2026-07-18',
      spanDays: 7,
    });
    expect(parsed).toEqual({
      kind: 'photo',
      caption: '前髪・正面',
      schedule: 'range',
      startDayKey: '2026-07-18',
      spanDays: 7,
    });
  });

  it('相対指定（3日後）でも入力できる', () => {
    const parsed = CreateCheckInputSchema.parse({
      kind: 'photo',
      caption: '前髪・正面',
      schedule: 'single',
      startInDays: 3,
    });
    expect(parsed).toMatchObject({ schedule: 'single', startInDays: 3 });
  });

  it('場所メモ・時刻メモを任意で持てる', () => {
    const parsed = CreateCheckInputSchema.parse({
      kind: 'photo',
      caption: '前髪・正面',
      schedule: 'single',
      startDayKey: '2026-07-18',
      placeNote: '洗面所',
      timeNote: '朝',
    });
    expect(parsed).toMatchObject({ placeNote: '洗面所', timeNote: '朝' });
  });

  it('photo はキャプション非空・question は質問文非空', () => {
    expect(() =>
      CreateCheckInputSchema.parse({ kind: 'photo', caption: '   ', schedule: 'single', startDayKey: '2026-07-18' }),
    ).toThrow();
    expect(() =>
      CreateCheckInputSchema.parse({ kind: 'question', questionText: '', schedule: 'single', startDayKey: '2026-07-18' }),
    ).toThrow();
  });

  it('range は spanDays >= 2 必須', () => {
    const base = { kind: 'photo', caption: '前髪・正面', schedule: 'range', startDayKey: '2026-07-18' };
    expect(() => CreateCheckInputSchema.parse(base)).toThrow();
    expect(() => CreateCheckInputSchema.parse({ ...base, spanDays: 1 })).toThrow();
    expect(() => CreateCheckInputSchema.parse({ ...base, spanDays: 2 })).not.toThrow();
  });
});

describe('Plan / 取り下げ / 回答の入力', () => {
  it('Plan の本文は trim して非空必須', () => {
    expect(CreatePlanInputSchema.parse({ body: '  シャンプーを変える  ' })).toEqual({
      body: 'シャンプーを変える',
    });
    expect(() => CreatePlanInputSchema.parse({ body: '   ' })).toThrow();
  });

  it('取り下げの理由は非空必須（唯一の脱出弁の代償）', () => {
    expect(WithdrawInputSchema.parse({ reason: ' 肌に合わず返品した ' })).toEqual({
      reason: '肌に合わず返品した',
    });
    expect(() => WithdrawInputSchema.parse({ reason: '' })).toThrow();
  });

  it('空回答は拒否される', () => {
    expect(() => AnswerQuestionInputSchema.parse({ answerText: '  ' })).toThrow();
  });
});

describe('沿革の round-trip', () => {
  const plan: GoalPlan = {
    id: 1,
    goalId: 7,
    dayKey: '2026-07-15',
    body: 'ボリュームアップシャンプーを使えば髪質が良くなるのではないだろうか',
    status: 'active',
    withdrawReason: null,
    createdAt: 1_770_000_000_000,
    checks: [
      {
        id: 10,
        planId: 1,
        kind: 'photo',
        caption: '前髪・正面',
        questionText: '',
        schedule: 'single',
        startDayKey: '2026-07-18',
        spanDays: null,
        placeNote: '洗面所',
        timeNote: '朝',
        status: 'active',
        cancelReason: null,
        createdAt: 1_770_000_000_000,
        results: [
          { id: 100, checkId: 10, dayKey: '2026-07-18', imageId: 5, answerText: null, createdAt: 1_770_000_000_000 },
        ],
      },
      {
        id: 11,
        planId: 1,
        kind: 'question',
        caption: '',
        questionText: 'ボリュームアップシャンプーの使用感はどうだった？',
        schedule: 'range',
        startDayKey: '2026-07-18',
        spanDays: 7,
        placeNote: null,
        timeNote: null,
        status: 'cancelled',
        cancelReason: '続かなかった。3日で飽きた',
        createdAt: 1_770_000_000_000,
        results: [
          { id: 101, checkId: 11, dayKey: '2026-07-18', imageId: null, answerText: '泡立ちは良い', createdAt: 1_770_000_000_000 },
        ],
      },
    ],
  };

  it('Plan（Check・回答を入れ子に持つ）が round-trip する', () => {
    expect(GoalPlanSchema.parse(plan)).toEqual(plan);
  });

  it('沿革全体が round-trip する（取り下げ済みも消えない）', () => {
    const chronicle = { goalId: 7, plans: [plan] };
    const parsed = ChronicleSchema.parse(chronicle);
    expect(parsed).toEqual(chronicle);
    expect(parsed.plans[0]!.checks[1]!.cancelReason).toBe('続かなかった。3日で飽きた');
  });

  it('Check を1つも持たない Plan も妥当（方針だけの Plan）', () => {
    const bare = { ...plan, id: 2, body: 'ブログはやめる。反応が薄いから', checks: [] };
    expect(() => GoalPlanSchema.parse(bare)).not.toThrow();
  });
});
