// エントリポイント: タブルーティング + 各画面の起動.
import { loadState, state } from './state.js';
import { h, clear, closeModal } from './util.js';
import * as today from './today.js';
import * as timeline from './timeline.js';
import * as kanban from './kanban.js';
import * as reflection from './reflection.js';
import * as goals from './goals.js';
import * as settings from './settings.js';
import { maybeShowOnboarding } from './onboarding.js';
import { renderDemoBar } from './demo.js';

const SCREENS = { today, timeline, kanban, reflection, goals, settings };
let current = null;

async function activate(name) {
  if (name === current) return;
  // 前画面の後始末(タイマ等)
  if (current && SCREENS[current].hide) {
    try { SCREENS[current].hide(); } catch { /* noop */ }
  }
  closeModal();

  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.target === name));
  document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));

  current = name;
  const section = document.getElementById(`screen-${name}`);
  try {
    await SCREENS[name].show(section);
  } catch (err) {
    clear(section);
    section.appendChild(h('div', { class: 'fatal', text: `画面の読み込みに失敗しました: ${err.message}` }));
  }
}

/** デモの日付操作・開始/終了で現在画面を再取得・再描画する（demo.js が 'demo:refresh' を発火）。 */
async function rerenderCurrent() {
  if (!current) return;
  const section = document.getElementById(`screen-${current}`);
  if (SCREENS[current].hide) {
    try { SCREENS[current].hide(); } catch { /* noop */ }
  }
  closeModal();
  try {
    await SCREENS[current].show(section);
  } catch (err) {
    clear(section);
    section.appendChild(h('div', { class: 'fatal', text: `画面の読み込みに失敗しました: ${err.message}` }));
  }
}

function bootNav() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => activate(btn.dataset.target));
  });
  // ディープリンク: #timeline で始まる hash は timeline タブへ(通知からの遷移。timeline-revamp D8)。
  // 既に timeline 表示中でも from/to 付きで来たら再表示するため、いったん解除してから activate。
  window.addEventListener('hashchange', () => {
    if ((location.hash || '').startsWith('#timeline')) {
      if (current === 'timeline') current = null;
      void activate('timeline');
    }
  });
}

/** 初期表示画面: #timeline で始まる hash があれば timeline、なければ today。 */
function initialScreen() {
  return (location.hash || '').startsWith('#timeline') ? 'timeline' : 'today';
}

async function boot() {
  bootNav();
  // デモの日付操作・開始/終了は現在画面の再描画を要求する。
  document.addEventListener('demo:refresh', () => { void rerenderCurrent(); });
  renderDemoBar(); // 通常モードでは hidden のまま。
  const meta = document.getElementById('topbar-meta');
  try {
    await loadState();
    meta.textContent = `作業日 ${state.today} · tz ${state.config.tz}`;
    await activate(initialScreen());
    // 初回オンボーディング(ルール皆無時)。画面表示後に判定する。
    await maybeShowOnboarding();
  } catch (err) {
    const main = document.querySelector('.content');
    clear(main);
    main.appendChild(h('div', { class: 'fatal' },
      h('p', { text: 'バックエンドに接続できませんでした。' }),
      h('p', { class: 'muted', text: String(err.message) }),
    ));
  }
}

boot();
