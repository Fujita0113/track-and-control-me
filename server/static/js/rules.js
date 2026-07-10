// ルール編集: ルールセット一覧. 未来日は編集可, 当日/過去は READ-ONLY(凍結).
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, fmtHM, addDays, toast, openModal, closeModal, emptyState } from './util.js';
import { TARGETS, targetLabel, PLANNING_SIGNALS, planningSignalLabel } from './targets.js';

/** ルール編集セクション(見出し + 作成ボタン + ルールセット一覧)を root に描画する。
 * ゲート画面から合成して使うため、再描画は自身のセクション内に閉じる。 */
export async function renderRuleEditing(root) {
  clear(root);
  const newBtn = h('button', { class: 'btn primary', text: '＋ ルールを作成', type: 'button' });
  root.appendChild(h('div', { class: 'section-head' },
    h('h2', {}, 'ルール編集'),
    h('div', { class: 'row' }, newBtn),
  ));
  const body = h('div', { class: 'stack' });
  root.appendChild(body);

  const reload = () => renderList(body, reload).catch((e) => toast(`失敗: ${e.message}`, 'err'));
  newBtn.addEventListener('click', async () => {
    // 初期状態(ルール皆無)では当日から使えるよう「今日」を対象にする。
    // 既存ルールがあれば凍結ポリシーどおり「翌日」を対象にする。
    const rules = await api.getRules().catch(() => []);
    const target = rules.length === 0 ? state.today : addDays(state.today, 1);
    const groups = await api.getGroups().catch(() => []);
    const existing = await api.getRule(target).catch(() => null);
    openRuleEditor(target, existing && existing.ruleSet ? existing.conditions : [], groups, reload);
  });
  await reload();
}

async function renderList(body, reload) {
  clear(body);
  body.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
  const [rulesets, groups] = await Promise.all([api.getRules(), api.getGroups().catch(() => [])]);
  clear(body);

  if (!rulesets.length) {
    body.appendChild(emptyState('ルールセットがありません。「＋ ルールを作成」から追加してください（初回は今日から有効なルールを作成できます）。'));
    return;
  }

  const groupName = new Map(groups.map((g) => [g.stable_group_id, g.name]));
  for (const rs of rulesets) {
    body.appendChild(rulesetCard(rs, groups, groupName, reload));
  }
}

function statusBadge(status) {
  if (status === 'DRAFT_FUTURE') return h('span', { class: 'badge accent', text: '未来(編集可)' });
  if (status === 'FROZEN_ACTIVE') return h('span', { class: 'badge warn', text: '凍結(当日)' });
  return h('span', { class: 'badge', text: '過去' });
}

function condText(c, groupName) {
  const label = targetLabel(c.target);
  if (c.target === 'TOTAL_WORK') return `${label} ≥ ${fmtHM(c.threshold_seconds || 0)}`;
  if (c.target === 'GROUP') return `${label}[${groupName.get(c.stable_group_id) || c.stable_group_id}] ≥ ${fmtHM(c.threshold_seconds || 0)}`;
  if (c.target === 'MANUAL_CHECK') return `${label}: ${c.label || c.condition_key}`;
  if (c.target === 'PLANNING') return `${label}: ${planningSignalLabel(c.signal_key)}`;
  return label;
}

export function rulesetCard(rs, groups, groupName, onChange) {
  const editable = rs.ruleSet.status === 'DRAFT_FUTURE';
  const card = h('div', { class: 'card' });
  const head = h('div', { class: 'row' },
    h('h3', { text: rs.ruleSet.effective_date }),
    statusBadge(rs.ruleSet.status),
    h('span', { class: 'muted', text: `combinator=${rs.ruleSet.combinator}` }),
    h('div', { class: 'spacer' }),
  );
  if (editable) {
    const edit = h('button', { class: 'btn small', text: '編集', type: 'button' });
    edit.addEventListener('click', () => openRuleEditor(rs.ruleSet.effective_date, rs.conditions, groups, onChange));
    const del = h('button', { class: 'btn small danger', text: '削除', type: 'button' });
    del.addEventListener('click', async () => {
      if (!confirm(`${rs.ruleSet.effective_date} のルールを削除しますか?`)) return;
      try { await api.deleteRule(rs.ruleSet.effective_date); toast('削除しました', 'ok'); onChange(); }
      catch (err) { toast(err.status === 409 ? '凍結済みのため削除できません' : `失敗: ${err.message}`, 'err'); }
    });
    head.appendChild(edit);
    head.appendChild(del);
  }
  card.appendChild(head);

  const list = h('div', { class: 'list', style: { marginTop: '10px' } });
  if (!rs.conditions.length) list.appendChild(emptyState('条件なし'));
  for (const c of rs.conditions) {
    list.appendChild(h('div', { class: 'list-row' }, h('span', { class: 'grow', text: condText(c, groupName) })));
  }
  card.appendChild(list);
  return card;
}

// --- 条件ビルダー(未来日のみ) -----------------------------------------
export function openRuleEditor(date, conditions, groups, onDone) {
  const body = h('div', { class: 'modal-body' });
  body.appendChild(h('p', { class: 'muted', text: `対象日: ${date} (combinator = ALL / AND)` }));

  const rowsHost = h('div', { class: 'list' });
  body.appendChild(rowsHost);

  const addRow = (c) => rowsHost.appendChild(condEditorRow(c, groups));
  if (conditions.length) conditions.forEach((c) => addRow(fromRow(c)));
  else addRow({ target: 'TOTAL_WORK', minutes: 120 });

  const addBtn = h('button', { class: 'btn small', text: '＋ 条件を追加', type: 'button' });
  addBtn.addEventListener('click', () => addRow({ target: 'TOTAL_WORK', minutes: 60 }));
  body.appendChild(addBtn);

  const save = h('button', { class: 'btn primary', text: '保存 (PUT)', type: 'button' });
  save.addEventListener('click', async () => {
    const conds = [];
    for (const row of rowsHost.querySelectorAll('.cond-editor')) {
      const c = readEditorRow(row);
      if (c) conds.push(c);
    }
    save.disabled = true;
    try {
      await api.putRule(date, { combinator: 'ALL', conditions: conds });
      toast('ルールを保存しました', 'ok');
      closeModal();
      onDone();
    } catch (err) {
      if (err.status === 409) toast('当日/過去は凍結されており編集できません', 'err');
      else toast(`失敗: ${err.message}`, 'err');
      save.disabled = false;
    }
  });
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', text: 'キャンセル', type: 'button', onclick: closeModal }),
    save,
  ));
  openModal(body, `ルール編集 — ${date}`);
}

function fromRow(c) {
  return {
    target: c.target,
    minutes: c.threshold_seconds ? Math.round(c.threshold_seconds / 60) : 0,
    stableGroupId: c.stable_group_id || '',
    label: c.label || '',
    signalKey: c.signal_key || '',
  };
}

function condEditorRow(c, groups) {
  const targetSel = h('select', {}, ...TARGETS.map((t) => h('option', { value: t.v }, t.label)));
  targetSel.value = c.target;
  const minutes = h('input', { type: 'number', min: '0', step: '5', value: String(c.minutes ?? 0) });
  minutes.style.width = '80px';
  const groupSel = h('select', {}, ...groups.map((x) => h('option', { value: x.stable_group_id }, x.name)));
  if (c.stableGroupId) groupSel.value = c.stableGroupId;
  const labelInp = h('input', { type: 'text', value: c.label || '', placeholder: 'チェック項目名' });
  // PLANNING シグナルは既知選択肢の <select>。凍結済みの未知値は選択肢へ温存する。
  const signalSel = h('select', {}, ...PLANNING_SIGNALS.map((s) => h('option', { value: s.v }, s.label)));
  const known = PLANNING_SIGNALS.some((s) => s.v === c.signalKey);
  if (c.signalKey && !known) {
    signalSel.appendChild(h('option', { value: c.signalKey }, `${c.signalKey}（凍結値）`));
  }
  signalSel.value = c.signalKey || 'tomorrow_planned';

  const extra = h('div', { class: 'row', style: { flex: '1' } });
  const rm = h('button', { class: 'icon-btn', text: '🗑', title: '削除', type: 'button' });

  const row = h('div', { class: 'cond cond-editor' },
    h('div', { class: 'stack', style: { flex: '1' } },
      h('div', { class: 'row' }, h('span', { class: 'muted', text: '条件' }), targetSel, extra),
    ),
    rm,
  );
  rm.addEventListener('click', () => row.remove());

  const sync = () => {
    clear(extra);
    const t = targetSel.value;
    if (t === 'TOTAL_WORK') extra.append(labelSpan('しきい値(分)'), minutes);
    else if (t === 'GROUP') extra.append(groupSel, labelSpan('≥ 分'), minutes);
    else if (t === 'MANUAL_CHECK') extra.append(labelInp);
    else if (t === 'PLANNING') extra.append(labelSpan('シグナル'), signalSel);
  };
  targetSel.addEventListener('change', sync);
  sync();

  // 参照用に要素をぶら下げる.
  row._get = () => {
    const t = targetSel.value;
    if (t === 'TOTAL_WORK') return { target: t, thresholdSeconds: (Number(minutes.value) || 0) * 60 };
    if (t === 'GROUP') return { target: t, stableGroupId: groupSel.value, thresholdSeconds: (Number(minutes.value) || 0) * 60 };
    if (t === 'MANUAL_CHECK') return { target: t, label: labelInp.value.trim() || 'チェック' };
    if (t === 'PLANNING') return { target: t, signalKey: signalSel.value || null };
    return null;
  };
  return row;
}

function labelSpan(t) { return h('span', { class: 'muted', text: t }); }
function readEditorRow(row) { return row._get ? row._get() : null; }
