// ルール（解錠条件）の UI 部品（spec: editable-rule-registry / goal-lifecycle-fork / goal-chronicle）。
//
// Plan / Check の語彙は撤去された。ルールは第一級で、種類（⏱総作業/⏱グループ/⏱カテゴリ/☑チェック/
// 📷写真/💬質問）と いつ（永続/単発/範囲）が独立した2軸。ルールを足せる場所は目標作成時と
// 振り返りタブの目標コーナーの2つだけ（今日タブに書き込み動線は無い）。
//
// ★フォームの肝は「種類の切替が『いつ』の選択・入力値に一切触れない」こと（2軸の独立）。

import { h, clear, toast, addDays, openModal, closeModal, attachTooltip, ctrlEnterToSave } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { isDemo } from './demo.js';
import { CONDITION_KINDS, conditionKindValue, conditionKindTarget, ruleNiceLabel } from './targets.js';

/** デモ中はデモ DB 向けの書き込み API へ切替える（本番書き込みは呼ばない・spec: demo-rule-tutorial）。 */
const ruleApi = {
  add: (goalId, input) => (isDemo() ? api.demo.addGoalRule(goalId, input, state.demo.virtualDay) : api.addGoalRule(goalId, input)),
  update: (goalId, ruleId, input) => (isDemo() ? api.demo.updateGoalRule(goalId, ruleId, input, state.demo.virtualDay) : api.updateGoalRule(goalId, ruleId, input)),
  remove: (goalId, ruleId, reason) => (isDemo() ? api.demo.removeGoalRule(goalId, ruleId, reason, state.demo.virtualDay) : api.removeGoalRule(goalId, ruleId, reason)),
  goal: (goalId) => (isDemo() ? api.demo.goal(goalId, state.demo.virtualDay) : api.getGoal(goalId)),
  chronicle: (goalId) => (isDemo() ? api.demo.chronicle(goalId) : api.getGoalChronicle(goalId)),
};

/** 日付の表示形（'2026-07-18' → '7/18'）。 */
export function shortDay(dayKey) {
  const [, m, d] = String(dayKey || '').split('-');
  return m && d ? `${Number(m)}/${Number(d)}` : String(dayKey || '');
}

/**
 * 理由必須のプロンプト。理由が空なら null を返す（呼び出し側は何もしない）。
 * 「理由さえ書けば変更・削除できる」緩さと引き換えに、その事実が沿革に残る（design D4）。
 */
export function promptReason(message) {
  const reason = window.prompt(message);
  if (reason === null) return null; // キャンセル。
  if (!reason.trim()) {
    toast('理由を入力してください（空では実行できません）', 'error');
    return null;
  }
  return reason.trim();
}

// --- 初回オープン時のトースト（spec: goal-check-gate / design D7）-----------

/** 「その日すでにトーストを出したか」を覚える localStorage キー（day_key 単位）。 */
const TOAST_FLAG_KEY = 'dueRuleToastShownDay';

/**
 * その日に回答すべき写真/質問ルールがあれば、**その日はじめてダッシュボードを開いたとき1回だけ**トーストを出す。
 * 時刻ではスケジュールしない（croner も OS トーストも使わない）。ダッシュボード読み込み時に問い合わせて、
 * 既存 `toast()` で1回出すだけ＝完全ローカル・オフライン原則をそのまま保てる。
 */
export async function maybeShowDueRuleToast(todayKey) {
  try {
    if (localStorage.getItem(TOAST_FLAG_KEY) === todayKey) return;
    const res = await api.getDueRules(todayKey);
    const rules = (res && res.rules) || [];
    if (!rules.length) return;
    localStorage.setItem(TOAST_FLAG_KEY, todayKey);
    const first = rules[0];
    const more = rules.length > 1 ? `ほか${rules.length - 1}件 ` : '';
    const icon = first.target === 'PHOTO' ? '📷' : '💬';
    toast(`${icon} ${first.label} ― 今日のルールです${more ? `（${more}` : '（'}${first.goalName || ''}）`);
  } catch {
    // 通知は補助でしかない。失敗しても画面は壊さない（ゲートが本体）。
  }
}

// --- ルールフォーム（種類×いつ×理由の3軸）----------------------------------

/** フォーム用の種類選択肢（PLANNING を含む既存 CONDITION_KINDS ＋ 写真/質問）。 */
const FORM_KINDS = [
  ...CONDITION_KINDS,
  { v: 'PHOTO', target: 'PHOTO', signalKey: null, label: '📷 写真を出す' },
  { v: 'QUESTION', target: 'QUESTION', signalKey: null, label: '💬 質問に答える' },
];

/**
 * ルールフォームを組む（作成・編集で共用）。`initial` を渡すと編集として prefill する。
 * 返り値の `read()` が API 入力（{target, ...contentFields, startDay, endDay, reason}）を返す。
 */
export function buildRuleForm({ initial, todayKey, groups } = {}) {
  const isEdit = !!initial;
  const kindSel = h('select', {}, ...FORM_KINDS.map((k) => h('option', { value: k.v }, k.label)));
  const initialKindV = initial ? (initial.target === 'PLANNING' ? conditionKindValue('PLANNING', initial.signalKey) : initial.target) : 'TOTAL_WORK';
  kindSel.value = initialKindV;

  const minutes = h('input', { class: 'pc-input pc-input-num', type: 'number', min: '1', step: '5', value: String(initial?.thresholdSeconds ? Math.round(initial.thresholdSeconds / 60) : 60) });
  const groupSel = h('select', { class: 'pc-input' }, ...(groups || []).map((g) => h('option', { value: String(g.id) }, g.name)));
  if (initial?.groupIdentityId != null) groupSel.value = String(initial.groupIdentityId);
  const catInp = h('input', { class: 'pc-input', type: 'text', placeholder: '例: 運動', value: initial?.label || '' });
  const catList = h('datalist', { id: `rf-catlist-${Math.random().toString(36).slice(2)}` });
  catInp.setAttribute('list', catList.id);
  api.getCategories().then((cats) => { clear(catList); for (const c of cats || []) catList.appendChild(h('option', { value: c.name })); }).catch(() => {});
  const labelInp = h('input', { class: 'pc-input', type: 'text', placeholder: 'チェック名', value: initial?.label || '' });
  // 写真キャプション・質問文は作成後変更できない（design: editable-rule-registry）。編集時は無効化する。
  const captionInp = h('input', { class: 'pc-input', type: 'text', placeholder: '例: 前髪・正面', maxlength: '60', value: initial?.caption || '' });
  const questionInp = h('input', { class: 'pc-input', type: 'text', placeholder: '例: 使用感はどうだった？', maxlength: '120', value: initial?.questionText || '' });
  if (isEdit && initial.target === 'PHOTO') captionInp.disabled = true;
  if (isEdit && initial.target === 'QUESTION') questionInp.disabled = true;

  const extra = h('div', { class: 'row', style: { flex: '1', gap: '8px', flexWrap: 'wrap' } });
  const syncKind = () => {
    clear(extra);
    const { target } = conditionKindTarget(kindSel.value);
    if (target === 'TOTAL_WORK') extra.append(labelSpan('しきい値(分)'), minutes);
    else if (target === 'GROUP') extra.append(labelSpan('グループ'), groupSel, labelSpan('≥ 分'), minutes);
    else if (target === 'TIMELINE') extra.append(labelSpan('カテゴリ'), catInp, catList, labelSpan('≥ 分'), minutes);
    else if (target === 'MANUAL_CHECK') extra.append(labelSpan('チェック名'), labelInp);
    else if (target === 'PHOTO') extra.append(labelSpan('撮るもの'), captionInp, isEdit ? labelSpan('（作成後は変更不可）') : null);
    else if (target === 'QUESTION') extra.append(labelSpan('質問文'), questionInp, isEdit ? labelSpan('（作成後は変更不可）') : null);
    // PLANNING はシグナル選択が種類に統合済み（追加入力なし）。
  };
  kindSel.addEventListener('change', syncKind);
  syncKind();
  if (initial?.needsReset && conditionKindTarget(kindSel.value).target === 'GROUP') {
    groupSel.value = ''; // 壊れた参照は選び直しを促す（既定の選択を空にする）。
  }

  // --- 軸2: いつ（永続/単発/範囲）--------------------------------------------
  const initialSchedule = initial?.schedule || 'permanent';
  const state = { schedule: initialSchedule };
  const startInput = h('input', { class: 'pc-input pc-input-date', type: 'date', value: initial?.startDay || todayKey, min: isEdit ? undefined : todayKey });
  const endInput = h('input', { class: 'pc-input pc-input-date', type: 'date', value: initial?.endDay || addDays(todayKey, 6) });
  const endField = h('label', { class: 'pc-field pc-field-inline' }, h('span', { class: 'pc-field-label', text: '終了' }), endInput);
  endField.hidden = initialSchedule !== 'range';
  const startFieldAlways = h('label', { class: 'pc-field pc-field-inline' }, h('span', { class: 'pc-field-label', text: '開始日' }), startInput);
  startFieldAlways.hidden = initialSchedule === 'permanent';

  const scheduleSeg = h('div', { class: 'pc-seg' });
  for (const { v, label } of [{ v: 'permanent', label: 'ずっと（永続）' }, { v: 'single', label: '単発' }, { v: 'range', label: '範囲' }]) {
    const b = h('button', { type: 'button', class: 'pc-seg-btn' + (v === initialSchedule ? ' on' : ''), text: label });
    b.addEventListener('click', () => {
      state.schedule = v;
      for (const x of scheduleSeg.children) x.classList.toggle('on', x === b);
      startFieldAlways.hidden = v === 'permanent';
      endField.hidden = v !== 'range';
    });
    scheduleSeg.appendChild(b);
  }

  const reasonInp = h('textarea', { class: 'pc-textarea', rows: '2', placeholder: '理由（必須）例: ボリュームアップシャンプーを使えば髪質が良くなるのではないだろうか' });

  const el = h('div', { class: 'pc-checkform' },
    h('div', { class: 'pc-axis' },
      h('div', { class: 'pc-axis-head', text: '種類' }),
      h('div', { class: 'row' }, kindSel, extra),
    ),
    h('div', { class: 'pc-axis' },
      h('div', { class: 'pc-axis-head', text: 'いつ' }),
      scheduleSeg,
      startFieldAlways,
      endField,
    ),
    h('div', { class: 'pc-axis' },
      h('div', { class: 'pc-axis-head', text: '理由（必須）' }),
      reasonInp,
    ),
  );

  return {
    el,
    read() {
      const { target, signalKey } = conditionKindTarget(kindSel.value);
      const out = { target, reason: reasonInp.value.trim() };
      if (target === 'TOTAL_WORK') out.thresholdSeconds = (Number(minutes.value) || 0) * 60;
      else if (target === 'GROUP') { out.groupIdentityId = groupSel.value ? Number(groupSel.value) : null; out.thresholdSeconds = (Number(minutes.value) || 0) * 60; }
      else if (target === 'TIMELINE') { out.label = catInp.value.trim(); out.thresholdSeconds = (Number(minutes.value) || 0) * 60; }
      else if (target === 'MANUAL_CHECK') out.label = labelInp.value.trim();
      else if (target === 'PLANNING') out.signalKey = signalKey || null;
      else if (target === 'PHOTO') out.caption = isEdit ? (initial.caption || '') : captionInp.value.trim();
      else if (target === 'QUESTION') out.questionText = isEdit ? (initial.questionText || '') : questionInp.value.trim();

      if (state.schedule === 'permanent') { out.startDay = todayKey; out.endDay = null; }
      else if (state.schedule === 'single') { out.startDay = startInput.value; out.endDay = startInput.value; }
      else { out.startDay = startInput.value; out.endDay = endInput.value; }
      return out;
    },
  };
}

function labelSpan(t) { return h('span', { class: 'muted', text: t }); }

/**
 * 延長フォーク（design D7）。ルールの終端が目標の終了を越えるとき、伸ばすかやめるかを問う。
 * ユーザーが選ぶまで待ち、'extend'|'truncate' を返す。ダイアログを閉じる（Esc/背景クリック）と null。
 */
function extensionForkDialog({ goalName, goalEndDay, proposedEndDay }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const body = h('div', { class: 'modal-body stack' },
      h('p', { text: `このルールは ${shortDay(proposedEndDay)} まで続きます。「${goalName}」は ${shortDay(goalEndDay)} で終了予定です。目標の終了を ${shortDay(proposedEndDay)} まで伸ばしますか？` }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', text: 'やめておく', onclick: () => { finish('truncate'); closeModal(); } }),
        h('button', { class: 'btn primary', type: 'button', text: '伸ばす', onclick: () => { finish('extend'); closeModal(); } }),
      ),
    );
    openModal(body, '目標の終了を延長しますか？');
    const backdrop = document.querySelector('#modal-root .modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null); });
    const onKey = (e) => { if (e.key === 'Escape') { finish(null); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  });
}

/** ルール作成・編集モーダルを開く。延長フォークが必要なら都度問い、答えるまで保存を確定しない。 */
function openRuleFormModal({ title, initial, todayKey, groups, onSave }) {
  const form = buildRuleForm({ initial, todayKey, groups });
  const save = h('button', { class: 'btn primary', type: 'button', text: initial ? '保存' : 'ルールを追加' });
  attachTooltip(save, { label: '保存', keys: ['Ctrl', 'Enter'] });
  const body = h('div', { class: 'modal-body stack' }, form.el,
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: 'キャンセル', onclick: closeModal }), save));

  async function trySave(payload, extend) {
    try {
      await onSave({ ...payload, extend });
    } catch (err) {
      if (err.status === 409 && err.data && err.data.extensionRequired) {
        const choice = await extensionForkDialog({
          goalName: title.goalName, goalEndDay: err.data.goalEndDay, proposedEndDay: err.data.proposedEndDay,
        });
        if (!choice) return; // ユーザーがフォークを閉じた＝保存しない。
        await trySave(payload, choice);
        return;
      }
      throw err;
    }
  }

  save.addEventListener('click', async () => {
    const payload = form.read();
    if (!payload.reason) { toast('理由を入力してください', 'error'); return; }
    save.disabled = true;
    try {
      await trySave(payload);
      closeModal();
    } catch (err) {
      toast((err.data && err.data.error) || '保存できませんでした', 'error');
    } finally {
      save.disabled = false;
    }
  });

  ctrlEnterToSave(body, save);
  openModal(body, title.text);
}

// --- 目標コーナーのルールブロック（振り返りタブ）----------------------------

export function ruleScheduleText(r) {
  if (r.schedule === 'permanent') return 'ずっと（永続）';
  if (r.schedule === 'single') return `${shortDay(r.startDay)}（単発）`;
  return `${shortDay(r.startDay)}〜${shortDay(r.endDay)}（範囲・毎日）`;
}

export function ruleKindIcon(target) {
  if (target === 'MANUAL_CHECK') return '☑';
  if (target === 'PHOTO') return '📷';
  if (target === 'QUESTION') return '💬';
  if (target === 'TOTAL_WORK' || target === 'GROUP' || target === 'TIMELINE') return '⏱';
  return '';
}

export function ruleDisplayLabel(r) {
  if (r.target === 'TOTAL_WORK' || r.target === 'GROUP' || r.target === 'TIMELINE') {
    return `${r.label || '総作業時間'} ${Math.round((r.thresholdSeconds || 0) / 60)}分以上`;
  }
  return ruleNiceLabel(r.target, r.label);
}

/** ルール1行（表示＋✎/−）。 */
function ruleRow(goal, r, todayKey, groups, onChanged) {
  const badges = h('div', { class: 'row', style: { gap: '6px' } });
  if (r.needsReset) badges.appendChild(h('span', { class: 'badge warn', text: '⚠ 参照が壊れています' }));
  const main = h('div', { class: 'pc-plan-body', style: { flex: '1' } },
    `${ruleKindIcon(r.target)} ${ruleDisplayLabel(r)}`,
    h('span', { class: 'pc-pending-when', text: `　${ruleScheduleText(r)}` }),
  );
  const editBtn = h('button', { type: 'button', class: 'btn btn-ghost pc-sm', text: '✎' });
  const delBtn = h('button', { type: 'button', class: 'btn btn-ghost pc-sm', text: '−' });
  editBtn.addEventListener('click', () => {
    openRuleFormModal({
      title: { text: `ルールを編集 — ${ruleDisplayLabel(r)}`, goalName: goal.name },
      initial: r,
      todayKey,
      groups,
      onSave: async (payload) => {
        const { extend, ...rest } = payload;
        await ruleApi.update(goal.id, r.ruleId, { ...rest, extend });
        toast('ルールを保存しました', 'ok');
        onChanged();
      },
    });
  });
  delBtn.addEventListener('click', async () => {
    const reason = promptReason(`「${ruleDisplayLabel(r)}」を削除する理由（必須）`);
    if (!reason) return;
    try {
      await ruleApi.remove(goal.id, r.ruleId, reason);
      toast('ルールを削除しました（沿革には残ります）', 'ok');
      onChanged();
    } catch (err) {
      toast((err.data && err.data.error) || '削除できませんでした', 'error');
    }
  });
  return h('div', { class: 'pc-plan' }, h('div', { class: 'pc-plan-head' }, main, badges, h('div', { class: 'pc-plan-actions' }, editBtn, delBtn)));
}

/** 沿革1件を「＋追加／✎変更／−削除 ラベル ― 理由」の1行へ。 */
function changeLine(entry) {
  const opLabel = entry.change.op === 'add' ? '＋追加' : entry.change.op === 'remove' ? '−削除' : '✎変更';
  const row = h('div', { class: 'pc-pending-row' },
    h('span', { class: 'pc-pending-label', text: `${opLabel} ${ruleKindIcon(entry.target)} ${entry.label}` }),
  );
  if (entry.change.reason) row.appendChild(h('span', { class: 'pc-pending-note', text: ` ― ${entry.change.reason}` }));
  return row;
}

/**
 * 振り返りタブの目標コーナーに置くルールブロック（spec: editable-rule-registry）。
 * ルール一覧＋「＋追加」＋各行の✎/−＋「最近の変更」。今日タブに書き込み動線は無い。
 */
export function buildGoalRulesBlock(goal, todayKey, onReload) {
  const host = h('div', { class: 'pc-block' });
  const listHost = h('div', { class: 'pc-plans' });
  const changesHost = h('div', { class: 'pc-pending', style: { marginTop: '10px' } });
  const addBtn = h('button', { type: 'button', class: 'btn btn-ghost pc-sm', text: '＋ 追加' });

  let groups = [];
  const reload = async () => {
    clear(listHost);
    clear(changesHost);
    groups = await api.getGroupsRecent().catch(() => []);
    const fresh = await ruleApi.goal(goal.id).catch(() => goal);
    Object.assign(goal, fresh);
    if (!goal.rules.length) {
      listHost.appendChild(h('p', { class: 'pc-empty', text: 'まだルールはありません。「＋ 追加」でこの目標のためのルールを作れます。' }));
    } else {
      for (const r of goal.rules) listHost.appendChild(ruleRow(goal, r, todayKey, groups, reload));
    }
    try {
      const chronicle = await ruleApi.chronicle(goal.id);
      const recent = (chronicle.entries || []).slice(-5).reverse();
      if (recent.length) {
        changesHost.appendChild(h('div', { class: 'pc-axis-head', text: '最近の変更' }));
        for (const e of recent) changesHost.appendChild(changeLine(e));
      }
    } catch { /* noop: 沿革が読めなくてもルール一覧は表示する */ }
    if (onReload) onReload();
  };

  addBtn.addEventListener('click', () => {
    openRuleFormModal({
      title: { text: 'ルールを追加', goalName: goal.name },
      todayKey,
      groups,
      onSave: async (payload) => {
        const { extend, ...rest } = payload;
        const res = await ruleApi.add(goal.id, { ...rest, extend });
        toast(res.truncated ? `ルールを追加しました（目標末尾まで${shortDay(res.rule.end_day)}に調整しました）` : 'ルールを追加しました', 'ok');
        await reload();
      },
    });
  });

  host.appendChild(h('div', { class: 'pc-head' },
    h('span', { class: 'pc-title', text: 'ルール' }),
    h('span', { class: 'pc-hint', text: 'この目標で守ること' }),
    h('div', { class: 'spacer' }),
    addBtn,
  ));
  host.appendChild(listHost);
  host.appendChild(changesHost);
  reload();
  return host;
}
