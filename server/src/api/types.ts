import type { DB } from '../db/index.js';

export interface ApiDeps {
  db: DB;
  /** ingest 後と同じダウンストリーム処理（再計算/評価/reveal）を同期実行。 */
  runPipeline: () => void;
}
