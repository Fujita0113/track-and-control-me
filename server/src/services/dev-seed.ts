import type { DB } from '../db/index.js';
import { createTask } from './tasks.js';
import { createGoal, addDaysKey } from './goals.js';
import { todayKey } from './summary.js';

/**
 * 開発用DB（フォールバックポート起動時の `track.dev.sqlite`）を新規作成した回に限り投入する
 * 最小限のサンプルデータ（spec: server-port-fallback / design.md D4）。
 * 生SQLではなく既存のサービス関数を使う（バリデーション・不変条件に自動的に追従するため）。
 * 使い捨てデータのため `Date.now()` 基準の相対日時でよい（固定 day_key の再現性は不要）。
 */
export function seedDevSample(db: DB): void {
  createTask(db, { title: '受信トレイを整理する', status: 'TODO', priority: 'mid' });
  createTask(db, { title: '今日の作業計画を立てる', status: 'DOING', priority: 'high' });
  createTask(db, { title: 'デモ用タスクの完了確認', status: 'DONE', priority: 'low' });

  createGoal(db, {
    name: '開発用サンプル目標',
    purpose: 'フォールバック起動時のダッシュボード確認用サンプルデータ。',
    startReason: '開発用DBの動作確認のため',
    endDay: addDaysKey(todayKey(db), 29),
    start: 'today',
    rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 3600, reason: '開発用サンプルの初期ルール' }],
  });
}
