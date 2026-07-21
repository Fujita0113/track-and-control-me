// Plan（賭け）/ Check（答え合わせ）の UI 部品
// （spec: goal-plan-check / goal-check-gate / goal-chronicle）。
//
// 画面の分業に従い、ここは「書く＝振り返りタブ」側の部品と、今日タブ・目標タブが共有する
// 小物（Check の要約表示・取り下げプロンプト）を提供する。
//
// ★Check フォームの肝は **種類（📷/💬）と いつ（単発⇄範囲）が独立した2軸**であること。
// 種類の切替は「いつ」の選択・入力値に一切触れない（触れたらこの設計が壊れる）。

import { h, clear, toast, addDays } from './util.js';
import { api } from './api.js';

/** 日付の表示形（'2026-07-18' → '7/18'）。 */
export function shortDay(dayKey) {
  const [, m, d] = String(dayKey || '').split('-');
  return m && d ? `${Number(m)}/${Number(d)}` : String(dayKey || '');
}

/** Check の対象日の表示（単発＝1日／範囲＝期間）。 */
export function checkWhenText(check) {
  if (check.schedule === 'single') return shortDay(check.startDayKey);
  const end = addDays(check.startDayKey, (check.spanDays || 1) - 1);
  return `${shortDay(check.startDayKey)}〜${shortDay(end)}`;
}

/** 種類の絵文字。 */
export function kindIcon(kind) {
  return kind === 'photo' ? '📷' : '💬';
}

/** Check の表示ラベル＝写真はキャプション／質問は質問文。 */
export function checkLabel(check) {
  return check.kind === 'photo' ? check.caption : check.questionText;
}

/**
 * 理由必須の取り下げプロンプト。理由が空なら null を返す（呼び出し側は何もしない）。
 * 「理由さえ書けば逃げられる」緩さと引き換えに、逃げた事実が歴史に残る（design D9）。
 */
export function promptReason(message) {
  const reason = window.prompt(message);
  if (reason === null) return null; // キャンセル。
  if (!reason.trim()) {
    toast('理由を入力してください（空では取り下げられません）', 'error');
    return null;
  }
  return reason.trim();
}

// --- 初回オープン時のトースト（spec: goal-check-gate / design D7）-----------

/** 「その日すでにトーストを出したか」を覚える localStorage キー（day_key 単位）。 */
const TOAST_FLAG_KEY = 'checkToastShownDay';

/**
 * その日に回答すべき Check があれば、**その日はじめてダッシュボードを開いたとき1回だけ**トーストを出す。
 *
 * **時刻ではスケジュールしない**（croner も OS トーストも使わない）。ダッシュボード読み込み時に
 * 問い合わせて、既存 `toast()` で1回出すだけ＝完全ローカル・オフライン原則をそのまま保てる。
 * 「その日もう出したか」は day_key 単位のフラグで判定するので、同じ日の再読み込みでは出ない。
 *
 * 夜まで開かなければトーストも夜に出るが、ユーザーが本当に困る「気づかないまま一日終わる」は
 * 今日タブのゲートが必ず防ぐ。ここはその補助でしかない。
 */
export async function maybeShowDueCheckToast(todayKey) {
  try {
    if (localStorage.getItem(TOAST_FLAG_KEY) === todayKey) return; // 同じ日の2回目以降は出さない。
    const res = await api.getDueChecks(todayKey);
    const checks = (res && res.checks) || [];
    // 回答すべき Check が無い日は出さない。
    if (!checks.length) return;
    localStorage.setItem(TOAST_FLAG_KEY, todayKey);
    const first = checks[0];
    const more = checks.length > 1 ? `ほか${checks.length - 1}件 ` : '';
    toast(`${kindIcon(first.kind)} ${first.label} ― 今日の Check です${more ? `（${more}` : '（'}${first.goalName}）`);
  } catch {
    // 通知は補助でしかない。失敗しても画面は壊さない（ゲートが本体）。
  }
}

// --- Check フォーム（2軸）--------------------------------------------------

/**
 * 「＋ Check」フォームを組む。返り値の `read()` が API 入力（CreateCheckInput）を返す。
 *
 * 2軸は独立して描く:
 *   軸1 種類 … 📷 写真を投稿する（撮るもの）／💬 質問に答える（質問文）
 *   軸2 いつ … 単発（ある1日）／範囲（開始日から N 日間・毎日）
 * 種類のラジオは kind 側のフィールドだけを出し入れし、「いつ」のトグル・入力値には触れない。
 */
function checkForm(todayKey) {
  const state = { kind: 'photo', schedule: 'single' };

  // --- 軸1: 種類 ---
  const captionInput = h('input', { class: 'pc-input', type: 'text', placeholder: '例: 前髪・正面', maxlength: '60' });
  const questionInput = h('input', { class: 'pc-input', type: 'text', placeholder: '例: 使用感はどうだった？', maxlength: '120' });
  const captionField = h('label', { class: 'pc-field' }, h('span', { class: 'pc-field-label', text: '撮るもの' }), captionInput);
  const questionField = h('label', { class: 'pc-field' }, h('span', { class: 'pc-field-label', text: '質問文' }), questionInput);

  const kindRadios = [
    { v: 'photo', label: '📷 写真を投稿する' },
    { v: 'question', label: '💬 質問に答える' },
  ].map(({ v, label }) => {
    const input = h('input', { type: 'radio', name: 'pc-kind', value: v, checked: v === 'photo' });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      state.kind = v;
      // 種類に属するフィールドだけを切り替える。「いつ」には触れない（2軸の独立）。
      captionField.hidden = v !== 'photo';
      questionField.hidden = v !== 'question';
    });
    return h('label', { class: 'pc-radio' }, input, h('span', { text: label }));
  });
  questionField.hidden = true;

  // --- 軸2: いつ ---
  const startInput = h('input', { class: 'pc-input pc-input-date', type: 'date', value: addDays(todayKey, 3), min: todayKey });
  const spanInput = h('input', { class: 'pc-input pc-input-num', type: 'number', min: '2', max: '30', value: '7' });
  const spanField = h('label', { class: 'pc-field pc-field-inline' },
    h('span', { class: 'pc-field-label', text: '日数' }),
    spanInput,
    h('span', { class: 'pc-unit', text: '日間（毎日）' }),
  );
  spanField.hidden = true; // 既定は単発。

  const scheduleSeg = h('div', { class: 'pc-seg' });
  for (const { v, label } of [
    { v: 'single', label: '単発' },
    { v: 'range', label: '範囲' },
  ]) {
    const b = h('button', { type: 'button', class: 'pc-seg-btn' + (v === 'single' ? ' on' : ''), text: label });
    b.addEventListener('click', () => {
      state.schedule = v;
      for (const x of scheduleSeg.children) x.classList.toggle('on', x === b);
      spanField.hidden = v !== 'range';
    });
    scheduleSeg.appendChild(b);
  }

  // --- メモ（判定には使わない・design D8）---
  const placeInput = h('input', { class: 'pc-input', type: 'text', placeholder: '例: 洗面所', maxlength: '40' });
  const timeInput = h('input', { class: 'pc-input', type: 'text', placeholder: '例: 朝', maxlength: '40' });

  const el = h('div', { class: 'pc-checkform' },
    h('div', { class: 'pc-axis' },
      h('div', { class: 'pc-axis-head', text: '種類' }),
      h('div', { class: 'pc-radios' }, ...kindRadios),
      captionField,
      questionField,
    ),
    h('div', { class: 'pc-axis' },
      h('div', { class: 'pc-axis-head', text: 'いつ' }),
      scheduleSeg,
      h('label', { class: 'pc-field pc-field-inline' }, h('span', { class: 'pc-field-label', text: '開始日' }), startInput),
      spanField,
    ),
    h('div', { class: 'pc-axis' },
      h('div', { class: 'pc-axis-head', text: 'メモ（任意）' }),
      h('div', { class: 'pc-notes' },
        h('label', { class: 'pc-field pc-field-inline' }, h('span', { class: 'pc-field-label', text: '場所' }), placeInput),
        h('label', { class: 'pc-field pc-field-inline' }, h('span', { class: 'pc-field-label', text: '時刻' }), timeInput),
      ),
      h('p', { class: 'pc-note-hint', text: '※ 場所・時刻メモは判定には使いません（覚え書きです）' }),
    ),
  );

  return {
    el,
    /** フォームの現在値を API 入力へ。「いつ」は絶対日（固定 day_key）で送る。 */
    read() {
      const out = { schedule: state.schedule, startDayKey: startInput.value };
      if (state.kind === 'photo') Object.assign(out, { kind: 'photo', caption: captionInput.value.trim() });
      else Object.assign(out, { kind: 'question', questionText: questionInput.value.trim() });
      if (state.schedule === 'range') out.spanDays = Number(spanInput.value);
      const place = placeInput.value.trim();
      const time = timeInput.value.trim();
      if (place) out.placeNote = place;
      if (time) out.timeNote = time;
      return out;
    },
  };
}

// --- 目標コーナーの Plan / Check ブロック（振り返りタブ）--------------------

/** 仕掛け中の Check 1行（「📷前髪・正面（7/18）」）。 */
function pendingCheckRow(check) {
  const when = checkWhenText(check);
  const row = h('div', { class: 'pc-pending-row' },
    h('span', { class: 'pc-pending-label', text: `${kindIcon(check.kind)} ${checkLabel(check)}` }),
    h('span', { class: 'pc-pending-when', text: `（${when}）` }),
  );
  if (check.status === 'cancelled') {
    row.classList.add('off');
    row.appendChild(h('span', { class: 'pc-pending-note', text: `やめた ― ${check.cancelReason || ''}` }));
  }
  return row;
}

/**
 * Plan 1件の表示（本文＋仕掛け中 Check ＋ 取り下げ導線）。
 * `todayKey` は Check フォームの基準日（Plan の作成日ではない＝昨日の Plan に今日以降の Check を足せる）。
 */
function planRow(plan, todayKey, onChanged) {
  const checksHost = h('div', { class: 'pc-pending' });
  for (const c of plan.checks) checksHost.appendChild(pendingCheckRow(c));

  const head = h('div', { class: 'pc-plan-head' }, h('p', { class: 'pc-plan-body', text: plan.body }));
  const el = h('div', { class: 'pc-plan' }, head, checksHost);

  if (plan.status === 'withdrawn') {
    el.classList.add('off');
    head.appendChild(h('span', { class: 'pc-plan-note', text: `取り下げた ― ${plan.withdrawReason || ''}` }));
    return el;
  }

  // 進行中の Plan にだけ「＋ Check」と「取り下げる」を出す。
  const addBtn = h('button', { type: 'button', class: 'btn btn-ghost pc-sm', text: '＋ Check' });
  const withdrawBtn = h('button', { type: 'button', class: 'btn btn-ghost pc-sm', text: '取り下げる' });
  head.appendChild(h('div', { class: 'pc-plan-actions' }, addBtn, withdrawBtn));

  // ＋ Check：2軸フォームを開いて1件足す。
  const formHost = h('div', { class: 'pc-formhost', hidden: true });
  el.appendChild(formHost);
  addBtn.addEventListener('click', () => {
    if (!formHost.hidden) { formHost.hidden = true; clear(formHost); return; }
    const form = checkForm(todayKey);
    const save = h('button', { type: 'button', class: 'btn btn-primary pc-sm', text: 'Check を足す' });
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost pc-sm', text: 'やめる' });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api.createGoalCheck(plan.id, form.read());
        toast('Check を仕掛けました', 'ok');
        onChanged();
      } catch (err) {
        toast((err.data && err.data.error) || 'Check を作れませんでした', 'error');
        save.disabled = false;
      }
    });
    cancel.addEventListener('click', () => { formHost.hidden = true; clear(formHost); });
    clear(formHost);
    formHost.appendChild(form.el);
    formHost.appendChild(h('div', { class: 'pc-form-actions' }, save, cancel));
    formHost.hidden = false;
  });

  // 取り下げる：理由必須。ぶら下がる未達 Check もまとめて外れる。
  withdrawBtn.addEventListener('click', async () => {
    const reason = promptReason('この Plan を取り下げる理由（必須）');
    if (!reason) return;
    try {
      await api.withdrawGoalPlan(plan.id, reason);
      toast('Plan を取り下げました（沿革には残ります）', 'ok');
      onChanged();
    } catch (err) {
      toast((err.data && err.data.error) || '取り下げできませんでした', 'error');
    }
  });

  return el;
}

/**
 * 振り返りタブの目標コーナーに置く Plan / Check ブロック（9.1〜9.4）。
 * 日記エディタとは独立（Plan/Check はこのブロックの中で即時保存し、日記の dirty/flush に相乗りしない）。
 */
export function buildPlanCheckBlock(goal, todayKey) {
  const host = h('div', { class: 'pc-block' });
  const listHost = h('div', { class: 'pc-plans' });
  const newHost = h('div', { class: 'pc-newplan', hidden: true });
  const addPlanBtn = h('button', { type: 'button', class: 'btn btn-ghost pc-sm', text: '＋ Plan' });

  const reload = async () => {
    clear(listHost);
    let plans = [];
    try {
      plans = await api.getGoalPlans(goal.id);
    } catch {
      listHost.appendChild(h('p', { class: 'pc-empty', text: 'Plan を読み込めませんでした' }));
      return;
    }
    if (!plans.length) {
      listHost.appendChild(h('p', { class: 'pc-empty', text: 'まだ Plan はありません。賭けを一文で書くと、答え合わせ（Check）を仕掛けられます。' }));
      return;
    }
    for (const p of plans) listHost.appendChild(planRow(p, todayKey, reload));
  };

  // ＋ Plan：短文1つだけ（種別の選択肢は無い＝本文を読めば分かる）。
  addPlanBtn.addEventListener('click', () => {
    if (!newHost.hidden) { newHost.hidden = true; clear(newHost); return; }
    const input = h('textarea', {
      class: 'pc-textarea',
      rows: '2',
      placeholder: '例: ボリュームアップシャンプーを使えば髪質が良くなるのではないだろうか',
    });
    const save = h('button', { type: 'button', class: 'btn btn-primary pc-sm', text: '保存' });
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost pc-sm', text: 'やめる' });
    const submit = async () => {
      const body = input.value.trim();
      if (!body) { toast('Plan の本文を入力してください', 'error'); return; }
      save.disabled = true;
      try {
        await api.createGoalPlan(goal.id, body);
        toast('Plan を書きました', 'ok');
        newHost.hidden = true;
        clear(newHost);
        await reload();
      } catch (err) {
        toast((err.data && err.data.error) || 'Plan を保存できませんでした', 'error');
        save.disabled = false;
      }
    };
    save.addEventListener('click', submit);
    // Ctrl/Cmd+Enter で保存（振り返り・カンバンと同じ動線）。
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    cancel.addEventListener('click', () => { newHost.hidden = true; clear(newHost); });
    clear(newHost);
    newHost.appendChild(input);
    newHost.appendChild(h('div', { class: 'pc-form-actions' }, save, cancel));
    newHost.hidden = false;
    input.focus();
  });

  host.appendChild(h('div', { class: 'pc-head' },
    h('span', { class: 'pc-title', text: 'Plan / Check' }),
    h('span', { class: 'pc-hint', text: '賭けを書き、答え合わせを仕掛ける' }),
    h('div', { class: 'spacer' }),
    addPlanBtn,
  ));
  host.appendChild(newHost);
  host.appendChild(listHost);
  reload();
  return host;
}
