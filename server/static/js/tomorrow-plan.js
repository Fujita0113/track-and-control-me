// 明日の計画ビュー(spec: tomorrow-plan-capture / tomorrow-plan-board)。振り返りワークスペースの左メイン第3ビュー。
//  - 本文の「明日」段落を素朴なヒューリスティックで短句候補チップへ分割し、タップで即登録。
//  - 登録先は本物のカンバンの未着手(TODO)列（別ストアは作らない）。due は現在の明日トグルに従う。
//  - 登録済みタスクは、チップ帯の下に埋め込んだ本物のカンバン盤面（保留/未着手/進行中/完了）の
//    カードとして表示する（issue #67）。新規タスクの直接入力は盤面自身の「＋ 新規タスク」で行う
//    （専用の直接入力欄は issue #67 のフィードバックで撤去）。列間ドラッグ・並べ替え・期限調整は盤面が担う。
import { api } from './api.js';
import { state } from './state.js';
import { h, clear, toast } from './util.js';
import { computeDue, tomorrowMode, mount as mountBoard, unmount as unmountBoard, reloadTasks } from './kanban.js';

const MAX_CANDIDATES = 8;
const MIN_LEN = 2;
const MAX_LEN = 20;
// 句読点・代表的な接続詞・スラッシュで区切る（形態素解析は行わない・素朴なヒューリスティック）。
const SPLIT_RE = /[。、！？\n]|まず|次に|そして|その後|してから|したら|それから|なければ|あれば|／|\//;

/** 本文から「明日」段落を拾い、句読点・接続詞で分割した短句候補配列を返す（純関数）。 */
export function extractCandidates(bodyText) {
  const text = String(bodyText || '');
  if (!text.trim()) return [];
  const paragraphs = text.split(/\n{1,}/).map((p) => p.trim()).filter(Boolean);
  const target = paragraphs.find((p) => p.includes('明日')) || paragraphs[paragraphs.length - 1] || '';
  if (!target) return [];
  const parts = target.replace(/明日の?段取り[：:はも]?/g, '').split(SPLIT_RE);
  const seen = new Set();
  const out = [];
  for (let raw of parts) {
    let p = String(raw || '').trim().replace(/^[、,・はもがを]+/, '').trim();
    if (p.length < MIN_LEN) continue;
    if (p.length > MAX_LEN) p = p.slice(0, MAX_LEN);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

let ctx = null; // { container, candidates, tasks, sidebar, chipSection }

export function hide() {
  ctx = null;
  unmountBoard();
}

/**
 * 対象日の本文テキストから候補を抽出し、埋め込みカンバン盤面と併せて描画する。
 * sidebar は右サイドバーの詳細/ログ供給先とタブ切替コールバック（reflection.js から渡される）:
 * { detailHost, logHost, onDetailOpen, onArchived }
 */
export async function render(container, bodyText, sidebar) {
  let tasks = [];
  try { tasks = await api.getTasks(); } catch { /* noop */ }
  ctx = { container, candidates: extractCandidates(bodyText), tasks, sidebar };
  await paint();
}

/** チップの「登録済み」判定: 完了していないタスクなら、盤面上のどの列にあっても登録済み扱いにする。 */
function registeredTitles(tasks) {
  return new Set((tasks || []).filter((t) => t.status !== 'DONE').map((t) => t.title));
}

async function paint() {
  if (!ctx) return;
  const { container, sidebar } = ctx;
  clear(container);

  const wrap = h('div', { class: 'rf-plan' });
  const chipSection = h('div', { class: 'rf-plan-chip-section' });
  ctx.chipSection = chipSection;
  renderChips(chipSection);
  wrap.appendChild(chipSection);

  const boardHost = h('div', { class: 'rf-plan-board' });
  wrap.appendChild(boardHost);
  container.appendChild(wrap);

  await mountBoard(boardHost, {
    bodyClass: null, // rf-page を壊さない（design D1）
    asideHost: { detail: sidebar.detailHost, log: sidebar.logHost },
    effects: false,
    settingsPopover: false,
    categorizeMode: false,
    tomorrowDefault: true,
    onDetailOpen: sidebar.onDetailOpen,
    onArchived: sidebar.onArchived,
  });
}

function renderChips(hostEl) {
  if (!ctx) return;
  clear(hostEl);
  const { candidates, tasks } = ctx;
  const registered = registeredTitles(tasks);
  if (!candidates.length) return;

  hostEl.appendChild(h('div', { class: 'rf-plan-section-lbl', text: '本文から拾えるもの（タップで追加）' }));
  const chipHost = h('div', { class: 'rf-plan-chips' });
  for (const c of candidates) {
    const done = registered.has(c);
    const chip = h('button', {
      class: `rf-plan-chip${done ? ' done' : ''}`, type: 'button', disabled: done,
      text: done ? `✓ ${c}` : `＋ ${c}`,
    });
    if (!done) chip.addEventListener('click', () => registerTask(c));
    chipHost.appendChild(chip);
  }
  hostEl.appendChild(chipHost);
}

/** 未着手(TODO)列へ登録する。due は現在の明日トグル（既定 ON・design D6）に従う。 */
async function registerTask(title) {
  if (!ctx) return;
  const dec = computeDue(null, 'TODO', tomorrowMode(), state.today);
  const due = dec.change ? dec.due : null;
  try {
    await api.createTask({ title, status: 'TODO', priority: 'low', due, due_locked: 0 });
    ctx.tasks = await api.getTasks().catch(() => ctx.tasks);
    await reloadTasks(); // 埋め込み盤面をフルリマウントせずに最新化する
    renderChips(ctx.chipSection);
  } catch (err) { toast(`追加に失敗: ${err.message}`, 'err'); }
}
