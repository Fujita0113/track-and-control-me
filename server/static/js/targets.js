// 共有: 条件ターゲットの語彙(値↔ラベル)。gate.js / rules.js が同じ定義を使う。
export const TARGETS = [
  { v: 'TOTAL_WORK', label: '総作業時間' },
  { v: 'GROUP', label: 'グループ作業' },
  { v: 'MANUAL_CHECK', label: '手動チェック' },
  { v: 'PLANNING', label: '翌日計画' },
];

/** ターゲット値 → 日本語ラベル。未知はそのまま返す。 */
export function targetLabel(t) {
  const found = TARGETS.find((x) => x.v === t);
  return found ? found.label : t;
}
