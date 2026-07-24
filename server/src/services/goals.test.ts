import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import {
  createGoal,
  listGoals,
  getGoal,
  deleteGoal,
  getGoalReport,
  saveJournal,
  getJournal,
  listJournalImages,
  addJournalImage,
  getJournalImageBytes,
  updateJournalImageCaption,
  deleteJournalImage,
  addDaysKey,
  addRuleToGoal,
  updateGoalRule,
  removeGoalRule,
  continueGoal,
  endGoal,
  submitRulePhoto,
  answerRuleQuestion,
  GoalDeleteWindowError,
  GoalReportNotReadyError,
  JournalNotWritableError,
  JournalImageError,
  JournalImageNotFoundError,
  GoalValidationError,
  GoalExtensionRequiredError,
  GoalLifecycleError,
} from './goals.js';
import { resolveIdentity } from './group-identity.js';

/** テスト用 data URL（バイト内容は検証しないので任意バイト列でよい）。 */
const dataUrl = (mime = 'image/png', bytes: number[] = [1, 2, 3]): string =>
  `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h: number, mi: number) =>
  zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

// 「今日」= 2026-07-10 → 明日開始の目標は 2026-07-11 開始・2026-08-09 完了。
const NOW_TODAY = jst(2026, 7, 10, 12, 0);
const NOW_NEXT = jst(2026, 7, 11, 12, 0);
const NOW_COMPLETED = jst(2026, 8, 10, 12, 0);
const START = '2026-07-11';
const END = '2026-08-09';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function seedEval(dayKey: string, per: unknown[]): void {
  db.prepare(
    `INSERT INTO unlock_evaluation (day_key, status, conditions_met, per_condition_results, first_met_at, reveal_fired, is_final, updated_at)
     VALUES (?, 'LOCKED', 0, ?, NULL, 0, 0, 0)`,
  ).run(dayKey, JSON.stringify(per));
}

describe('目標の作成（明日開始・「採用」は廃止・自動紐付け）', () => {
  it('その場で作ったルールが自動で紐づき、Day 1/30 の開始前で現れる', () => {
    const g = createGoal(
      db,
      { name: 'メンタルを安定させる', purpose: '穏やかに', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400, reason: '4時間は守りたい' }], start: 'tomorrow' },
      NOW_TODAY,
    );
    expect(g.startDay).toBe(START);
    expect(g.endDay).toBe(END);
    expect(g.status).toBe('upcoming');
    expect(g.dayCount).toBe(30);
    expect(g.rules).toHaveLength(1);
    expect(g.rules[0]!.target).toBe('TOTAL_WORK');
    expect(g.rules[0]!.conditionKey).toBe(`rule:${g.rules[0]!.ruleId}`);
  });

  it('理由なし・ルール0件は拒否され、目標もルールも作られない', () => {
    expect(() => createGoal(db, { name: 'x', rules: [], start: 'tomorrow' }, NOW_TODAY)).toThrow(GoalValidationError);
    expect(() =>
      createGoal(db, { name: 'x', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: '' }], start: 'tomorrow' }, NOW_TODAY),
    ).toThrow();
    expect(listGoals(db, NOW_TODAY)).toHaveLength(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM rule').get() as { c: number }).c).toBe(0);
  });

  it('PHOTO×範囲・QUESTION×単発をその場で作って紐づけられる', () => {
    const g = createGoal(
      db,
      {
        name: '髪質を改善する',
        rules: [
          { target: 'PHOTO', caption: '前髪・正面', startDay: START, endDay: addDaysKey(START, 6), reason: '…髪質が良くなるのではないだろうか' },
          { target: 'QUESTION', questionText: '使用感はどうだった？', startDay: addDaysKey(START, 7), endDay: addDaysKey(START, 7), reason: '1週間後に手応えを確かめたい' },
        ],
        start: 'tomorrow',
      },
      NOW_TODAY,
    );
    expect(g.rules.map((r) => r.target).sort()).toEqual(['PHOTO', 'QUESTION']);
  });

  it('GROUP は直近使用グループ（identity）から選んで作れる', () => {
    const identityId = resolveIdentity(db, '競技プログラミング', 'yellow')!;
    const g = createGoal(
      db,
      { name: '競プロで緑になる', rules: [{ target: 'GROUP', groupIdentityId: identityId, thresholdSeconds: 7200, reason: '緑になりたい' }], start: 'tomorrow' },
      NOW_TODAY,
    );
    expect(g.rules[0]!.groupIdentityId).toBe(identityId);
    expect(g.rules[0]!.needsReset).toBe(false);
  });

  it('並行して2つ作成でき、互いに影響しない', () => {
    createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    createGoal(db, { name: 'B', rules: [{ target: 'MANUAL_CHECK', label: '筋トレ', reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    expect(listGoals(db, NOW_TODAY)).toHaveLength(2);
  });

  it('今日開始の既定は当日を Day1 として即進行中になる', () => {
    const g = createGoal(db, { name: '今日から', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }] }, NOW_TODAY);
    expect(g.startDay).toBe('2026-07-10');
    expect(g.status).toBe('active');
    expect(g.dayNumber).toBe(1);
  });
});

describe('削除猶予（作成当日のみ）', () => {
  it('作成当日は削除でき、紐づけ・日記も CASCADE で消える（ルール本体は残る）', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const ruleId = g.rules[0]!.ruleId;
    expect(deleteGoal(db, g.id, NOW_TODAY)).toBe(true);
    expect(listGoals(db, NOW_TODAY)).toHaveLength(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM rule WHERE id = ?').get(ruleId) as { c: number }).c).toBe(1);
  });

  it('翌日以降は削除できない', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    expect(() => deleteGoal(db, g.id, NOW_NEXT)).toThrow(GoalDeleteWindowError);
  });
});

describe('目標コーナーのルール編集・削除（ジャンル固定なし・design D3）', () => {
  it('理由つきで閾値を変更でき、rule:<id> は不変（rule_change に記録される）', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400, reason: '作る' }], start: 'tomorrow' }, NOW_TODAY);
    const ruleId = g.rules[0]!.ruleId;
    const { rule } = updateGoalRule(db, g.id, ruleId, { target: 'TOTAL_WORK', thresholdSeconds: 10800, startDay: START, reason: '課題週間。ゼロにはしない' }, {}, NOW_NEXT);
    expect(rule.id).toBe(ruleId);
    expect(rule.threshold_seconds).toBe(10800);
    const change = db.prepare("SELECT * FROM rule_change WHERE rule_id = ? AND op = 'update'").get(ruleId) as { reason: string };
    expect(change.reason).toBe('課題週間。ゼロにはしない');
  });

  it('採用中でも理由つきで削除でき、当日の実効ゲートから外れる（過去日は不変）', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: '作る' }], start: 'tomorrow' }, NOW_TODAY);
    const ruleId = g.rules[0]!.ruleId;
    const removed = removeGoalRule(db, g.id, ruleId, '反応が薄いから', NOW_NEXT);
    expect(removed.status).toBe('removed');
    expect(getGoal(db, g.id, NOW_NEXT).rules).toHaveLength(0);
  });

  it('他目標が追うルールを壊さない', () => {
    const g1 = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const g2 = createGoal(db, { name: 'B', rules: [{ target: 'MANUAL_CHECK', label: '筋トレ', reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    removeGoalRule(db, g2.id, g2.rules[0]!.ruleId, '理由', NOW_NEXT);
    expect(getGoal(db, g1.id, NOW_NEXT).rules).toHaveLength(1);
  });
});

describe('壊れたルールを直す（issue #59・グループ差し替え）', () => {
  it('GROUP の identity を差し替えても rule:<id> は不変で、needsReset が解消する', () => {
    const g = createGoal(
      db,
      { name: '競プロで緑になる', rules: [{ target: 'GROUP', stableGroupId: 'broken-uuid', thresholdSeconds: 7200, reason: '既存の壊れた参照' }], start: 'tomorrow' },
      NOW_TODAY,
    );
    const ruleId = g.rules[0]!.ruleId;
    expect(getGoal(db, g.id, NOW_TODAY).rules[0]!.needsReset).toBe(true);

    const identityId = resolveIdentity(db, '競技プログラミング', 'yellow')!;
    const { rule } = updateGoalRule(
      db, g.id, ruleId,
      { target: 'GROUP', groupIdentityId: identityId, thresholdSeconds: 7200, startDay: START, reason: '拡張のバグでUUIDが壊れていた' },
      {}, NOW_NEXT,
    );
    expect(rule.id).toBe(ruleId);
    expect(getGoal(db, g.id, NOW_NEXT).rules[0]!.needsReset).toBe(false);
  });
});

describe('期間延長フォーク（design D7）', () => {
  it('目標末尾を越えるルールは GoalExtensionRequiredError（未指定時）', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const overEnd = addDaysKey(END, 4); // 目標末尾より後
    expect(() =>
      addRuleToGoal(db, g.id, { target: 'PHOTO', caption: '前髪', startDay: END, endDay: overEnd, reason: 'r' }, {}, NOW_NEXT),
    ).toThrow(GoalExtensionRequiredError);
  });

  it('伸ばすと目標終了が延び、Day N/M が変わる', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const overEnd = addDaysKey(END, 4);
    const { truncated } = addRuleToGoal(db, g.id, { target: 'PHOTO', caption: '前髪', startDay: END, endDay: overEnd, reason: 'r' }, { extend: 'extend' }, NOW_NEXT);
    expect(truncated).toBe(false);
    const updated = getGoal(db, g.id, NOW_NEXT);
    expect(updated.endDay).toBe(overEnd);
    expect(updated.dayCount).toBe(34);
  });

  it('やめると目標末尾まで切り詰めて作成は成功する', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const overEnd = addDaysKey(END, 4);
    const { rule, truncated } = addRuleToGoal(db, g.id, { target: 'PHOTO', caption: '前髪', startDay: END, endDay: overEnd, reason: 'r' }, { extend: 'truncate' }, NOW_NEXT);
    expect(truncated).toBe(true);
    expect(rule.end_day).toBe(END);
    expect(getGoal(db, g.id, NOW_NEXT).endDay).toBe(END); // 目標自体は延びない
  });

  it('期間短縮の手段は無い（end_day は前方向にのみ変わる）', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const overEnd = addDaysKey(END, 4);
    addRuleToGoal(db, g.id, { target: 'PHOTO', caption: '前髪', startDay: END, endDay: overEnd, reason: 'r' }, { extend: 'extend' }, NOW_NEXT);
    // 短縮 API は存在しない＝ end_day を早める操作を提供していないことを、伸びたままであることで確認する。
    expect(getGoal(db, g.id, NOW_NEXT).endDay).toBe(overEnd);
  });
});

describe('完走フォーク（続ける／終える・spec: goal-lifecycle-fork）', () => {
  function seedCompletedGoal(): number {
    return createGoal(db, { name: '英語を毎日やる', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600, reason: '毎日60分' }], start: 'tomorrow' }, NOW_TODAY).id;
  }

  it('未完走・未到来ではフォークを呼べない', () => {
    const id = seedCompletedGoal();
    expect(() => continueGoal(db, id, NOW_NEXT)).toThrow(GoalLifecycleError);
  });

  it('続けると新しい30日目標が Day1/30 で作られ、永続ルールが続投する', () => {
    const id = seedCompletedGoal();
    const ruleId = getGoal(db, id, NOW_COMPLETED).rules[0]?.ruleId ?? db.prepare('SELECT rule_id FROM goal_rule WHERE goal_id = ?').get(id) as unknown as number;
    const newGoal = continueGoal(db, id, NOW_COMPLETED);
    expect(newGoal.status).toBe('active');
    expect(newGoal.dayNumber).toBe(1);
    expect(newGoal.dayCount).toBe(30);
    // 永続ルールが新目標へ紐づく。
    const linked = db.prepare('SELECT 1 FROM goal_rule WHERE goal_id = ? AND rule_id IN (SELECT rule_id FROM goal_rule WHERE goal_id = ?)').get(newGoal.id, id);
    expect(linked).toBeTruthy();
    void ruleId;
    // 前サイクルは読めるまま残る。
    expect(getGoal(db, id, NOW_COMPLETED).status).toBe('completed');
    expect(getGoal(db, id, NOW_COMPLETED).continuedGoalId).toBe(newGoal.id);
    // 二重フォークは拒否。
    expect(() => continueGoal(db, id, NOW_COMPLETED)).toThrow(GoalLifecycleError);
  });

  it('終えると永続ルールがゲートから外れ、レポート・沿革は残る', () => {
    const id = seedCompletedGoal();
    const view = endGoal(db, id, 'もう十分身についた', NOW_COMPLETED);
    expect(view.lifecycleChoice).toBe('ended');
    expect(view.lifecycleReason).toBe('もう十分身についた');
    const ruleRow = db.prepare('SELECT r.status AS status FROM goal_rule gr JOIN rule r ON r.id = gr.rule_id WHERE gr.goal_id = ?').get(id) as { status: string };
    expect(ruleRow.status).toBe('removed');
    // レポートは開ける。
    expect(() => getGoalReport(db, id, NOW_COMPLETED)).not.toThrow();
  });

  it('未回答の間は永続ルールがゲートに残り続ける', () => {
    const id = seedCompletedGoal();
    // フォークに答える前は rule が active のまま。
    const before = db.prepare('SELECT r.status AS status FROM goal_rule gr JOIN rule r ON r.id = gr.rule_id WHERE gr.goal_id = ?').get(id) as { status: string };
    expect(before.status).toBe('active');
  });

  it('完走レポートにフォークが出て、進行中プレビューには出ない', () => {
    const id = seedCompletedGoal();
    expect(getGoalReport(db, id, NOW_COMPLETED).goal.showLifecycleFork).toBe(true);
    // 進行中の別目標では出ない。
    const g2 = createGoal(db, { name: 'B', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const runningReport = getGoalReport(db, g2.id, NOW_NEXT);
    expect(runningReport.goal.showLifecycleFork).toBe(false);
  });
});

describe('写真/質問ルールへの回答（今日タブ・design D5）', () => {
  it('写真提出でルールが met になり、③の画像として保存される', () => {
    const g = createGoal(
      db,
      { name: '髪質を改善する', rules: [{ target: 'PHOTO', caption: '前髪・正面', startDay: START, endDay: START, reason: 'r' }], start: 'tomorrow' },
      NOW_TODAY,
    );
    const ruleId = g.rules[0]!.ruleId;
    const answer = submitRulePhoto(db, ruleId, START, { dataUrl: dataUrl() }, NOW_NEXT);
    expect(answer.imageId).not.toBeNull();
    expect(listJournalImages(db, g.id, START)[0]!.caption).toBe('前髪・正面');
  });

  it('質問回答でルールが met になる（空回答は拒否）', () => {
    const g = createGoal(
      db,
      { name: '髪質を改善する', rules: [{ target: 'QUESTION', questionText: '使用感は？', startDay: START, endDay: START, reason: 'r' }], start: 'tomorrow' },
      NOW_TODAY,
    );
    const ruleId = g.rules[0]!.ruleId;
    expect(() => answerRuleQuestion(db, ruleId, START, '  ', NOW_NEXT)).toThrow();
    const answer = answerRuleQuestion(db, ruleId, START, '泡立ちは良い', NOW_NEXT);
    expect(answer.answerText).toBe('泡立ちは良い');
  });
});

describe('目標日記（明日開始）', () => {
  it('進行中の日は保存でき、reflection_done を汚染しない', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    saveJournal(db, g.id, START, '初日の日記', NOW_NEXT);
    expect(getJournal(db, g.id, START).content).toBe('初日の日記');
    expect((db.prepare('SELECT COUNT(*) AS c FROM reflection_entry').get() as { c: number }).c).toBe(0);
  });

  it('完走後の日記書き込みは拒否される', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    expect(() => saveJournal(db, g.id, START, 'x', NOW_COMPLETED)).toThrow(JournalNotWritableError);
  });
});

describe('目標日記の画像添付（明日開始）', () => {
  it('開始前・進行中・完走後いずれでも追加/一覧/取得/更新/削除できる（D4b: いつでも可）', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);

    const a = addJournalImage(db, g.id, START, { dataUrl: dataUrl('image/png', [1, 2, 3]), caption: '台所' }, NOW_TODAY);
    const b = addJournalImage(db, g.id, START, { dataUrl: dataUrl('image/jpeg', [4, 5]), caption: '机' }, NOW_NEXT);
    const c = addJournalImage(db, g.id, END, { dataUrl: dataUrl('image/png', [6]), caption: '台所' }, NOW_COMPLETED);
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);

    const list = listJournalImages(db, g.id, START);
    expect(list.map((x) => x.caption)).toEqual(['台所', '机']);

    const bin = getJournalImageBytes(db, g.id, a.imageId);
    expect(bin.mime).toBe('image/png');
    expect(Buffer.from(bin.bytes).equals(Buffer.from([1, 2, 3]))).toBe(true);

    updateJournalImageCaption(db, g.id, a.imageId, 'キッチン');
    expect(listJournalImages(db, g.id, START).find((x) => x.imageId === a.imageId)!.caption).toBe('キッチン');
    expect(deleteJournalImage(db, g.id, c.imageId)).toBe(true);
    expect(listJournalImages(db, g.id, END)).toHaveLength(0);
  });

  it('期間外の day_key は 400（JournalImageError）で拒否される', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    expect(() => addJournalImage(db, g.id, '2026-07-10', { dataUrl: dataUrl() }, NOW_NEXT)).toThrow(JournalImageError);
  });

  it('他目標の imageId は触れない（所有検証・404 相当）', () => {
    const g1 = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const g2 = createGoal(db, { name: 'B', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const img = addJournalImage(db, g1.id, START, { dataUrl: dataUrl(), caption: 'g1' }, NOW_NEXT);
    expect(() => getJournalImageBytes(db, g2.id, img.imageId)).toThrow(JournalImageNotFoundError);
  });
});

describe('完了レポート（明日開始）', () => {
  it('完走前は 409（GoalReportNotReadyError）', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    expect(() => getGoalReport(db, g.id, NOW_TODAY)).toThrow(GoalReportNotReadyError);
  });

  it('欠測=未達成、達成日数=当日ゲートにあった全ルール met の日数、変更マーカー、日単位フォールバック', () => {
    const identityId = resolveIdentity(db, 'AtCoder', 'blue')!;
    const g = createGoal(
      db,
      { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400, reason: 'r' }, { target: 'GROUP', groupIdentityId: identityId, thresholdSeconds: 1800, reason: 'r' }], start: 'tomorrow' },
      NOW_TODAY,
    );
    const totalRuleId = g.rules.find((r) => r.target === 'TOTAL_WORK')!.ruleId;
    const groupRuleId = g.rules.find((r) => r.target === 'GROUP')!.ruleId;

    seedEval('2026-07-11', [
      { conditionKey: `rule:${totalRuleId}`, target: 'TOTAL_WORK', met: true, actualSeconds: 15000, thresholdSeconds: 14400 },
      { conditionKey: `rule:${groupRuleId}`, target: 'GROUP', met: true, actualSeconds: 2000, thresholdSeconds: 1800 },
    ]);
    seedEval('2026-07-12', [
      { conditionKey: `rule:${totalRuleId}`, target: 'TOTAL_WORK', met: true, actualSeconds: 11000, thresholdSeconds: 10800 },
      { conditionKey: `rule:${groupRuleId}`, target: 'GROUP', met: false, actualSeconds: 100, thresholdSeconds: 1800 },
    ]);
    updateGoalRule(db, g.id, totalRuleId, { target: 'TOTAL_WORK', thresholdSeconds: 10800, startDay: START, reason: '課題週間。ゼロにはしない' }, {}, jst(2026, 7, 12, 12, 0));

    db.prepare(`INSERT INTO reflection_entry (date, content, satisfaction, created_at, updated_at) VALUES ('2026-07-11', 'Day1 の振り返り', NULL, 0, 0)`).run();
    db.prepare(`INSERT INTO goal_journal (goal_id, day_key, content, created_at, updated_at) VALUES (?, '2026-08-09', 'Day30 の日記', 0, 0)`).run(g.id);

    const rep = getGoalReport(db, g.id, NOW_COMPLETED);

    expect(rep.goal.dayCount).toBe(30);
    expect(rep.goal.achievedDays).toBe(1);
    expect(rep.hasTimeType).toBe(true);

    const total = rep.rules.find((r) => r.ruleId === totalRuleId)!;
    const group = rep.rules.find((r) => r.ruleId === groupRuleId)!;
    expect(total.cells[0]!.met).toBe(true);
    expect(total.cells[1]!.met).toBe(true);
    expect(group.cells[1]!.met).toBe(false);
    expect(total.cells[2]!.met).toBe(false); // Day3 欠測=未達成

    expect(rep.ruleChanges.length).toBe(1);
    expect(rep.ruleChanges[0]!.dayNumber).toBe(2);
    expect(rep.ruleChanges[0]!.reason).toContain('課題週間');

    expect(rep.days[0]!.source).toBe('reflection');
    expect(rep.days[29]!.source).toBe('journal');
  });

  it('削除後の日は inactive（対象外）扱いで、削除前の達成は保持される', () => {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const ruleId = g.rules[0]!.ruleId;
    seedEval('2026-07-11', [{ conditionKey: `rule:${ruleId}`, target: 'TOTAL_WORK', met: true, actualSeconds: 200, thresholdSeconds: 100 }]);
    // Day3 に削除する。
    removeGoalRule(db, g.id, ruleId, '反応が薄いから', jst(2026, 7, 13, 12, 0));

    const rep = getGoalReport(db, g.id, NOW_COMPLETED);
    const cell = rep.rules[0]!.cells;
    expect(cell[0]!.met).toBe(true); // Day1: 削除前
    expect(cell[2]!.inactive).toBe(true); // Day3 以降: 削除済みで対象外
    expect(rep.goal.achievedDays).toBe(1); // Day1 のみ
  });

  it('TIMELINE ルールは①カレンダーに乗り、②時間推移（isTimeType）として扱われる', () => {
    const g = createGoal(db, { name: '運動', rules: [{ target: 'TIMELINE', label: '運動', thresholdSeconds: 1800, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const ruleId = g.rules[0]!.ruleId;
    seedEval('2026-07-11', [{ conditionKey: `rule:${ruleId}`, target: 'TIMELINE', met: true, actualSeconds: 2100, thresholdSeconds: 1800 }]);
    const rep = getGoalReport(db, g.id, NOW_COMPLETED);
    const p = rep.rules.find((x) => x.ruleId === ruleId)!;
    expect(p.isTimeType).toBe(true);
    expect(p.cells[0]!.met).toBe(true);
  });

  it('MANUAL_CHECK ルールは①カレンダーに乗り、②時間推移からは除外される（非時間型）', () => {
    const g = createGoal(db, { name: '筋トレ習慣', rules: [{ target: 'MANUAL_CHECK', label: '筋トレ', reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const ruleId = g.rules[0]!.ruleId;
    seedEval('2026-07-11', [{ conditionKey: `rule:${ruleId}`, target: 'MANUAL_CHECK', met: true }]);
    const rep = getGoalReport(db, g.id, NOW_COMPLETED);
    const p = rep.rules.find((x) => x.ruleId === ruleId)!;
    expect(p.isTimeType).toBe(false);
    expect(p.label).toBe('筋トレ');
    expect(p.cells[0]!.met).toBe(true);
    expect(rep.hasTimeType).toBe(false);
  });
});

describe('走行中プレビュー（レポートの鍵を外す・spec: goal-report / design D6）', () => {
  const NOW_DAY12 = jst(2026, 7, 22, 12, 0);

  function seedRunningGoal(): { id: number; ruleId: number } {
    const g = createGoal(db, { name: 'A', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400, reason: 'r' }], start: 'tomorrow' }, NOW_TODAY);
    const ruleId = g.rules[0]!.ruleId;
    for (let i = 0; i < 12; i++) {
      seedEval(addDaysKey(START, i), [{ conditionKey: `rule:${ruleId}`, target: 'TOTAL_WORK', met: true, actualSeconds: 15000, thresholdSeconds: 14400 }]);
    }
    return { id: g.id, ruleId };
  }

  it('進行中でもレポートが返る（Day 12/30 の姿）', () => {
    const { id } = seedRunningGoal();
    const rep = getGoalReport(db, id, NOW_DAY12);
    expect(rep.goal.status).toBe('active');
    expect(rep.goal.dayNumber).toBe(12);
    expect(rep.goal.dayCount).toBe(30);
  });

  it('未到来（Day13〜30）は空白＝future で、未達成の黒星にならない', () => {
    const { id } = seedRunningGoal();
    const cells = getGoalReport(db, id, NOW_DAY12).rules[0]!.cells;
    for (const c of cells.slice(0, 12)) {
      expect(c.future).toBe(false);
      expect(c.met).toBe(true);
    }
    for (const c of cells.slice(12)) {
      expect(c.future).toBe(true);
      expect(c.met).toBe(false);
    }
  });

  it('⑤沿革がレポートに含まれる（日記は含まない）', () => {
    const { id, ruleId } = seedRunningGoal();
    saveJournal(db, id, '2026-07-13', '日記の本文はここに', jst(2026, 7, 13, 12, 0));
    updateGoalRule(db, id, ruleId, { target: 'TOTAL_WORK', thresholdSeconds: 10800, startDay: START, reason: '課題週間' }, {}, jst(2026, 7, 13, 12, 0));

    const rep = getGoalReport(db, id, NOW_DAY12);
    expect(rep.chronicle.goalId).toBe(id);
    expect(rep.chronicle.entries.some((e) => e.change.reason === '課題週間')).toBe(true);
    expect(JSON.stringify(rep.chronicle)).not.toContain('日記の本文はここに');
    expect(rep.days[2]!.text).toBe('日記の本文はここに');
  });
});
