import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { listGoals, getGoal, getJournal } from './goals.js';
import { goalBurnup } from './goal-burnup.js';
import { getChronicle } from './goal-chronicle.js';
import { goalHistory } from './goal-history.js';
import { getDayAllocation } from './day-allocation.js';
import { daySummary } from './summary.js';
import { getTimeline } from './timeline.js';
import { totalWorkSecondsForDay } from './categories.js';
import { getDemoDb, resetDemoDb } from './demo-db.js';
import { addAutoExclusion, removeAutoExclusion } from './timeline.js';
import { recompute } from './recompute.js';
import { evaluateDay } from '../rules/evaluate.js';
import { listTasks } from './tasks.js';
import { getBlueprint, computeOpenPath, type BlueprintNode } from './task-tree.js';
import {
  seedDemo,
  DEMO_GOAL_ID,
  DEMO_GOAL2_ID,
  DEMO_GOAL3_ID,
  DEMO_GOAL3_START_DAY,
  DEMO_GOAL3_END_DAY,
  DEMO_GOAL3_ENDED_DAY,
  DEMO_START_DAY,
  DEMO_END_DAY,
  DEMO_EFFECTIVE_END_DAY,
  DEMO_FREEZE_START_DAY,
  DEMO_FREEZE_END_DAY,
  DEMO_PRE_START_DAY,
  DEMO_AFTER_END_DAY,
  DEMO_GOAL2_START_DAY,
  DEMO_GOAL2_END_DAY,
  DEMO_GOAL2_FREEZE_DAY,
  DEMO_GOAL2_EFFECTIVE_END_DAY,
  DEMO_GOAL4_ID,
  DEMO_GOAL4_ENDED_DAY,
  DEMO_GOAL4_RESUMED_DAY,
  DEMO_GOAL4_EFFECTIVE_END_DAY,
  DEMO_ALLOC_DAY,
  DEMO_FORGOTTEN_DAY,
  RULE_TOTAL_ID,
  RULE_KIN_ID,
  RULE_WALK_ID,
  RULE_STRETCH_ID,
  RULE_PHOTO_MORNING_ID,
  RULE_QUESTION_FOCUS_ID,
  RULE_PHOTO_SKY_ID,
  RULE_QUESTION_PHONE_ID,
} from './demo-seed.js';

const TZ = 'Asia/Tokyo';
/** 仮想 day_key（正午 JST）→ epoch ms。demo.ts の virtualNowMs と同じ規則。 */
const vnow = (dayKey: string): number => {
  const [y, m, d] = dayKey.split('-').map(Number);
  return zonedTimeToEpoch(y!, m!, d!, 12, 0, 0, TZ);
};

/** 設計図ノードを自身+子孫すべてへ平坦化する（テストの id 探索用）。 */
function flattenIds(node: BlueprintNode): BlueprintNode[] {
  return [node, ...node.children.flatMap(flattenIds)];
}

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  seedDemo(db);
});

describe('デモ seed の仮想日付連動（5.2 / 1.4）', () => {
  it('開始前 → 進行中 Day N/30 → 完走 が仮想 day_key に連動する', () => {
    // 開始前（start − 1）。
    let g = listGoals(db, vnow(DEMO_PRE_START_DAY))[0]!;
    expect(g.status).toBe('upcoming');
    expect(g.startDay).toBe(DEMO_START_DAY);
    expect(g.endDay).toBe(DEMO_END_DAY);
    expect(g.dayNumber).toBeNull();

    // Day1（開始日）。
    g = listGoals(db, vnow(DEMO_START_DAY))[0]!;
    expect(g.status).toBe('active');
    expect(g.dayNumber).toBe(1);

    // Day8（+7 進行中）。
    g = listGoals(db, vnow('2026-06-18'))[0]!;
    expect(g.status).toBe('active');
    expect(g.dayNumber).toBe(8);

    // Day30（最終日）。
    g = listGoals(db, vnow(DEMO_END_DAY))[0]!;
    expect(g.status).toBe('active');
    expect(g.dayNumber).toBe(30);

    // 完走（end + 1）。
    g = listGoals(db, vnow(DEMO_AFTER_END_DAY))[0]!;
    expect(g.status).toBe('completed');
    expect(g.dayNumber).toBeNull();
  });

  // レポート（①達成カレンダー・②時間推移・③写真比較・④日記ストリップ）は capability ごと廃止された
  // （spec: goal-report REMOVED・goal-burnup-forecast）。開始前・進行中の開閉判定は進捗グラフ
  // （burnup）が引き継ぎ、①のセル単位の met/frozen・achievedDays・②の閾値変更ログ・③の画像集約に
  // 相当する読み手はどこにも残らないため、それらを検証していたテストはここで意図的に落とす。
  // 日記本文は既存の getJournal() で別途検証済み（「日記は日付単位で引ける」）。
  it('開始前のみ進捗グラフ不可（進行中は走行中プレビューとして開ける）', () => {
    // 開始前（まだ1日も走っていない）は拒否。
    expect(goalBurnup(db, DEMO_GOAL_ID, vnow(DEMO_PRE_START_DAY))).toBeNull();
    // 進行中は開ける。
    expect(getGoal(db, DEMO_GOAL_ID, vnow(DEMO_START_DAY)).status).toBe('active');
    // 完走後の実効 end_day は凍結2日ぶん延びる（spec: goal-freeze）。
    expect(getGoal(db, DEMO_GOAL_ID, vnow(DEMO_AFTER_END_DAY)).endDay).toBe(DEMO_EFFECTIVE_END_DAY);
  });

  describe('一時凍結のサンプル（spec: goal-freeze・issue #60）', () => {
    it('目標の実効 end_day が凍結2日ぶん延びる', () => {
      const g = listGoals(db, vnow(DEMO_AFTER_END_DAY)).find((x) => x.id === DEMO_GOAL_ID)!;
      expect(g.endDay).toBe(DEMO_EFFECTIVE_END_DAY);
      expect(g.dayCount).toBe(32);
      expect(g.freeze).not.toBeNull();
      expect(g.freeze!.state).toBe('released');
      expect(g.freeze!.startDay).toBe(DEMO_FREEZE_START_DAY);
      expect(g.freeze!.endDay).toBe(DEMO_FREEZE_END_DAY);
    });

    it('凍結中の仮想日付では目標カードに凍結中と出る', () => {
      const g = listGoals(db, vnow(DEMO_FREEZE_START_DAY)).find((x) => x.id === DEMO_GOAL_ID)!;
      expect(g.status).toBe('active');
      expect(g.freeze!.state).toBe('frozen');
    });

    it('沿革に発効が理由つきで残る（種別・予約フェーズは廃止・spec: goal-freeze MODIFIED）', () => {
      const freezes = getChronicle(db, DEMO_GOAL_ID, DEMO_AFTER_END_DAY).freezes;
      expect(freezes.map((f) => f.kind)).toEqual(['activate']);
      expect(freezes[0]!.reason).toContain('差し込み案件');
      expect(freezes[0]!.startDay).toBe(DEMO_FREEZE_START_DAY);
    });
  });

  it('日記は日付単位で引ける（getJournal）', () => {
    expect(getJournal(db, DEMO_GOAL_ID, DEMO_START_DAY).content).toContain('はじめて');
    expect(getJournal(db, DEMO_GOAL_ID, DEMO_END_DAY).content).toContain('30日を終えて');
  });

  describe('⑤沿革のサンプル（ルール操作の年表）', () => {
    /** 沿革（rule_change は day_key 昇順・同日内は記録順）。 */
    const chronicle = (): ReturnType<typeof getChronicle> => getChronicle(db, DEMO_GOAL_ID, DEMO_AFTER_END_DAY);

    it('6件のルール操作が既存の谷（Day11 / Day13 / Day20 / Day23）に時系列で並ぶ', () => {
      const entries = chronicle().entries;
      expect(entries.map((e) => e.change.dayKey)).toEqual([
        '2026-06-21', '2026-06-21', '2026-06-23', '2026-06-23', '2026-06-30', '2026-07-03',
      ]);
      expect(entries.map((e) => e.ruleId)).toEqual([
        RULE_PHOTO_MORNING_ID, RULE_QUESTION_FOCUS_ID, RULE_TOTAL_ID, RULE_PHOTO_SKY_ID, RULE_QUESTION_PHONE_ID, RULE_QUESTION_PHONE_ID,
      ]);
      expect(entries[0]!.change.reason).toContain('朝いちに前倒し');
      expect(entries[3]!.change.reason).toContain('3時間へ下げる'); // Day13 の閾値変更の判断と呼応する。
    });

    it('📷×単発・💬×単発・📷×範囲・削除済み が1つずつ揃う（沿革が読み物になる）', () => {
      const entries = chronicle().entries;
      expect(entries.map((e) => `${e.target}/${e.change.op}`)).toEqual([
        'PHOTO/add', 'QUESTION/add', 'TOTAL_WORK/update', 'PHOTO/add', 'QUESTION/add', 'QUESTION/remove',
      ]);
    });

    it('📷×単発は画像つきの答え合わせがぶら下がる', () => {
      const e = chronicle().entries.find((x) => x.ruleId === RULE_PHOTO_MORNING_ID)!;
      expect(e.label).toBe('朝の机');
      expect(e.answers).toHaveLength(1);
      expect(e.answers[0]!.imageId).toBeTypeOf('number');
    });

    it('💬×単発は Q&A のペアで残る', () => {
      const e = chronicle().entries.find((x) => x.ruleId === RULE_QUESTION_FOCUS_ID)!;
      expect(e.label).toBe('前倒しで集中は変わったか');
      expect(e.answers[0]!.answerText).toContain('朝は入りが速い');
    });

    it('📷×範囲は「7日中5日提出」の事実がそのまま残る（サボりを美化も負債化もしない）', () => {
      const e = chronicle().entries.find((x) => x.ruleId === RULE_PHOTO_SKY_ID)!;
      expect(e.answers).toHaveLength(5);
      // Day16（06-26）・Day20（06-30）はサボった日（既存の谷日）＝提出が無い。
      expect(e.answers.map((r) => r.dayKey)).toEqual([
        '2026-06-24', '2026-06-25', '2026-06-27', '2026-06-28', '2026-06-29',
      ]);
    });

    it('削除したルールが理由つきで沿革に残る（答えた2日は消えない）', () => {
      const addEntry = chronicle().entries.find((x) => x.ruleId === RULE_QUESTION_PHONE_ID && x.change.op === 'add')!;
      const removeEntry = chronicle().entries.find((x) => x.ruleId === RULE_QUESTION_PHONE_ID && x.change.op === 'remove')!;
      expect(removeEntry.change.reason).toContain('置き場所から変える');
      // 取り下げても、それまでに答えた2日は消えない（add エントリにぶら下がる）。
      expect(addEntry.answers).toHaveLength(2);
    });

    it('走行中プレビューの沿革は「その日までに起きたこと」だけを載せる（未来を見せない）', () => {
      // Day12（06-22）時点: Day11 の2件だけが存在し、Day13 以降はまだ無い。
      const day12 = getChronicle(db, DEMO_GOAL_ID, '2026-06-22');
      expect(day12.entries.map((e) => e.change.dayKey)).toEqual(['2026-06-21', '2026-06-21']);
      // 仕掛かり中（Day14・Day15 の回答はまだ起きていない）。
      expect(day12.entries.every((e) => e.answers.length === 0)).toBe(true);

      // Day15（06-25）時点: Day13 の2件まで現れ、Day14・Day15 の回答だけが載る。
      const day15 = getChronicle(db, DEMO_GOAL_ID, '2026-06-25');
      expect(day15.entries.map((e) => e.change.dayKey)).toEqual(['2026-06-21', '2026-06-21', '2026-06-23', '2026-06-23']);
      const sky = day15.entries.find((e) => e.ruleId === RULE_PHOTO_SKY_ID)!;
      expect(sky.answers.map((r) => r.dayKey)).toEqual(['2026-06-24', '2026-06-25']); // 06-27 以降はまだ。
    });

    it('沿革に日記本文は載らない（④日記リーダーが読む）', () => {
      const json = JSON.stringify(chronicle());
      expect(json).not.toContain('はじめての一日'); // Day1 の日記見出し。
      expect(json).not.toContain('30日を終えて'); // Day30 の日記見出し。
    });

    // レポート③（写真の比較・reportImages のキャプション横断集約）と①（達成カレンダー・
    // achievedDays・rules 一覧）は capability ごと廃止された（spec: goal-report REMOVED）。
    // どちらも代替の読み手が無いため、それらを検証していた2テストはここで意図的に落とす
    // （画像そのものの保存・キャプションは既存の goal_journal_image 経由で別途検証済み）。
  });

  // レポート①②（達成カレンダー・時間推移）は capability ごと廃止された
  // （spec: goal-report REMOVED）。DEMO_GOAL2 のルール一覧・セル単位の met・achievedDays に
  // 相当する読み手はどこにも残らないため、それらを検証していた assertion はここで意図的に落とす。
  it('手動チェックのみの目標（DEMO_GOAL2）が一覧に並び、日記が引ける', () => {
    // 一覧には主目標・手動チェックのみ目標・目標時間つきで終えた目標・終了→再開の目標の4件が並ぶ。
    const goals = listGoals(db, vnow(DEMO_AFTER_END_DAY));
    expect(goals.length).toBe(4);
    const g2 = goals.find((g) => g.id === DEMO_GOAL2_ID)!;
    expect(g2.name).toBe('朝の散歩を習慣にする');
    // ③④ Before/After の日記が引ける。
    expect(getJournal(db, DEMO_GOAL2_ID, DEMO_GOAL2_START_DAY).content).toContain('朝散歩を始める');
  });

  it('1日だけの一時凍結でも対象外になり、期限が1日延びる（種別統合後の挙動・spec: goal-freeze MODIFIED）', () => {
    const g2 = getGoal(db, DEMO_GOAL2_ID, vnow(DEMO_AFTER_END_DAY));
    // 統合後は「終了日=当日」を指定しても凍結1日ぶん実効 end_day が延びる（旧・当日凍結の
    // 「期限は延びない」という代金は無くなった）。
    expect(g2.endDay).toBe(DEMO_GOAL2_EFFECTIVE_END_DAY);
    expect(g2.freeze!.startDay).toBe(DEMO_GOAL2_FREEZE_DAY);
    expect(g2.freeze!.endDay).toBe(DEMO_GOAL2_FREEZE_DAY);
    expect(getGoal(db, DEMO_GOAL_ID, vnow(DEMO_AFTER_END_DAY)).endDay).toBe(DEMO_EFFECTIVE_END_DAY);
  });

  describe('終了→再開のサイクルのサンプル（spec: goal-lifecycle-fork ADDED・issue #103）', () => {
    it('終了していた3日ぶん実効 end_day が延びる', () => {
      const g4 = getGoal(db, DEMO_GOAL4_ID, vnow(DEMO_AFTER_END_DAY));
      expect(g4.status).toBe('completed');
      expect(g4.endDay).toBe(DEMO_GOAL4_EFFECTIVE_END_DAY);
      expect(g4.dayCount).toBe(13);
      expect(g4.resumingOn).toBeNull();
      // レポート①（達成カレンダーのセル単位 frozen/met・achievedDays）は capability ごと
      // 廃止された（spec: goal-report REMOVED）。終了区間ぶん dayCount が延びる事実は上で
      // getGoal() により検証済みで、セル単位の frozen フラグに相当する読み手はどこにも
      // 残らないため、それを検証していたアサーションはここで意図的に落とす。
    });

    it('大きい沿革に「終える」「→再開」が理由つきで並ぶ', () => {
      const h = goalHistory(db, vnow(DEMO_AFTER_END_DAY));
      const ended = h.find((e) => e.kind === 'ended' && e.goalId === DEMO_GOAL4_ID)!;
      expect(ended).toBeDefined();
      expect(ended.dayKey).toBe(DEMO_GOAL4_ENDED_DAY);
      expect(ended.reason).toContain('体調を崩した');
      expect(ended.pending).toBe(false);

      const resumed = h.find((e) => e.kind === 'resumed' && e.goalId === DEMO_GOAL4_ID)!;
      expect(resumed).toBeDefined();
      expect(resumed.dayKey).toBe(DEMO_GOAL4_RESUMED_DAY);
      expect(resumed.reason).toContain('体調が戻った');
      expect(resumed.pending).toBe(false);
    });
  });
});

describe('目標時間・大きい沿革のサンプル（spec: goal-target-hours / goal-history・issue #76）', () => {
  it('主目標は目標時間（5h/日）と証拠写真を持ち、完走してもペースが安定して読める', () => {
    const g = getGoal(db, DEMO_GOAL_ID, vnow(DEMO_AFTER_END_DAY));
    expect(g.targetHours).not.toBeNull();
    expect(g.targetHours!.kind).toBe('TOTAL_WORK');
    expect(g.targetHours!.secondsPerDay).toBe(5 * 3600);
    expect(g.pace).not.toBeNull();
    expect(g.outcomeCaption).toBe('作業スペース');
    expect(g.outcomeMet).toBe(true);
  });

  it('3つ目の目標は目標時間つきで進行中に理由つきで終えている（大きい沿革の主役）', () => {
    const g = getGoal(db, DEMO_GOAL3_ID, vnow(DEMO_AFTER_END_DAY));
    expect(g.status).toBe('ended');
    expect(g.endedDayKey).toBe(DEMO_GOAL3_ENDED_DAY);
    expect(g.targetHours!.kind).toBe('GROUP_SET');
    expect(g.targetHours!.labels).toEqual(['AtCoder']);
    // 期限（7日）より前、Day5 で終えている。
    expect(g.endDay).toBe(DEMO_GOAL3_END_DAY);
    expect(g.startDay).toBe(DEMO_GOAL3_START_DAY);
  });

  it('大きい沿革に4件の目標（作成×4）と、終えた目標の行に3つ（到達判定・答え・Before→After）が並ぶ', () => {
    const h = goalHistory(db, vnow(DEMO_AFTER_END_DAY));
    const created = h.filter((e) => e.kind === 'created');
    expect(created.length).toBe(4);
    expect(created.some((e) => e.name === 'AtCoderのレーティングを上げる')).toBe(true);

    const ended = h.find((e) => e.kind === 'ended' && e.goalId === DEMO_GOAL3_ID)!;
    expect(ended).toBeDefined();
    expect(ended.reason).toContain('試験勉強はもう大丈夫');
    // ① 数字（目標時間の到達/未達）: 時間は目標(2h/日)に届かなかった。
    expect(ended.pace).not.toBeNull();
    expect(ended.pace!.met).toBe(false);
    // ② 自己申告: めざした状態には届いた（数字だけでは読めない事実・design D7 の主役）。
    expect(ended.outcomeMet).toBe(true);
    // ③ 証拠写真（Before→After）。
    expect(ended.photos.before).not.toBeNull();
    expect(ended.photos.after).not.toBeNull();
    expect(ended.photos.before!.dayKey).toBe(DEMO_GOAL3_START_DAY);
    expect(ended.photos.after!.dayKey).toBe(DEMO_GOAL3_ENDED_DAY);

    // 完走した主目標（DEMO_GOAL_ID）は 'completed' として載り、目標時間の到達も読める。
    const completedMain = h.find((e) => e.kind === 'completed' && e.goalId === DEMO_GOAL_ID)!;
    expect(completedMain).toBeDefined();
    expect(completedMain.pace).not.toBeNull();
    expect(completedMain.outcomeMet).toBe(true);
  });
});

describe('配分バー seed（reflection-alloc-group-identity）', () => {
  it('振り返り(紫)が1本の大きな WORK スライスへ合算され、今日タブ内訳と一致する（issue #47）', () => {
    const now = zonedTimeToEpoch(2026, 6, 25, 23, 0, 0, TZ); // Day15 の記録より後
    const a = getDayAllocation(db, DEMO_ALLOC_DAY, now);
    const work = a.slices.filter((s) => s.kind === 'WORK');
    // 振り返り(紫)は 30 分 × 6（別 stable_group_id）が1本の 3h スライスへ合算される。
    const reflect = work.find((s) => s.label === '振り返り')!;
    expect(reflect).toBeDefined();
    expect(reflect.seconds).toBe(3 * 3600);
    expect(reflect.color).toBe('purple');
    // WORK は「振り返り / 勉強 / 制作」に加え、改名使い回し（issue #52・未登録）の「執筆 / 調査」、
    // および登録済み改名（group-rule-snapshot-identity）で合算された「英語」の6スライス。
    // 同一 identity の分裂は起きないが、改名イベントとして記録されていない別 identity は別スライスのまま。
    expect(work).toHaveLength(6);
    expect(new Set(work.map((s) => s.label))).toEqual(
      new Set(['振り返り', '勉強', '制作', '執筆', '調査', '英語']),
    );
    // 「英会話」→「英語」の登録済み改名: 改名前後の2区間(30分×2)が同一 identity として
    // 現在名「英語」の1本(60分)へ合算される。旧名「英会話」のスライスは残らない（進捗が巻き戻らない）。
    const renamed = work.find((s) => s.label === '英語')!;
    expect(renamed).toBeDefined();
    expect(renamed.seconds).toBe(60 * 60);
    expect(renamed.color).toBe('cyan');
    expect(work.some((s) => s.label === '英会話')).toBe(false);
    // 振り返りが最大スライス（埋没せず先頭）。
    expect(a.slices[0]!.label).toBe('振り返り');
    // WORK スライス合計＝daySummary（today-group-breakdown）の同グループ合計（ドリフト防止）。
    const summary = daySummary(db, DEMO_ALLOC_DAY);
    for (const w of work) {
      const g = summary.groups.find((gr) => gr.name === w.label)!;
      expect(g, `daySummary に ${w.label} が無い`).toBeDefined();
      expect(w.seconds).toBe(Math.round(g.seconds));
    }
    // 休憩(MANUAL・grey)が1本。
    const manual = a.slices.filter((s) => s.kind === 'MANUAL');
    expect(manual).toHaveLength(1);
    expect(manual[0]!.seconds).toBe(45 * 60);
  });
});

describe('タイムライン identity 単位化 seed（timeline-group-identity / issue #52）', () => {
  it('改名して使い回した同一 sid が名前ごとに別 AUTO ブロックへ分離する', () => {
    const now = zonedTimeToEpoch(2026, 6, 25, 23, 0, 0, TZ); // Day15 の記録より後
    const tl = getTimeline(db, DEMO_ALLOC_DAY, now);
    const write = tl.auto.find((b) => b.title === '執筆');
    const research = tl.auto.find((b) => b.title === '調査');
    // 同一 stable_group_id('demo-reuse-52') だが、名前ごとに別ブロックへ分離する。
    expect(write).toBeDefined();
    expect(research).toBeDefined();
    expect(write!.color).toBe('green');
    expect(research!.color).toBe('blue');
    // 先頭名(執筆)で 16:00–17:00 全区間を覆う単一ブロックにはならない。
    expect(tl.auto.some((b) => b.title === '執筆' && b.endAt - b.startAt > 30 * 60 * 1000)).toBe(false);
    // 別 sid・同一 identity の連続「振り返り」(demo-refl-1/2) は1本へ結合される（#47 と一貫）。
    // 9:00–9:30 と 9:30–10:00 は別 stable_group_id だが連続・同一 identity のため 9:00–10:00 の1ブロック。
    const reflStart = zonedTimeToEpoch(2026, 6, 25, 9, 0, 0, TZ);
    const reflEnd = zonedTimeToEpoch(2026, 6, 25, 10, 0, 0, TZ);
    expect(tl.auto.some((b) => b.title === '振り返り' && b.startAt === reflStart && b.endAt === reflEnd)).toBe(true);
  });

  it('登録済みの改名（英会話→英語）は隣接ブロックが1本へ結合され現在名で表示される', () => {
    const now = zonedTimeToEpoch(2026, 6, 25, 23, 0, 0, TZ);
    const tl = getTimeline(db, DEMO_ALLOC_DAY, now);
    const start = zonedTimeToEpoch(2026, 6, 25, 17, 0, 0, TZ);
    const end = zonedTimeToEpoch(2026, 6, 25, 18, 0, 0, TZ);
    const merged = tl.auto.find((b) => b.startAt === start && b.endAt === end);
    expect(merged).toBeDefined();
    expect(merged!.title).toBe('英語'); // 改名前の「英会話」区間を含め、現在名の1ブロック。
    expect(tl.auto.some((b) => b.title === '英会話')).toBe(false);
  });
});

describe('自動記録の削除デモ（timeline-record-deletion / issue #90）', () => {
  // レポート①（達成カレンダーの achievedDays・cells[].actualSeconds）は capability ごと
  // 廃止された（spec: goal-report REMOVED）。「閉じ忘れブロックを削除すると Day16 の実測秒数が
  // 減り、取り消すと元に戻る」という本テストの核（issue #90）は、レポートを経由せず
  // totalWorkSecondsForDay() で直接検証する（既存の集計関数・burnup も内部で使う）。
  it('閉じ忘れた「動画視聴」ブロックが谷日 Day16 に見え、削除すると総作業時間が減り取り消せる', () => {
    const now = vnow(DEMO_AFTER_END_DAY);

    // (a) デモリセット直後＝「気づく前」。閉じ忘れブロックぶんも含めて Day16 は320分（force で
    // 一度だけ本物の集計を通した状態・seedDemo 参照）。
    expect(totalWorkSecondsForDay(db, DEMO_FORGOTTEN_DAY)).toBe(320 * 60);

    const tl = getTimeline(db, DEMO_FORGOTTEN_DAY);
    const video = tl.auto.find((b) => b.title === '動画視聴')!;
    expect(video).toBeDefined();
    expect(video.endAt - video.startAt).toBe(120 * 60_000);

    // (b) 削除（API と同じ経路: 除外レコード追加 → force 再集計 → force 再評価）。
    const id = addAutoExclusion(db, DEMO_FORGOTTEN_DAY, {
      identityKey: video.identityKey,
      startAt: video.startAt,
      endAt: video.endAt,
    });
    recompute(db, { onlyDays: [DEMO_FORGOTTEN_DAY], force: true });
    evaluateDay(db, DEMO_FORGOTTEN_DAY, now, { force: true });

    expect(totalWorkSecondsForDay(db, DEMO_FORGOTTEN_DAY)).toBe(200 * 60); // 320分 → 200分（-2時間）。
    expect(getTimeline(db, DEMO_FORGOTTEN_DAY).auto.some((b) => b.title === '動画視聴')).toBe(false);

    // (c) 取り消し: 削除前の状態へ完全に戻る。
    expect(removeAutoExclusion(db, id)).toBe(true);
    recompute(db, { onlyDays: [DEMO_FORGOTTEN_DAY], force: true });
    evaluateDay(db, DEMO_FORGOTTEN_DAY, now, { force: true });

    expect(totalWorkSecondsForDay(db, DEMO_FORGOTTEN_DAY)).toBe(320 * 60);
    expect(getTimeline(db, DEMO_FORGOTTEN_DAY).auto.some((b) => b.title === '動画視聴')).toBe(true);
  });
});

describe('設計図のサンプル（spec: task-tree / goal-blueprint / task-estimate）', () => {
  it('主目標の設計図は3階層・根直下の枝が2つ完了・1つ走行中・進行中の葉を1つ持つ', () => {
    const { nodes } = getBlueprint(db, DEMO_GOAL_ID);
    expect(nodes.map((n) => n.title)).toEqual(['志望動機を明確にする', '面接の練習をする', '苦手な質問への回答を用意する']);

    const branch1 = nodes[0]!; // 完了（tree_order 0）。
    expect(branch1.done).toBe(true);
    expect(branch1.children.map((n) => n.title)).toEqual(['企業研究をする', '自己分析をする']);
    expect(branch1.children.every((n) => n.done)).toBe(true);
    expect(branch1.estimatedSeconds).toBe(12 * 3600);

    const branch2 = nodes[1]!; // 完了（tree_order 1）。
    expect(branch2.done).toBe(true);
    expect(branch2.children.map((n) => n.title)).toEqual(['模擬面接を1回受ける']);

    const branch3 = nodes[2]!; // 走行中（tree_order 2・runningBranch はここへ収束する）。
    expect(branch3.done).toBe(false);
    const pickUp = branch3.children.find((n) => n.title === '質問をピックアップする')!;
    expect(pickUp.done).toBe(true); // 完了済みの葉。
    expect(pickUp.notes).toBe('去年の資料から。20問くらいに絞る。');
    const list = branch3.children.find((n) => n.title === '定番の質問リストを書き出す')!;
    expect(list.done).toBe(true); // pickUp と同日（凍結明け Day13）に完了する2件目。

    const summarize = branch3.children.find((n) => n.title === '回答をまとめる')!;
    expect(summarize.children).toHaveLength(2); // 3階層目（容れ物のさらに下）。
    const draft = summarize.children.find((n) => n.title === 'Notion に下書きする')!;
    expect(draft.status).toBe('DOING'); // 進行中の葉。
    expect(draft.done).toBe(false);
    expect(summarize.done).toBe(false); // 未決着の子孫を持つため容れ物はまだ未完了。
    // 想定時間は上書きされても記録は残る（design D6）。現在値は見直し後の30h。
    expect(branch3.estimatedSeconds).toBe(30 * 3600);
    const changes = db
      .prepare('SELECT reason FROM task_estimate_change WHERE task_id = ? ORDER BY id')
      .all(branch3.id) as { reason: string }[];
    expect(changes.map((c) => c.reason)).toEqual(['当初の見立て', '一周目の感触からもう少し軽いと見直した']);

    // 展開規則: 進行中の葉（Notion に下書きする）へ至る枝だけが開く（design D10）。
    const idOf = (title: string): number => nodes.flatMap(flattenIds).find((n) => n.title === title)!.id;
    const open = computeOpenPath(nodes);
    expect(open).toEqual([idOf('苦手な質問への回答を用意する'), idOf('回答をまとめる')]);
  });

  it('容れ物（回答をまとめる）は葉だけがカンバンのカードになる盤面から隠れる', () => {
    const rows = listTasks(db);
    const summarize = rows.find((t) => t.title === '回答をまとめる')!;
    expect(summarize.has_children).toBe(1);
    const draft = rows.find((t) => t.title === 'Notion に下書きする')!;
    expect(draft.has_children).toBe(0);
    expect(draft.parent_task_id).toBe(summarize.id);
  });
});

describe('進捗グラフのサンプル（spec: goal-burnup / task-estimate・issue #105 系）', () => {
  it('根直下の枝が2つ完了（黒丸）・1つ走行中（白丸）で、走行中の枝は同日2件完了をまとめる', () => {
    const v = goalBurnup(db, DEMO_GOAL_ID, vnow(DEMO_AFTER_END_DAY))!;
    expect(v.markers.branches.map((b) => ({ title: b.title, completed: b.completed }))).toEqual([
      { title: '志望動機を明確にする', completed: true },
      { title: '面接の練習をする', completed: true },
      { title: '苦手な質問への回答を用意する', completed: false },
    ]);
    const running = v.markers.branches.find((b) => !b.completed)!;
    expect(running.leaves.map((l) => l.title)).toEqual(
      expect.arrayContaining(['質問をピックアップする', '定番の質問リストを書き出す', 'Notion に下書きする', '先輩にレビューしてもらう']),
    );
    // 凍結明け Day13（2026-06-23）に2件同日完了 → leafCompletions で1グループにまとまる。
    const group = v.markers.leafCompletions.find((g) => g.dayKey === '2026-06-23')!;
    expect(group).toBeDefined();
    expect(group.leaves.map((l) => l.title).sort()).toEqual(['定番の質問リストを書き出す', '質問をピックアップする'].sort());
  });

  it('走行中の枝は実測から単価を導き、残り想定・完了予想日が算定される（進行中の時点で見る）', () => {
    // 完走後は完了予想を出さない（design task 7.7）ため、進行中の Day（凍結明けから数日後）で見る。
    const v = goalBurnup(db, DEMO_GOAL_ID, vnow('2026-07-05'))!;
    // 2つの完了枝は残り0（黒丸に単価は乗らない）。残りは走行中の枝ぶんだけ。
    expect(v.remainingSeconds).not.toBeNull();
    expect(v.remainingSeconds).toBeGreaterThan(0);
    expect(v.overall.projectedDay).not.toBeNull();
    expect(v.recent3.projectedDay).not.toBeNull();
  });
});

describe('本番非干渉ガードレール（5.1）', () => {
  it('デモ DB のリセットは本番 DB（別コネクション）に一切触れない', () => {
    const prod = openDb(':memory:');
    const before = (prod.prepare('SELECT COUNT(*) AS c FROM goal').get() as { c: number }).c;
    expect(before).toBe(0);

    // デモ DB を構築・リセット・読み取り（主目標＋手動チェックのみ目標＋終えた目標＋終了→再開目標の4件）。
    const demo = getDemoDb();
    expect(listGoals(demo, vnow(DEMO_AFTER_END_DAY)).length).toBe(4);
    resetDemoDb();
    getGoal(getDemoDb(), DEMO_GOAL_ID, vnow(DEMO_AFTER_END_DAY));

    // 本番 DB は無傷（目標ゼロのまま）。
    const after = (prod.prepare('SELECT COUNT(*) AS c FROM goal').get() as { c: number }).c;
    expect(after).toBe(0);
    prod.close();
  });

  it('デモ関連ソースは reveal・本番書き込み関数を import/参照しない', () => {
    const here = dirname(fileURLToPath(import.meta.url)); // .../server/src/services
    const files = [
      join(here, 'demo-db.ts'),
      join(here, 'demo-seed.ts'),
      join(here, '..', 'api', 'demo.ts'),
    ];
    // reveal・パスワード生成・本番書き込み系の識別子は現れてはならない（design.md D3）。
    const forbidden = [
      'revealPasswords',
      'password/reveal',
      'runPasswordCommand',
      'markRevealFired',
      'createGoal',
      'saveJournal',
      'deleteGoal',
      'updateConfig',
      'saveReflection',
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const token of forbidden) {
        expect(src.includes(token), `${f} に禁止識別子 ${token} が含まれています`).toBe(false);
      }
    }
  });
});
