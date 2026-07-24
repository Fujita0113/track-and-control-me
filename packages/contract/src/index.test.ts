import { describe, it, expect } from 'vitest';
import {
  ActivitySampleSchema,
  ClientMessageSchema,
  ServerMessageSchema,
  GroupRefSchema,
  DEFAULTS,
  RuleTargetSchema,
  RuleScheduleSchema,
  RuleOpSchema,
  AnswerQuestionInputSchema,
  RuleReasonInputSchema,
  ChronicleSchema,
  type ActivitySample,
  type Chronicle,
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

describe('ルールの enum（種類・スケジュール・操作）', () => {
  it('target は7種のみ（PHOTO/QUESTION を含む）', () => {
    for (const t of ['TOTAL_WORK', 'GROUP', 'TIMELINE', 'MANUAL_CHECK', 'PLANNING', 'PHOTO', 'QUESTION'])
      expect(RuleTargetSchema.parse(t)).toBe(t);
    expect(() => RuleTargetSchema.parse('CHECK')).toThrow();
  });

  it('schedule は permanent|single|range のみ', () => {
    expect(RuleScheduleSchema.parse('permanent')).toBe('permanent');
    expect(RuleScheduleSchema.parse('single')).toBe('single');
    expect(RuleScheduleSchema.parse('range')).toBe('range');
    expect(() => RuleScheduleSchema.parse('weekly')).toThrow();
  });

  it('op は add|update|remove のみ', () => {
    expect(RuleOpSchema.parse('add')).toBe('add');
    expect(RuleOpSchema.parse('update')).toBe('update');
    expect(RuleOpSchema.parse('remove')).toBe('remove');
    expect(() => RuleOpSchema.parse('withdraw')).toThrow();
  });
});

describe('理由・回答の入力', () => {
  it('理由は trim して非空必須（追加・変更・削除で共通・design D4）', () => {
    expect(RuleReasonInputSchema.parse({ reason: '  課題週間。ゼロにはしない  ' })).toEqual({
      reason: '課題週間。ゼロにはしない',
    });
    expect(() => RuleReasonInputSchema.parse({ reason: '   ' })).toThrow();
  });

  it('空回答は拒否される', () => {
    expect(() => AnswerQuestionInputSchema.parse({ answerText: '  ' })).toThrow();
  });
});

describe('沿革の round-trip', () => {
  const chronicle: Chronicle = {
    goalId: 7,
    entries: [
      {
        ruleId: 10,
        target: 'PHOTO',
        label: '前髪・正面',
        change: {
          id: 1,
          ruleId: 10,
          dayKey: '2026-07-15',
          dayNumber: 3,
          op: 'add',
          before: null,
          after: { target: 'PHOTO', caption: '前髪・正面' },
          reason: 'ボリュームアップシャンプーを使えば髪質が良くなるのではないだろうか',
          createdAt: 1_770_000_000_000,
        },
        answers: [
          { id: 100, ruleId: 10, dayKey: '2026-07-18', dayNumber: 6, imageId: 5, answerText: null, createdAt: 1_770_000_000_000 },
        ],
      },
      {
        ruleId: 11,
        target: 'TOTAL_WORK',
        label: '総作業時間',
        change: {
          id: 2,
          ruleId: 11,
          dayKey: '2026-07-20',
          dayNumber: 8,
          op: 'remove',
          before: { thresholdSeconds: 1800 },
          after: null,
          reason: '反応が薄いから',
          createdAt: 1_770_000_000_000,
        },
        answers: [],
      },
    ],
    endedNote: null,
  };

  it('沿革全体が round-trip する（削除済みも消えない）', () => {
    const parsed = ChronicleSchema.parse(chronicle);
    expect(parsed).toEqual(chronicle);
    expect(parsed.entries[1]!.change.reason).toBe('反応が薄いから');
  });

  it('答え合わせを1つも持たないエントリも妥当（時間型ルールの変更等）', () => {
    expect(() => ChronicleSchema.parse(chronicle)).not.toThrow();
  });

  it('終える理由つきの最終エントリを持てる（design D7）', () => {
    const withEnded = { ...chronicle, endedNote: { reason: 'もう十分身についた', dayNumber: 30 } };
    expect(() => ChronicleSchema.parse(withEnded)).not.toThrow();
  });
});
