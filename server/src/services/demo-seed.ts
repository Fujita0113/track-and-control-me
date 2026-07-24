import zlib from 'node:zlib';
import type { DB } from '../db/index.js';
import { addDaysKey } from './goals.js';
import { resolveIdentity, renameIdentity } from './group-identity.js';

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
export const DEMO_GOAL_ID = 1; // 主目標・空 DB への最初の挿入なので rowid=1。

const GOAL_DAYS = 30;
const GOAL_NAME = 'メンタルを安定させる';
const GOAL_PURPOSE = '毎日を穏やかに保ち、作業と振り返りの習慣で心を整える。';

// --- 2つ目のデモ目標: 手動チェック（非時間型）のみを採用した完走目標 --------------
// 時間型の実践を含まないため、完走レポートに②「時間の推移」が出ない例を示す
// （goal-adopt-manual-check）。主目標より前の別期間（2026-05）に置き、一覧では主目標の後ろに並ぶ。
export const DEMO_GOAL2_ID = 2;
export const DEMO_GOAL2_START_DAY = '2026-05-01'; // Day1
export const DEMO_GOAL2_END_DAY = addDaysKey(DEMO_GOAL2_START_DAY, GOAL_DAYS - 1); // 2026-05-30
const GOAL2_NAME = '朝の散歩を習慣にする';
const GOAL2_PURPOSE = '時間では測らない「やった／やってない」だけの一点突破チャレンジ。';
const KEY_WALK = 'manual:朝散歩';
const KEY_STRETCH = 'manual:ストレッチ';
// 手動チェックを飛ばした日（1始まり Day 番号）。両方達成の日＝達成日数 24/30。
const WALK_MISS_DAYS = new Set<number>([5, 12, 20]); // 朝散歩 met 27/30
const STRETCH_MISS_DAYS = new Set<number>([8, 12, 15, 22]); // ストレッチ met 26/30
// 2つ目の目標の日記（Before/After＋中盤の谷のみ・他日は空でフォールバック確認）。
const GOAL2_JOURNAL: Record<number, string> = {
  1: '# 朝散歩を始める\n時間や量で自分を追い込むのに疲れた。今回は「やったか/やってないか」だけ。朝に外へ出て、軽くストレッチ。それだけを30日。',
  12: '**両方飛ばした日。** 寝坊して散歩もストレッチも抜けた。数字じゃないぶん、抜けた日は白黒はっきり残る。それでいい。',
  30: '# 30日を終えて\n時間で測らないチェックだけでも、続けた事実はちゃんと積み上がった。カレンダーが埋まっていくのが素直に嬉しい。',
};

// 総作業の閾値: Day1..12 は 4h（14400s）、Day13 に 3h（10800s）へ引き下げ（理由つき）。
const THRESH_HIGH = 14400;
const THRESH_LOW = 10800;
const THRESH_CHANGE_DAY = 13; // Day13 から低い閾値が効く。

// seed 用の固定タイムスタンプ（Date.now() 非依存。canDelete 等の判定には使われない経路）。
const SEED_TS = Date.UTC(2026, 5, 10, 0, 0, 0); // 2026-06-10T00:00:00Z

// --- 配分バー（reflection-day-overview）用のタイムライン記録 seed（reflection-alloc-group-identity）--
// issue #47 の再現: 同名同色（振り返り・紫）を「開き直しで別 stable_group_id」になった複数セッションとして
// 焼き込む。配分バーが名前＋色 identity で束ねれば1本の大きなスライスへ合算される（分裂・埋没しない）。
// 既存の谷日 Day15（2026-06-25）に置く。session は達成集計(daily_totals_snapshot)を読まないため
// 達成日数 24/30 の筋書きには影響しない（配分表示は別経路）。
export const DEMO_ALLOC_DAY = addDaysKey(DEMO_START_DAY, 14); // Day15 = 2026-06-25
// 2026-06-25 の JST 時刻 → epoch ms（Date.now 非依存。JST = UTC+9、対象時刻は全て 09:00 以降）。
const allocMs = (h: number, mi: number): number => Date.UTC(2026, 5, 25, h - 9, mi, 0);

// 実践の condition_key（既存の採用モデルと同じ命名）。
const KEY_TOTAL = 'total_work';
const KEY_REFLECTION = 'planning:reflection_done';
const KEY_TOMORROW = 'planning:tomorrow_tasks_registered';
// 手動チェック実践（非時間型）。安定キー manual:<ラベル>（goal-adopt-manual-check）。
const KEY_KIN = 'manual:筋トレ';

// 筋トレ（手動チェック）を飛ばした日（1始まりの Day 番号）。
// いずれも既存の谷（Day 11,12,13,15,16,20）に含まれる日のみ選ぶ＝達成日数 24/30 を変えない。
const KIN_MISS_DAYS = new Set<number>([11, 12, 16]);

// --- ⑤沿革のサンプル: Plan（賭け）と Check（答え合わせ）（spec: goal-plan-check / goal-chronicle）--
//
// 既存の谷（Day 11,12,13,20）へ寄せて「崩れた → 賭けを立てた → 答え合わせした」の筋が読めるようにする。
// Plan/Check は goal_practice ではないので ①達成カレンダー・達成日数 24/30 には一切影響しない
// （per_condition_results は上で焼き込み済みで、Check の合流はデモの評価行を書き換えない）。
//
// 📷×単発・📷×範囲・💬×単発・取り下げ済み を1つずつ揃える。
const D = (n: number): string => addDaysKey(DEMO_START_DAY, n - 1); // Day 番号 → day_key。

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
  '# はじめての一日\n最近、気持ちの浮き沈みが激しい。まずは「作業4時間・振り返り・明日の準備・筋トレ」を30日続けてみる。体を動かすと気分が上向くと聞いたので、筋トレは手動チェックで記録する。うまくやろうとしすぎないのが今日のテーマ。',
  '朝の入りは重かったが、机に向かえば手は動いた。振り返りを書くと、頭の中が少し整理される感覚がある。',
  'ペースはつかめてきた。完璧じゃなくても「やった」に丸をつけられるのは気分がいい。',
  '今日はよく集中できた。作業が乗ると、夜の振り返りも前向きになる。良い循環。',
  '疲れは残るが淡々とこなせた。明日のタスクを先に決めておくと朝が軽い。',
  '眠気と戦いつつ最低ラインは超えた。続けることの意味が少し分かってきた。',
  '調子の良い日。長めに作業できた。気分が安定しているのが自分でも分かる。',
  '平常運転。派手さはないが、こういう日を積み重ねたい。',
  '少し飽きが来た。それでも手順化しておいたおかげで動けた。',
  '10日到達。ここまで大きく崩れずに来られた。折り返しに向けて気を抜かない。',
  '**つまずいた。** やることが重なって作業時間が全然伸びない。明日の準備も、筋トレも手が回らなかった。',
  '気持ちが沈んで振り返りを書けなかった。筋トレも今日はパス。無理に埋めず、今日は寝る。ゼロの日も記録に残す。',
  '課題週間で作業4時間はもう現実的じゃない。**閾値を3時間へ下げた。** 逃げじゃなく、ゼロにしないための調整。',
  '下げた基準なら届いた。小さくても「達成」に戻せたのが大きい。',
  '振り返りは書けたが作業が伸びず。谷はまだ続いている。焦らない。',
  '作業は戻ってきた。ただ夜に力尽きて振り返りも筋トレも抜けた。惜しい。',
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
  '# 30日を終えて\n始めた頃の不安定さが嘘のよう。**基準を下げてでも続けた**中盤の判断が効いた。作業と振り返り、そして筋トレの習慣が体に馴染んだ。数字の達成より、\n心が整った実感が一番の収穫。この習慣は続ける。',
];

// --- サンプル画像（単色 PNG・design D8）------------------------------------
// ③④の画像表示をデモで見せるため、依存なしで生成した単色 PNG を BLOB として焼き込む。
// 変化を色で表す（初日=灰 / 中間=琥珀 / 最終日=緑）。中身は説明用のダミー。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function pngCrc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function solidPng(rgb: [number, number, number], w = 480, h = 360): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8bit / RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = rgb[0];
    row[1 + x * 3 + 1] = rgb[1];
    row[1 + x * 3 + 2] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
const IMG_BEFORE = solidPng([138, 148, 166]); // 灰（初日）
const IMG_MID = solidPng([224, 165, 58]); // 琥珀（中間）
const IMG_AFTER = solidPng([76, 175, 106]); // 緑（最終日）
const IMG_SKY = solidPng([132, 178, 214]); // 空色（範囲Check の「その日の空」）
const IMG_DESK = solidPng([196, 172, 140]); // 木目（単発Check の「朝の机」）

/**
 * ⑤沿革のサンプル（Plan / Check / 回答 / 取り下げ）を焼き込む。
 * すべて固定 day_key・固定タイムスタンプ（`Date.now()` 非依存）。
 *
 * 筋書き（既存の谷に寄せる）:
 *   Day11 谷で崩れる → Day11 に「朝へ前倒し」の賭け（📷×単発・💬×単発 で答え合わせ）
 *   Day13 閾値を 3h へ下げた判断を Plan として残す（📷×範囲 で7日中5日の記録）
 *   Day20 取りこぼしから「寝る前のスマホ」の賭け → 続かず**理由つきで取り下げ**（沿革には残る）
 */
function seedPlansAndChecks(db: DB): void {
  const insPlan = db.prepare(
    `INSERT INTO goal_plan (id, goal_id, day_key, body, status, withdraw_reason, created_at)
     VALUES (@id, @goal, @day, @body, @status, @reason, @now)`,
  );
  const insCheck = db.prepare(
    `INSERT INTO goal_check
       (id, plan_id, kind, caption, question_text, schedule, start_day_key, span_days, place_note, time_note, status, cancel_reason, created_at)
     VALUES (@id, @plan, @kind, @caption, @question, @schedule, @start, @span, @place, @time, @status, @cancel, @now)`,
  );
  const insResult = db.prepare(
    `INSERT INTO goal_check_result (check_id, day_key, image_id, answer_text, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insImg = db.prepare(
    `INSERT INTO goal_journal_image (goal_id, day_key, caption, mime, bytes, width, height, sort_order, created_at)
     VALUES (?, ?, ?, 'image/png', ?, 480, 360, ?, ?)`,
  );
  /** 写真Check の提出＝先指定キャプションで画像を保存し、その image_id を回答に持つ（design D5）。 */
  const submitPhoto = (checkId: number, dayKey: string, caption: string, bytes: Buffer, sort: number): void => {
    const imageId = insImg.run(DEMO_GOAL_ID, dayKey, caption, bytes, sort, SEED_TS).lastInsertRowid as number;
    insResult.run(checkId, dayKey, imageId, null, SEED_TS);
  };

  // --- Plan A（Day11 の谷で立てた賭け）------------------------------------
  // 文面は社史調の言い切り（飾らない）。Plan→Check が素直につながる筋にする。
  insPlan.run({
    id: 1, goal: DEMO_GOAL_ID, day: D(11),
    body: '作業を朝いちに前倒しする。夜に回すと崩れるため。',
    status: 'active', reason: null, now: SEED_TS,
  });
  // A1: 📷×単発 — Day14 に「朝の机」を1枚。提出済み。
  insCheck.run({
    id: 1, plan: 1, kind: 'photo', caption: '朝の机', question: '',
    schedule: 'single', start: D(14), span: null, place: '自室', time: '朝',
    status: 'active', cancel: null, now: SEED_TS,
  });
  submitPhoto(1, D(14), '朝の机', IMG_DESK, 0);
  // A2: 💬×単発 — Day15 に一度だけ答える。
  insCheck.run({
    id: 2, plan: 1, kind: 'question', caption: '', question: '前倒しで集中は変わったか',
    schedule: 'single', start: D(15), span: null, place: null, time: null,
    status: 'active', cancel: null, now: SEED_TS,
  });
  insResult.run(2, D(15), null, '朝は入りが速い。前夜に眠れないと崩れる。', SEED_TS);

  // --- Plan B（Day13 の閾値引き下げの判断そのものを残す）-------------------
  insPlan.run({
    id: 2, goal: DEMO_GOAL_ID, day: D(13),
    body: '総作業の基準を4時間から3時間へ下げる。ゼロの日を作らないため。',
    status: 'active', reason: null, now: SEED_TS,
  });
  // B1: 📷×範囲 — Day14〜Day20 の7日間、毎日「その日の空」を撮る。7日中5日提出（Day16・Day19 はサボり）。
  // サボった日は繰り越さず、期間を過ぎたら消える＝沿革には「7日中5日提出」と事実どおり残る。
  insCheck.run({
    id: 3, plan: 2, kind: 'photo', caption: 'その日の空', question: '',
    schedule: 'range', start: D(14), span: 7, place: null, time: '朝',
    status: 'active', cancel: null, now: SEED_TS,
  });
  for (const [i, day] of [14, 15, 17, 18, 20].entries()) submitPhoto(3, D(day), 'その日の空', IMG_SKY, i);

  // --- Plan C（Day20 の取りこぼしから立て、続かず取り下げた）---------------
  // 取り下げた事実と理由は沿革に残す＝「逃げた事実そのものが歴史に残る」（design D9）。
  insPlan.run({
    id: 3, goal: DEMO_GOAL_ID, day: D(20),
    body: '就寝前のスマホをやめる。',
    status: 'withdrawn', reason: '続かず。意志ではなく置き場所から変える。', now: SEED_TS,
  });
  // C1: 💬×範囲 — Day21〜Day25 の5日間。2日答えたところで Plan ごと取り下げ（未達なので cancelled）。
  insCheck.run({
    id: 4, plan: 3, kind: 'question', caption: '', question: 'スマホを見ずに寝られたか',
    schedule: 'range', start: D(21), span: 5, place: null, time: '夜',
    status: 'cancelled', cancel: '続かず。意志ではなく置き場所から変える。', now: SEED_TS,
  });
  insResult.run(4, D(21), null, '見ずに寝られた。朝の目覚めは軽い。', SEED_TS);
  insResult.run(4, D(22), null, 'ベッドで30分見てしまった。手の届く場所にあるのが因。', SEED_TS);
}

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
    // 手動チェック実践「筋トレ」（非時間型・閾値なし）。完走レポート①に手動チェック行として乗る。
    insPractice.run({ goal: DEMO_GOAL_ID, key: KEY_KIN, target: 'MANUAL_CHECK', label: '筋トレ', group: null, signal: null, sort: 3 });

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
      const kinMet = !KIN_MISS_DAYS.has(i + 1); // 筋トレ（手動チェック）。飛ばした日のみ未達成。
      const allMet = metTotal && plan.refl && plan.tmr && kinMet;

      // per_condition_results（レポート①②と today の条件進捗が読む焼き込み列）。
      // 手動チェックは非時間型なので actualSeconds/thresholdSeconds を持たない。
      const per = [
        { conditionKey: KEY_TOTAL, target: 'TOTAL_WORK', met: metTotal, actualSeconds: workSec, thresholdSeconds: threshold, label: '総作業時間' },
        { conditionKey: KEY_REFLECTION, target: 'PLANNING', met: plan.refl, signalKey: 'reflection_done', label: '今日の振り返り' },
        { conditionKey: KEY_TOMORROW, target: 'PLANNING', met: plan.tmr, signalKey: 'tomorrow_tasks_registered', label: '明日のタスク登録' },
        { conditionKey: KEY_KIN, target: 'MANUAL_CHECK', met: kinMet, label: '筋トレ' },
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

    // サンプル画像（③④の見え方確認用・design D8）。
    // 「作業スペース」= 初日/中間/最終日の3枚（③デフォルトは初日↔最終日、全比較は3枚）、
    // 「植物」= 初日/最終日の2枚、Day30 に単独の「記念」1枚。
    const midDay = addDaysKey(DEMO_START_DAY, 14); // Day15
    const insImg = db.prepare(
      `INSERT INTO goal_journal_image (goal_id, day_key, caption, mime, bytes, width, height, sort_order, created_at)
       VALUES (?, ?, ?, 'image/png', ?, 480, 360, ?, ?)`,
    );
    insImg.run(DEMO_GOAL_ID, DEMO_START_DAY, '作業スペース', IMG_BEFORE, 0, SEED_TS);
    insImg.run(DEMO_GOAL_ID, DEMO_START_DAY, '植物', IMG_BEFORE, 1, SEED_TS);
    insImg.run(DEMO_GOAL_ID, midDay, '作業スペース', IMG_MID, 0, SEED_TS);
    insImg.run(DEMO_GOAL_ID, DEMO_END_DAY, '作業スペース', IMG_AFTER, 0, SEED_TS);
    insImg.run(DEMO_GOAL_ID, DEMO_END_DAY, '植物', IMG_AFTER, 1, SEED_TS);
    insImg.run(DEMO_GOAL_ID, DEMO_END_DAY, '記念', IMG_AFTER, 2, SEED_TS);

    seedPlansAndChecks(db);

    // --- 2つ目のデモ目標: 手動チェックのみ（非時間型）を採用した完走目標 -----------
    // 時間型実践が無いため、完走レポートは①達成カレンダーのみ・②時間の推移は出ない。
    db.prepare(
      'INSERT INTO goal (id, name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(DEMO_GOAL2_ID, GOAL2_NAME, GOAL2_PURPOSE, DEMO_GOAL2_START_DAY, DEMO_GOAL2_END_DAY, SEED_TS);
    // 採用実践は手動チェック2つ（朝散歩 / ストレッチ）。閾値なし・非時間型。
    insPractice.run({ goal: DEMO_GOAL2_ID, key: KEY_WALK, target: 'MANUAL_CHECK', label: '朝散歩', group: null, signal: null, sort: 0 });
    insPractice.run({ goal: DEMO_GOAL2_ID, key: KEY_STRETCH, target: 'MANUAL_CHECK', label: 'ストレッチ', group: null, signal: null, sort: 1 });

    for (let i = 0; i < GOAL_DAYS; i++) {
      const dayKey = addDaysKey(DEMO_GOAL2_START_DAY, i);
      const walkMet = !WALK_MISS_DAYS.has(i + 1);
      const stretchMet = !STRETCH_MISS_DAYS.has(i + 1);
      const allMet = walkMet && stretchMet;
      // per_condition_results は手動チェックのみ（actualSeconds/thresholdSeconds なし＝非時間型）。
      const per = [
        { conditionKey: KEY_WALK, target: 'MANUAL_CHECK', met: walkMet, label: '朝散歩' },
        { conditionKey: KEY_STRETCH, target: 'MANUAL_CHECK', met: stretchMet, label: 'ストレッチ' },
      ];
      insEval.run({
        day: dayKey,
        status: allMet ? 'UNLOCKED' : 'LOCKED',
        met: allMet ? 1 : 0,
        per: JSON.stringify(per),
        first: allMet ? SEED_TS : null,
        now: SEED_TS,
      });
      const j = GOAL2_JOURNAL[i + 1];
      if (j) insJournal.run(DEMO_GOAL2_ID, dayKey, j, SEED_TS, SEED_TS);
    }
    // ③ Before/After 画像（1枚ずつ・同一キャプションでペア化）。
    insImg.run(DEMO_GOAL2_ID, DEMO_GOAL2_START_DAY, '朝の道', IMG_BEFORE, 0, SEED_TS);
    insImg.run(DEMO_GOAL2_ID, DEMO_GOAL2_END_DAY, '朝の道', IMG_AFTER, 0, SEED_TS);

    // --- 配分バー用タイムライン記録（Day15・reflection-alloc-group-identity）-----------
    // 振り返り(紫)を「開き直しで別 stable_group_id」になった 30 分 × 6 回＝3h として焼き込む。
    // 名前＋色 identity で束ねれば1本の大きなスライスへ合算される（issue #47 の再現・確認）。
    const insAllocSession = db.prepare(
      `INSERT INTO session
         (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
          started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, '[]', 1, ?, 'NORMAL', ?)`,
    );
    // [stable_group_id, 名前, 色, [開始h,開始m], [終了h,終了m]]。
    const allocSessions: [string, string, string, [number, number], [number, number]][] = [
      ['demo-refl-1', '振り返り', 'purple', [9, 0], [9, 30]], // 別 group_id・同名同色
      ['demo-refl-2', '振り返り', 'purple', [9, 30], [10, 0]],
      ['demo-alloc-study', '勉強', 'blue', [10, 0], [11, 0]],
      ['demo-refl-3', '振り返り', 'purple', [11, 0], [11, 30]],
      ['demo-refl-4', '振り返り', 'purple', [11, 30], [12, 0]],
      ['demo-alloc-study', '勉強', 'blue', [12, 45], [13, 45]],
      ['demo-refl-5', '振り返り', 'purple', [13, 45], [14, 15]],
      ['demo-refl-6', '振り返り', 'purple', [14, 15], [14, 45]],
      ['demo-alloc-make', '制作', 'green', [14, 45], [15, 30]],
      // 同一 stable_group_id を改名して使い回す（timeline-group-identity / issue #52）。
      // 「執筆」(green)→「調査」(blue) は同一 sid だが、タイムラインでは名前ごとに
      // 別ブロックへ分離する（先頭名で全区間を覆う巨大ブロックにならないことの再現）。
      ['demo-reuse-52', '執筆', 'green', [16, 0], [16, 30]],
      ['demo-reuse-52', '調査', 'blue', [16, 30], [17, 0]],
    ];
    for (const [gid, name, color, [sh, sm], [eh, em]] of allocSessions) {
      const s = allocMs(sh, sm);
      const e = allocMs(eh, em);
      // recompute.ts 相当: セッション確定時に identity を解決する（group-rule-snapshot-identity）。
      resolveIdentity(db, name, color, gid, e);
      insAllocSession.run(gid, name, color, s, e, DEMO_ALLOC_DAY, e - s, SEED_TS);
    }

    // --- 改名（登録済み）の筋書き（group-rule-snapshot-identity・design D3/D4）-------------
    // 「執筆」→「調査」（上記）は改名イベントとして記録されていない別々の組なので分離したまま。
    // こちらは実際に `renameIdentity` を通した「登録済みの改名」＝進捗が巻き戻らないことを示す。
    // 同一 stable_group_id を「英会話」(cyan) → 「英語」(cyan) へ改名して使い回す。
    const renameGid = 'demo-rename-lang';
    const beforeRename = { name: '英会話', color: 'cyan' };
    const afterRename = { name: '英語', color: 'cyan' };
    const renameAt = allocMs(17, 30);
    resolveIdentity(db, beforeRename.name, beforeRename.color, renameGid, allocMs(17, 0));
    insAllocSession.run(
      renameGid, beforeRename.name, beforeRename.color,
      allocMs(17, 0), allocMs(17, 30), DEMO_ALLOC_DAY, 30 * 60 * 1000, SEED_TS,
    );
    renameIdentity(db, beforeRename, afterRename, renameAt);
    resolveIdentity(db, afterRename.name, afterRename.color, renameGid, allocMs(18, 0));
    insAllocSession.run(
      renameGid, afterRename.name, afterRename.color,
      allocMs(17, 30), allocMs(18, 0), DEMO_ALLOC_DAY, 30 * 60 * 1000, SEED_TS,
    );
    // 休憩（自己申告 MANUAL・grey）12:00–12:45。配分バーに MANUAL スライスを1本見せる。
    db.prepare(
      `INSERT INTO activity_log_entry
         (day_key, start_at, end_at, entry_type, title, color, category_key, coactive_group_keys,
          n, co_record_group_id, edited, created_at, updated_at)
       VALUES (?, ?, ?, 'MANUAL', '休憩', 'grey', '休憩', '[]', 1, NULL, 0, ?, ?)`,
    ).run(DEMO_ALLOC_DAY, allocMs(12, 0), allocMs(12, 45), SEED_TS, SEED_TS);
  });
  tx();
}
