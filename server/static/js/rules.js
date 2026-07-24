// ルール編集: ルールセット一覧. 未来日は編集可, 当日/過去は READ-ONLY(凍結).
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, fmtHM, addDays, toast, openModal, closeModal, emptyState, attachTooltip, ctrlEnterToSave } from './util.js';
import { targetLabel, planningSignalLabel, CONDITION_KINDS, conditionKindValue, conditionKindTarget } from './targets.js';

// 当日追加（DRAFT_TODAY）の条件は sort_order にこの下駄を履いて格納される（server: SAME_DAY_BASE）。
// baseline（day 開始時点の凍結条件）と当日追加分を UI 上で区別するのに使う。
const SAME_DAY_BASE = 100000;

/** effective 今日ルールを一覧から解決（当日の明示行 → 無ければ直近の過去行へフォールバック）。 */
function effectiveTodayRule(rulesets, today) {
  const explicit = rulesets.find((r) => r.ruleSet.effective_date === today);
  if (explicit) return explicit;
  return rulesets.find((r) => r.ruleSet.effective_date < today) || null;
}

/** 当日ルールの条件を baseline（凍結・当日ロック）と当日追加分に分ける。 */
function splitTodayConditions(rule) {
  const isDraftToday = rule.ruleSet && rule.ruleSet.status === 'DRAFT_TODAY';
  const baseline = [], additions = [];
  for (const c of rule.conditions) {
    if (isDraftToday && (c.sort_order ?? 0) >= SAME_DAY_BASE) additions.push(c);
    else baseline.push(c);
  }
  return { baseline, additions };
}

/** ルール編集セクション(見出し + 作成ボタン + ルールセット一覧)を root に描画する。
 * ゲート画面から合成して使うため、再描画は自身のセクション内に閉じる。 */
export async function renderRuleEditing(root) {
  clear(root);
  const newBtn = h('button', { class: 'btn primary', text: '＋ ルールを作成', type: 'button' });
  // 当日に「新しい条件だけ」を追加する動線（厳しくする方向のみ当日反映・既存条件はロック）。
  const addTodayBtn = h('button', { class: 'btn', text: '＋ 当日に条件を追加', type: 'button' });
  root.appendChild(h('div', { class: 'section-head' },
    h('h2', {}, 'ルール編集'),
    h('div', { class: 'row' }, addTodayBtn, newBtn),
  ));
  const body = h('div', { class: 'stack' });
  root.appendChild(body);

  const reload = () => renderList(body, reload).catch((e) => toast(`失敗: ${e.message}`, 'err'));
  newBtn.addEventListener('click', async () => {
    // 初期状態(ルール皆無)では当日から使えるよう「今日」を対象にする。
    // 既存ルールがあれば凍結ポリシーどおり「翌日」を対象にする。
    const rules = await api.getRules().catch(() => []);
    const target = rules.length === 0 ? state.today : addDays(state.today, 1);
    // グループ選択肢は直近30日に実測された identity から（tab_group の UUID 行は使わない・spec: group-identity-registry）。
    const groups = await api.getGroupsRecent().catch(() => []);
    const goals = await api.getGoals().catch(() => []);
    const existing = await api.getRule(target).catch(() => null);
    // 初期条件は3段分岐:
    // 1) 対象日に明示ルールがあればその条件
    // 2) 無ければ対象日が継承する直近の過去ルール(effective_date < target の最初=最新)の条件
    // 3) 継承元も無い(ルール皆無)なら空
    let initialConditions;
    if (existing && existing.ruleSet) {
      initialConditions = existing.conditions;
    } else {
      const inherited = rules.find((r) => r.ruleSet.effective_date < target);
      initialConditions = inherited ? inherited.conditions : [];
    }
    openRuleEditor(target, initialConditions, groups, reload, computeLocked(goals));
  });
  addTodayBtn.addEventListener('click', async () => {
    const [rulesets, groups] = await Promise.all([
      api.getRules().catch(() => []),
      api.getGroupsRecent().catch(() => []),
    ]);
    const eff = effectiveTodayRule(rulesets, state.today);
    if (!eff || !eff.conditions.length) {
      // baseline が無い（実効ルール皆無）＝ブートストラップ。通常の「＋ ルールを作成」で当日フル編集できる。
      toast('当日の実効ルールがありません。「＋ ルールを作成」から今日のルールを作成してください。', 'err');
      return;
    }
    const { baseline, additions } = splitTodayConditions(eff);
    openTodayAddEditor(state.today, baseline, additions, groups, reload);
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
    api.getGroupsRecent().catch(() => []),
    api.getGoals().catch(() => []),
  ]);
  const locked = computeLocked(goals);
  clear(body);

  if (!rulesets.length) {
    body.appendChild(emptyState('ルールセットがありません。「＋ ルールを作成」から追加してください（初回は今日から有効なルールを作成できます）。'));
    return;
  }

  for (const rs of rulesets) {
    body.appendChild(rulesetCard(rs, groups, reload, locked));
  }
}

function statusBadge(status) {
  if (status === 'DRAFT_FUTURE') return h('span', { class: 'badge accent', text: '未来(編集可)' });
  if (status === 'DRAFT_TODAY') return h('span', { class: 'badge accent', text: '当日追加(編集可)' });
  if (status === 'FROZEN_ACTIVE') return h('span', { class: 'badge warn', text: '凍結(当日)' });
  return h('span', { class: 'badge', text: '過去' });
}

function condText(c) {
  const label = targetLabel(c.target);
  if (c.target === 'TOTAL_WORK') return `${label} ≥ ${fmtHM(c.threshold_seconds || 0)}`;
  // group_name/group_needs_reset はサーバーが埋め込む(identity の現在名; 旧条件は「要再設定」付き)。
  if (c.target === 'GROUP') {
    const name = c.group_name ? `${c.group_name}${c.group_needs_reset ? '（要再設定）' : ''}` : '?';
    return `${label}[${name}] ≥ ${fmtHM(c.threshold_seconds || 0)}`;
  }
  // TIMELINE は「<カテゴリ> ◯分以上」で表示する（timeline: 生キーは出さない）。
  if (c.target === 'TIMELINE') return `${c.label || 'カテゴリ'} ${Math.round((c.threshold_seconds || 0) / 60)}分以上`;
  if (c.target === 'MANUAL_CHECK') return `${label}: ${c.label || c.condition_key}`;
  // PLANNING はフラット化済みなので signal ラベルをそのまま条件名にする(「翌日計画: …」の二重表記を避ける)。
  if (c.target === 'PLANNING') return planningSignalLabel(c.signal_key);
  return label;
}

export function rulesetCard(rs, groups, onChange, locked = { keys: new Set(), byKey: new Map() }) {
  const editable = rs.ruleSet.status === 'DRAFT_FUTURE';
  const isDraftToday = rs.ruleSet.status === 'DRAFT_TODAY';
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
  } else if (isDraftToday) {
    // 当日追加あり: 既存条件はロックのまま、追加分の編集／撤回だけを許す。
    const { baseline, additions } = splitTodayConditions(rs);
    const edit = h('button', { class: 'btn small', text: '当日追加を編集', type: 'button' });
    edit.addEventListener('click', () => openTodayAddEditor(rs.ruleSet.effective_date, baseline, additions, groups, onChange));
    const del = h('button', { class: 'btn small danger', text: '追加を撤回', type: 'button' });
    del.addEventListener('click', async () => {
      if (!confirm('当日追加した条件をすべて撤回して、当日開始時点の状態に戻しますか?')) return;
      try { await api.deleteRule(rs.ruleSet.effective_date); toast('当日追加を撤回しました', 'ok'); onChange(); }
      catch (err) {
        const msg = err.data?.goalLocked
          ? '目標が採用中の当日追加条件は撤回できません（ジャンル固定）'
          : `失敗: ${err.message}`;
        toast(msg, 'err');
      }
    });
    head.appendChild(edit);
    head.appendChild(del);
  }
  card.appendChild(head);

  const additionKeys = new Set(isDraftToday ? splitTodayConditions(rs).additions.map((c) => c.condition_key) : []);
  const list = h('div', { class: 'list', style: { marginTop: '10px' } });
  if (!rs.conditions.length) list.appendChild(emptyState('条件なし'));
  for (const c of rs.conditions) {
    const row = h('div', { class: 'list-row' }, h('span', { class: 'grow', text: condText(c) }));
    if (isDraftToday && additionKeys.has(c.condition_key)) {
      row.appendChild(h('span', { class: 'badge accent', text: '＋ 当日追加' }));
    } else if (isDraftToday) {
      row.appendChild(h('span', { class: 'badge warn', text: '🔒 当日ロック' }));
    }
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
  attachTooltip(save, { label: '保存', keys: ['Ctrl', 'Enter'] });
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
      if (!got || (got.target !== 'TOTAL_WORK' && got.target !== 'GROUP' && got.target !== 'TIMELINE')) continue;
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
  enterToSave(body, save);
  ctrlEnterToSave(body, save);
  openModal(body, `ルール編集 — ${date}`);
}

/**
 * モーダル body 内の単一行 input（text/number）での素の Enter で保存ボタン相当を実行する。
 * IME 変換確定 Enter は無視し、textarea は改行のまま残す。save が disabled 中は二重送信を防ぐ。
 */
function enterToSave(body, save) {
  body.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== 'Enter' || e.shiftKey) return;
    const el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    e.preventDefault();
    if (save.disabled) return;
    save.click();
  });
}

/** 保存済みの条件行を PUT 入力（ConditionInput）へ写す。conditionKey を明示し baseline 一致を保証する。 */
function condToInput(c) {
  return {
    target: c.target,
    stableGroupId: c.stable_group_id || undefined,
    groupIdentityId: c.group_identity_id ?? undefined,
    comparator: 'GTE',
    thresholdSeconds: c.threshold_seconds ?? null,
    label: c.label || undefined,
    signalKey: c.signal_key || undefined,
    conditionKey: c.condition_key,
  };
}

/**
 * 当日の条件追加エディタ（spec: same-day-rule-additions / 5.2・5.3）。
 * 既存の baseline 条件は「当日ロック」で読み取り専用表示し、新しい条件の追加のみ許す。
 * 追加分は同日中は自由に編集・削除できる。保存は PUT（baseline + 追加分の全体）で行い、
 * baseline を緩める編集はサーバが baseline 違反（400）で拒否する。
 */
export function openTodayAddEditor(date, baseline, additions, groups, onDone) {
  const body = h('div', { class: 'modal-body' });
  body.appendChild(h('p', { class: 'muted', text: `対象日: ${date}（当日）。既存の条件はロックされ、当日は「新しい条件の追加」だけができます（追加分は同日中は自由に編集・削除でき、翌日から凍結されます）。` }));

  if (baseline.length) {
    body.appendChild(h('label', { class: 'muted', text: '既存の条件（当日ロック）' }));
    const bl = h('div', { class: 'list' });
    for (const c of baseline) {
      bl.appendChild(h('div', { class: 'list-row' },
        h('span', { class: 'grow', text: condText(c) }),
        h('span', { class: 'badge warn', text: '🔒 当日ロック' }),
      ));
    }
    body.appendChild(bl);
  }

  body.appendChild(h('label', { class: 'muted', text: '当日に追加する条件' }));
  const rowsHost = h('div', { class: 'list' });
  body.appendChild(rowsHost);
  const addRow = (c) => rowsHost.appendChild(condEditorRow(c, groups, false));
  additions.forEach((c) => addRow(fromRow(c)));

  const addBtn = h('button', { class: 'btn small', text: '＋ 条件を追加', type: 'button' });
  // 当日追加はタイムライン記録（習慣）が主用途のため既定を TIMELINE にする。
  addBtn.addEventListener('click', () => addRow({ target: 'TIMELINE', label: '', minutes: 30 }));
  body.appendChild(addBtn);

  const save = h('button', { class: 'btn primary', text: '保存（当日に追加）', type: 'button' });
  attachTooltip(save, { label: '保存', keys: ['Ctrl', 'Enter'] });
  save.addEventListener('click', async () => {
    const addRows = [...rowsHost.querySelectorAll('.cond-editor')];
    const adds = [];
    for (const row of addRows) { const c = readEditorRow(row); if (c) adds.push(c); }
    // baseline は据え置きで送る（条件キー・値を変えない＝緩めない）。追加分を末尾に足す。
    const conditions = [...baseline.map(condToInput), ...adds];
    save.disabled = true;
    try {
      await api.putRule(date, { combinator: 'ALL', conditions });
      toast('当日に条件を追加しました', 'ok');
      closeModal();
      onDone();
    } catch (err) {
      if (err.data?.baselineViolation) toast('当日は既存条件を緩められません（新しい条件の追加のみ可能）', 'err');
      else if (err.data?.reasonRequired) toast('採用中条件の閾値変更には理由が必要です', 'err');
      else if (err.data?.goalLocked) toast('目標が採用中の実践は外せません（ジャンル固定）', 'err');
      else toast(`失敗: ${err.message}`, 'err');
      save.disabled = false;
    }
  });
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', text: 'キャンセル', type: 'button', onclick: closeModal }),
    save,
  ));
  enterToSave(body, save);
  ctrlEnterToSave(body, save);
  openModal(body, `当日に条件を追加 — ${date}`);
}

function fromRow(c) {
  return {
    target: c.target,
    conditionKey: c.condition_key,
    minutes: c.threshold_seconds ? Math.round(c.threshold_seconds / 60) : 0,
    groupIdentityId: c.group_identity_id ?? null,
    label: c.label || '',
    signalKey: c.signal_key || '',
  };
}

/**
 * 単一の条件エディタ行（純粋な行ビルダー）。全5ターゲット＋PLANNING フラット化・カテゴリ補完・
 * グループ選択を1つの <select> で扱う。goals.js の「毎日やること」からも再利用する（locked=false）。
 * `row._get()` が `{ target, thresholdSeconds?, groupIdentityId?, label?, signalKey? }` を返す。
 */
export function condEditorRow(c, groups, locked = false) {
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
  // グループ選択肢は直近実測 identity（合計時間降順・spec: group-identity-registry）。UUID は出さない。
  const groupSel = h('select', {}, ...groups.map((x) => h('option', { value: String(x.id) }, x.name)));
  if (c.groupIdentityId != null) groupSel.value = String(c.groupIdentityId);
  const labelInp = h('input', { type: 'text', value: c.label || '', placeholder: 'チェック項目名' });

  // TIMELINE 用: 手動カテゴリ（直近使用順）を候補に出す自由入力。未登録名は保存時にレジストリへ upsert される。
  const catInp = h('input', { type: 'text', value: c.label || '', placeholder: 'カテゴリ（例: 運動）' });
  catInp.style.width = '140px';
  const catList = h('datalist');
  const catListId = `cat-list-${Math.random().toString(36).slice(2)}`;
  catList.id = catListId;
  catInp.setAttribute('list', catListId);
  api.getCategories().then((cats) => {
    clear(catList);
    for (const cat of cats || []) catList.appendChild(h('option', { value: cat.name }));
  }).catch(() => { /* 候補が出せなくても自由入力は可能 */ });

  const extra = h('div', { class: 'row', style: { flex: '1' } });
  const rm = h('button', { class: 'icon-btn', text: '🗑', title: '削除', type: 'button' });

  // ジャンル固定: 種別/グループ/カテゴリは変更不可・行削除不可。閾値(minutes)のみ編集可。
  if (locked) {
    kindSel.disabled = true;
    groupSel.disabled = true;
    catInp.disabled = true;
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
    else if (target === 'TIMELINE') extra.append(catInp, catList, labelSpan('≥ 分'), minutes);
    else if (target === 'MANUAL_CHECK') extra.append(labelInp);
    // PLANNING はシグナル選択が条件そのものへ統合されたため、追加入力は無し。
  };
  kindSel.addEventListener('change', sync);
  sync();

  // 参照用に要素をぶら下げる.
  row._get = () => {
    const { target, signalKey } = conditionKindTarget(kindSel.value);
    if (target === 'TOTAL_WORK') return { target, thresholdSeconds: (Number(minutes.value) || 0) * 60 };
    if (target === 'GROUP') return { target, groupIdentityId: groupSel.value ? Number(groupSel.value) : null, thresholdSeconds: (Number(minutes.value) || 0) * 60 };
    if (target === 'TIMELINE') return { target, label: catInp.value.trim() || 'uncategorized', thresholdSeconds: (Number(minutes.value) || 0) * 60 };
    if (target === 'MANUAL_CHECK') return { target, label: labelInp.value.trim() || 'チェック' };
    if (target === 'PLANNING') return { target, signalKey: signalKey || null };
    return null;
  };
  return row;
}

function labelSpan(t) { return h('span', { class: 'muted', text: t }); }
function readEditorRow(row) { return row._get ? row._get() : null; }
