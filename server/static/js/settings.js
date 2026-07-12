// 設定: ws_port / shared_token 表示(コピー) と 各種設定の編集(PATCH /api/config).
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, copyText, toast } from './util.js';
import { startDemo, stopDemo, resetSample } from './demo.js';

export async function show(root) {
  clear(root);
  const body = h('div', { class: 'stack' });
  root.appendChild(body);
  await render(body);
}

async function render(body) {
  clear(body);
  body.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
  const cfg = await api.getConfig();
  state.config = cfg;
  clear(body);

  // お試し（デモ）モードの入り口（spec: demo-mode / 入り口）。
  body.appendChild(demoCard(body));

  // 拡張機能へ渡す接続情報
  const connCard = h('div', { class: 'card' }, h('div', { class: 'card-title', text: '拡張機能 接続情報' }));
  connCard.appendChild(copyRow('ws_port', String(cfg.ws_port)));
  connCard.appendChild(copyRow('shared_token', cfg.shared_token || '(未設定)'));
  connCard.appendChild(h('p', { class: 'muted', text: 'これらを Edge 拡張のポップアップに貼り付けてください。' }));
  body.appendChild(connCard);

  // 編集フォーム
  const fields = [
    { key: 'tz', label: 'タイムゾーン', type: 'text' },
    { key: 'day_boundary_minutes', label: '日境界(分, 240=04:00)', type: 'number' },
    { key: 'gap_cap_seconds', label: 'ギャップ上限(秒)', type: 'number' },
    { key: 'idle_detection_seconds', label: 'アイドル検出(秒)', type: 'number' },
    { key: 'heartbeat_seconds', label: 'ハートビート(秒)', type: 'number' },
    { key: 'session_coalesce_seconds', label: 'セッション結合(秒)', type: 'number' },
    { key: 'away_min_seconds', label: '離席とみなす最小時間(分)', type: 'number', unit: 'min' },
    { key: 'planning_min_tomorrow_tasks', label: '明日のタスク登録: 必要件数（閾値）', type: 'number' },
    { key: 'ws_port', label: 'ws_port', type: 'number' },
    { key: 'shared_token', label: 'shared_token', type: 'text' },
  ];
  const toggles = [
    { key: 'reveal_yesterday', label: '前日パスワードも表示 (reveal_yesterday)' },
    { key: 'planning_require_reflection', label: 'PLANNING に振り返り必須' },
    { key: 'include_ungrouped_in_split', label: '未グループを分割に含める' },
    { key: 'exclude_ungrouped_from_total', label: '未グループ時間を総作業時間に含めない（娯楽の除外）' },
  ];

  const inputs = new Map();
  const grid = h('div', { class: 'grid grid-2' });
  for (const f of fields) {
    // unit==='min' は秒設定を分単位で表示・編集する(保存時に *60)。
    const raw = cfg[f.key];
    const shown = f.unit === 'min'
      ? (raw == null ? '' : String(Math.round(raw / 60)))
      : (raw == null ? '' : String(raw));
    const inp = h('input', { type: f.type, value: shown });
    inputs.set(f.key, { inp, type: f.unit === 'min' ? 'min' : f.type });
    grid.appendChild(h('label', { class: 'field' }, f.label, inp));
  }

  const togHost = h('div', { class: 'stack' });
  for (const t of toggles) {
    const chk = h('input', { type: 'checkbox' });
    chk.checked = cfg[t.key] === 1;
    inputs.set(t.key, { inp: chk, type: 'bool' });
    togHost.appendChild(h('label', { class: 'inline' }, chk, t.label));
  }

  const undefinedSel = h('select', {},
    h('option', { value: 'LOCKED' }, 'LOCKED'),
    h('option', { value: 'UNLOCKED' }, 'UNLOCKED'),
  );
  undefinedSel.value = cfg.undefined_day_policy || 'LOCKED';
  inputs.set('undefined_day_policy', { inp: undefinedSel, type: 'text' });

  const save = h('button', { class: 'btn primary', text: '保存 (PATCH)', type: 'button' });
  save.addEventListener('click', async () => {
    const patch = {};
    for (const [key, { inp, type }] of inputs) {
      if (type === 'bool') patch[key] = inp.checked ? 1 : 0;
      else if (type === 'min') patch[key] = Math.round(Number(inp.value) * 60); // 分 → 秒
      else if (type === 'number') patch[key] = Number(inp.value);
      else patch[key] = inp.value;
    }
    save.disabled = true;
    try {
      const updated = await api.patchConfig(patch);
      state.config = updated;
      toast('設定を保存しました', 'ok');
      render(body);
    } catch (err) { toast(`失敗: ${err.message}`, 'err'); save.disabled = false; }
  });

  const editCard = h('div', { class: 'card' },
    h('div', { class: 'card-title', text: '設定の編集' }),
    grid,
    h('label', { class: 'field', style: { marginTop: '10px' } }, 'undefined_day_policy', undefinedSel),
    h('div', { class: 'stack', style: { marginTop: '12px' } }, togHost),
    h('div', { class: 'row', style: { marginTop: '14px' } }, save),
  );
  body.appendChild(editCard);

  // 読み取り専用の参考値
  body.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title', text: '参考(読み取り専用)' }),
    kv('concurrency_policy', cfg.concurrency_policy || '-'),
    kv('hasSalt', String(cfg.hasSalt)),
  ));

  // 運用メモ(オンデマンド起動 vs 常駐)
  body.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title', text: '運用メモ' }),
    h('p', { class: 'muted', text: '時間計測は Edge 拡張が起動中のみ 30 秒周期で行われ、サーバー停止中は拡張側に最大 2000 件（約16時間分）退避 → 再接続時に集計されます。したがって「見たいときだけ npm run server」でも概ね成立します（バッファ超過分は失われます）。' }),
    h('p', { class: 'muted', style: { marginTop: '8px' }, text: 'ただし 04:00 の日次ロールオーバー / ルール凍結はサーバー常駐が前提です。オンデマンド起動のみだと境界処理は次回起動時にまとめて実行され、凍結タイミングがずれる可能性があります。厳密な運用が必要ならスタートアップ登録で常駐させてください。' }),
  ));
}

/** お試し（デモ）モードの入り口カード（開始/終了・サンプルリセット）。 */
function demoCard(body) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-title', text: 'お試し（デモ）モード' }));
  card.appendChild(h('p', { class: 'muted', text: 'あらかじめ用意したサンプル目標（30日チャレンジ）を、日付を進めながら「読むだけ」で体験できます。デモの日付操作・サンプルは本番データにも本番の解禁判定にも一切影響しません。' }));

  const row = h('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } });
  const rerender = () => render(body);

  if (!state.demo.active) {
    const startBtn = h('button', { class: 'btn primary', text: '🧪 デモを開始', type: 'button' });
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try { await startDemo(); toast('デモモードを開始しました', 'ok'); rerender(); }
      catch (err) { toast(`デモを開始できませんでした: ${err.message}`, 'err'); startBtn.disabled = false; }
    });
    row.appendChild(startBtn);
  } else {
    const stopBtn = h('button', { class: 'btn', text: 'デモを終了', type: 'button' });
    stopBtn.addEventListener('click', () => { stopDemo(); toast('デモモードを終了しました', 'ok'); rerender(); });
    const resetBtn = h('button', { class: 'btn small', text: 'サンプルをリセット', type: 'button' });
    resetBtn.addEventListener('click', async () => {
      resetBtn.disabled = true;
      try { await resetSample(); } catch (err) { toast(`リセットに失敗: ${err.message}`, 'err'); }
      finally { resetBtn.disabled = false; }
    });
    row.appendChild(h('span', { class: 'badge accent', text: 'デモ中' }));
    row.appendChild(stopBtn);
    row.appendChild(resetBtn);
  }
  card.appendChild(row);
  return card;
}

function copyRow(label, value) {
  const btn = h('button', { class: 'btn small', text: 'コピー', type: 'button' });
  btn.addEventListener('click', () => copyText(value));
  return h('div', { class: 'list-row' },
    h('span', { class: 'muted', text: label }),
    h('span', { class: 'grow mono', text: value }),
    btn,
  );
}

function kv(k, v) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { text: v }));
}
