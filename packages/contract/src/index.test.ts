import { describe, it, expect } from 'vitest';
import {
  ActivitySampleSchema,
  ClientMessageSchema,
  ServerMessageSchema,
  GroupRefSchema,
  DEFAULTS,
  type ActivitySample,
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
