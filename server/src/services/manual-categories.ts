import type { DB } from '../db/index.js';

/**
 * 手動記録カテゴリのレジストリ（spec: manual-category-registry / design.md D2/D3）。
 * 離席／空き時間の記録ポップオーバーで使う表示ラベルを読み書きする純粋なデータ層。
 * カテゴリは表示ラベルにすぎず、集計・ルール評価・rollover・パスワード解錠へは一切波及させない
 * （依存を持ち込まない）。並び順は「最終使用の新しい順 → シード挿入順（rowid）」。
 */

export interface ManualCategory {
  name: string;
  lastUsedAt: number;
  useCount: number;
}

/** 登録済みカテゴリを直近使用順で返す（未使用はシード順で末尾）。 */
export function listManualCategories(db: DB): ManualCategory[] {
  const rows = db
    .prepare(
      'SELECT name, last_used_at, use_count FROM manual_category ORDER BY last_used_at DESC, rowid ASC',
    )
    .all() as { name: string; last_used_at: number; use_count: number }[];
  return rows.map((r) => ({ name: r.name, lastUsedAt: r.last_used_at, useCount: r.use_count }));
}

/**
 * カテゴリの使用を登録（upsert）。既存なら最終使用時刻を更新し使用回数を +1、
 * 未知なら新規登録（use_count=1）。trim 後に空になる名前は no-op（登録しない）。
 */
export function recordCategoryUse(db: DB, name: string, nowMs: number): void {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return;
  db.prepare(
    `INSERT INTO manual_category (name, last_used_at, use_count, created_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET
       last_used_at = excluded.last_used_at,
       use_count = use_count + 1`,
  ).run(trimmed, nowMs, nowMs);
}
