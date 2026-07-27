// 一時凍結の UI 部品（spec: goal-freeze・issue #60）。
// 操作導線は振り返りタブの目標カードだけに置く（今日タブ・目標タブには置かない）。
import { h, toast } from './util.js';
import { api } from './api.js';
import { shortDay } from './rule-form.js';

/** 月枠の状態を一言で（すべての目標カードに表示・spec: goal-freeze）。 */
function quotaLine(quota, goalId) {
  if (!quota || !quota.used) {
    return h('p', { class: 'muted gf-quota', text: '今月の凍結枠は空いています（アプリ全体で月1回）。' });
  }
  const who = quota.goalId === goalId ? 'この目標が' : `「${quota.goalName}」が`;
  return h('p', {
    class: 'muted gf-quota',
    text: `今月の凍結枠は使用済みです（${who} ${shortDay(quota.startDay)}〜${shortDay(quota.endDay)} で使用中・${quota.recoversOn} に回復）。`,
  });
}

function reserveForm(goal, quota, onChanged) {
  const wrap = h('div', { class: 'gf-block' },
    h('div', { class: 'gf-head' }, h('span', { class: 'gf-title', text: '一時凍結' })),
    quotaLine(quota, goal.id),
  );
  if (quota && quota.used) return wrap;

  const endInput = h('input', { class: 'pc-input pc-input-date', type: 'date' });
  const reasonInp = h('textarea', { class: 'pc-textarea', rows: '2', placeholder: '理由（必須）例: OpenWork の大タスクに全振りしたい' });
  const btn = h('button', { class: 'btn btn-ghost pc-sm', type: 'button', text: '凍結を予約（翌日発効）' });
  btn.addEventListener('click', async () => {
    const reason = reasonInp.value.trim();
    if (!reason) { toast('理由を入力してください', 'error'); return; }
    if (!endInput.value) { toast('終了日を選んでください', 'error'); return; }
    btn.disabled = true;
    try {
      await api.reserveGoalFreeze(goal.id, { endDay: endInput.value, reason });
      toast('凍結を予約しました（翌日発効）', 'ok');
      await onChanged();
    } catch (err) {
      toast((err.data && err.data.error) || '予約できませんでした', 'error');
    } finally {
      btn.disabled = false;
    }
  });
  wrap.appendChild(h('div', { class: 'gf-form' },
    h('label', { class: 'pc-field pc-field-inline' }, h('span', { class: 'pc-field-label', text: '終了日' }), endInput),
    reasonInp,
    btn,
  ));
  return wrap;
}

function reservedView(goal, freeze, onChanged) {
  const wrap = h('div', { class: 'gf-block' },
    h('div', { class: 'gf-head' }, h('span', { class: 'gf-title', text: '一時凍結（予約中）' })),
    h('p', { class: 'muted', text: `${shortDay(freeze.startDay)} から凍結予定（〜${shortDay(freeze.endDay)}）― ${freeze.reason}` }),
  );
  const cancelBtn = h('button', { class: 'btn btn-ghost pc-sm', type: 'button', text: '取消' });
  cancelBtn.addEventListener('click', async () => {
    if (!confirm('凍結の予約を取り消しますか？')) return;
    cancelBtn.disabled = true;
    try {
      await api.cancelGoalFreeze(goal.id);
      toast('凍結の予約を取り消しました', 'ok');
      await onChanged();
    } catch (err) {
      toast((err.data && err.data.error) || '取消できませんでした', 'error');
      cancelBtn.disabled = false;
    }
  });
  wrap.appendChild(cancelBtn);
  return wrap;
}

function frozenView(goal, freeze, onChanged) {
  const wrap = h('div', { class: 'gf-block gf-frozen' },
    h('div', { class: 'gf-head' }, h('span', { class: 'gf-title', text: '❄ 一時凍結中' })),
    h('p', { class: 'muted', text: `${shortDay(freeze.startDay)} 〜 ${shortDay(freeze.endDay)} ― ${freeze.reason}` }),
  );

  const formHost = h('div', { class: 'gf-form', hidden: true });
  const endInput = h('input', { class: 'pc-input pc-input-date', type: 'date', value: freeze.endDay });
  const reasonInp = h('textarea', { class: 'pc-textarea', rows: '2', placeholder: '理由（必須）例: まだ終わらない' });
  const submitBtn = h('button', { class: 'btn btn-ghost pc-sm', type: 'button', text: '延長を確定' });
  submitBtn.addEventListener('click', async () => {
    const reason = reasonInp.value.trim();
    if (!reason) { toast('理由を入力してください', 'error'); return; }
    submitBtn.disabled = true;
    try {
      await api.updateGoalFreeze(goal.id, { endDay: endInput.value, reason });
      toast('凍結を延長しました', 'ok');
      await onChanged();
    } catch (err) {
      toast((err.data && err.data.error) || '延長できませんでした', 'error');
      submitBtn.disabled = false;
    }
  });
  formHost.append(
    h('label', { class: 'pc-field pc-field-inline' }, h('span', { class: 'pc-field-label', text: '新しい終了日' }), endInput),
    reasonInp,
    submitBtn,
  );

  const extendBtn = h('button', { class: 'btn btn-ghost pc-sm', type: 'button', text: '延長' });
  extendBtn.addEventListener('click', () => { formHost.hidden = !formHost.hidden; });
  const releaseBtn = h('button', { class: 'btn btn-ghost pc-sm', type: 'button', text: '解除' });
  releaseBtn.addEventListener('click', async () => {
    if (!confirm('凍結を今すぐ解除しますか？（今日からルールがゲートに戻ります）')) return;
    releaseBtn.disabled = true;
    try {
      await api.releaseGoalFreeze(goal.id);
      toast('凍結を解除しました', 'ok');
      await onChanged();
    } catch (err) {
      toast((err.data && err.data.error) || '解除できませんでした', 'error');
      releaseBtn.disabled = false;
    }
  });

  wrap.appendChild(h('div', { class: 'row', style: { gap: '6px' } }, extendBtn, releaseBtn));
  wrap.appendChild(formHost);
  return wrap;
}

/** 振り返りタブの目標カードに置く凍結ブロック（編集可能・spec: goal-freeze）。 */
export function buildFreezeBlock(goal, quota, onChanged) {
  const freeze = goal.freeze;
  if (freeze && freeze.state === 'reserved') return reservedView(goal, freeze, onChanged);
  if (freeze && freeze.state === 'frozen') return frozenView(goal, freeze, onChanged);
  return reserveForm(goal, quota, onChanged);
}

/** その目標が今まさに凍結中か（ルールブロックの折りたたみに使う）。 */
export function isFrozenNow(goal) {
  return !!(goal.freeze && goal.freeze.state === 'frozen');
}

/** デモ（閲覧専用）向けの凍結状態表示。操作導線は出さない（spec: goal-freeze）。 */
export function buildFreezeReadOnly(goal, quota) {
  const wrap = h('div', { class: 'gf-block gf-readonly' },
    h('div', { class: 'gf-head' }, h('span', { class: 'gf-title', text: '一時凍結' })),
  );
  const f = goal.freeze;
  if (f && f.state === 'reserved') {
    wrap.appendChild(h('p', { class: 'muted', text: `${shortDay(f.startDay)} から凍結予定（〜${shortDay(f.endDay)}）― ${f.reason}` }));
  } else if (f && f.state === 'frozen') {
    wrap.appendChild(h('p', { class: 'muted', text: `❄ ${shortDay(f.startDay)} 〜 ${shortDay(f.endDay)} 凍結中 ― ${f.reason}` }));
  } else {
    wrap.appendChild(quotaLine(quota, goal.id));
  }
  return wrap;
}
