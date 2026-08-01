import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { seedDevSample } from './dev-seed.js';
import { listTasks } from './tasks.js';
import { listGoals } from './goals.js';

/**
 * spec: server-port-fallback — 開発用DBの初回サンプルデータ投入。
 * 空の開発用DBに対して呼んだときだけ意味を持つので、ここでは
 * 「呼べばカンバンタスクと長期目標が最低1件ずつできる」ことだけを確認する
 * (存在チェック自体は main.ts 側の起動シーケンスの責務)。
 */

describe('seedDevSample', () => {
  it('カンバンタスクを最低1件作る', () => {
    const db = openDb(':memory:');
    seedDevSample(db);
    const tasks = listTasks(db);
    expect(tasks.length).toBeGreaterThan(0);
  });

  it('長期目標を最低1件作る', () => {
    const db = openDb(':memory:');
    seedDevSample(db);
    const goals = listGoals(db);
    expect(goals.length).toBeGreaterThan(0);
  });
});
