// 初回オンボーディング(spec: onboarding-initial-rules).
// 当日ルール無し かつ 未来ルール無し のとき、初期ルール作成を促すダイアログを表示し、
// 翌日(未来日)ルール作成フローへ誘導する。当日ルールの自動生成は行わない(凍結ポリシー維持)。
import { api } from './api.js';
import { state } from './state.js';
import { h, openModal, closeModal, toast } from './util.js';
import { openRuleEditor } from './rules.js';

/** 未来ルール = DRAFT_FUTURE 状態のルールセット(編集可能な未来日)。 */
function hasFutureRule(rulesets) {
  return (rulesets || []).some(
    (rs) => rs && rs.ruleSet && rs.ruleSet.status === 'DRAFT_FUTURE',
  );
}

/** 条件成立(当日ルール無し かつ 未来ルール無し)ならダイアログを表示する。 */
export async function maybeShowOnboarding() {
  let unlock;
  let rulesets;
  try {
    [unlock, rulesets] = await Promise.all([
      api.getUnlock(state.today),
      api.getRules(),
    ]);
  } catch {
    return; // 取得失敗時は黙って何もしない(通常フローを妨げない)。
  }

  const noTodayRule = !unlock.hasRuleSet;
  const noFutureRule = !hasFutureRule(rulesets);
  if (!(noTodayRule && noFutureRule)) return; // どちらか有ればダイアログを出さない。

  showDialog();
}

function showDialog() {
  // 初期状態(実効ルール皆無)では、当日から使えるよう「今日」のルールを作成する。
  // このブートストラップ当日ルールは今日中は何度でも編集でき、明日以降は凍結される。
  const target = state.today;
  const body = h('div', { class: 'modal-body' },
    h('p', {}, 'まだ解錠ルールが設定されていません。'),
    h('p', { class: 'muted', text: `今日 (${target}) のルールを作成すると、ゲートの解錠条件が今日から有効になります。初回に作成した当日ルールは今日中は何度でも編集でき（タイポや達成不能のやり直しに対応）、明日以降は凍結されます。` }),
  );
  const createBtn = h('button', { class: 'btn primary', text: '今日のルールを作成', type: 'button' });
  createBtn.addEventListener('click', async () => {
    closeModal();
    try {
      const groups = await api.getGroups().catch(() => []);
      const existing = await api.getRule(target).catch(() => null);
      // 作成後は onDone で特別な処理は不要(ゲート/ルール領域は各画面で再描画される)。
      openRuleEditor(target, existing && existing.ruleSet ? existing.conditions : [], groups, () => {
        toast('初期ルールを作成しました', 'ok');
      });
    } catch (err) {
      toast(`ルール作成を開けませんでした: ${err.message}`, 'err');
    }
  });
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', text: 'あとで', type: 'button', onclick: closeModal }),
    createBtn,
  ));
  openModal(body, '初期ルールを作成してください');
}
