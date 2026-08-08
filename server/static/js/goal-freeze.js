// 一時凍結の UI 部品（spec: goal-freeze・issue #60）。
import { h, clear, toast } from './util.js';
import { api } from './api.js';
import { shortDay, ruleDisplayLabel, ruleKindIcon } from './rule-form.js';

/**
 * 種別に対応する月枠を取り出す（design D4）。当日凍結は today の月、期間凍結は翌日の月を見るので、
 * 月の最終日だけ両者は違う月を指す。`sameDay` を持たない応答（デモ）は期間凍結の枠で代用する。
 */
function quotaOf(quota, kind) {
  if (!quota) return null;
  return kind === 'same_day' ? (quota.sameDay || quota) : quota;
}

/** 月枠の状態を一言で（spec: goal-freeze。表示は必ず重複チェックと同じ「start_day の月」で判定する）。 */
function quotaLine(quota, goalId, kind = 'period') {
  const q = quotaOf(quota, kind);
  if (!q || !q.used) {
    return h('p', { class: 'muted gf-quota', text: '今月の凍結枠は空いています（アプリ全体で月1回）。' });
  }
  const who = q.goalId === goalId ? 'この目標が' : `「${q.goalName}」が`;
  return h('p', {
    class: 'muted gf-quota',
    text: `今月の凍結枠は使用済みです（${who} ${shortDay(q.startDay)}〜${shortDay(q.endDay)} で使用中・${q.recoversOn} に回復）。`,
  });
}

/** 種別ごとの代金（spec: goal-freeze MODIFIED「操作導線」の明示要求）。 */
const FREEZE_KINDS = [
  {
    kind: 'period',
    label: '期間を指定して翌日から',
    cost: '明日から効きます。凍結した日数ぶん期限が後ろへ延びます。',
  },
  {
    kind: 'same_day',
    label: '今日1日だけ',
    cost: '今日から効きます。そのかわり期限は延びません（残り日数が1日減ります）。',
  },
];

/**
 * 一時凍結のモーダルを開く (issue #60・当日凍結の追加)。
 * 既定は**期間凍結（翌日発効）**（design D10）。当日凍結を既定にすると今夜のノルマを壊すまでの
 * クリック数が最短になり、衝動に対する摩擦が消えるため、当日凍結は「わざわざ選ぶもの」にする。
 */
export function openFreezeModal(goals, quota, onChanged, defaultGoalId = null, initialKind = 'period') {
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

  // 種別は既定が期間凍結。当日凍結が選べない（＝その月の枠が埋まっている）ときだけ当日から開く。
  let kind = initialKind === 'same_day' ? 'same_day' : 'period';
  const usedFor = (k) => !!(quotaOf(quota, k) || {}).used;

  if (usedFor('period') && usedFor('same_day')) {
    body.appendChild(quotaLine(quota, defaultGoalId, 'period'));
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

  // 既定の種別が使えない（その月の枠が埋まっている）ときは、まだ空いているほうから始める。
  if (usedFor(kind)) kind = kind === 'period' ? 'same_day' : 'period';

  // 入力ステップ: 種別 → 理由 → 期限（期間凍結のみ）→ 対象目標選択
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

  const submitBtn = h('button', { class: 'btn primary', type: 'button' });

  submitBtn.addEventListener('click', async () => {
    const sameDay = kind === 'same_day';
    const reason = reasonInp.value.trim();
    if (!reason) {
      toast('凍結する理由を入力してください', 'error');
      reasonInp.focus();
      return;
    }
    if (!sameDay && !endInput.value) {
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
      if (sameDay) {
        await api.sameDayFreezeMulti(ids, { reason });
        toast(`今日1日だけ凍結しました（${ids.length}件・今日から）`, 'ok');
      } else {
        await api.reserveGoalFreezeMulti(ids, { endDay: endInput.value, reason });
        toast(`凍結を予約しました（${ids.length}件・翌日発効）`, 'ok');
      }
      closeModal();
      await onChanged();
    } catch (err) {
      toast((err.data && err.data.error) || (sameDay ? '凍結できませんでした' : '予約できませんでした'), 'error');
      submitBtn.disabled = false;
    }
  });

  // 1. 種別（既定は期間凍結）。それぞれの代金と、どちらも同じ月枠を1回使うことを明示する。
  const quotaHost = h('div', { class: 'gf-quota-host' });
  const endField = h('div', { class: 'field gf-enddate-field' },
    h('span', { class: 'pc-field-label', style: { fontWeight: '600' }, text: '3. 凍結終了日' }),
    endInput,
  );
  const kindSeg = h('div', { class: 'gf-kind-seg' });
  const kindBtns = new Map();

  const syncKind = () => {
    for (const [k, btn] of kindBtns) btn.classList.toggle('on', k === kind);
    // 当日凍結は「今日1日だけ」で期間を持たないので、期限の入力欄自体を出さない。
    endField.hidden = kind === 'same_day';
    clear(quotaHost);
    quotaHost.appendChild(quotaLine(quota, defaultGoalId, kind));
    const blocked = usedFor(kind);
    submitBtn.disabled = blocked;
    submitBtn.textContent = kind === 'same_day' ? '今日1日だけ凍結する' : '一時凍結を予約（翌日発効）';
  };

  FREEZE_KINDS.forEach(({ kind: k, label, cost }) => {
    const btn = h('button', { class: 'gf-kind-btn', type: 'button', 'data-kind': k },
      h('span', { class: 'gf-kind-label', text: label }),
      h('span', { class: 'gf-kind-cost', text: cost }),
    );
    btn.addEventListener('click', () => { kind = k; syncKind(); });
    kindBtns.set(k, btn);
    kindSeg.appendChild(btn);
  });

  body.appendChild(h('div', { class: 'field' },
    h('span', { class: 'pc-field-label', style: { fontWeight: '600' }, text: '1. 凍結のしかたを選ぶ' }),
    kindSeg,
    h('p', { class: 'muted gf-kind-note', text: 'どちらも同じ月枠を1回使います（アプリ全体で月1回）。' }),
  ));
  body.appendChild(quotaHost);

  body.appendChild(h('div', { class: 'field' },
    h('span', { class: 'pc-field-label', style: { fontWeight: '600' }, text: '2. 凍結する理由（必須）' }),
    reasonInp,
  ));

  body.appendChild(endField);

  body.appendChild(h('div', { class: 'field' },
    h('span', { class: 'pc-field-label', style: { fontWeight: '600' }, text: '4. 対象の目標を選択（複数選択可）' }),
    goalListEl,
  ));

  body.appendChild(h('div', { class: 'actions', style: { marginTop: '12px' } },
    h('button', { class: 'btn', type: 'button', text: 'キャンセル', onClick: closeModal }),
    submitBtn,
  ));

  syncKind();
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
  const sameDay = freeze.kind === 'same_day';
  const wrap = h('div', { class: 'gf-block gf-frozen' },
    h('div', { class: 'gf-head' }, h('span', { class: 'gf-title', text: sameDay ? '❄ 今日1日だけ凍結中' : '❄ 一時凍結中' })),
    h('p', {
      class: 'muted',
      text: sameDay
        ? `${shortDay(freeze.startDay)}（今日）のみ ― ${freeze.reason}（期限は延びません）`
        : `${shortDay(freeze.startDay)} 〜 ${shortDay(freeze.endDay)} ― ${freeze.reason}`,
    }),
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

  // 当日凍結には延長の導線を出さない（延長を許すと期限延長つきの期間凍結へ化ける・design D3）。
  wrap.appendChild(sameDay
    ? h('div', { class: 'row', style: { gap: '6px' } }, releaseBtn)
    : h('div', { class: 'row', style: { gap: '6px' } }, extendBtn, releaseBtn));
  if (!sameDay) wrap.appendChild(formHost);
  return wrap;
}

function unreservedView(goal, quota, allGoals, onChanged) {
  const periodUsed = !!(quotaOf(quota, 'period') || {}).used;
  const sameDayUsed = !!(quotaOf(quota, 'same_day') || {}).used;
  const wrap = h('div', { class: 'gf-block' },
    h('div', { class: 'gf-head' }, h('span', { class: 'gf-title', text: '一時凍結' })),
    quotaLine(quota, goal.id, 'period'),
  );

  const open = (initialKind) => openFreezeModal(allGoals || [goal], quota, onChanged, goal.id, initialKind);

  if (!periodUsed) {
    const btn = h('button', { class: 'btn btn-ghost pc-sm', type: 'button', text: '❄ 一時凍結する' });
    btn.addEventListener('click', () => open('period'));
    wrap.appendChild(btn);
    return wrap;
  }

  // 月の最終日だけ、期間凍結（翌月の枠）と当日凍結（今月の枠）で見る月が食い違う（design D4）。
  // 期間凍結の枠が埋まっていても当日凍結の枠が空いていることがあるので、その入口だけは残す。
  if (!sameDayUsed && quota && quota.sameDay) {
    wrap.appendChild(h('p', { class: 'muted gf-quota gf-quota-sameday', text: `${quota.sameDay.month} の枠はまだ空いているため、今日1日だけの凍結は行えます。` }));
    const btn = h('button', { class: 'btn btn-ghost pc-sm', type: 'button', text: '❄ 今日1日だけ凍結する' });
    btn.addEventListener('click', () => open('same_day'));
    wrap.appendChild(btn);
  }
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
  } else if (f && f.state === 'frozen' && f.kind === 'same_day') {
    wrap.appendChild(h('p', { class: 'muted', text: `❄ ${shortDay(f.startDay)}（今日1日だけ）凍結中 ― ${f.reason}（期限は延びません）` }));
  } else if (f && f.state === 'frozen') {
    wrap.appendChild(h('p', { class: 'muted', text: `❄ ${shortDay(f.startDay)} 〜 ${shortDay(f.endDay)} 凍結中 ― ${f.reason}` }));
  } else {
    wrap.appendChild(quotaLine(quota, goal.id));
  }
  return wrap;
}
