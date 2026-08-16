// 一時凍結の UI 部品（spec: goal-freeze MODIFIED・種別と予約フェーズを廃止・issue #103）。
import { h, toast } from './util.js';
import { api } from './api.js';
import { shortDay, ruleDisplayLabel, ruleKindIcon } from './rule-form.js';

/** 月枠の状態を一言で（spec: goal-freeze。表示は必ず重複チェックと同じ「start_day の月」で判定する）。 */
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

/**
 * 一時凍結のモーダルを開く（issue #103・種別選択を廃止し常に当日発効の単一凍結に統合）。
 * 入力ステップ: 1. 理由（必須） → 2. 終了日（当日以降で自由指定） → 3. 対象の目標選択 → 4. 決定。
 */
export function openFreezeModal(goals, quota, onChanged, defaultGoalId = null) {
  const activeGoals = (goals || []).filter((g) => g.status === 'active' && (!g.freeze || g.freeze.state === 'released'));

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

  if (quota && quota.used) {
    body.appendChild(quotaLine(quota, defaultGoalId));
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

  // 1. 理由（必須）
  const reasonInp = h('textarea', {
    class: 'pc-textarea',
    rows: '2',
    placeholder: '例: 大タスク・出張に集中するため',
  });

  // 2. 終了日（当日以降で自由指定。同じ日を指定すれば実質1日だけの凍結になる）。
  const endInput = h('input', { class: 'pc-input pc-input-date', type: 'date' });
  const todayStr = new Date().toISOString().split('T')[0];
  endInput.min = todayStr;
  endInput.value = todayStr;

  // 3. 対象目標の選択リスト (checkbox で複数選択可能)
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

    const rawRules = g.rules || [];
    const rules = rawRules.filter((r) => !r.carryStale);
    let rulesEl;
    if (rules.length > 0) {
      const listItems = rules.map((r) => {
        const icon = ruleKindIcon(r.target);
        const labelText = ruleDisplayLabel(r);
        const text = icon ? `${icon} ${labelText}` : labelText;
        return h('li', { text });
      });
      rulesEl = h('ul', {
        class: 'muted',
        style: { margin: '4px 0 0 18px', padding: '0', fontSize: '12px', lineHeight: '1.4' },
      }, ...listItems);
    } else if (rawRules.length > 0) {
      rulesEl = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' }, text: 'ルール: （達成済み単発ルールのみ）' });
    } else {
      rulesEl = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' }, text: 'ルール: （登録ルールなし）' });
    }

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

  // 4. 決定
  const submitBtn = h('button', { class: 'btn primary', type: 'button', text: '一時凍結する（当日発効）' });

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
      const ids = Array.from(selectedGoalIds);
      await api.freezeGoalMulti(ids, { endDay: endInput.value, reason });
      toast(`一時凍結しました（${ids.length}件・今日から）`, 'ok');
      closeModal();
      await onChanged();
    } catch (err) {
      toast((err.data && err.data.error) || '凍結できませんでした', 'error');
      submitBtn.disabled = false;
    }
  });

  body.appendChild(quotaLine(quota, defaultGoalId));

  body.appendChild(h('div', { class: 'field' },
    h('span', { class: 'pc-field-label', style: { fontWeight: '600' }, text: '1. 凍結する理由（必須）' }),
    reasonInp,
  ));

  body.appendChild(h('div', { class: 'field' },
    h('span', { class: 'pc-field-label', style: { fontWeight: '600' }, text: '2. 凍結終了日' }),
    endInput,
    h('p', { class: 'muted', text: '今日を選べば実質1日だけの凍結になります。今日から効きます。' }),
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

function unfrozenView(goal, quota, allGoals, onChanged) {
  const used = !!(quota && quota.used);
  const wrap = h('div', { class: 'gf-block' },
    h('div', { class: 'gf-head' }, h('span', { class: 'gf-title', text: '一時凍結' })),
    quotaLine(quota, goal.id),
  );

  if (used) return wrap;

  const btn = h('button', { class: 'btn btn-ghost pc-sm', type: 'button', text: '❄ 一時凍結する' });
  btn.addEventListener('click', () => openFreezeModal(allGoals || [goal], quota, onChanged, goal.id));
  wrap.appendChild(btn);
  return wrap;
}

/** 振り返りタブの目標カードに置く凍結ブロック（編集可能・spec: goal-freeze）。 */
export function buildFreezeBlock(goal, quota, onChanged, allGoals = []) {
  const freeze = goal.freeze;
  if (freeze && freeze.state === 'frozen') return frozenView(goal, freeze, onChanged);
  return unfrozenView(goal, quota, allGoals, onChanged);
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
  if (f && f.state === 'frozen') {
    wrap.appendChild(h('p', { class: 'muted', text: `❄ ${shortDay(f.startDay)} 〜 ${shortDay(f.endDay)} 凍結中 ― ${f.reason}` }));
  } else {
    wrap.appendChild(quotaLine(quota, goal.id));
  }
  return wrap;
}
