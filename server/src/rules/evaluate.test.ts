import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { createRule, updateRule, ruleConditionKey } from '../services/rule-registry.js';
import { evaluateDay } from './evaluate.js';
import { resolveIdentity, renameIdentity } from '../services/group-identity.js';
import { daySummary } from '../services/summary.js';

/**
 * ルール評価（rule:<id> 起点・spec: editable-rule-registry / goal-check-gate / design.md D3・D4・D5）。
 * 内訳（today-group-breakdown）と同一源泉（session.credited_ms）で判定されること、別名（改名前の
 * 名前）が合算されること、旧 group:<uuid> 条件は従来経路のまま不変であること、差し替え前後で過去日の
 * met が不変であること、PHOTO 単発ルールが達成まで繰り越されることを担保する（task 3.5）。
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h: number, mi: number) =>
  zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);
const DAY = '2026-07-20';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function seedSession(
  d: DB,
  name: string,
  color: string | null,
  startAt: number,
  endAt: number,
  creditedMs = endAt - startAt,
): void {
  resolveIdentity(d, name, color); // recompute.ts 相当（セッション確定時の identity 解決）。
  d.prepare(
    `INSERT INTO session
      (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
       started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES ('sg', ?, ?, NULL, ?, ?, ?, '[]', 1, ?, 'NORMAL', ?)`,
  ).run(name, color, startAt, endAt, DAY, creditedMs, endAt);
}

describe('GROUP ルールの identity 化された評価', () => {
  it('内訳の秒数と GROUP ルールの実績秒が一致する', () => {
    const id = resolveIdentity(db, '開発', 'blue')!;
    seedSession(db, '開発', 'blue', jst(2026, 7, 20, 9, 0), jst(2026, 7, 20, 11, 27)); // 2h27m
    createRule(db, { target: 'GROUP', groupIdentityId: id, thresholdSeconds: 900, startDay: DAY, reason: 'r' });

    const summary = daySummary(db, DAY);
    const breakdown = summary.groups.find((g) => g.name === '開発')!;
    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP')!;
    expect(cond.actualSeconds).toBe(breakdown.seconds);
  });

  it('別グループの時間では解錠されない', () => {
    const compId = resolveIdentity(db, '競技プログラミング', 'yellow')!;
    seedSession(db, '面接', 'grey', jst(2026, 7, 20, 9, 0), jst(2026, 7, 20, 11, 0));
    createRule(db, { target: 'GROUP', groupIdentityId: compId, thresholdSeconds: 60, startDay: DAY, reason: 'r' });

    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP')!;
    expect(cond.actualSeconds).toBe(0);
    expect(cond.met).toBe(false);
  });

  it('別名（改名前の名前）区間が合算される', () => {
    const id = resolveIdentity(db, '競技プログラミング', 'yellow')!;
    seedSession(db, '競技プログラミング', 'yellow', jst(2026, 7, 20, 9, 0), jst(2026, 7, 20, 10, 30)); // 90分
    renameIdentity(db, { name: '競技プログラミング', color: 'yellow' }, { name: '競プロ', color: 'yellow' });
    seedSession(db, '競プロ', 'yellow', jst(2026, 7, 20, 11, 0), jst(2026, 7, 20, 11, 30)); // 30分
    createRule(db, { target: 'GROUP', groupIdentityId: id, thresholdSeconds: 60 * 60, startDay: DAY, reason: 'r' });

    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP')!;
    expect(cond.actualSeconds).toBe(120 * 60);
    expect(cond.met).toBe(true);
    expect(cond.groupName).toBe('競プロ');
  });

  it('ルールの中身（閾値・condition_key）は改名で変わらない（表示名だけが変わる）', () => {
    const id = resolveIdentity(db, '開発', 'blue')!;
    const rule = createRule(db, { target: 'GROUP', groupIdentityId: id, thresholdSeconds: 900, startDay: DAY, reason: 'r' });
    const before = { threshold: rule.threshold_seconds, key: ruleConditionKey(rule.id), groupIdentityId: rule.group_identity_id };

    renameIdentity(db, { name: '開発', color: 'blue' }, { name: '開発（新）', color: 'blue' });

    expect({
      threshold: db.prepare('SELECT threshold_seconds FROM rule WHERE id = ?').get(rule.id),
      key: ruleConditionKey(rule.id),
      groupIdentityId: (db.prepare('SELECT group_identity_id FROM rule WHERE id = ?').get(rule.id) as { group_identity_id: number }).group_identity_id,
    }).toEqual({ threshold: { threshold_seconds: before.threshold }, key: before.key, groupIdentityId: before.groupIdentityId });

    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP')!;
    expect(cond.groupName).toBe('開発（新）');
    expect(cond.thresholdSeconds).toBe(900);
  });

  it('旧 group:<uuid> 参照（stableGroupId のみ）は daily_totals_snapshot 単位のまま評価される（移行前後で判定不変）', () => {
    db.prepare(
      `INSERT INTO daily_totals_snapshot (day_key, stable_group_id, ms, is_final, updated_at)
       VALUES (?, ?, ?, 0, 0)`,
    ).run(DAY, 'legacy-uuid', 30 * 60 * 1000);
    createRule(db, { target: 'GROUP', stableGroupId: 'legacy-uuid', thresholdSeconds: 60, startDay: DAY, reason: 'r' });

    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP')!;
    expect(cond.actualSeconds).toBe(30 * 60);
    expect(cond.met).toBe(true);
    expect(cond.groupName).toContain('要再設定');
  });
});

describe('差し替え前後で過去日 met が不変', () => {
  it('過去日が凍結済み（is_final=1）なら、ルールを差し替えても per_condition_results は書き換わらない', () => {
    const brokenId = resolveIdentity(db, '面接', 'grey')!;
    seedSession(db, '面接', 'grey', jst(2026, 7, 20, 9, 0), jst(2026, 7, 20, 11, 0)); // 2h
    const rule = createRule(db, {
      target: 'GROUP',
      groupIdentityId: brokenId, // 壊れた参照（意図せず「面接」で解錠されてしまう）
      thresholdSeconds: 60,
      startDay: DAY,
      reason: '既存',
    });
    // Day を評価して凍結する（rollover 相当）。
    evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    db.prepare("UPDATE unlock_evaluation SET is_final = 1 WHERE day_key = ?").run(DAY);
    const frozenBefore = db.prepare('SELECT per_condition_results FROM unlock_evaluation WHERE day_key = ?').get(DAY);

    // 正しい identity へ差し替える（issue #59 の修正）。
    const correctId = resolveIdentity(db, '競技プログラミング', 'yellow')!;
    updateRule(db, rule.id, {
      target: 'GROUP',
      groupIdentityId: correctId,
      thresholdSeconds: 60,
      startDay: DAY,
      reason: '拡張のバグでUUIDが壊れていた',
    });

    const frozenAfter = db.prepare('SELECT per_condition_results FROM unlock_evaluation WHERE day_key = ?').get(DAY);
    expect(frozenAfter).toEqual(frozenBefore); // 過去日は不変。
  });
});

describe('PHOTO 単発ルールの繰り越し', () => {
  it('達成するまで毎日ゲートへ残り続け、提出すれば met になる', () => {
    const rule = createRule(db, {
      target: 'PHOTO',
      caption: '前髪・正面',
      startDay: '2026-07-18',
      endDay: '2026-07-18',
      reason: '手応えを確かめたい',
    });

    // 単発日を過ぎても未提出なら LOCKED のまま（繰り越し）。
    const before = evaluateDay(db, '2026-07-25', jst(2026, 7, 25, 9, 0));
    const condBefore = before.perCondition.find((c) => c.ruleId === rule.id)!;
    expect(condBefore.met).toBe(false);
    expect(before.status).toBe('LOCKED');

    // 7/25 に提出する。
    db.prepare(
      'INSERT INTO rule_answer (rule_id, day_key, answer_text, created_at) VALUES (?, ?, ?, ?)',
    ).run(rule.id, '2026-07-25', null, jst(2026, 7, 25, 9, 30));

    const after = evaluateDay(db, '2026-07-25', jst(2026, 7, 25, 10, 0));
    expect(after.perCondition.find((c) => c.ruleId === rule.id)!.met).toBe(true);

    // 翌日以降も met のまま（提出日以降ずっと・latch は別に UNLOCKED を維持）。
    const next = evaluateDay(db, '2026-07-26', jst(2026, 7, 26, 9, 0));
    expect(next.perCondition.find((c) => c.ruleId === rule.id)!.met).toBe(true);
  });

  it('範囲ルールはサボった日を繰り越さない（翌日は翌日の分だけ要求）', () => {
    const rule = createRule(db, {
      target: 'QUESTION',
      questionText: '使用感はどうだった？',
      startDay: '2026-07-14',
      endDay: '2026-07-20',
      reason: 'r',
    });
    // 7/14 はサボる。
    const day14 = evaluateDay(db, '2026-07-14', jst(2026, 7, 14, 9, 0));
    expect(day14.perCondition.find((c) => c.ruleId === rule.id)!.met).toBe(false);

    // 7/15 に回答すれば 7/15 は met（7/14 の未達は引きずらない）。
    db.prepare(
      'INSERT INTO rule_answer (rule_id, day_key, answer_text, created_at) VALUES (?, ?, ?, ?)',
    ).run(rule.id, '2026-07-15', '泡立ちは良い', jst(2026, 7, 15, 9, 0));
    const day15 = evaluateDay(db, '2026-07-15', jst(2026, 7, 15, 9, 30));
    const cond15 = day15.perCondition.find((c) => c.ruleId === rule.id)!;
    expect(cond15.met).toBe(true);
    expect(cond15.rangeDayNumber).toBe(2);
    expect(cond15.spanDays).toBe(7);

    // 範囲を過ぎればゲートから消える。
    const after = evaluateDay(db, '2026-07-21', jst(2026, 7, 21, 9, 0));
    expect(after.perCondition.find((c) => c.ruleId === rule.id)).toBeUndefined();
  });
});
