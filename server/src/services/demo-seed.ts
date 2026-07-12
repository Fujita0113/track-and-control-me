import type { DB } from '../db/index.js';
import { addDaysKey } from './goals.js';

/**
 * デモ（お試し）モードのサンプルデータ（spec: demo-mode / design.md D4）。
 * goal-report の design-brief の筋書きをそのまま固定 day_key に焼き込む。
 * 集計が実際に読むテーブル（goal / goal_practice / practice_threshold_change /
 * goal_journal / unlock_evaluation.per_condition_results / daily_totals_snapshot）へ
 * 直接挿入し、30日ぶんのゲート評価パイプラインは再現走行しない。
 * `Date.now()` に依存しない（固定 day_key と固定タイムスタンプのみ）。
 */

// --- 固定期間（design-brief）--------------------------------------------------
export const DEMO_START_DAY = '2026-06-11'; // Day1
export const DEMO_END_DAY = '2026-07-10'; // Day30（start + 29）
export const DEMO_PRE_START_DAY = addDaysKey(DEMO_START_DAY, -1); // 開始前（start − 1）
export const DEMO_AFTER_END_DAY = addDaysKey(DEMO_END_DAY, 1); // 完走（end + 1）
export const DEMO_GOAL_ID = 1; // 単一目標・空 DB への最初の挿入なので rowid=1。

const GOAL_DAYS = 30;
const GOAL_NAME = 'メンタルを安定させる';
const GOAL_PURPOSE = '毎日を穏やかに保ち、作業と振り返りの習慣で心を整える。';

// 総作業の閾値: Day1..12 は 4h（14400s）、Day13 に 3h（10800s）へ引き下げ（理由つき）。
const THRESH_HIGH = 14400;
const THRESH_LOW = 10800;
const THRESH_CHANGE_DAY = 13; // Day13 から低い閾値が効く。

// seed 用の固定タイムスタンプ（Date.now() 非依存。canDelete 等の判定には使われない経路）。
const SEED_TS = Date.UTC(2026, 5, 10, 0, 0, 0); // 2026-06-10T00:00:00Z

// 実践の condition_key（既存の採用モデルと同じ命名）。
const KEY_TOTAL = 'total_work';
const KEY_REFLECTION = 'planning:reflection_done';
const KEY_TOMORROW = 'planning:tomorrow_tasks_registered';

/**
 * 30日ぶんの筋書き（達成 24/30・中盤に谷→後半持ち直し）。
 * workMin = その日の総作業分、refl = 振り返り記入、tmr = 明日タスク登録。
 * met(total) は当日の閾値との比較で導出（Day13 以降は低い閾値）。
 * 未達成（谷）は Day 11,12,13,15,16,20 の6日に集約する。
 */
interface DayPlan {
  workMin: number;
  refl: boolean;
  tmr: boolean;
}
const T = true;
const F = false;
const PLAN: DayPlan[] = [
  { workMin: 250, refl: T, tmr: T }, // Day1
  { workMin: 268, refl: T, tmr: T }, // Day2
  { workMin: 242, refl: T, tmr: T }, // Day3
  { workMin: 300, refl: T, tmr: T }, // Day4
  { workMin: 255, refl: T, tmr: T }, // Day5
  { workMin: 246, refl: T, tmr: T }, // Day6
  { workMin: 280, refl: T, tmr: T }, // Day7
  { workMin: 252, refl: T, tmr: T }, // Day8
  { workMin: 264, refl: T, tmr: T }, // Day9
  { workMin: 248, refl: T, tmr: T }, // Day10
  { workMin: 175, refl: T, tmr: F }, // Day11 谷: 作業も明日計画も崩れる
  { workMin: 150, refl: F, tmr: T }, // Day12 谷: 振り返りが書けない
  { workMin: 205, refl: T, tmr: F }, // Day13 閾値を 3h へ。作業は届くが計画が抜ける（谷）
  { workMin: 190, refl: T, tmr: T }, // Day14 立て直しの一歩
  { workMin: 130, refl: T, tmr: T }, // Day15 谷: 作業が伸びない
  { workMin: 200, refl: F, tmr: T }, // Day16 谷: 振り返りが抜ける
  { workMin: 210, refl: T, tmr: T }, // Day17 持ち直し
  { workMin: 225, refl: T, tmr: T }, // Day18
  { workMin: 198, refl: T, tmr: T }, // Day19
  { workMin: 205, refl: T, tmr: F }, // Day20 一度きりの取りこぼし
  { workMin: 215, refl: T, tmr: T }, // Day21
  { workMin: 230, refl: T, tmr: T }, // Day22
  { workMin: 200, refl: T, tmr: T }, // Day23
  { workMin: 240, refl: T, tmr: T }, // Day24
  { workMin: 210, refl: T, tmr: T }, // Day25
  { workMin: 225, refl: T, tmr: T }, // Day26
  { workMin: 250, refl: T, tmr: T }, // Day27
  { workMin: 235, refl: T, tmr: T }, // Day28
  { workMin: 260, refl: T, tmr: T }, // Day29
  { workMin: 275, refl: T, tmr: T }, // Day30
];

// 30日ぶんの日記（Day1=Before / Day30=After、中盤は谷と交渉、後半は持ち直し）。
const JOURNAL: string[] = [
  '# はじめての一日\n最近、気持ちの浮き沈みが激しい。まずは「作業4時間・振り返り・明日の準備」を30日続けてみる。うまくやろうとしすぎないのが今日のテーマ。',
  '朝の入りは重かったが、机に向かえば手は動いた。振り返りを書くと、頭の中が少し整理される感覚がある。',
  'ペースはつかめてきた。完璧じゃなくても「やった」に丸をつけられるのは気分がいい。',
  '今日はよく集中できた。作業が乗ると、夜の振り返りも前向きになる。良い循環。',
  '疲れは残るが淡々とこなせた。明日のタスクを先に決めておくと朝が軽い。',
  '眠気と戦いつつ最低ラインは超えた。続けることの意味が少し分かってきた。',
  '調子の良い日。長めに作業できた。気分が安定しているのが自分でも分かる。',
  '平常運転。派手さはないが、こういう日を積み重ねたい。',
  '少し飽きが来た。それでも手順化しておいたおかげで動けた。',
  '10日到達。ここまで大きく崩れずに来られた。折り返しに向けて気を抜かない。',
  '**つまずいた。** やることが重なって作業時間が全然伸びない。明日の準備まで手が回らなかった。',
  '気持ちが沈んで振り返りを書けなかった。無理に埋めず、今日は寝る。ゼロの日も記録に残す。',
  '課題週間で作業4時間はもう現実的じゃない。**閾値を3時間へ下げた。** 逃げじゃなく、ゼロにしないための調整。',
  '下げた基準なら届いた。小さくても「達成」に戻せたのが大きい。',
  '振り返りは書けたが作業が伸びず。谷はまだ続いている。焦らない。',
  '作業は戻ってきた。ただ夜に力尽きて振り返りが抜けた。惜しい。',
  '谷を抜けた感触。基準を下げたことで、続けること自体は途切れていない。',
  '安定してきた。3時間ラインが今の自分にはちょうどいい。',
  'リズムが戻った。振り返りを書くと一日の区切りがつく。',
  '油断して明日の準備を忘れた。一度きりにする。',
  '立て直し完了。ここからは積み上げるだけ。',
  '好調。作業も準備も自然に回るようになってきた。',
  '淡々と達成。習慣になると意志の力をあまり使わなくて済む。',
  '集中できた一日。数字より「整っている感覚」が増えた。',
  '残り一週間。ここまで来ると続けるのが当たり前になっている。',
  '気分の波が明らかに小さくなった。記録を見返すと自分の変化が分かる。',
  '好調維持。作業のあとの振り返りが一番落ち着く時間になった。',
  '安定。明日の準備までがワンセットとして体に入った。',
  'あと一日。谷も含めて全部が今の自分をつくった。',
  '# 30日を終えて\n始めた頃の不安定さが嘘のよう。**基準を下げてでも続けた**中盤の判断が効いた。数字の達成より、\n心が整った実感が一番の収穫。この習慣は続ける。',
];

/** デモ用サンプルを空の（マイグレーション済み）DB へ seed する。 */
export function seedDemo(db: DB): void {
  const tx = db.transaction(() => {
    // 目標本体。
    db.prepare(
      'INSERT INTO goal (id, name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(DEMO_GOAL_ID, GOAL_NAME, GOAL_PURPOSE, DEMO_START_DAY, DEMO_END_DAY, SEED_TS);

    // 採用実践3つ（作業4時間 / 振り返りを書く / 明日のタスク登録）。
    const insPractice = db.prepare(
      `INSERT INTO goal_practice (goal_id, condition_key, target, label_snapshot, stable_group_id, signal_key, sort_order)
       VALUES (@goal, @key, @target, @label, @group, @signal, @sort)`,
    );
    insPractice.run({ goal: DEMO_GOAL_ID, key: KEY_TOTAL, target: 'TOTAL_WORK', label: '総作業時間', group: null, signal: null, sort: 0 });
    insPractice.run({ goal: DEMO_GOAL_ID, key: KEY_REFLECTION, target: 'PLANNING', label: '今日の振り返り', group: null, signal: 'reflection_done', sort: 1 });
    insPractice.run({ goal: DEMO_GOAL_ID, key: KEY_TOMORROW, target: 'PLANNING', label: '明日のタスク登録', group: null, signal: 'tomorrow_tasks_registered', sort: 2 });

    // 閾値変更ログ（Day13 に 4h→3h、理由必須）。
    const changeDate = addDaysKey(DEMO_START_DAY, THRESH_CHANGE_DAY - 1);
    db.prepare(
      `INSERT INTO practice_threshold_change (condition_key, effective_date, old_seconds, new_seconds, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(KEY_TOTAL, changeDate, THRESH_HIGH, THRESH_LOW, '課題週間。ゼロにはしない', SEED_TS);

    // タブグループ（today ビューのドーナツ/名称用）。
    const insGroup = db.prepare(
      `INSERT INTO tab_group (stable_group_id, name, color, external_group_id, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    );
    insGroup.run('demo-study', '勉強', 'blue', SEED_TS, SEED_TS);
    insGroup.run('demo-make', '制作', 'green', SEED_TS, SEED_TS);

    const insEval = db.prepare(
      `INSERT INTO unlock_evaluation
         (day_key, status, conditions_met, per_condition_results, first_met_at, reveal_fired, is_final, updated_at)
       VALUES (@day, @status, @met, @per, @first, 0, 1, @now)`,
    );
    const insTotals = db.prepare(
      `INSERT INTO daily_totals_snapshot (day_key, stable_group_id, ms, is_final, updated_at)
       VALUES (@day, @group, @ms, 1, @now)`,
    );
    const insJournal = db.prepare(
      `INSERT INTO goal_journal (goal_id, day_key, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    for (let i = 0; i < GOAL_DAYS; i++) {
      const dayKey = addDaysKey(DEMO_START_DAY, i);
      const plan = PLAN[i]!;
      const threshold = i + 1 >= THRESH_CHANGE_DAY ? THRESH_LOW : THRESH_HIGH;
      const workSec = plan.workMin * 60;
      const metTotal = workSec >= threshold;
      const allMet = metTotal && plan.refl && plan.tmr;

      // per_condition_results（レポート①②と today の条件進捗が読む焼き込み列）。
      const per = [
        { conditionKey: KEY_TOTAL, target: 'TOTAL_WORK', met: metTotal, actualSeconds: workSec, thresholdSeconds: threshold, label: '総作業時間' },
        { conditionKey: KEY_REFLECTION, target: 'PLANNING', met: plan.refl, signalKey: 'reflection_done', label: '今日の振り返り' },
        { conditionKey: KEY_TOMORROW, target: 'PLANNING', met: plan.tmr, signalKey: 'tomorrow_tasks_registered', label: '明日のタスク登録' },
      ];
      insEval.run({
        day: dayKey,
        status: allMet ? 'UNLOCKED' : 'LOCKED',
        met: allMet ? 1 : 0,
        per: JSON.stringify(per),
        first: allMet ? SEED_TS : null,
        now: SEED_TS,
      });

      // 総作業スナップショット（勉強65% / 制作35%で分割、合計 = workSec）。
      const studyMs = Math.round(workSec * 0.65) * 1000;
      const makeMs = workSec * 1000 - studyMs;
      insTotals.run({ day: dayKey, group: 'demo-study', ms: studyMs, now: SEED_TS });
      insTotals.run({ day: dayKey, group: 'demo-make', ms: makeMs, now: SEED_TS });

      // 目標日記（30日ぶん）。
      insJournal.run(DEMO_GOAL_ID, dayKey, JOURNAL[i] ?? '', SEED_TS, SEED_TS);
    }
  });
  tx();
}
