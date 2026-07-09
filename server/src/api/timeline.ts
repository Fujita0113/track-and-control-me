import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './types.js';
import {
  getTimeline,
  addManualEntry,
  updateEntry,
  deleteEntry,
  promoteGapToAway,
  setSplitOverride,
} from '../services/timeline.js';
import { todayKey } from '../services/summary.js';

/** タイムライン API（tasks 6.3–6.5, 6.7）。 */
export function registerTimelineRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;

  app.get('/api/timeline/:date', async (req) => {
    const { date } = req.params as { date: string };
    return getTimeline(db, date);
  });

  app.post('/api/timeline/:date/manual', async (req, reply) => {
    const { date } = req.params as { date: string };
    const b = req.body as {
      startAt: number;
      endAt: number;
      title: string;
      color?: string | null;
      categoryKey?: string | null;
    };
    if (b?.startAt == null || b?.endAt == null || !b?.title) {
      reply.code(400);
      return { error: 'startAt, endAt, title は必須' };
    }
    const id = addManualEntry(db, date, b);
    return { id };
  });

  app.patch('/api/timeline/entry/:id', async (req) => {
    const { id } = req.params as { id: string };
    const patch = req.body as Record<string, unknown>;
    return { updated: updateEntry(db, Number(id), patch) };
  });

  app.delete('/api/timeline/entry/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { deleted: deleteEntry(db, Number(id)) };
  });

  app.post('/api/timeline/:date/gap-to-away', async (req, reply) => {
    const { date } = req.params as { date: string };
    const b = req.body as { startAt: number; endAt: number; title?: string };
    if (b?.startAt == null || b?.endAt == null) {
      reply.code(400);
      return { error: 'startAt, endAt は必須' };
    }
    const id = promoteGapToAway(db, date, b.startAt, b.endAt, b.title);
    return { id };
  });

  // 割合上書き（task 6.7）: 保存 → 再集計で円グラフ/合計へ反映。
  app.put('/api/timeline/:date/split', async (req, reply) => {
    const { date } = req.params as { date: string };
    const b = req.body as { startAt: number; endAt: number; ratios: Record<string, number> };
    if (b?.startAt == null || b?.endAt == null || !b?.ratios) {
      reply.code(400);
      return { error: 'startAt, endAt, ratios は必須' };
    }
    setSplitOverride(db, date, b.startAt, b.endAt, b.ratios);
    deps.runPipeline();
    return getTimeline(db, date);
  });

  // 明示的に「今日」を返すユーティリティ。
  app.get('/api/timeline', async () => getTimeline(db, todayKey(db)));
}
