import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type DB } from '../db/index.js';
import { registerApiRoutes } from './index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { recompute } from '../services/recompute.js';
import { totalWorkMsForDay } from '../services/categories.js';

/**
 * spec: timeline-record-deletion（issue #90）— 自動記録の削除／取り消し API。
 * `split` と同じく「日付スコープ ＋ 即時再集計」の形。API 呼び出しだけで集計が更新され、
 * 呼び出し側が別途 recompute を回さなくても GET /api/timeline に反映されることを固定する。
 */

const TZ = 'Asia/Tokyo';
const DAY = '2026-08-05';
const MIN = 60_000;
const jst = (h: number, mi: number) => zonedTimeToEpoch(2026, 8, 5, h, mi, 0, TZ);

const W1 = { start: jst(12, 0), end: jst(13, 0) }; // 開発 + ブログ投稿（同時2）
const W2 = { start: jst(14, 0), end: jst(15, 0) }; // 開発 のみ（単独）

let app: FastifyInstance;
let db: DB;
let seq = 0;

function seedWindow(groups: { stableGroupId: string; title: string; color: string }[], win: { start: number; end: number }): void {
  const stmt = db.prepare(
    `INSERT INTO raw_sample
      (boot_id, seq, client_ts, monotonic_ms, tz, event_type, active_group_id,
       active_stable_group_id, active_title, active_color, window_id, tab_id,
       idle_state, browser_focused, open_group_keys, ext_version, received_at)
     VALUES ('boot', ?, ?, ?, 'Asia/Tokyo', 'HEARTBEAT', 1, ?, ?, ?, 1, 1, 'active', 1, ?, '0.1.0', ?)`,
  );
  const open = JSON.stringify(
    groups.map((g, i) => ({ groupId: i + 1, stableGroupId: g.stableGroupId, title: g.title, color: g.color })),
  );
  const head = groups[0]!;
  for (let t = win.start; t <= win.end; t += MIN) {
    stmt.run(seq++, t, t - jst(0, 0), head.stableGroupId, head.title, head.color, open, t);
  }
}

async function timeline(): Promise<{ auto: { title: string; startAt: number; identityKey: string; creditedMs: number }[] }> {
  const res = await app.inject({ method: 'GET', url: `/api/timeline/${DAY}` });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

async function identityKeyOf(title: string, startAt: number): Promise<string> {
  const tl = await timeline();
  const block = tl.auto.find((b) => b.title === title && b.startAt === startAt);
  expect(block, `AUTO ブロックが見つからない: ${title}`).toBeDefined();
  return block!.identityKey;
}

async function postExclusion(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/timeline/${DAY}/exclusions`, payload });
}

beforeEach(async () => {
  db = openDb(':memory:');
  seq = 0;
  app = Fastify();
  await registerApiRoutes(app, { db, runPipeline: () => {} });
  await app.ready();
  seedWindow([
    { stableGroupId: 'g-dev', title: '開発', color: 'green' },
    { stableGroupId: 'g-blog', title: 'ブログ投稿', color: 'magenta' },
  ], W1);
  seedWindow([{ stableGroupId: 'g-dev', title: '開発', color: 'green' }], W2);
  recompute(db);
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('POST /api/timeline/:date/exclusions', () => {
  it('自動記録を削除し、応答時点で集計とタイムラインへ反映されている', async () => {
    const identityKey = await identityKeyOf('開発', W2.start);
    const res = await postExclusion({ identityKey, startAt: W2.start, endAt: W2.end });

    expect(res.statusCode).toBe(200);
    expect(typeof JSON.parse(res.body).id).toBe('number');

    // 呼び出し側が recompute を回さなくても反映されている。
    const tl = await timeline();
    expect(tl.auto.some((b) => b.startAt === W2.start)).toBe(false);
    expect(totalWorkMsForDay(db, DAY)).toBe(60 * MIN); // 120分 − 60分
  });

  it('同時オープンの一方を削除すると残りへ再按分された結果が返る', async () => {
    const identityKey = await identityKeyOf('開発', W1.start);
    await postExclusion({ identityKey, startAt: W1.start, endAt: W1.end });

    const tl = await timeline();
    const blog = tl.auto.find((b) => b.title === 'ブログ投稿')!;
    expect(blog.creditedMs).toBe(60 * MIN);
    expect(totalWorkMsForDay(db, DAY)).toBe(120 * MIN); // 総和は不変
  });

  it('確定済みの日でも削除できる', async () => {
    const identityKey = await identityKeyOf('開発', W2.start);
    db.prepare('UPDATE daily_totals_snapshot SET is_final = 1 WHERE day_key = ?').run(DAY);

    const res = await postExclusion({ identityKey, startAt: W2.start, endAt: W2.end });
    expect(res.statusCode).toBe(200);
    expect(totalWorkMsForDay(db, DAY)).toBe(60 * MIN);
  });

  it('identityKey が無い、または endAt <= startAt は 400 で拒否する', async () => {
    const identityKey = await identityKeyOf('開発', W2.start);

    const noKey = await postExclusion({ startAt: W2.start, endAt: W2.end });
    expect(noKey.statusCode).toBe(400);

    const badRange = await postExclusion({ identityKey, startAt: W2.end, endAt: W2.start });
    expect(badRange.statusCode).toBe(400);

    const zeroRange = await postExclusion({ identityKey, startAt: W2.start, endAt: W2.start });
    expect(zeroRange.statusCode).toBe(400);

    // 拒否された要求は集計を変えない。
    expect(totalWorkMsForDay(db, DAY)).toBe(120 * MIN);
    const tl = await timeline();
    expect(tl.auto.some((b) => b.startAt === W2.start)).toBe(true);
  });
});

describe('DELETE /api/timeline/exclusion/:id', () => {
  it('取り消すと記録と集計が元へ戻る', async () => {
    const identityKey = await identityKeyOf('開発', W2.start);
    const created = await postExclusion({ identityKey, startAt: W2.start, endAt: W2.end });
    const { id } = JSON.parse(created.body) as { id: number };
    expect(totalWorkMsForDay(db, DAY)).toBe(60 * MIN);

    const res = await app.inject({ method: 'DELETE', url: `/api/timeline/exclusion/${id}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).restored).toBe(true);

    const tl = await timeline();
    expect(tl.auto.some((b) => b.title === '開発' && b.startAt === W2.start)).toBe(true);
    expect(totalWorkMsForDay(db, DAY)).toBe(120 * MIN);
  });

  it('存在しない ID の取り消しはエラーにせず restored:false を返す', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/timeline/exclusion/999999' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).restored).toBe(false);
    expect(totalWorkMsForDay(db, DAY)).toBe(120 * MIN);
  });
});
