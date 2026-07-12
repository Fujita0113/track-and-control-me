import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './types.js';
import {
  getTimeline,
  addManualEntry,
  addCoRecordEntries,
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
      title?: string;
      color?: string | null;
      categoryKey?: string | null;
      category?: string | null;
      // 複数カテゴリの均等割同時記録（timeline-coactive-record）。
      categories?: string[];
    };
    if (b?.startAt == null || b?.endAt == null) {
      reply.code(400);
      return { error: 'startAt, endAt は必須' };
    }
    // 複数カテゴリ配列があれば同時記録として一括作成（正規化後 0 件は 400）。
    if (Array.isArray(b.categories)) {
      const ids = addCoRecordEntries(db, date, {
        startAt: b.startAt,
        endAt: b.endAt,
        categories: b.categories,
        color: b.color,
      });
      if (ids.length === 0) {
        reply.code(400);
        return { error: '有効なカテゴリを1つ以上指定してください' };
      }
      return { ids, id: ids[0] };
    }
    // 後方互換: 単一 body（title 必須）。
    if (!b?.title) {
      reply.code(400);
      return { error: 'startAt, endAt, title は必須' };
    }
    const id = addManualEntry(db, date, {
      startAt: b.startAt,
      endAt: b.endAt,
      title: b.title,
      color: b.color,
      categoryKey: b.categoryKey,
      category: b.category,
    });
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
