// エントリポイント: タブルーティング + 各画面の起動.
import { loadState, state } from './state.js';
import { h, clear, closeModal } from './util.js';
import * as today from './today.js';
import * as timeline from './timeline.js';
import * as kanban from './kanban.js';
import * as reflection from './reflection.js';
import * as settings from './settings.js';
import { maybeShowOnboarding } from './onboarding.js';

const SCREENS = { today, timeline, kanban, reflection, settings };
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

function bootNav() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => activate(btn.dataset.target));
  });
}

async function boot() {
  bootNav();
  const meta = document.getElementById('topbar-meta');
  try {
    await loadState();
    meta.textContent = `作業日 ${state.today} · tz ${state.config.tz}`;
    await activate('today');
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
