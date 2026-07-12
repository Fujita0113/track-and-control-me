// アプリ共有状態: 設定と「今日」の dayKey をブート時に一度読み込む。
import { api } from './api.js';

export const state = {
  config: null,
  today: null, // 作業日 'YYYY-MM-DD'（境界 04:00）
  // お試し（デモ）モード（spec: demo-mode / design.md D5）。
  //  active=false（通常モード）では全画面のデモ分岐が完全 no-op。
  //  virtualDay=仮想「今日」の day_key、goal=サンプル目標のメタ（id/期間/名前）。
  demo: { active: false, virtualDay: null, goal: null },
};

export async function loadState() {
  state.config = await api.getConfig();
  const summary = await api.getSummary();
  state.today = summary.dayKey;
  return state;
}
