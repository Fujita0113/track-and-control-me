// 共有: 条件ターゲットの語彙(値↔ラベル)。today.js(ゲート) / rule-form.js / goals.js が同じ定義を使う。
export const TARGETS = [
  { v: 'TOTAL_WORK', label: '総作業時間' },
  { v: 'GROUP', label: 'グループ作業' },
  { v: 'TIMELINE', label: 'タイムライン記録' },
  { v: 'MANUAL_CHECK', label: '手動チェック' },
  // PLANNING は編集 UI ではフラット化(CONDITION_KINDS)して signal_key ごとに1項目へ展開する。
  // ここは targetLabel のフォールバック用(単体で表示されることは通常ない)。
  { v: 'PLANNING', label: '翌日計画' },
  { v: 'PHOTO', label: '写真' },
  { v: 'QUESTION', label: '質問' },
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

/** 条件の表示ラベル(フラット)。PLANNING は signal_key のラベル、その他はターゲットのラベル。
 *  「就寝前リチュアル: 今日の振り返り」のような二重表記をやめ、条件の中身を直接示す。 */
export function conditionLabel(target, signalKey) {
  if (target === 'PLANNING') return planningSignalLabel(signalKey);
  return targetLabel(target);
}

/**
 * ルールの表示ラベル。サーバーは PLANNING ルールの `label` に生の signal_key を返す
 * （表示名の解決はクライアントの語彙を使うため）。それ以外の target はサーバーの label をそのまま使う。
 */
export function ruleNiceLabel(target, label) {
  if (target === 'PLANNING') return planningSignalLabel(label);
  return label;
}

// 共有: ルール編集の条件ドロップダウン(フラット)。
// 旧「就寝前リチュアル」ターゲット＋「シグナル」サブセレクトの2段を廃し、PLANNING を
// signal_key ごとに1項目へ展開する。各エントリは UI 選択値 v ↔ サーバー (target, signalKey)。
// PLANNING 系は "PLANNING:<signalKey>" を選択値にして 1 つの <select> で完結させる。
export const CONDITION_KINDS = [
  { v: 'TOTAL_WORK', target: 'TOTAL_WORK', signalKey: null },
  { v: 'GROUP', target: 'GROUP', signalKey: null },
  { v: 'TIMELINE', target: 'TIMELINE', signalKey: null },
  { v: 'MANUAL_CHECK', target: 'MANUAL_CHECK', signalKey: null },
  { v: 'PLANNING:reflection_done', target: 'PLANNING', signalKey: 'reflection_done' },
  { v: 'PLANNING:tomorrow_tasks_registered', target: 'PLANNING', signalKey: 'tomorrow_tasks_registered' },
  { v: 'PLANNING:tomorrow_planned', target: 'PLANNING', signalKey: 'tomorrow_planned' },
].map((k) => ({ ...k, label: conditionLabel(k.target, k.signalKey) }));

/** (target, signalKey) → 条件ドロップダウンの選択値 v。PLANNING は signal_key を含める(null は tomorrow_planned)。 */
export function conditionKindValue(target, signalKey) {
  if (target === 'PLANNING') return `PLANNING:${signalKey || 'tomorrow_planned'}`;
  return target;
}

/** 選択値 v → { target, signalKey }。"PLANNING:<key>" を分解し、凍結済みの未知 signal_key も復元できる。 */
export function conditionKindTarget(v) {
  if (v.startsWith('PLANNING:')) return { target: 'PLANNING', signalKey: v.slice('PLANNING:'.length) };
  return { target: v, signalKey: null };
}
