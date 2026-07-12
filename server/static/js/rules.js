// ルール編集: ルールセット一覧. 未来日は編集可, 当日/過去は READ-ONLY(凍結).
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, fmtHM, addDays, toast, openModal, closeModal, emptyState } from './util.js';
import { targetLabel, planningSignalLabel, CONDITION_KINDS, conditionKindValue, conditionKindTarget } from './targets.js';

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
    const goals = await api.getGoals().catch(() => []);
    const existing = await api.getRule(target).catch(() => null);
    openRuleEditor(target, existing && existing.ruleSet ? existing.conditions : [], groups, reload, computeLocked(goals));
  });
  await reload();
}

/** 進行中/開始前の目標が採用中の condition_key を集約する（ジャンル固定の対象）。 */
function computeLocked(goals) {
  const keys = new Set();
  const byKey = new Map();
  for (const g of goals || []) {
    if (g.status !== 'active' && g.status !== 'upcoming') continue;
    for (const p of g.practices) {
      keys.add(p.conditionKey);
      if (!byKey.has(p.conditionKey)) byKey.set(p.conditionKey, []);
      byKey.get(p.conditionKey).push(g.name);
    }
  }
  return { keys, byKey };
}

async function renderList(body, reload) {
  clear(body);
  body.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
  const [rulesets, groups, goals] = await Promise.all([
    api.getRules(),
    api.getGroups().catch(() => []),
    api.getGoals().catch(() => []),
  ]);
  const locked = computeLocked(goals);
  clear(body);

  if (!rulesets.length) {
    body.appendChild(emptyState('ルールセットがありません。「＋ ルールを作成」から追加してください（初回は今日から有効なルールを作成できます）。'));
    return;
  }

  const groupName = new Map(groups.map((g) => [g.stable_group_id, g.name]));
  for (const rs of rulesets) {
    body.appendChild(rulesetCard(rs, groups, groupName, reload, locked));
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
  // PLANNING はフラット化済みなので signal ラベルをそのまま条件名にする(「翌日計画: …」の二重表記を避ける)。
  if (c.target === 'PLANNING') return planningSignalLabel(c.signal_key);
  return label;
}

export function rulesetCard(rs, groups, groupName, onChange, locked = { keys: new Set(), byKey: new Map() }) {
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
    edit.addEventListener('click', () => openRuleEditor(rs.ruleSet.effective_date, rs.conditions, groups, onChange, locked));
    const del = h('button', { class: 'btn small danger', text: '削除', type: 'button' });
    del.addEventListener('click', async () => {
      if (!confirm(`${rs.ruleSet.effective_date} のルールを削除しますか?`)) return;
      try { await api.deleteRule(rs.ruleSet.effective_date); toast('削除しました', 'ok'); onChange(); }
      catch (err) {
        const msg = err.data?.goalLocked
          ? '目標が採用中の実践が外れるため削除できません（ジャンル固定）'
          : err.status === 409 ? '凍結済みのため削除できません' : `失敗: ${err.message}`;
        toast(msg, 'err');
      }
    });
    head.appendChild(edit);
    head.appendChild(del);
  }
  card.appendChild(head);

  const list = h('div', { class: 'list', style: { marginTop: '10px' } });
  if (!rs.conditions.length) list.appendChild(emptyState('条件なし'));
  for (const c of rs.conditions) {
    const row = h('div', { class: 'list-row' }, h('span', { class: 'grow', text: condText(c, groupName) }));
    if (locked.keys.has(c.condition_key)) {
      row.appendChild(h('span', {
        class: 'badge accent',
        text: '🔒 ジャンル固定',
        title: `目標が採用中: ${(locked.byKey.get(c.condition_key) || []).join(' / ')}`,
      }));
    }
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

// --- 条件ビルダー(未来日のみ) -----------------------------------------
export function openRuleEditor(date, conditions, groups, onDone, locked = { keys: new Set(), byKey: new Map() }) {
  const body = h('div', { class: 'modal-body' });
  body.appendChild(h('p', { class: 'muted', text: `対象日: ${date} (combinator = ALL / AND)` }));
  if (locked.keys.size) {
    body.appendChild(h('p', { class: 'muted', text: '🔒 ジャンル固定の実践は削除・種別変更できません。閾値は変更時に理由の入力を求めます。' }));
  }

  const rowsHost = h('div', { class: 'list' });
  body.appendChild(rowsHost);

  const addRow = (c, isLocked = false) => rowsHost.appendChild(condEditorRow(c, groups, isLocked));
  if (conditions.length) {
    conditions.forEach((c) => {
      const r = fromRow(c);
      addRow(r, locked.keys.has(c.condition_key));
    });
  } else {
    addRow({ target: 'TOTAL_WORK', minutes: 120 });
  }

  const addBtn = h('button', { class: 'btn small', text: '＋ 条件を追加', type: 'button' });
  addBtn.addEventListener('click', () => addRow({ target: 'TOTAL_WORK', minutes: 60 }));
  body.appendChild(addBtn);

  const save = h('button', { class: 'btn primary', text: '保存 (PUT)', type: 'button' });
  save.addEventListener('click', async () => {
    const rows = [...rowsHost.querySelectorAll('.cond-editor')];
    const conds = [];
    for (const row of rows) {
      const c = readEditorRow(row);
      if (c) conds.push(c);
    }
    // 採用中(ジャンル固定)の時間条件で閾値(分)が変わったものを検出し、理由を求める。
    const changed = [];
    for (const row of rows) {
      const meta = row._meta;
      if (!meta || !meta.locked || !row._get) continue;
      const got = row._get();
      if (!got || (got.target !== 'TOTAL_WORK' && got.target !== 'GROUP')) continue;
      const newMin = got.thresholdSeconds != null ? Math.round(got.thresholdSeconds / 60) : 0;
      if (newMin !== (meta.origMinutes ?? 0)) changed.push(meta.conditionKey);
    }
    let reason = null;
    if (changed.length) {
      reason = prompt(`採用中の実践の閾値を変更します。理由を入力してください（レポートに残ります）:\n${changed.join(', ')}`);
      if (reason == null || !reason.trim()) { toast('理由が未入力のため送信しませんでした', 'err'); return; }
    }
    save.disabled = true;
    try {
      const putBody = { combinator: 'ALL', conditions: conds };
      if (reason) putBody.threshold_change_reason = reason;
      await api.putRule(date, putBody);
      toast('ルールを保存しました', 'ok');
      closeModal();
      onDone();
    } catch (err) {
      if (err.data?.reasonRequired) toast('採用中条件の閾値変更には理由が必要です', 'err');
      else if (err.data?.goalLocked) toast('目標が採用中の実践は外せません（ジャンル固定）', 'err');
      else if (err.status === 409) toast('当日/過去は凍結されており編集できません', 'err');
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
    conditionKey: c.condition_key,
    minutes: c.threshold_seconds ? Math.round(c.threshold_seconds / 60) : 0,
    stableGroupId: c.stable_group_id || '',
    label: c.label || '',
    signalKey: c.signal_key || '',
  };
}

function condEditorRow(c, groups, locked = false) {
  // 条件はフラットな1つの <select>。PLANNING は signal_key ごとの項目(今日の振り返り / 明日のタスク登録 …)。
  const kindSel = h('select', {}, ...CONDITION_KINDS.map((k) => h('option', { value: k.v }, k.label)));
  const kindVal = conditionKindValue(c.target, c.signalKey);
  // 凍結済みルールの未知 signal_key を温存する(編集は未来日のみだが防御的に)。
  if (!CONDITION_KINDS.some((k) => k.v === kindVal)) {
    kindSel.appendChild(h('option', { value: kindVal }, `${c.signalKey || c.target}（凍結値）`));
  }
  kindSel.value = kindVal;
  const minutes = h('input', { type: 'number', min: '0', step: '5', value: String(c.minutes ?? 0) });
  minutes.style.width = '80px';
  const groupSel = h('select', {}, ...groups.map((x) => h('option', { value: x.stable_group_id }, x.name)));
  if (c.stableGroupId) groupSel.value = c.stableGroupId;
  const labelInp = h('input', { type: 'text', value: c.label || '', placeholder: 'チェック項目名' });

  const extra = h('div', { class: 'row', style: { flex: '1' } });
  const rm = h('button', { class: 'icon-btn', text: '🗑', title: '削除', type: 'button' });

  // ジャンル固定: 種別/グループは変更不可・行削除不可。閾値(minutes)のみ編集可。
  if (locked) {
    kindSel.disabled = true;
    groupSel.disabled = true;
    rm.disabled = true;
    rm.title = 'ジャンル固定（削除不可）';
  }
  const headRow = h('div', { class: 'row' }, h('span', { class: 'muted', text: '条件' }), kindSel, extra);
  if (locked) headRow.appendChild(h('span', { class: 'badge accent', text: '🔒 固定' }));

  const row = h('div', { class: 'cond cond-editor' },
    h('div', { class: 'stack', style: { flex: '1' } }, headRow),
    rm,
  );
  row._meta = { conditionKey: c.conditionKey, locked, origMinutes: c.minutes ?? 0 };
  if (!locked) rm.addEventListener('click', () => row.remove());

  const sync = () => {
    clear(extra);
    const { target } = conditionKindTarget(kindSel.value);
    if (target === 'TOTAL_WORK') extra.append(labelSpan('しきい値(分)'), minutes);
    else if (target === 'GROUP') extra.append(groupSel, labelSpan('≥ 分'), minutes);
    else if (target === 'MANUAL_CHECK') extra.append(labelInp);
    // PLANNING はシグナル選択が条件そのものへ統合されたため、追加入力は無し。
  };
  kindSel.addEventListener('change', sync);
  sync();

  // 参照用に要素をぶら下げる.
  row._get = () => {
    const { target, signalKey } = conditionKindTarget(kindSel.value);
    if (target === 'TOTAL_WORK') return { target, thresholdSeconds: (Number(minutes.value) || 0) * 60 };
    if (target === 'GROUP') return { target, stableGroupId: groupSel.value, thresholdSeconds: (Number(minutes.value) || 0) * 60 };
    if (target === 'MANUAL_CHECK') return { target, label: labelInp.value.trim() || 'チェック' };
    if (target === 'PLANNING') return { target, signalKey: signalKey || null };
    return null;
  };
  return row;
}

function labelSpan(t) { return h('span', { class: 'muted', text: t }); }
function readEditorRow(row) { return row._get ? row._get() : null; }
