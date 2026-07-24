import { describe, it, expect, beforeEach } from 'vitest';
import { UNGROUPED_KEY } from '@track/contract';
import { openDb, type DB, updateConfig } from '../db/index.js';
import { daySummary, rangeSummary } from './summary.js';
import { totalWorkSecondsForDay } from './categories.js';
import { upsertFutureRuleSet } from '../rules/rules.js';
import { evaluateDay } from '../rules/evaluate.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { resolveIdentity, renameIdentity } from './group-identity.js';

/**
 * spec: today-group-breakdown — 今日タブ/range の「グループ別」内訳を、記録時点スナップショット
 * `(tab_group_name_snapshot, group_color_snapshot)` identity 単位で集計・分類する（issue #19）。
 * 権威集計(daily_totals)・総作業時間・解錠ルール評価は不変であることも固定する。
 */

const TZ = 'Asia/Tokyo';
const DAY = '2026-07-11';
const NOW_BEFORE = zonedTimeToEpoch(2026, 7, 10, 12, 0, 0, TZ);
const NOW_DAY = zonedTimeToEpoch(2026, 7, 11, 12, 0, 0, TZ);
const MIN = 60_000;

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function seedSession(
  db: DB,
  sid: string,
  name: string,
  color: string | null,
  ms: number,
  dayKey = DAY,
): void {
  db.prepare(
    `INSERT INTO session
       (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
        started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES (?, ?, ?, NULL, 0, ?, ?, '[]', 1, ?, 'NORMAL', 0)`,
  ).run(sid, name, color, ms, dayKey, ms);
}

function seedTotals(db: DB, sid: string, ms: number, dayKey = DAY): void {
  db.prepare(
    `INSERT INTO daily_totals_snapshot (day_key, stable_group_id, ms, is_final, updated_at)
     VALUES (?, ?, ?, 0, 0)
     ON CONFLICT(day_key, stable_group_id) DO UPDATE SET ms = excluded.ms`,
  ).run(dayKey, sid, ms);
}

describe('2.1 改名をまたいだグループは記録時点の名前で別スライスになる', () => {
  it('同一 sid の webエンジニアリング(pink)→振り返り(purple) が別スライスで返る', () => {
    // 実データ相当: 同一 sid が pink `webエンジニアリング` 100分 → purple `振り返り` 20分。
    const sid = '70d5118e-web';
    seedSession(db, sid, 'webエンジニアリング', 'pink', 100 * MIN);
    seedSession(db, sid, '振り返り', 'purple', 20 * MIN);

    const groups = daySummary(db, DAY).groups;
    const web = groups.find((g) => g.name === 'webエンジニアリング');
    const rev = groups.find((g) => g.name === '振り返り');

    // pink は消えず、現在名 purple `振り返り` に吸収されない。
    expect(web).toBeDefined();
    expect(web!.color).toBe('pink');
    expect(web!.seconds).toBe(100 * 60);
    expect(rev).toBeDefined();
    expect(rev!.color).toBe('purple');
    expect(rev!.seconds).toBe(20 * 60);
    // 別 identity なので合成キーも別。
    expect(web!.stableGroupId).not.toBe(rev!.stableGroupId);
    // ms 降順: pink が先頭。
    expect(groups[0]!.name).toBe('webエンジニアリング');
  });

  it('7日棒グラフでも改名前系列(pink)が該当日に保持される', () => {
    const sid = '70d5118e-web';
    seedSession(db, sid, 'webエンジニアリング', 'pink', 100 * MIN);
    seedSession(db, sid, '振り返り', 'purple', 20 * MIN);

    const range = rangeSummary(db, DAY, DAY);
    expect(range).toHaveLength(1);
    const names = range[0]!.groups.map((g) => g.name);
    expect(names).toContain('webエンジニアリング');
    expect(names).toContain('振り返り');
  });
});

describe('2.2 集計方式切り替え後も総作業時間と解錠ルール判定は不変', () => {
  it('KPI と TOTAL_WORK/GROUP は daily_totals 源泉のまま（session の改名内訳に影響されない）', () => {
    // 権威集計: g-dev 130分・未グループ 20分。KPI/ルールはこれのみを読む。
    seedTotals(db, 'g-dev', 130 * MIN);
    seedTotals(db, UNGROUPED_KEY, 20 * MIN);
    // 内訳(session): 同一 sid g-dev が途中改名して2 identity になっていても KPI/ルールは不変。
    seedSession(db, 'g-dev', '開発A', 'blue', 100 * MIN);
    seedSession(db, 'g-dev', '開発B', 'green', 30 * MIN);
    seedSession(db, UNGROUPED_KEY, 'ungrouped', null, 20 * MIN);

    upsertFutureRuleSet(
      db,
      DAY,
      {
        combinator: 'ALL',
        conditions: [
          { target: 'TOTAL_WORK', thresholdSeconds: 150 * 60 },
          { target: 'GROUP', stableGroupId: 'g-dev', thresholdSeconds: 120 * 60 },
        ],
      },
      NOW_BEFORE,
    );
    const r = evaluateDay(db, DAY, NOW_DAY);

    // KPI: 130 + 20 = 150 分（未グループ算入 = 既定 OFF）。
    expect(totalWorkSecondsForDay(db, DAY)).toBe(150 * 60);
    const total = r.perCondition.find((p) => p.target === 'TOTAL_WORK')!;
    expect(total.actualSeconds).toBe(150 * 60);
    expect(total.met).toBe(true);
    // GROUP は sid 単位合算 = 130 分（session の 100/30 分割に依らない）。
    const grp = r.perCondition.find((p) => p.target === 'GROUP')!;
    expect(grp.actualSeconds).toBe(130 * 60);
    expect(grp.met).toBe(true);
    expect(r.status).toBe('UNLOCKED');

    // 一方で内訳は改名 identity で2スライスに分離される。
    const groups = daySummary(db, DAY).groups;
    expect(groups.filter((g) => g.stableGroupId !== UNGROUPED_KEY)).toHaveLength(2);
  });
});

describe('2.3 未グループは単一行として表示され非計上ヒントを保持する', () => {
  it('複数の未グループ session が1行へ集約され、exclude ON で countsTowardTotal=false', () => {
    seedSession(db, UNGROUPED_KEY, 'ungrouped', null, 20 * MIN);
    seedSession(db, UNGROUPED_KEY, 'ungrouped', null, 10 * MIN);
    updateConfig(db, { exclude_ungrouped_from_total: 1 });

    const ung = daySummary(db, DAY).groups.filter((g) => g.stableGroupId === UNGROUPED_KEY);
    expect(ung).toHaveLength(1);
    expect(ung[0]!.seconds).toBe(30 * 60);
    expect(ung[0]!.name).toBe('その他（未グループ）');
    expect(ung[0]!.color).toBeNull();
    expect(ung[0]!.countsTowardTotal).toBe(false);
  });

  it('exclude OFF（既定）では countsTowardTotal=true', () => {
    seedSession(db, UNGROUPED_KEY, 'ungrouped', null, 20 * MIN);
    const ung = daySummary(db, DAY).groups.find((g) => g.stableGroupId === UNGROUPED_KEY)!;
    expect(ung.countsTowardTotal).toBe(true);
  });
});

describe('2.5 改名した区間は identity レジストリ経由で現在名の1スライスへ合算される', () => {
  it('改名前後の区間が同一 identity として合算され、旧名のスライスは残らない', () => {
    resolveIdentity(db, '競技プログラミング', 'yellow');
    seedSession(db, 'sid-a', '競技プログラミング', 'yellow', 90 * MIN);
    renameIdentity(db, { name: '競技プログラミング', color: 'yellow' }, { name: '競プロ', color: 'yellow' });
    seedSession(db, 'sid-a', '競プロ', 'yellow', 30 * MIN);

    const groups = daySummary(db, DAY).groups;
    expect(groups.find((g) => g.name === '競技プログラミング')).toBeUndefined();
    const merged = groups.find((g) => g.name === '競プロ');
    expect(merged).toBeDefined();
    expect(merged!.seconds).toBe(120 * 60);
  });
});

describe('2.4 同一 identity(name,color) の別 sid は1スライスへ合算', () => {
  it('異なる sid が同じ 振り返り(purple) なら合算される', () => {
    seedSession(db, 'sid-a', '振り返り', 'purple', 15 * MIN);
    seedSession(db, 'sid-b', '振り返り', 'purple', 25 * MIN);

    const purple = daySummary(db, DAY).groups.filter((g) => g.name === '振り返り');
    expect(purple).toHaveLength(1);
    expect(purple[0]!.seconds).toBe(40 * 60);
  });

  it('同名でも色が違えば別スライスのまま', () => {
    seedSession(db, 'sid-a', '振り返り', 'purple', 15 * MIN);
    seedSession(db, 'sid-b', '振り返り', 'pink', 25 * MIN);

    const rev = daySummary(db, DAY).groups.filter((g) => g.name === '振り返り');
    expect(rev).toHaveLength(2);
    expect(new Set(rev.map((g) => g.color))).toEqual(new Set(['purple', 'pink']));
  });
});
