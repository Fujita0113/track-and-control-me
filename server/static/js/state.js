// アプリ共有状態: 設定と「今日」の dayKey をブート時に一度読み込む。
import { api } from './api.js';

export const state = {
  config: null,
  today: null, // 作業日 'YYYY-MM-DD'（境界 04:00）
};

export async function loadState() {
  state.config = await api.getConfig();
  const summary = await api.getSummary();
  state.today = summary.dayKey;
  return state;
}
