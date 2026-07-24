import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import {
  createRule,
  updateRule,
  removeRule,
  getRule,
  listActiveRules,
  isRuleActiveOn,
  isRuleMetOn,
  rangeDayNumber,
  rangeSpanDays,
  ruleSchedule,
  carryoverPolicy,
  resolveByStableOrLegacy,
  ReasonRequiredError,
  RuleValidationError,
  RuleImmutableFieldError,
  RuleNotFoundError,
} from './rule-registry.js';

/**
 * 単体テスト（task 2.5 / spec: editable-rule-registry）。
 * 中身変更で rule:<id> 不変／理由なし操作は拒否／rule_change が1操作1行／caption 後変更拒否 を検証する。
 */

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('createRule', () => {
  it('理由なしは拒否される（rule も rule_change も作られない）', () => {
    expect(() =>
      createRule(db, { target: 'TOTAL_WORK', thresholdSeconds: 14400, startDay: '2026-07-01', reason: '  ' }),
    ).toThrow(ReasonRequiredError);
    expect((db.prepare('SELECT COUNT(*) AS c FROM rule').get() as { c: number }).c).toBe(0);
  });

  it('TOTAL_WORK は分数0以下を拒否する', () => {
    expect(() =>
      createRule(db, { target: 'TOTAL_WORK', thresholdSeconds: 0, startDay: '2026-07-01', reason: 'x' }),
    ).toThrow(RuleValidationError);
  });

  it('作成すると rule_change が op=add で1行記録される', () => {
    const rule = createRule(db, {
      target: 'TOTAL_WORK',
      thresholdSeconds: 14400,
      startDay: '2026-07-01',
      endDay: null,
      reason: '作業時間を守りたい',
    });
    const changes = db.prepare('SELECT * FROM rule_change WHERE rule_id = ?').all(rule.id) as {
      op: string;
      before: string | null;
      after: string;
      reason: string;
    }[];
    expect(changes).toHaveLength(1);
    expect(changes[0]!.op).toBe('add');
    expect(changes[0]!.before).toBeNull();
    expect(JSON.parse(changes[0]!.after).thresholdSeconds).toBe(14400);
    expect(changes[0]!.reason).toBe('作業時間を守りたい');
  });

  it('TIMELINE/MANUAL_CHECK はラベル必須、PHOTO/QUESTION はキャプション/質問文必須', () => {
    expect(() => createRule(db, { target: 'TIMELINE', thresholdSeconds: 600, startDay: '2026-07-01', reason: 'r' })).toThrow(
      RuleValidationError,
    );
    expect(() => createRule(db, { target: 'MANUAL_CHECK', startDay: '2026-07-01', reason: 'r' })).toThrow(
      RuleValidationError,
    );
    expect(() => createRule(db, { target: 'PHOTO', startDay: '2026-07-01', endDay: '2026-07-01', reason: 'r' })).toThrow(
      RuleValidationError,
    );
    expect(() =>
      createRule(db, { target: 'QUESTION', startDay: '2026-07-01', endDay: '2026-07-01', reason: 'r' }),
    ).toThrow(RuleValidationError);
  });

  it('PHOTO×範囲・QUESTION×単発を作れる', () => {
    const photo = createRule(db, {
      target: 'PHOTO',
      caption: '前髪・正面',
      startDay: '2026-07-01',
      endDay: '2026-07-07',
      reason: '髪質が良くなるのでは',
    });
    expect(photo.target).toBe('PHOTO');
    expect(ruleSchedule(photo.start_day, photo.end_day)).toBe('range');

    const question = createRule(db, {
      target: 'QUESTION',
      questionText: '使用感はどうだった？',
      startDay: '2026-07-08',
      endDay: '2026-07-08',
      reason: '手応えを確かめたい',
    });
    expect(question.target).toBe('QUESTION');
    expect(ruleSchedule(question.start_day, question.end_day)).toBe('single');
  });
});

describe('updateRule', () => {
  it('中身を変更しても rule:<id>（安定キー＝id）は不変', () => {
    const rule = createRule(db, {
      target: 'TOTAL_WORK',
      thresholdSeconds: 14400,
      startDay: '2026-07-01',
      reason: '作る',
    });
    const updated = updateRule(
      db,
      rule.id,
      { target: 'TOTAL_WORK', thresholdSeconds: 10800, startDay: '2026-07-01', reason: '課題週間。ゼロにはしない' },
    );
    expect(updated.id).toBe(rule.id);
    expect(updated.threshold_seconds).toBe(10800);
  });

  it('グループ差し替え（GROUP identity 変更）でも id は不変', () => {
    const identityId = db
      .prepare('INSERT INTO group_identity (name, color, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('競技プログラミング', 'blue', 0, 0).lastInsertRowid as number;
    const rule = createRule(db, {
      target: 'GROUP',
      stableGroupId: 'broken-uuid',
      thresholdSeconds: 7200,
      startDay: '2026-07-01',
      reason: '既存の壊れた参照',
    });
    const updated = updateRule(db, rule.id, {
      target: 'GROUP',
      groupIdentityId: identityId,
      thresholdSeconds: 7200,
      startDay: '2026-07-01',
      reason: '拡張のバグでUUIDが壊れていた',
    });
    expect(updated.id).toBe(rule.id);
    expect(updated.group_identity_id).toBe(identityId);
  });

  it('理由なしの変更は拒否され、rule は変わらない', () => {
    const rule = createRule(db, {
      target: 'TOTAL_WORK',
      thresholdSeconds: 14400,
      startDay: '2026-07-01',
      reason: '作る',
    });
    expect(() =>
      updateRule(db, rule.id, { target: 'TOTAL_WORK', thresholdSeconds: 10800, startDay: '2026-07-01', reason: '' }),
    ).toThrow(ReasonRequiredError);
    expect(getRule(db, rule.id).threshold_seconds).toBe(14400);
  });

  it('写真ルールのキャプションは作成後に変更できない', () => {
    const rule = createRule(db, {
      target: 'PHOTO',
      caption: '前髪・正面',
      startDay: '2026-07-01',
      endDay: '2026-07-07',
      reason: '作る',
    });
    expect(() =>
      updateRule(db, rule.id, {
        target: 'PHOTO',
        caption: '後ろ姿',
        startDay: '2026-07-01',
        endDay: '2026-07-07',
        reason: '変えたい',
      }),
    ).toThrow(RuleImmutableFieldError);
  });

  it('存在しないルールは RuleNotFoundError', () => {
    expect(() =>
      updateRule(db, 999, { target: 'TOTAL_WORK', thresholdSeconds: 100, startDay: '2026-07-01', reason: 'r' }),
    ).toThrow(RuleNotFoundError);
  });

  it('1回の更新で rule_change が1行だけ追加される（op=update）', () => {
    const rule = createRule(db, {
      target: 'TOTAL_WORK',
      thresholdSeconds: 14400,
      startDay: '2026-07-01',
      reason: '作る',
    });
    updateRule(db, rule.id, {
      target: 'TOTAL_WORK',
      thresholdSeconds: 10800,
      startDay: '2026-07-01',
      reason: '課題週間',
    });
    const changes = db.prepare("SELECT * FROM rule_change WHERE rule_id = ? AND op = 'update'").all(rule.id);
    expect(changes).toHaveLength(1);
  });
});

describe('removeRule', () => {
  it('理由なしは拒否され、ルールは active のまま', () => {
    const rule = createRule(db, {
      target: 'TOTAL_WORK',
      thresholdSeconds: 14400,
      startDay: '2026-07-01',
      reason: '作る',
    });
    expect(() => removeRule(db, rule.id, '  ')).toThrow(ReasonRequiredError);
    expect(getRule(db, rule.id).status).toBe('active');
  });

  it('理由つきで削除すると status=removed になり rule_change が op=remove で記録される', () => {
    const rule = createRule(db, {
      target: 'TOTAL_WORK',
      thresholdSeconds: 14400,
      startDay: '2026-07-01',
      reason: '作る',
    });
    removeRule(db, rule.id, '反応が薄いから');
    expect(getRule(db, rule.id).status).toBe('removed');
    const change = db.prepare("SELECT * FROM rule_change WHERE rule_id = ? AND op = 'remove'").get(rule.id) as {
      before: string;
      after: string | null;
      reason: string;
    };
    expect(change.after).toBeNull();
    expect(JSON.parse(change.before).thresholdSeconds).toBe(14400);
    expect(change.reason).toBe('反応が薄いから');
  });
});

describe('listActiveRules', () => {
  it('start_day/end_day の範囲外・removed のルールは含まれない', () => {
    const permanent = createRule(db, {
      target: 'TOTAL_WORK',
      thresholdSeconds: 14400,
      startDay: '2026-07-01',
      reason: '作る',
    });
    const future = createRule(db, {
      target: 'PHOTO',
      caption: '前髪',
      startDay: '2026-08-01',
      endDay: '2026-08-01',
      reason: '単発',
    });
    const removed = createRule(db, {
      target: 'MANUAL_CHECK',
      label: '筋トレ',
      startDay: '2026-07-01',
      reason: '作る',
    });
    removeRule(db, removed.id, '飽きた');

    const active = listActiveRules(db, '2026-07-10');
    const ids = active.map((r) => r.id);
    expect(ids).toContain(permanent.id);
    expect(ids).not.toContain(future.id);
    expect(ids).not.toContain(removed.id);
  });
});

describe('carryoverPolicy / ruleSchedule', () => {
  it('PHOTO/QUESTION の単発のみ carry、範囲・永続は daily、時間型/非時間型は none', () => {
    expect(carryoverPolicy('PHOTO', 'single')).toBe('carry');
    expect(carryoverPolicy('QUESTION', 'single')).toBe('carry');
    expect(carryoverPolicy('PHOTO', 'range')).toBe('daily');
    expect(carryoverPolicy('PHOTO', 'permanent')).toBe('daily');
    expect(carryoverPolicy('TOTAL_WORK', 'single')).toBe('none');
    expect(carryoverPolicy('GROUP', 'permanent')).toBe('none');
    expect(carryoverPolicy('MANUAL_CHECK', 'single')).toBe('none');
    expect(carryoverPolicy('PLANNING', 'range')).toBe('none');
  });

  it('ruleSchedule は end_day=null→permanent, start=end→single, start<end→range', () => {
    expect(ruleSchedule('2026-07-01', null)).toBe('permanent');
    expect(ruleSchedule('2026-07-01', '2026-07-01')).toBe('single');
    expect(ruleSchedule('2026-07-01', '2026-07-07')).toBe('range');
  });
});

describe('isRuleActiveOn / isRuleMetOn / rangeDayNumber', () => {
  it('単発 PHOTO/QUESTION は達成するまで start_day を過ぎても有効（繰り越し）', () => {
    const rule = { status: 'active' as const, target: 'PHOTO' as const, start_day: '2026-07-18', end_day: '2026-07-18' };
    expect(isRuleActiveOn(rule, '2026-07-18')).toBe(true);
    expect(isRuleActiveOn(rule, '2026-07-25')).toBe(true); // 単発日を過ぎても有効
    expect(isRuleActiveOn(rule, '2026-07-17')).toBe(false); // 開始前は無効
  });

  it('範囲 PHOTO/QUESTION は end_day を過ぎると消える（繰り越さない）', () => {
    const rule = { status: 'active' as const, target: 'PHOTO' as const, start_day: '2026-07-01', end_day: '2026-07-07' };
    expect(isRuleActiveOn(rule, '2026-07-07')).toBe(true);
    expect(isRuleActiveOn(rule, '2026-07-08')).toBe(false);
  });

  it('単発の時間型ルールは繰り越さず、その日限りで消える', () => {
    const rule = { status: 'active' as const, target: 'TOTAL_WORK' as const, start_day: '2026-07-18', end_day: '2026-07-18' };
    expect(isRuleActiveOn(rule, '2026-07-18')).toBe(true);
    expect(isRuleActiveOn(rule, '2026-07-19')).toBe(false);
  });

  it('isRuleMetOn: 単発は提出日以降ずっと met、範囲・永続はその日ちょうどの提出のみ', () => {
    expect(isRuleMetOn('PHOTO', 'single', ['2026-07-18'], '2026-07-25')).toBe(true);
    expect(isRuleMetOn('PHOTO', 'range', ['2026-07-18'], '2026-07-19')).toBe(false);
    expect(isRuleMetOn('QUESTION', 'range', ['2026-07-19'], '2026-07-19')).toBe(true);
  });

  it('rangeDayNumber/rangeSpanDays は範囲のみ値を返す', () => {
    expect(rangeSpanDays('2026-07-01', '2026-07-07')).toBe(7);
    expect(rangeDayNumber('2026-07-01', '2026-07-07', '2026-07-03')).toBe(3);
    expect(rangeDayNumber('2026-07-01', '2026-07-07', '2026-08-01')).toBeNull();
    expect(rangeDayNumber('2026-07-01', null, '2026-07-01')).toBeNull();
    expect(rangeDayNumber('2026-07-01', '2026-07-01', '2026-07-01')).toBeNull();
  });

  it('listActiveRules: 単発 PHOTO は達成期限を過ぎても含まれ続ける', () => {
    const rule = createRule(db, {
      target: 'PHOTO',
      caption: '前髪',
      startDay: '2026-07-18',
      endDay: '2026-07-18',
      reason: '単発',
    });
    const ids = listActiveRules(db, '2026-07-25').map((r) => r.id);
    expect(ids).toContain(rule.id);
  });
});

describe('resolveByStableOrLegacy', () => {
  it('rule:<id> が一致すればそれを、無ければ legacy_condition_key で解決する', () => {
    const rule = { id: 5, legacy_condition_key: 'group:broken-uuid' };
    const results = [
      { conditionKey: 'total_work', met: true },
      { conditionKey: 'group:broken-uuid', met: false },
    ];
    expect(resolveByStableOrLegacy(results, rule)?.met).toBe(false);

    const resultsWithStable = [{ conditionKey: 'rule:5', met: true }, { conditionKey: 'group:broken-uuid', met: false }];
    expect(resolveByStableOrLegacy(resultsWithStable, rule)?.met).toBe(true);

    expect(resolveByStableOrLegacy([{ conditionKey: 'other', met: true }], rule)).toBeUndefined();
  });
});
