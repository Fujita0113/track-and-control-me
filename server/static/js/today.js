// 「今日」ハブ: 旧 dashboard(概況) + gate(解錠状態/条件進捗) + checks(手動チェック) を集約.
// 上から (1) 作業概況(総作業/グループ別ドーナツ/7日棒, 除外内訳は非表示),
//        (2) 解錠状態ヒーロー + 条件進捗(MANUAL_CHECK は行内チェックボックス),
//        (3) パスワード解錠, (4) 翌日ルール編集(rules.js 再利用).
// 30秒リフレッシュはゲート領域(ヒーロー/条件/reveal)のみ。モーダルが開いている間はスキップ。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, fmtDur, fmtHM, colorHex, copyText, toast, emptyState } from './util.js';
import { targetLabel, planningSignalLabel } from './targets.js';
import { renderRuleEditing } from './rules.js';
import { isDemo } from './demo.js';
import { promptReason, shortDay } from './plan-check.js';

let charts = [];
let timer = null;
/**
 * ゲート領域の再描画関数（show() が設定）。Check の回答・取り下げ後に条件行から呼び、
 * 解錠状態（＝パスワードの出現）まで即座に反映させる。タブ非表示中は no-op。
 */
let refreshGate = () => undefined;

function destroyCharts() {
  for (const c of charts) {
    try { c.destroy(); } catch { /* noop */ }
  }
  charts = [];
}

export function hide() {
  destroyCharts();
  if (timer) { clearInterval(timer); timer = null; }
  refreshGate = () => undefined;
}

export async function show(root) {
  clear(root);
  hide();

  // デモ中は仮想日付のサンプル（解錠状態・条件進捗・ダミーパスワード）を静的表示。
  // 本物の reveal / ルール編集（本番書き込み）は動かさない。
  if (isDemo()) { await showDemo(root); return; }

  // 3 領域を用意し、それぞれ独立に描画・更新する。
  const overviewRegion = h('div', { class: 'stack' });
  const gateRegion = h('div', { class: 'stack', style: { marginTop: '18px' } });
  const rulesRegion = h('div', { class: 'stack', style: { marginTop: '24px' } });
  root.appendChild(overviewRegion);
  root.appendChild(gateRegion);
  root.appendChild(rulesRegion);

  // 概況(重い / チャート)は初回のみ描画。
  await renderOverview(overviewRegion).catch((e) => toast(`概況の読み込み失敗: ${e.message}`, 'err'));

  // ゲート領域は初回 + 30秒毎。モーダルが開いていればスキップ(未保存入力を守る)。
  refreshGate = () => {
    if (document.getElementById('modal-root').classList.contains('open')) return undefined;
    return renderGate(gateRegion).catch((e) => toast(`更新失敗: ${e.message}`, 'err'));
  };
  await refreshGate();
  timer = setInterval(refreshGate, 30000);

  // 翌日ルール編集(rules.js)。ゲートの定期更新とは独立に再描画。
  await renderRuleEditing(rulesRegion);
}

// --- (1) 作業概況 --------------------------------------------------------
async function renderOverview(region) {
  clear(region);
  destroyCharts();
  region.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));

  const date = state.today;
  const summary = await api.getSummary(date);
  const to = date;
  const from = addDaysLocal(date, -6);
  const range = await api.getRange(from, to);

  clear(region);

  // 総作業 KPI(除外内訳カードは表示しない)。
  region.appendChild(h('div', { class: 'card' },
    h('div', { class: 'stat' },
      h('div', { class: 'num', text: fmtDur(summary.totalWorkSeconds) }),
      h('div', { class: 'lbl', text: `総作業時間 (${summary.dayKey})` }),
    ),
  ));

  // グループ別ドーナツ。
  const groupCanvas = h('canvas', {});
  region.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title', text: 'グループ別' }),
    summary.groups.length ? h('div', { class: 'chart-wrap' }, groupCanvas) : emptyState('グループデータなし'),
  ));
  if (summary.groups.length) {
    // 設定 ON の未グループ行は時間つきで表示しつつ「総作業時間に非計上」を凡例ラベルへ明示（行は消さない）。
    charts.push(doughnut(groupCanvas, {
      labels: summary.groups.map((g) => (g.countsTowardTotal === false ? `${g.name}（総作業時間に非計上）` : g.name)),
      values: summary.groups.map((g) => Math.round(g.seconds / 60)),
      colors: summary.groups.map((g) => colorHex(g.color)),
    }));
  }

  // 直近7日の積み上げ棒。
  const barCanvas = h('canvas', {});
  region.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title', text: `直近7日のグループ別作業時間 (${from} 〜 ${to})` }),
    h('div', { class: 'chart-wrap tall' }, barCanvas),
  ));
  charts.push(stackedBar(barCanvas, range));
}

// --- (2) 解錠状態 + 条件進捗 + reveal ------------------------------------
async function renderGate(region) {
  const date = state.today;
  const [unlock, planning] = await Promise.all([
    api.getUnlock(date),
    api.getPlanning(date).catch(() => null),
  ]);
  clear(region);

  const unlocked = unlock.status === 'UNLOCKED';
  region.appendChild(h('div', { class: `gate-hero ${unlocked ? 'unlocked' : 'locked'}` },
    h('div', { class: 'lock-icon', text: unlocked ? '🔓' : '🔒' }),
    h('div', { class: 'lock-text' },
      h('div', { class: 'st', text: unlocked ? 'UNLOCKED — 達成済み' : 'LOCKED — 未達成' }),
      h('div', { class: 'sub', text: unlock.hasRuleSet ? `${date} のルールを評価` : `${date} のルール未設定 (達成不能)` }),
    ),
  ));

  const condCard = h('div', { class: 'card' }, h('div', { class: 'card-title', text: '条件の進捗' }));
  const list = h('div', { class: 'list' });
  if (!unlock.perCondition || unlock.perCondition.length === 0) {
    list.appendChild(emptyState('条件が定義されていません'));
  } else {
    for (const c of unlock.perCondition) list.appendChild(condRow(c, planning, date));
  }
  condCard.appendChild(list);
  region.appendChild(condCard);

  if (unlocked) {
    region.appendChild(revealCard(date));
  } else {
    const remaining = (unlock.perCondition || []).filter((c) => !c.met).length;
    region.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-title', text: 'パスワード' }),
      h('p', { class: 'muted', text: `未達成のためパスワードは表示できません。残り ${remaining} 条件を満たしてください。` }),
    ));
  }
}

function condRow(c, planning, date) {
  const met = !!c.met;

  // 目標の Check（合成条件）は、その場で答える／やめる導線を行内に持つ（spec: goal-check-gate）。
  // ゲートで足止めされている場所で解決できるようにするため、別タブへ飛ばさない。
  if (c.target === 'CHECK') return checkCondRow(c, date);

  // MANUAL_CHECK は行内チェックボックスでトグル(旧 checks.js を吸収)。
  if (c.target === 'MANUAL_CHECK') {
    const box = h('input', { type: 'checkbox' });
    box.checked = met;
    const row = h('label', { class: `cond${met ? ' met' : ''}` },
      box,
      h('div', { class: 'cond-main' },
        h('div', { class: 'cond-title', text: c.label || '手動チェック' }),
        h('div', { class: 'cond-sub', text: box.checked ? 'チェック済み' : '未チェック' }),
      ),
      h('span', { class: `mark ${met ? 'yes' : 'no'}`, text: met ? '✓' : '✗' }),
    );
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        await api.putCheck(date, c.conditionKey, box.checked);
        row.classList.toggle('met', box.checked);
        row.querySelector('.cond-sub').textContent = box.checked ? 'チェック済み' : '未チェック';
        row.querySelector('.mark').textContent = box.checked ? '✓' : '✗';
        row.querySelector('.mark').className = `mark ${box.checked ? 'yes' : 'no'}`;
        toast('チェックを更新しました', 'ok');
      } catch (err) {
        box.checked = !box.checked;
        toast(`更新失敗: ${err.message}`, 'err');
      } finally {
        box.disabled = false;
      }
    });
    return row;
  }

  let title = targetLabel(c.target);
  let chipColor = null;
  let sub = '';
  if (c.target === 'TOTAL_WORK') {
    sub = `${fmtHM(c.actualSeconds || 0)} / ${fmtHM(c.thresholdSeconds || 0)}`;
  } else if (c.target === 'GROUP') {
    // identity の現在名（改名後）＋色チップで表示する。UUID は出さない（spec: group-rule-identity）。
    title = `グループ: ${c.groupName || '不明なグループ（要再設定）'}`;
    chipColor = c.groupColor || null;
    sub = `${fmtHM(c.actualSeconds || 0)} / ${fmtHM(c.thresholdSeconds || 0)}`;
  } else if (c.target === 'TIMELINE') {
    // 「<カテゴリ> ◯分以上」＋「実績 / 閾値」（spec: group-rule-identity・ゲート画面の TIMELINE 表示）。
    const min = Math.round((c.thresholdSeconds || 0) / 60);
    title = `${c.label || 'カテゴリ'} ${min}分以上`;
    sub = `${fmtHM(c.actualSeconds || 0)} / ${fmtHM(c.thresholdSeconds || 0)}`;
  } else if (c.target === 'PLANNING') {
    // フラット化: signal_key の日本語ラベルをそのまま条件名にする(「翌日計画: …」の接頭辞は付けない)。
    title = planningSignalLabel(c.signalKey);
    if (planning) {
      // シグナルごとに関係する実データだけを補足表示する。
      if (c.signalKey === 'reflection_done') {
        sub = `振り返り: ${planning.reflectionDone ? '✓ 記録済み' : '✗ 未記録'}`;
      } else if (c.signalKey === 'tomorrow_tasks_registered') {
        sub = `明日のタスク: ${planning.tomorrowTaskCount} 件`;
      } else {
        sub = `振り返り: ${planning.reflectionDone ? '✓' : '✗'} / 明日のタスク: ${planning.tomorrowTaskCount} 件`;
      }
    } else {
      sub = met ? '完了' : '未完了';
    }
  }

  const titleEl = h('div', { class: 'cond-title' });
  if (chipColor) {
    const chip = h('span', { class: 'cond-color-chip' });
    chip.style.background = colorHex(chipColor);
    titleEl.appendChild(chip);
  }
  titleEl.appendChild(document.createTextNode(title));
  const main = h('div', { class: 'cond-main' },
    titleEl,
    h('div', { class: 'cond-sub', text: sub }),
  );
  if ((c.target === 'TOTAL_WORK' || c.target === 'GROUP' || c.target === 'TIMELINE') && c.thresholdSeconds) {
    const pct = Math.min(100, Math.round(((c.actualSeconds || 0) / c.thresholdSeconds) * 100));
    const bar = h('div', { class: 'progress' }, h('span', {}));
    bar.firstChild.style.width = `${pct}%`;
    main.appendChild(bar);
  }
  return h('div', { class: `cond ${met ? 'met' : ''}` },
    main,
    h('span', { class: `mark ${met ? 'yes' : 'no'}`, text: met ? '✓' : '✗' }),
  );
}

/**
 * 目標 Check の不足条件行（spec: goal-check-gate「今日タブから直接 Check に答える」）。
 *   📷 写真 … 貼付／ファイル選択で提出。**キャプションは先指定なので聞かない**。
 *   💬 質問 … 質問文を提示し、答え（非空）を書いて保存。
 * どちらの行にも「やめる」（理由必須）を置く＝唯一の脱出弁をその場に用意する。
 * 由来の Plan を副題に出し、「何のための答え合わせか」を思い出せるようにする。
 */
function checkCondRow(c, date) {
  const met = !!c.met;
  const icon = c.checkKind === 'photo' ? '📷' : '💬';
  const row = h('div', { class: `cond cond-check ${met ? 'met' : ''}` });

  // 状態の一言。範囲Check は「7/18〜7/24 の1日目」と、その日が期間の何日目かまで出す
  // （各日が独立して要求される仕様なので、「何日目の分か」が分からないと意味が取れない）。
  const status = met ? (c.checkKind === 'photo' ? '提出済み' : '回答済み') : c.checkKind === 'photo' ? '写真がまだ' : '未回答';
  let when = '';
  if (c.checkSchedule === 'range' && c.rangeDayNumber) {
    const end = addDaysLocal(c.startDayKey, (c.spanDays || 1) - 1);
    when = `（${shortDay(c.startDayKey)}〜${shortDay(end)} の${c.rangeDayNumber}日目）`;
  }

  const main = h('div', { class: 'cond-main' },
    h('div', { class: 'cond-title', text: `${icon} ${c.label || 'Check'}` }),
    h('div', { class: 'cond-sub', text: `${status}${when}` }),
    c.planBody ? h('div', { class: 'cond-sub cond-plan', text: `└ Plan: ${c.planBody}` }) : null,
  );
  row.appendChild(main);
  row.appendChild(h('span', { class: `mark ${met ? 'yes' : 'no'}`, text: met ? '✓' : '✗' }));
  if (met) return row; // 済んだ行に操作は出さない。

  const actionHost = h('div', { class: 'cond-actions' });
  main.appendChild(actionHost);
  const fail = (err, fallback) => toast((err.data && err.data.error) || fallback, 'err');
  const done = (msg) => { toast(msg, 'ok'); refreshGate(); };

  if (c.checkKind === 'photo') {
    // 写真: ファイル選択／貼り付け。キャプション入力欄は出さない（先指定済み）。
    const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'cond-file' });
    const label = h('label', { class: 'btn btn-ghost cond-btn' }, '写真を出す', fileInput);
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try {
        const dataUrl = await fileToDataUrl(file);
        await api.submitCheckPhoto(c.checkId, { dataUrl, date });
        done(`「${c.label}」を提出しました`);
      } catch (err) {
        fail(err, '写真を提出できませんでした');
      }
    });
    actionHost.appendChild(label);
    actionHost.appendChild(h('span', { class: 'cond-hint', text: `キャプションは「${c.label}」で保存されます` }));
  } else {
    // 質問: 質問文はタイトルに出ているので、答えだけを書く。空回答はサーバーが 400 で弾く。
    const input = h('input', { type: 'text', class: 'cond-answer', placeholder: '答えを書く' });
    const send = h('button', { type: 'button', class: 'btn btn-ghost cond-btn', text: '答える' });
    const submit = async () => {
      if (!input.value.trim()) { toast('答えを入力してください', 'err'); return; }
      send.disabled = true;
      try {
        await api.answerCheck(c.checkId, input.value.trim(), date);
        done('答えを記録しました');
      } catch (err) {
        fail(err, '答えを保存できませんでした');
        send.disabled = false;
      }
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    actionHost.appendChild(input);
    actionHost.appendChild(send);
  }

  // やめる（理由必須）。取り下げた事実は沿革に残る。
  const quit = h('button', { type: 'button', class: 'btn btn-ghost cond-btn', text: 'やめる' });
  quit.addEventListener('click', async () => {
    const reason = promptReason(`「${c.label}」をやめる理由（必須）`);
    if (!reason) return;
    try {
      await api.cancelCheck(c.checkId, reason);
      done('取り下げました（沿革には残ります）');
    } catch (err) {
      fail(err, '取り下げできませんでした');
    }
  });
  actionHost.appendChild(quit);
  return row;
}

/** File → data URL（写真提出用）。 */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('画像を読み込めませんでした'));
    fr.readAsDataURL(file);
  });
}

function revealCard(date) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-title', text: 'パスワード' }));
  const area = h('div', { class: 'stack' });
  const btn = h('button', { class: 'btn primary', text: 'パスワード表示', type: 'button' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const res = await api.reveal(date);
      clear(area);
      if (!res.unlocked) {
        area.appendChild(h('p', { class: 'muted', text: res.reason || 'パスワードを表示できません' }));
      } else if (!res.entries || res.entries.length === 0) {
        area.appendChild(h('p', { class: 'muted', text: res.reason || 'パスワードコマンドの結果がありません' }));
      } else {
        for (const e of res.entries) area.appendChild(pwEntry(e));
        if (res.missing) area.appendChild(h('p', { class: 'muted', text: '一部の候補は生成に失敗しました。' }));
      }
    } catch (err) {
      toast(`失敗: ${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'パスワード再表示';
    }
  });
  card.appendChild(h('p', { class: 'muted', text: '達成済みです。以下のボタンでパスワードを生成・表示できます(平文は保存されません)。' }));
  card.appendChild(btn);
  card.appendChild(area);
  return card;
}

function pwEntry(e) {
  const roleLabel = e.role === 'TODAY' ? '当日' : '前日';
  if (!e.ok || !e.password) {
    return h('div', { class: 'list-row' },
      h('span', { class: 'badge warn', text: `${roleLabel} (${e.targetDate})` }),
      h('span', { class: 'grow muted', text: e.error || '生成失敗' }),
    );
  }
  const copyBtn = h('button', { class: 'btn small', text: 'コピー', type: 'button' });
  copyBtn.addEventListener('click', () => copyText(e.password));
  return h('div', { class: 'pw-entry' },
    h('span', { class: 'badge accent', text: `${roleLabel} (${e.targetDate})` }),
    h('span', { class: 'pw-val mono grow', text: e.password }),
    copyBtn,
  );
}

// --- デモ: 仮想日付の今日ビュー（読み取り専用・ダミーパスワード）-----------
async function showDemo(root) {
  clear(root);
  destroyCharts();
  const overview = h('div', { class: 'stack' });
  const gate = h('div', { class: 'stack', style: { marginTop: '18px' } });
  root.appendChild(overview);
  root.appendChild(gate);
  overview.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));

  let data;
  try { data = await api.demo.today(state.demo.virtualDay); }
  catch (e) { clear(overview); overview.appendChild(emptyState(`読み込み失敗: ${e.message}`)); return; }

  // (1) 概況: 総作業 KPI + グループ別ドーナツ。
  clear(overview);
  overview.appendChild(h('div', { class: 'card' },
    h('div', { class: 'stat' },
      h('div', { class: 'num', text: fmtDur(data.totalWorkSeconds) }),
      h('div', { class: 'lbl', text: `総作業時間 (${data.dayKey})` }),
    ),
  ));
  const groupCanvas = h('canvas', {});
  overview.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title', text: 'グループ別' }),
    data.groups.length ? h('div', { class: 'chart-wrap' }, groupCanvas) : emptyState('この日は作業データがありません（デモ期間外）'),
  ));
  if (data.groups.length) {
    charts.push(doughnut(groupCanvas, {
      labels: data.groups.map((g) => g.name),
      values: data.groups.map((g) => Math.round(g.seconds / 60)),
      colors: data.groups.map((g) => colorHex(g.color)),
    }));
  }

  // (2) 解錠状態 + 条件進捗 + ダミーパスワード。
  clear(gate);
  const unlock = data.unlock; // EvalResult | null（デモ期間外は null）
  if (!unlock) {
    gate.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-title', text: '解錠状態' }),
      h('p', { class: 'muted', text: 'この仮想日付はデモの目標期間外です。上部バーの「＋7日」などで期間内に進めると、解錠状態と条件の進捗が表示されます。' }),
    ));
    return;
  }
  const unlocked = unlock.status === 'UNLOCKED';
  gate.appendChild(h('div', { class: `gate-hero ${unlocked ? 'unlocked' : 'locked'}` },
    h('div', { class: 'lock-icon', text: unlocked ? '🔓' : '🔒' }),
    h('div', { class: 'lock-text' },
      h('div', { class: 'st', text: unlocked ? 'UNLOCKED — 達成済み' : 'LOCKED — 未達成' }),
      h('div', { class: 'sub', text: `${data.dayKey} のサンプルを評価（デモ）` }),
    ),
  ));

  const condCard = h('div', { class: 'card' }, h('div', { class: 'card-title', text: '条件の進捗' }));
  const list = h('div', { class: 'list' });
  const per = unlock.perCondition || [];
  if (!per.length) list.appendChild(emptyState('条件が定義されていません'));
  else for (const c of per) list.appendChild(condRow(c, null, data.dayKey));
  condCard.appendChild(list);
  gate.appendChild(condCard);

  if (unlocked) {
    gate.appendChild(demoPwCard(data.dummyPassword));
  } else {
    const remaining = per.filter((c) => !c.met).length;
    gate.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-title', text: 'パスワード' }),
      h('p', { class: 'muted', text: `未達成のためパスワードは表示できません。残り ${remaining} 条件（デモ）。` }),
    ));
  }
}

/** デモの解錠時に見せるダミーパスワード（本物の生成コマンドは呼ばない）。 */
function demoPwCard(dummy) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-title', text: 'パスワード' }));
  card.appendChild(h('p', { class: 'muted', text: 'デモでは本物のパスワードは生成しません。以下はダミー表示です。' }));
  card.appendChild(h('div', { class: 'pw-entry' },
    h('span', { class: 'badge accent', text: 'デモ' }),
    h('span', { class: 'pw-val mono grow', text: dummy || 'デモ用 123456' }),
  ));
  return card;
}

// --- charts --------------------------------------------------------------
function addDaysLocal(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function doughnut(canvas, { labels, values, colors }) {
  return new window.Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 1, borderColor: '#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed;
              const hh = Math.floor(v / 60);
              const mm = v % 60;
              const t = hh > 0 ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm}分`;
              return `${ctx.label}: ${t}`;
            },
          },
        },
      },
    },
  });
}

function stackedBar(canvas, range) {
  const dayLabels = range.map((d) => d.dayKey.slice(5));
  const groupIds = [];
  const groupNames = new Map();
  const groupColors = new Map();
  for (const day of range) {
    for (const g of day.groups) {
      if (!groupNames.has(g.stableGroupId)) {
        groupNames.set(g.stableGroupId, g.name);
        groupColors.set(g.stableGroupId, g.color);
        groupIds.push(g.stableGroupId);
      }
    }
  }
  const datasets = groupIds.map((id) => ({
    label: groupNames.get(id),
    backgroundColor: colorHex(groupColors.get(id)),
    data: range.map((day) => {
      const g = day.groups.find((x) => x.stableGroupId === id);
      return g ? Math.round(g.seconds / 60) : 0;
    }),
  }));
  return new window.Chart(canvas, {
    type: 'bar',
    data: { labels: dayLabels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: {
          stacked: true, beginAtZero: true,
          ticks: { callback: (v) => `${Math.round(v / 60)}h` },
          title: { display: true, text: '時間' },
        },
      },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              const hh = Math.floor(v / 60);
              const mm = v % 60;
              return `${ctx.dataset.label}: ${hh > 0 ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm}m`}`;
            },
          },
        },
      },
    },
  });
}
