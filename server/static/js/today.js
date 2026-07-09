// 「今日」ハブ: 旧 dashboard(概況) + gate(解錠状態/条件進捗) + checks(手動チェック) を集約.
// 上から (1) 作業概況(総作業/グループ別ドーナツ/7日棒, 除外内訳は非表示),
//        (2) 解錠状態ヒーロー + 条件進捗(MANUAL_CHECK は行内チェックボックス),
//        (3) パスワード解錠, (4) 翌日ルール編集(rules.js 再利用).
// 30秒リフレッシュはゲート領域(ヒーロー/条件/reveal)のみ。モーダルが開いている間はスキップ。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, fmtDur, fmtHM, colorHex, copyText, toast, emptyState } from './util.js';
import { targetLabel } from './targets.js';
import { renderRuleEditing } from './rules.js';

let charts = [];
let timer = null;

function destroyCharts() {
  for (const c of charts) {
    try { c.destroy(); } catch { /* noop */ }
  }
  charts = [];
}

export function hide() {
  destroyCharts();
  if (timer) { clearInterval(timer); timer = null; }
}

export async function show(root) {
  clear(root);
  hide();

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
  const refreshGate = () => {
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
    charts.push(doughnut(groupCanvas, {
      labels: summary.groups.map((g) => g.name),
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
  let sub = '';
  if (c.target === 'TOTAL_WORK') {
    sub = `${fmtHM(c.actualSeconds || 0)} / ${fmtHM(c.thresholdSeconds || 0)}`;
  } else if (c.target === 'GROUP') {
    title = `グループ: ${c.stableGroupId || '?'}`;
    sub = `${fmtHM(c.actualSeconds || 0)} / ${fmtHM(c.thresholdSeconds || 0)}`;
  } else if (c.target === 'PLANNING') {
    title = '翌日計画 (PLANNING)';
    if (planning) sub = `振り返り: ${planning.reflectionDone ? '✓' : '✗'} / 翌日タスク: ${planning.tomorrowTaskCount}`;
    else sub = met ? '完了' : '未完了';
  }

  const main = h('div', { class: 'cond-main' },
    h('div', { class: 'cond-title', text: title }),
    h('div', { class: 'cond-sub', text: sub }),
  );
  if ((c.target === 'TOTAL_WORK' || c.target === 'GROUP') && c.thresholdSeconds) {
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
