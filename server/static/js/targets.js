// 共有: 条件ターゲットの語彙(値↔ラベル)。today.js(ゲート) / rules.js が同じ定義を使う。
export const TARGETS = [
  { v: 'TOTAL_WORK', label: '総作業時間' },
  { v: 'GROUP', label: 'グループ作業' },
  { v: 'MANUAL_CHECK', label: '手動チェック' },
  { v: 'PLANNING', label: '就寝前リチュアル' },
];

/** ターゲット値 → 日本語ラベル。未知はそのまま返す。 */
export function targetLabel(t) {
  const found = TARGETS.find((x) => x.v === t);
  return found ? found.label : t;
}

// 共有: PLANNING の signal_key 語彙（キー↔日本語ラベル）。
// サーバー planning.ts の PLANNING_SIGNAL_KEYS と一致させる。null は tomorrow_planned 相当。
export const PLANNING_SIGNALS = [
  { v: 'tomorrow_planned', label: '翌日計画（振り返り＋明日タスク）' },
  { v: 'reflection_done', label: '今日の振り返り' },
  { v: 'tomorrow_tasks_registered', label: '明日のタスク登録' },
];

/** signal_key → 日本語ラベル。null/未設定は既定（tomorrow_planned）扱い。未知は生キーを表示。 */
export function planningSignalLabel(k) {
  if (k == null || k === '') return '翌日計画（既定）';
  const found = PLANNING_SIGNALS.find((x) => x.v === k);
  return found ? found.label : k;
}
