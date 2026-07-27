// 一時凍結の UI 部品（spec: goal-freeze・issue #60）。
import { h, toast } from './util.js';
import { api } from './api.js';
import { shortDay } from './rule-form.js';

/** 月枠の状態を一言で（spec: goal-freeze）。 */
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

/** 一時凍結を予約するモーダルを開く (issue #60) */
export function openFreezeModal(goals, quota, onChanged, defaultGoalId = null) {
  const activeGoals = (goals || []).filter((g) => g.status === 'active' && (!g.freeze || g.freeze.state === 'none'));

  const closeBtn = h('button', { class: 'icon-btn', type: 'button', text: '✕' });

  const modalPanel = h('div', { class: 'modal-panel', style: { maxWidth: '540px', margin: 'auto' } },
    h('div', { class: 'modal-header' },
      h('h3', { text: '目標を一時凍結する' }),
      closeBtn,
    ),
    h('div', { class: 'modal-body' }),
  );

  const backdrop = h('div', { class: 'modal-backdrop' }, modalPanel);
  const modal = h('div', { class: 'modal-root open' }, backdrop);

  const closeModal = () => {
    modal.remove();
  };

  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  const body = modal.querySelector('.modal-body');
  body.appendChild(quotaLine(quota, defaultGoalId));

  if (quota && quota.used) {
    body.appendChild(h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', text: '閉じる', onClick: closeModal }),
    ));
    document.body.appendChild(modal);
    return;
  }

  if (activeGoals.length === 0) {
    body.appendChild(h('p', { class: 'muted', text: '凍結可能な進行中の目標がありません。' }));
    body.appendChild(h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', text: '閉じる', onClick: closeModal }),
    ));
    document.body.appendChild(modal);
    return;
  }

  // 入力ステップ: 理由 → 期限 → 対象目標選択
  const reasonInp = h('textarea', {
    class: 'pc-textarea',
    rows: '2',
    placeholder: '例: 大タスク・出張に集中するため',
  });

  const endInput = h('input', { class: 'pc-input pc-input-date', type: 'date' });

  // 今日の翌日（最短解凍日）をデフォルト最小値に
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  endInput.min = tomorrow.toISOString().split('T')[0];

  // 対象目標の選択リスト (checkbox で複数選択可能・ルール一覧を併記)
  const selectedGoalIds = new Set();
  if (defaultGoalId && activeGoals.some((g) => g.id === defaultGoalId)) {
    selectedGoalIds.add(defaultGoalId);
  } else {
    activeGoals.forEach((g) => selectedGoalIds.add(g.id));
  }

  const goalListEl = h('div', { class: 'stack', style: { gap: '8px', marginTop: '4px' } });
  activeGoals.forEach((g) => {
    const chk = h('input', {
      type: 'checkbox',
      name: 'freeze_target_goal',
      value: g.id,
      checked: selectedGoalIds.has(g.id),
    });
    chk.addEventListener('change', () => {
      if (chk.checked) selectedGoalIds.add(g.id);
      else selectedGoalIds.delete(g.id);
    });

    const rulesText = (g.rules || []).map((r) => r.label || r.target).filter(Boolean).join(', ');
    const rulesEl = rulesText
      ? h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' }, text: `ルール: ${rulesText}` })
      : h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' }, text: 'ルール: （登録ルールなし）' });

    const item = h('label', {
      class: 'list-row inline',
      style: { cursor: 'pointer', padding: '10px 12px', alignItems: 'flex-start' },
    },
      chk,
      h('div', { style: { flex: '1' } },
        h('div', { style: { fontWeight: '600' }, text: g.name || g.title || '（無題の目標）' }),
        rulesEl,
      ),
    );
    goalListEl.appendChild(item);
  });

  const submitBtn = h('button', { class: 'btn primary', type: 'button', text: '一時凍結を予約（翌日発効）' });

  submitBtn.addEventListener('click', async () => {
    const reason = reasonInp.value.trim();
    if (!reason) {
      toast('凍結する理由を入力してください', 'error');
      reasonInp.focus();
      return;
    }
    if (!endInput.value) {
      toast('凍結の終了日を選択してください', 'error');
      endInput.focus();
      return;
    }
    if (selectedGoalIds.size === 0) {
      toast('凍結する目標を1つ以上選択してください', 'error');
      return;
    }

    submitBtn.disabled = true;
    try {
      await api.reserveGoalFreezeMulti(Array.from(selectedGoalIds), { endDay: endInput.value, reason });
      toast(`凍結を予約しました（${selectedGoalIds.size}件・翌日発効）`, 'ok');
      closeModal();
      await onChanged();
    } catch (err) {
      toast((err.data && err.data.error) || '予約できませんでした', 'error');
      submitBtn.disabled = false;
    }
  });

  body.appendChild(h('div', { class: 'field' },
    h('span', { class: 'pc-field-label', style: { fontWeight: '600' }, text: '1. 凍結する理由（必須）' }),
    reasonInp,
  ));

  body.appendChild(h('div', { class: 'field' },
    h('span', { class: 'pc-field-label', style: { fontWeight: '600' }, text: '2. 凍結終了日' }),
    endInput,
  ));

  body.appendChild(h('div', { class: 'field' },
    h('span', { class: 'pc-field-label', style: { fontWeight: '600' }, text: '3. 対象の目標を選択（複数選択可）' }),
    goalListEl,
  ));

  body.appendChild(h('div', { class: 'actions', style: { marginTop: '12px' } },
    h('button', { class: 'btn', type: 'button', text: 'キャンセル', onClick: closeModal }),
    submitBtn,
  ));

  document.body.appendChild(modal);
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

function unreservedView(goal, quota, allGoals, onChanged) {
  const wrap = h('div', { class: 'gf-block' },
    h('div', { class: 'gf-head' }, h('span', { class: 'gf-title', text: '一時凍結' })),
    quotaLine(quota, goal.id),
  );
  if (quota && quota.used) return wrap;

  const btn = h('button', { class: 'btn btn-ghost pc-sm', type: 'button', text: '❄ 一時凍結する' });
  btn.addEventListener('click', () => {
    openFreezeModal(allGoals || [goal], quota, onChanged, goal.id);
  });
  wrap.appendChild(btn);
  return wrap;
}

/** 振り返りタブの目標カードに置く凍結ブロック（編集可能・spec: goal-freeze）。 */
export function buildFreezeBlock(goal, quota, onChanged, allGoals = []) {
  const freeze = goal.freeze;
  if (freeze && freeze.state === 'reserved') return reservedView(goal, freeze, onChanged);
  if (freeze && freeze.state === 'frozen') return frozenView(goal, freeze, onChanged);
  return unreservedView(goal, quota, allGoals, onChanged);
}

/** その目標が今場所に凍結中か（ルールブロックの折りたたみに使う）。 */
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
